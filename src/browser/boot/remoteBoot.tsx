/**
 * The remote client's boot path (F-24): everything comes over ONE WebSocket `pair` connection (scoped
 * host proxy, `fsx`, session/settings/shell channels), rendered by the shared `renderShell`. Every
 * failure maps to a `RemoteConnectScreen` state, never a throw.
 */
import { getProductName } from '../../branding/productName'
import { getBuildTime } from '../../branding/buildInfo'
import { adoptRuntimeChannel } from '../../branding/updateChannels'
import {
  ensureCatalog,
  readLocaleAssetMap,
  resolveLocale,
  resolveLocaleAssetUrl,
  createTranslate,
} from '../webview/i18n/translate'
import { localizeRuntimeNotification } from '../webview/i18n/modNotification'
import { createWebSocketTransport } from '../runtimeTransport'
import {
  connectRuntime,
  createHostBridgeTransportOverConnection,
  createRuntimeFileAccess,
  createSessionListChannel,
  createSessionStatusChannel,
  createSettingsBridgeOverConnection,
  createShellChannel,
  createWorkerTransportOverConnection,
  resolveRuntimeClientId,
  subscribeRuntimeNotifications,
  type RuntimeConnection,
} from '../runtimeClient'
import { isRuntimeRequestError } from '../runtimeClient'
import type { RuntimeNotification } from '../runtimeProtocol'
import { attachWorkspaceStore } from '../webview/workspaceStore'
import { attachProviderLoginStore } from '../webview/providerLoginStore'
import { attachProviderUsageStore } from '../webview/providerUsageStore'
import { buildGlicInitPayload, resolveBootLocaleTag } from './nexusBoot'
import { installPerClientTheme } from './perClientTheme'
import { recoverLocaleCatalog } from './remoteLocaleRecovery'
import type { RenderableBootContext, ShellBootFetches } from './renderShell'
import type { RemotePairing, RemotePairingError } from './remotePairing'
import {
  clearStoredPairing,
  forgetDevicePairing,
  isDeviceRememberable,
  resolveRemoteSocketUrl,
} from './remotePairing'
import { switchToDesktopBuild } from './remoteBuildSwitch'
import { UNREACHABLE_STATES } from '../webview/remote/unreachableStates'
import { enableAppInstall } from '../webview/remote/appInstall'
import { remoteHostFromBootstrap } from '../webview/remote/hostIdentity'
import type {
  RemoteConnectState,
  UnreachableProgress,
} from '../webview/remote/RemoteConnectScreen'

/** How long the pair handshake may take before the screen says so. */
const HANDSHAKE_TIMEOUT_MS = 15_000
/** Auto-retry cadence for the "reconnects on its own" screens. */
const AUTO_RETRY_MS = 5_000
/** The locale recovery's whole budget (`recoverLocaleCatalog`): waiting on
 *  the page's own catalog, then the current manifest and one catalog. */
const LOCALE_RECOVERY_DEADLINE_MS = 4_000
/** How long a pairing-error screen waits for its catalog before painting in
 *  English — the same bound `renderShell` puts on the shell's first render. */
const PAIRING_ERROR_LOCALE_DEADLINE_MS = 2_000
/**
 * Retry delays of a LIVE connection after the desktop went away; the last step repeats, unjittered.
 * "Reconnect now" restarts the ladder.
 */
export const LIVE_RECONNECT_LADDER_MS: readonly number[] = [
  1_000, 2_000, 4_000, 8_000, 16_000, 32_000,
  60_000, 120_000, 240_000, 480_000, 960_000,
  3_600_000,
]

/**
 * Page-wide "cannot reach the desktop" state across boot attempts. `everConnected` picks the card's
 * copy; attempts walk `LIVE_RECONNECT_LADDER_MS`.
 */
const unreachable = {
  everConnected: false,
  attempt: 0,
  /** The card last shown, while a retry of it is on the wire; null otherwise. */
  shown: null as UnreachableProgress | null,
}

/** The unreachable card's next progress: one more failed attempt, and the
 *  ladder's delay for it. Exported for tests. */
export function nextUnreachableProgress(
  state: { everConnected: boolean; attempt: number },
  now: number,
): UnreachableProgress {
  const attempt = state.attempt + 1
  const ladder = LIVE_RECONNECT_LADDER_MS
  const delay = ladder[Math.min(attempt - 1, ladder.length - 1)]!
  return { everConnected: state.everConnected, attempt, nextAttemptAt: now + delay }
}

/** Tests only: a fresh document's bookkeeping. */
export function resetUnreachableForTests(): void {
  unreachable.everConnected = false
  unreachable.attempt = 0
  unreachable.shown = null
}

function nexusTrace(message: string, details?: unknown): void {
  // Same opt-in gate as the desktop boot's narration.
  if (details === undefined) {
    console.info(`[NexusTrace][RemoteBoot] ${message}`)
    return
  }
  console.info(`[NexusTrace][RemoteBoot] ${message}`, details)
}

/** One root per boot — a retry re-RENDERS a new state onto it, never a
 *  second createRoot on the same container (React warns + the retry would
 *  paint nothing). Module-scope is fine: one remote boot per document. */
let connectScreenRoot: import('react-dom/client').Root | null = null
/** Bumped by every connect-screen render request and by every release. A
 *  render paints only if it is still the latest when its imports settle —
 *  see `renderConnectScreen`. */
let connectScreenGeneration = 0

/** What a live shell wired to its connection — the per-client theme installer
 *  and the notifications subscription — so the NEXT boot (a retry, a restarted
 *  runtime, a log-out) can tear it down first. Each was bound to the
 *  connection of the boot that made it; left behind, every reboot added one
 *  more resolver and one more subscriber on a dead wire. Module scope, like
 *  `connectScreenRoot`: one remote boot per document. */
let shellWiring: (() => void) | null = null

function disposeShellWiring(): void {
  const dispose = shellWiring
  shellWiring = null
  dispose?.()
}

/** Hand the container over: `renderShell` creates its OWN root, and React
 *  refuses a second createRoot on a container whose first root is still
 *  mounted — so the connect screen's root is unmounted first. A no-op when no
 *  connect state was ever painted. */
export function releaseConnectScreenRoot(): void {
  // A render still loading its modules must not paint (and createRoot) over
  // whatever takes the container next.
  connectScreenGeneration += 1
  connectScreenRoot?.unmount()
  connectScreenRoot = null
}

/**
 * Render a connect/error state; the latest REQUEST wins and a superseded render paints nothing.
 * Exported for tests.
 */
export async function renderConnectScreen(
  container: HTMLElement,
  fetches: Pick<ShellBootFetches, 'reactPromise' | 'reactDomPromise'>,
  localeTag: string | undefined,
  props: {
    state: RemoteConnectState
    onRetry?: (manual?: boolean) => void
    onOpenMatchingBuild?: () => void
    autoRetryMs?: number
    unreachable?: UnreachableProgress
  },
): Promise<void> {
  const generation = ++connectScreenGeneration
  const React = await fetches.reactPromise
  const { createRoot } = await fetches.reactDomPromise
  const { RemoteConnectScreen } = await import(
    '../webview/remote/RemoteConnectScreen'
  )
  const { I18nProvider } = await import('../webview/i18n')
  if (generation !== connectScreenGeneration) return
  connectScreenRoot ??= createRoot(container)
  connectScreenRoot.render(
    React.createElement(
      I18nProvider,
      { locale: localeTag },
      React.createElement(RemoteConnectScreen, props),
    ),
  )
}

/**
 * A client the host serves no toasts for — a remote always — falls back to the
 * browser's own notifications, and only when the user already allowed them.
 * http:// origins have no `Notification` at all; the constructor lookup covers
 * that without a secure-context probe.
 */
function showLocalNotification(notification: RuntimeNotification): void {
  const ctor = (globalThis as { Notification?: typeof Notification }).Notification
  if (!ctor || ctor.permission !== 'granted') return
  try {
    new ctor(notification.title ?? notification.message, {
      body: notification.title ? notification.message : undefined,
      tag: notification.notificationType,
    })
  } catch {
    // A browser that refuses the constructor outside a service worker.
  }
}

/** Map a handshake/transport failure to the screen that names it. */
export function stateForFailure(error: unknown): RemoteConnectState {
  // The transport close reason carries the relay/listener close code
  // (`ws-4001` …); a `bye` carries the hub's own code.
  const text =
    (error instanceof Error ? error.message : String(error)) +
    ' ' +
    ((error as { code?: unknown })?.code ?? '')
  if (text.includes('unauthorized')) return 'unauthorized'
  if (text.includes('4003')) return 'listener_disabled'
  if (text.includes('4001')) return 'runtime_offline'
  if (text.includes('4004')) return 'too_many_clients'
  if (text.includes('protocol_too_old')) return 'protocol_too_old'
  if (text.includes('protocol_too_new')) return 'protocol_too_new'
  return 'failed'
}

/**
 * Auto-retry cadence for a connect-screen state, or undefined: `runtime_offline`, `too_many_clients`
 * and `failed` retry. A retry re-runs the whole boot.
 */
export function autoRetryMsForState(state: RemoteConnectState): number | undefined {
  return state === 'failed' ||
    state === 'runtime_offline' ||
    state === 'too_many_clients' ||
    // The desktop coming back is the only fix, and it is one the page can
    // notice on its own — so it does, rather than parking on a screen the
    // user has to remember to press.
    state === 'host_gone'
    ? AUTO_RETRY_MS
    : undefined
}

/**
 * The connect screen and auto-retry for a LIVE connection's terminal close. `replaced` (another tab
 * holds this client id) gets its own screen and never auto-retries.
 */
export function screenForLiveClose(
  code: string,
  reason?: string,
): { state: RemoteConnectState; autoRetryMs?: number } {
  // Matched on the EXACT bye code, not through `stateForFailure`'s substring
  // parse: that one reads free text (a close reason, an Error message), and a
  // message that merely contains the word would land a first dial on a screen
  // about a second tab that does not exist.
  if (code === 'replaced') return { state: 'replaced' }
  // The desktop going away: a clean going-away close (1001, what the listener
  // sends when the browser is shutting down) or an abrupt drop (1006 / a close
  // that named no code — the process died, the network went). The generic
  // 'failed' copy is written for a FIRST dial ("it may be asleep, or not
  // reachable"); a connection that was live a moment ago has a better answer.
  if (reason === 'ws-1001' || reason === 'ws-1006' || reason === 'ws-closed') {
    return { state: 'host_gone', autoRetryMs: AUTO_RETRY_MS }
  }
  // A wire close names itself in `reason` (`ws-4003` → listener_disabled);
  // the bare code would collapse every one of them into 'failed'.
  const state = stateForFailure(`${code} ${reason ?? ''}`)
  const autoRetryMs = autoRetryMsForState(state)
  return autoRetryMs !== undefined ? { state, autoRetryMs } : { state }
}

/**
 * Render the screen for a link that never produced a pairing (malformed or
 * expired). Kept here — not in main.tsx — so the fork point stays a fork and
 * every remote screen comes from one module.
 */
export async function renderRemotePairingError(
  container: HTMLElement,
  error: RemotePairingError,
): Promise<void> {
  const localeTag = resolveBootLocaleTag()
  // Bounded like the shell's first render: a hung catalog fetch paints the
  // screen in English rather than never painting it at all.
  await Promise.race([
    startLocalePreload(localeTag),
    new Promise<void>(resolve => setTimeout(resolve, PAIRING_ERROR_LOCALE_DEADLINE_MS)),
  ])
  await renderConnectScreen(
    container,
    { reactPromise: import('react'), reactDomPromise: import('react-dom/client') },
    localeTag,
    { state: error === 'expired' ? 'expired' : 'invalid' },
  )
}

/** What `runtime.getBuildEntry` answers. `channel` is absent from a runtime
 *  that predates it. */
export type RuntimeBuildEntry = {
  build: string | null
  entryUrl: string | null
  channel?: string
}

/**
 * Read the runtime's build identity and adopt its update channel before rendering. `null` for an older
 * runtime (`unknown_route`) or a failed request; the caller then skips the version check.
 */
export async function readRuntimeBuildEntry(
  connection: Pick<RuntimeConnection, 'request'>,
): Promise<RuntimeBuildEntry | null> {
  try {
    const entry = await connection.request<RuntimeBuildEntry>('runtime.getBuildEntry')
    const channel = adoptRuntimeChannel(entry.channel)
    nexusTrace('runtime build entry', { build: entry.build, channel })
    return entry
  } catch (error) {
    // No report: the page's own resolution stands (a retried boot must not
    // keep the channel an earlier runtime reported).
    adoptRuntimeChannel(null)
    // An older runtime without the action (`unknown_route`) — dev included,
    // where `entryUrl` is null anyway — simply skips the check.
    if (!isRuntimeRequestError(error) || error.wire.code !== 'unknown_route') {
      nexusTrace('runtime.getBuildEntry failed; skipping version check', {
        message: error instanceof Error ? error.message : String(error),
      })
    }
    return null
  }
}

/**
 * Call `onFresh` when a live connection returns from `reconnecting` to a runtime that did NOT resume it
 * (a restarted desktop). Returns an unsubscribe; `onFresh` runs on a microtask after the publish.
 */
export function watchForFreshRuntime(
  connection: Pick<RuntimeConnection, 'watchLinkState'>,
  onFresh: () => void,
): () => void {
  let away = false
  return connection.watchLinkState(state => {
    if (state.status === 'reconnecting') {
      away = true
      return
    }
    if (state.status === 'ready' && away) {
      away = false
      // Deferred: the connection publishes `ready` MID-resume — it still has
      // to re-subscribe and re-arm its heartbeat — and `onFresh` closes it.
      // Closing from inside the publish would leave that heartbeat armed on
      // a closed object.
      if (!state.welcome.resumed) queueMicrotask(onFresh)
    }
  })
}

export async function remoteBootAndRender(
  container: HTMLElement,
  pairing: RemotePairing,
): Promise<void> {
  // A re-run (retry, restarted runtime, log-out): whatever the previous shell
  // wired to ITS connection goes first, before this boot wires its own.
  disposeShellWiring()
  // Same boot optimization as the desktop (nexusBootAndRender): kick off the
  // heavy imports + the catalog fetch IMMEDIATELY, overlapping the socket
  // connect + handshake instead of serializing after them.
  const fetches: ShellBootFetches = {
    reactPromise: import('react'),
    reactDomPromise: import('react-dom/client'),
    shellPromise: import('../webview/MultiSessionShell'),
    localePromise: startLocalePreload(resolveBootLocaleTag()),
  }
  const localeTag = resolveBootLocaleTag()
  // Installable as an app (F-24) — linked now, not after the connect: the
  // browser's install offer fires once, soon after it reads the manifest, and
  // is caught only by a listener that is already there.
  if (isDeviceRememberable(pairing)) enableAppInstall()

  const renderState = (
    state: RemoteConnectState,
    extras: {
      onRetry?: (manual?: boolean) => void
      onOpenMatchingBuild?: () => void
      autoRetryMs?: number
      unreachable?: UnreachableProgress
    } = {},
  ): Promise<void> =>
    renderConnectScreen(container, fetches, localeTag, { state, ...extras })

  /** Boot again, from scratch. Every retry goes through here: a re-run that
   *  THROWS (a failed import, a bug) used to be an unhandled rejection with
   *  the page stuck on "connecting"; now it lands on the screen that names
   *  the failure, with a retry of its own. */
  const reboot = (): void => {
    remoteBootAndRender(container, pairing).catch((error: unknown) => {
      const state = stateForFailure(error)
      nexusTrace('remote boot failed', {
        state,
        message: error instanceof Error ? error.message : String(error),
      })
      void renderState(state, {
        onRetry: reboot,
        autoRetryMs: autoRetryMsForState(state),
      }).catch(() => undefined)
    })
  }

  // The minimal "connecting" screen — the remote page's stand-in for the
  // desktop's outer-panel welcome.
  // Not awaited here (the connect must overlap it), but settled before the
  // shell takes the container: on a fast connect this render would otherwise
  // land AFTER renderShell and create a second root over the live shell.
  // A retry from the unreachable card keeps the card up, turned to "connecting".
  const connectingPainted = renderState(
    'connecting',
    unreachable.shown ? { unreachable: unreachable.shown } : {},
  ).catch(() => undefined)

  /** Show the unreachable card one step further up the ladder. `fromShell`:
   *  the shell held the container, so a retry needs the root released. */
  const renderUnreachable = (
    state: RemoteConnectState,
    fromShell: boolean,
  ): Promise<void> => {
    const progress = nextUnreachableProgress(unreachable, Date.now())
    unreachable.attempt = progress.attempt
    unreachable.shown = progress
    return renderState(state, {
      unreachable: progress,
      onRetry: manual => {
        // The user acted: the ladder starts over, as the live overlay's does.
        if (manual) {
          unreachable.attempt = 0
          unreachable.shown = { ...progress, attempt: 0 }
        }
        if (fromShell) releaseConnectScreenRoot()
        reboot()
      },
    })
  }

  const wsUrl = resolveRemoteSocketUrl(pairing, globalThis.location)
  nexusTrace('remote boot start', { wsUrl, pairId: pairing.pairId })

  // Security: a page served on a loopback host asks for `manager`, judged only by its own location
  // (the hub cannot see the peer address). The hub clamps it as a ceiling; it never raises a narrower link.
  const pageHost = globalThis.location?.hostname ?? ''
  const loopback =
    pageHost === '127.0.0.1' || pageHost === 'localhost' || pageHost === '[::1]'

  const connect = (): Promise<RuntimeConnection> =>
    connectRuntime({
      transport: createWebSocketTransport(new WebSocket(wsUrl)),
      client: {
        clientId: resolveRuntimeClientId(),
        kind: 'browser',
        build: getBuildTime() || undefined,
        // How the desktop's Remote access page names this device (F-24).
        // Sent only by a remote: the desktop's own shell is not a device
        // anyone lists, and the string is a claim, never a credential.
        userAgent: globalThis.navigator?.userAgent || undefined,
      },
      auth: { mode: 'pair', pairId: pairing.pairId },
      // The secret NEVER goes on the wire — connectRuntime uses it only to
      // answer the hub's challenge locally (D9).
      pairSecret: pairing.pairSecret,
      ...(loopback ? { scopeCeiling: 'manager' as const } : {}),
      handshakeTimeoutMs: HANDSHAKE_TIMEOUT_MS,
      // Reconnect-and-resume across a dropped wire: the wire IS
      // the failure mode of a remote client, unlike the desktop's MessagePort.
      reconnect: {
        createTransport: () =>
          createWebSocketTransport(new WebSocket(wsUrl)),
        delayLadderMs: LIVE_RECONNECT_LADDER_MS,
      },
    })

  let connection: RuntimeConnection
  try {
    connection = await connect()
  } catch (error) {
    const state = stateForFailure(error)
    nexusTrace('remote connect failed', { state })
    // The desktop answered, in a protocol this page does not speak: the page
    // came from an older (or newer) build than the desktop runs — typically a
    // cached bare-address redirect. Only a listener page's `/` knows where
    // the current build is, and reloading it is what the screen asks for.
    if (
      (state === 'protocol_too_old' || state === 'protocol_too_new') &&
      isDeviceRememberable(pairing) &&
      switchToDesktopBuild(null)
    ) {
      nexusTrace('protocol mismatch; reloading onto the desktop build', { state })
      return
    }
    if (UNREACHABLE_STATES.has(state)) {
      await renderUnreachable(state, false)
      return
    }
    unreachable.shown = null
    await renderState(state, {
      onRetry: reboot,
      autoRetryMs: autoRetryMsForState(state),
    })
    return
  }
  // Reached the desktop: whatever goes wrong from here is a LOST connection.
  unreachable.everConnected = true
  unreachable.attempt = 0
  unreachable.shown = null

  // Version-skew check: the runtime reports the immutable
  // entry of the build that BOOTED it; this page may have been served a
  // different one (a stale link, a deploy in between, or — most often — the
  // cached bare-address redirect of a device that last connected before the
  // desktop updated). A mismatch never runs two builds against each other:
  // the page switches itself onto the desktop's build (remoteBuildSwitch.ts),
  // and only a switch that would loop falls to the jump screen.
  const entry = await readRuntimeBuildEntry(connection)
  // The entry's own catalog may be gone from the origin: a desktop that
  // stayed up across deploys runs a build whose assets were not retained.
  // Recover from the current deploy before anything renders. Nothing
  // re-renders when a catalog lands later, so this has to finish first.
  const recovery = await recoverLocaleCatalog({
    locale: resolveLocale(localeTag),
    entryUrl: entry?.entryUrl,
    pageOrigin: globalThis.location.origin,
    ownAttempt: fetches.localePromise,
    deadlineMs: LOCALE_RECOVERY_DEADLINE_MS,
  })
  if (recovery.outcome !== 'not_needed') {
    nexusTrace('locale catalog recovery', recovery)
  }
  const ownBuild = getBuildTime()
  if (
    entry?.build &&
    ownBuild &&
    entry.build !== ownBuild &&
    entry.entryUrl !== null
  ) {
    const target =
      globalThis.location.origin + new URL(entry.entryUrl).pathname
    nexusTrace('build mismatch', { own: ownBuild, desktop: entry.build })
    if (switchToDesktopBuild(target)) {
      connection.close()
      return
    }
    await renderState('build_mismatch', {
      onOpenMatchingBuild: () => {
        // The fragment was erased at read time and lives in sessionStorage;
        // the new page re-reads it from there (remotePairing.ts).
        globalThis.location.href = target
      },
    })
    return
  }

  const getRuntimeConnection = () => Promise.resolve(connection)

  // The PreparedNexusBootContext-shaped context: every field
  // the shell reads, assembled from the connection instead of the host. What
  // is NOT here: `sharedWorkerPort` / `hostWindow` / `hostOrigin` (a remote has
  // none — renderShell's RenderableBootContext omits them), and the init
  // payload's host half (the runtime builds session inits from the desktop's
  // `runtime.publishHostEnvironment`; a non-`full` connection's `init` is
  // dropped by `sessionOpenFor` regardless).
  const initPayload = buildGlicInitPayload({ hostManifest: null })
  const createWorkerTransport = () =>
    createWorkerTransportOverConnection(getRuntimeConnection(), undefined, {
      onError: error =>
        nexusTrace('runtime transport error', {
          message: error instanceof Error ? error.message : String(error),
        }),
    })
  // Host calls ride the connection through the host-proxy table — scope-checked,
  // so most answer `forbidden_scope`, which the callers handle as "absent".
  // NO `events` half: host-pushed events are the desktop's C++ port, which a
  // remote does not have (a known gap).
  const transport = createHostBridgeTransportOverConnection({
    connection: getRuntimeConnection,
  })
  // Per-client theme on the remote: same resolver path as the desktop panel.
  // The remote's stored (scheme, seed, variant) rides the connection-backed
  // transport to `appearance.resolveTheme` (observe scope), and the result
  // applies locally — nothing about this client touches the desktop's profile.
  const disposePerClientTheme = installPerClientTheme(
    transport,
    window,
    document.documentElement,
    (message, details) => nexusTrace(message, details),
  )
  const shellChannel = createShellChannel({
    connection: getRuntimeConnection,
    onError: (error: unknown) =>
      nexusTrace('shell publish failed', {
        message: error instanceof Error ? error.message : String(error),
      }),
  })
  const unsubscribeNotifications = subscribeRuntimeNotifications({
    connection: getRuntimeConnection,
    // A remote has NO host toast route — that criterion is always false
    // here — so a notification is the browser's own, granted-only. A mod's
    // state (F-25) is composed here, in the user's language.
    show: notification =>
      showLocalNotification(
        localizeRuntimeNotification(
          notification,
          createTranslate(resolveLocale(resolveBootLocaleTag())),
        ),
      ),
    onError: error =>
      nexusTrace('notifications subscribe failed', {
        message: error instanceof Error ? error.message : String(error),
      }),
  })
  // Both are bound to THIS connection; the next boot (or a log-out) tears
  // them down through `disposeShellWiring` before wiring its own.
  shellWiring = () => {
    disposePerClientTheme()
    unsubscribeNotifications()
  }
  // Re-attaches when this is a reboot: the store's mirror moves from the
  // closed connection to this one (`WorkspaceStore.attach`).
  attachWorkspaceStore(getRuntimeConnection)
  attachProviderUsageStore(getRuntimeConnection)
  attachProviderLoginStore(getRuntimeConnection)

  const ctx: RenderableBootContext = {
    transport,
    files: createRuntimeFileAccess({ connection: getRuntimeConnection }),
    sessionChannel: createSessionListChannel({ connection: getRuntimeConnection }),
    sessionStatusChannel: createSessionStatusChannel({
      connection: getRuntimeConnection,
    }),
    settingsBridge: createSettingsBridgeOverConnection({
      connection: getRuntimeConnection,
    }),
    shellChannel,
    initPayload,
    createWorkerTransport,
    runtimeConnection: getRuntimeConnection,
  }

  await connectingPainted
  releaseConnectScreenRoot()
  const { renderShell } = await import('./renderShell')
  // Who the user is actually driving. `welcome.bootstrap` is the ONE place a
  // remote learns it: the machine name and OS ride it from the desktop's C++
  // host, and the account comes out of `homeDir`, which the desktop has
  // always sent. Everything is optional — an older desktop simply names
  // fewer lines (`RemoteHostIndicator`).
  // Declared ahead of `logOut`, which has to be able to silence the watcher
  // installed further down (a log-out close must render the signed-out
  // screen, not the close watcher's).
  let unwatchConnection: (() => void) | null = null
  const remoteHost = remoteHostFromBootstrap(
    globalThis.location?.host ?? '',
    connection.welcome?.bootstrap,
  )

  // Logging out is this DEVICE forgetting the link — not a request to the
  // desktop, which has nothing to revoke for one client (the pairing is
  // shared by every device; revoking it is the desktop's own "Reset link").
  // So: drop both stored pairings, close the wire, and hand the container
  // back to the connect screen. The screen is `unauthorized`, which is the
  // truthful state — this page now holds no credential — and it is terminal,
  // so nothing retries into the desktop behind the user's back.
  let shell: { unmount: () => void } | null = null

  /** The one way out of the live shell: hand the container back to the
   *  connect screen, in the state given. Idempotent — whichever path (a
   *  terminal close, a restarted runtime, a log-out) gets there first wins.
   *  Declared BEFORE the shell renders so a close that lands while it is
   *  rendering has somewhere to go. */
  let fallen = false
  const leaveShell = (): boolean => {
    if (fallen) return false
    fallen = true
    unwatchConnection?.()
    disposeShellWiring()
    shell?.unmount()
    shell = null
    return true
  }
  const fallToScreen = (screen: { state: RemoteConnectState; autoRetryMs?: number }): void => {
    if (!leaveShell()) return
    if (UNREACHABLE_STATES.has(screen.state)) {
      void renderUnreachable(screen.state, true)
      return
    }
    void renderState(screen.state, {
      onRetry: () => {
        releaseConnectScreenRoot()
        reboot()
      },
      autoRetryMs: screen.autoRetryMs,
    })
  }
  /**
   * A terminal close that ALREADY happened. `watchLinkState` replays nothing,
   * so a `bye` (`replaced`, `unauthorized`) that landed between the handshake
   * and the watchers below — the build-entry read, the locale recovery, the
   * shell's imports — would be missed and the shell would render over a
   * closed wire. Read off `state` instead, at each point the watchers are
   * not yet (or were not yet) listening. `shutting_down` is this page's own.
   */
  const fallIfClosed = (): boolean => {
    const state = connection.state
    if (state.status !== 'closed' || state.code === 'shutting_down') return false
    nexusTrace('remote connection closed before the shell was watching', {
      code: state.code,
      reason: state.reason,
    })
    fallToScreen(screenForLiveClose(state.code, state.reason))
    return true
  }

  const logOut = (): void => {
    nexusTrace('remote log out')
    unwatchConnection?.()
    disposeShellWiring()
    clearStoredPairing()
    forgetDevicePairing()
    // `shutting_down` is this page's own close, and the state watcher above
    // deliberately ignores it — the screen below is rendered here instead.
    connection.close()
    shell?.unmount()
    shell = null
    void renderState('unauthorized')
  }

  // No shell over a wire that closed while its modules were loading.
  if (fallIfClosed()) return

  shell = await renderShell(container, ctx, fetches, {
    title: getProductName(),
    // A remote has no host manifest, but every host with a remote listener
    // (F-24) serves transcript search (F-16 is older), so the remote states
    // it. The grant still decides: the gate also needs
    // `search.queryTranscripts` in the welcome's scoped capabilities.
    searchCapable: true,
    remoteHost,
    onRemoteLogOut: logOut,
  })

  // While the desktop is away the shell STAYS: the connection retries on
  // its own and `RemoteOfflineOverlay` covers the shell with the countdown
  // and a "Reconnect now". Only a runtime that came back as a different one
  // (the desktop restarted) replaces it — with a fresh boot, now that the
  // desktop is answering again.
  const unwatchFresh = watchForFreshRuntime(connection, () => {
    nexusTrace('reconnected to a restarted runtime; booting again')
    if (!leaveShell()) return
    // Ours, not the runtime's: `shutting_down`, which the close watcher
    // ignores (and it is already unsubscribed).
    connection.close()
    reboot()
  })

  // The connection ending FOR GOOD (a revoked pairing's `unauthorized` bye, a
  // listener switched off) must not leave a live-looking shell over a dead
  // wire: hand the container back to the connect screen, in the state the
  // close code names. `shutting_down` is this page's own close — not an error.
  const unwatchClose = connection.watchLinkState(state => {
    if (state.status !== 'closed' || state.code === 'shutting_down') return
    nexusTrace('remote connection closed', { code: state.code, reason: state.reason })
    fallToScreen(screenForLiveClose(state.code, state.reason))
  })
  // Both watchers behind the one handle `logOut` (and `leaveShell`) reach for.
  unwatchConnection = () => {
    unwatchClose()
    unwatchFresh()
  }
  // The watchers see only what happens from now on: a close that landed
  // while `renderShell` was awaiting is caught here, the same way.
  fallIfClosed()
}

/** Same helper as nexusBoot's — duplicated deliberately: it is 15 lines and
 *  sharing it would couple the two boot modules' import graphs further than
 *  the render they already share. Kept byte-identical in behavior. */
function startLocalePreload(localeTag: string | undefined): Promise<void> {
  const locale = resolveLocale(localeTag)
  const map = readLocaleAssetMap()
  const url = resolveLocaleAssetUrl(locale, map)
  if (!url) return Promise.resolve()
  return ensureCatalog(locale, url).catch(async (error: unknown) => {
    nexusTrace('locale catalog load failed', {
      locale,
      message: error instanceof Error ? error.message : String(error),
    })
    if (locale === 'en') return
    const enUrl = resolveLocaleAssetUrl('en', map)
    if (!enUrl) return
    await ensureCatalog('en', enUrl).catch(() => {
      // Nothing left to try — `t()` degrades to BOOTSTRAP_MESSAGES.
    })
  })
}
