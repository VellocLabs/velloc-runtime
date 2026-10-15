import type {
  BridgeEventEnvelope,
  BridgeEventUnsubscribe,
  BrowserBridgeAction,
  BrowserBridgeCapability,
  BrowserBridgeRequestPayload,
  BrowserBridgeResult,
  BrowserBridgeRoute,
  BrowserBridgeTransport,
  NexusSettingsSection,
  ResolveThemeRequest,
  PickAttachmentFilesResult,
  PickProjectFolderResult,
  ProviderMissingPrompt,
  SessionApplyAgentConfigEvent,
  SessionTabsChangedEvent,
  WindowDragRect,
} from '../bridge/browserBridgeProtocol'
import { createBridgeRoute } from '../bridge/browserBridgeProtocol'
import {
  raiseDesktopAlert,
  type DesktopAlert,
  type NotificationSink,
} from '../../notifications/desktopNotify'
import { randomUuid } from '../../utils/randomUuid'

function createRequestId(): string {
  return randomUuid()
}

/**
 * A bridge call the host answered with `ok: false`. `message` keeps the `<code>: <detail>` shape; a UI
 * that renders the failure switches on `code` to a catalog key, since neither field is user-visible text.
 */
export class BridgeRequestError extends Error {
  readonly code: string
  readonly detail: string

  constructor(code: string, detail: string) {
    super(`${code}: ${detail}`)
    this.name = 'BridgeRequestError'
    this.code = code
    this.detail = detail
  }
}

async function requestHostBridge<
  C extends BrowserBridgeCapability,
  A extends BrowserBridgeAction<C>,
>(
  transport: BrowserBridgeTransport,
  route: BrowserBridgeRoute<C, A>,
  payload: BrowserBridgeRequestPayload<C, A>,
): Promise<BrowserBridgeResult<C, A>> {
  const response = await transport.request({
    id: createRequestId(),
    route,
    payload,
  }) as { ok: true; result: BrowserBridgeResult<C, A> } | {
    ok: false
    error: { code: string; message: string }
  }

  if (!response.ok) {
    throw new BridgeRequestError(response.error.code, response.error.message)
  }

  return response.result
}

// --- search (span-index transcript search, the Ctrl+K dialog) --------------

export function queryTranscriptSearch(
  transport: BrowserBridgeTransport,
  payload: {
    targets: string[]
    query: string
    regex?: boolean
    caseSensitive?: boolean
    maxResults?: number
    generation: number
  },
) {
  return requestHostBridge(
    transport,
    createBridgeRoute('search', 'queryTranscripts'),
    payload,
  )
}

// --- sqlite (read/write host SQLite files over the direct bridge) ----------
// Each takes exactly one of `path` (one-shot) or `handle` (an open
// connection from sqliteOpen). See bridge/protocol/sqlite.ts.

export function sqliteQuery(
  transport: BrowserBridgeTransport,
  payload: BrowserBridgeRequestPayload<'sqlite', 'query'>,
) {
  return requestHostBridge(transport, createBridgeRoute('sqlite', 'query'), payload)
}

export function sqliteExecute(
  transport: BrowserBridgeTransport,
  payload: BrowserBridgeRequestPayload<'sqlite', 'execute'>,
) {
  return requestHostBridge(
    transport,
    createBridgeRoute('sqlite', 'execute'),
    payload,
  )
}

export function sqliteBatch(
  transport: BrowserBridgeTransport,
  payload: BrowserBridgeRequestPayload<'sqlite', 'batch'>,
) {
  return requestHostBridge(transport, createBridgeRoute('sqlite', 'batch'), payload)
}

export function sqliteOpen(
  transport: BrowserBridgeTransport,
  payload: BrowserBridgeRequestPayload<'sqlite', 'open'>,
) {
  return requestHostBridge(transport, createBridgeRoute('sqlite', 'open'), payload)
}

export function sqliteClose(
  transport: BrowserBridgeTransport,
  handle: string,
) {
  return requestHostBridge(transport, createBridgeRoute('sqlite', 'close'), {
    handle,
  })
}

export async function openNexusSettings(
  transport: BrowserBridgeTransport,
  section: NexusSettingsSection = 'models',
): Promise<void> {
  await requestHostBridge(
    transport,
    createBridgeRoute('ui', 'openNexusSettings'),
    { section },
  )
}

// --- systemPrefs (browser-global prefs for the React System section) -------

export function getSystemPrefs(transport: BrowserBridgeTransport) {
  return requestHostBridge(
    transport,
    createBridgeRoute('systemPrefs', 'get'),
    {},
  )
}

export function setBackgroundModeEnabled(
  transport: BrowserBridgeTransport,
  enabled: boolean,
) {
  return requestHostBridge(
    transport,
    createBridgeRoute('systemPrefs', 'setBackgroundMode'),
    { enabled },
  )
}

/**
 * Alias of `setBackgroundModeEnabled` on hosts since the System toggles were
 * merged; the UI still writes it so the one toggle also drives
 * the tray on an older host, where only this route did.
 */
export function setLauncherEnabled(
  transport: BrowserBridgeTransport,
  enabled: boolean,
) {
  return requestHostBridge(
    transport,
    createBridgeRoute('systemPrefs', 'setLauncher'),
    { enabled },
  )
}

// --- appearance (per-client theme resolver + host UI language) -------------
//
// The theme itself is per-client now: scheme/seed/variant live in this
// client's localStorage, and `resolveTheme` asks the host to run THAT triple
// through Chrome's colour pipeline without writing any pref. The host replies
// with the resolved colour roles, which the guest applies through the same
// `hostTheme.ts` path the old broadcast used. Only the UI language is still
// a host pref (the next-launch locale of THIS binary).

export function getAppearance(transport: BrowserBridgeTransport) {
  return requestHostBridge(
    transport,
    createBridgeRoute('appearance', 'getAppearance'),
    {},
  )
}

/**
 * Resolve the caller's (scheme, seed, variant) to colour roles. Never writes
 * a pref; never repaints another client. Rejects `unknown_route` on a binary
 * without the route — the caller degrades to the classic palette.
 */
export function resolveTheme(
  transport: BrowserBridgeTransport,
  payload: ResolveThemeRequest,
) {
  return requestHostBridge(
    transport,
    createBridgeRoute('appearance', 'resolveTheme'),
    payload,
  )
}

/** Takes effect on the next launch — pair with `relaunchApp`. */
export function setUiLocale(
  transport: BrowserBridgeTransport,
  locale: string,
) {
  return requestHostBridge(
    transport,
    createBridgeRoute('appearance', 'setUiLocale'),
    { locale },
  )
}

// --- appInfo (version + webapp URL for the React About section) ------------

export function getVersionInfo(transport: BrowserBridgeTransport) {
  return requestHostBridge(
    transport,
    createBridgeRoute('appInfo', 'getVersionInfo'),
    {},
  )
}

export function getWebappUrl(transport: BrowserBridgeTransport) {
  return requestHostBridge(
    transport,
    createBridgeRoute('appInfo', 'getWebappUrl'),
    {},
  )
}

export function setWebappUrl(
  transport: BrowserBridgeTransport,
  url: string,
) {
  return requestHostBridge(
    transport,
    createBridgeRoute('appInfo', 'setWebappUrl'),
    { url },
  )
}

/**
 * Restart the client. The host tears the guest down immediately after
 * replying, so a resolved promise means "the restart is under way" and is not
 * worth waiting on; a REJECTION is the informative case — a host older than
 * this route answers `NOT_IMPLEMENTED`, and the caller has to say so rather
 * than leaving a button that silently did nothing.
 */
export function relaunchApp(transport: BrowserBridgeTransport) {
  return requestHostBridge(
    transport,
    createBridgeRoute('appInfo', 'relaunch'),
    {},
  )
}

// --- browserTools (Tools · Browser settings) -------------------------------

export function browserToolsSnapshot(transport: BrowserBridgeTransport) {
  return requestHostBridge(
    transport,
    createBridgeRoute('browserTools', 'snapshot'),
    {},
  )
}

export function browserToolsSetField(
  transport: BrowserBridgeTransport,
  patch: { separateWindow?: boolean | null },
) {
  return requestHostBridge(
    transport,
    createBridgeRoute('browserTools', 'setField'),
    { patch },
  )
}

// --- providerAuth (Models-page network/keychain probes) --------------------

/**
 * The provider registry (id/name/authMode/type/OAuth-state). The Models page
 * uses this for field-gating + the OAuth branch — the bits settings.json
 * doesn't carry.
 */
export function providerAuthList(transport: BrowserBridgeTransport) {
  return requestHostBridge(
    transport,
    createBridgeRoute('providerAuth', 'list'),
    {},
  )
}

/**
 * Read-only transient verify probe. `updates` carries snake_case overlay fields
 * (api_key, base_url) combined over the stored config for THIS probe only — no
 * pref writes. On success the caller persists via the worker `providers.upsert`.
 * `keyProviderId` names a saved record whose stored key the host uses when
 * `updates.api_key` is empty (the key never reaches the WebUI).
 */
export function providerAuthVerify(
  transport: BrowserBridgeTransport,
  providerId: string,
  updates: Record<string, unknown>,
  keyProviderId?: string,
) {
  return requestHostBridge(
    transport,
    createBridgeRoute('providerAuth', 'verify'),
    keyProviderId
      ? { providerId, updates, keyProviderId }
      : { providerId, updates },
  )
}

export function providerAuthReset(
  transport: BrowserBridgeTransport,
  providerId: string,
) {
  return requestHostBridge(
    transport,
    createBridgeRoute('providerAuth', 'reset'),
    { providerId },
  )
}

/**
 * Refresh the model list for a provider. Returns the endpoint's current
 * model catalogue. Used as a fallback when `verify` returns `modelCount`
 * but the bridge schema strips the `models` array from the verify result.
 */
export function providerAuthRefresh(
  transport: BrowserBridgeTransport,
  providerId: string,
) {
  return requestHostBridge(
    transport,
    createBridgeRoute('providerAuth', 'refresh'),
    { providerId },
  )
}

/** Start the OAuth device-code / PKCE flow for an OAuth provider. */
export function providerAuthBeginOAuth(
  transport: BrowserBridgeTransport,
  providerId: string,
) {
  return requestHostBridge(
    transport,
    createBridgeRoute('providerAuth', 'beginOAuth'),
    { providerId },
  )
}

/** Poll the OAuth connection state (connected + account email). */
export function providerAuthOAuthStatus(
  transport: BrowserBridgeTransport,
  providerId: string,
) {
  return requestHostBridge(
    transport,
    createBridgeRoute('providerAuth', 'oauthStatus'),
    { providerId },
  )
}

/**
 * Open the native folder picker for a `code` session's project folder. Resolves with the absolute path
 * (`null` when canceled) and a `canceled` flag. Chromium host only; callers gate on host capability.
 */
export async function pickProjectFolder(
  transport: BrowserBridgeTransport,
  title?: string,
): Promise<PickProjectFolderResult> {
  return requestHostBridge(
    transport,
    createBridgeRoute('ui', 'pickProjectFolder'),
    title ? { title } : {},
  )
}

/**
 * Open the native multi-file picker for composer attachments (the guest cannot raise its own file
 * chooser). Resolves with absolute paths (empty when canceled) and a `canceled` flag; `extensions` is a
 * filter hint. Chromium host only; callers gate on host capability.
 */
export async function pickAttachmentFiles(
  transport: BrowserBridgeTransport,
  options?: { extensions?: readonly string[]; title?: string },
): Promise<PickAttachmentFilesResult> {
  const payload: { extensions?: string[]; title?: string } = {}
  if (options?.extensions && options.extensions.length > 0) {
    payload.extensions = [...options.extensions]
  }
  if (options?.title) {
    payload.title = options.title
  }
  return requestHostBridge(
    transport,
    createBridgeRoute('ui', 'pickAttachmentFiles'),
    payload,
  )
}

/**
 * Reveal a project folder in the native OS file manager (the chip's "Show in
 * Explorer" action). Chromium-host only; mock/dev hosts reject. Fire-and-forget
 * from the caller's view.
 */
export async function revealProjectFolder(
  transport: BrowserBridgeTransport,
  path: string,
): Promise<void> {
  await requestHostBridge(
    transport,
    createBridgeRoute('ui', 'revealProjectFolder'),
    { path },
  )
}

export async function getProviderMissingPrompt(
  transport: BrowserBridgeTransport,
): Promise<ProviderMissingPrompt> {
  return requestHostBridge(
    transport,
    createBridgeRoute('ui', 'getProviderMissingPrompt'),
    {},
  )
}

/**
 * Ask the host to open an in-conversation hyperlink in the browser
 * (a new tab in <main-contents-view>) rather than letting the click
 * navigate the nexus guest <webview> away. Called from the guest-side
 * capture-phase link interceptor in MultiSessionShell.
 */
export async function openUrl(
  transport: BrowserBridgeTransport,
  url: string,
): Promise<void> {
  await requestHostBridge(
    transport,
    createBridgeRoute('ui', 'openUrl'),
    { url },
  )
}

/**
 * Open a regular (non-agent) browser window — the topbar's "Open browser
 * window" button. Routes to the C++ `ui` adapter (`ui.openBrowserWindow`),
 * which replaces the Lit topbar's `BrowserApiProxy.openBrowserWindow()`.
 */
export async function openBrowserWindow(
  transport: BrowserBridgeTransport,
): Promise<void> {
  await requestHostBridge(
    transport,
    createBridgeRoute('ui', 'openBrowserWindow'),
    {},
  )
}

/**
 * Open Chrome's native languages settings page (chrome://settings/languages)
 * in a normal browser window — the Settings · General "Open language settings"
 * button. Routes to the C++ `ui` adapter (`ui.openLanguageSettings`), which
 * opens the fixed trusted URL via `OpenUrlInNormalWindow`. Chrome owns the
 * actual language list + restart-to-apply flow.
 */
export async function openLanguageSettings(
  transport: BrowserBridgeTransport,
): Promise<void> {
  await requestHostBridge(
    transport,
    createBridgeRoute('ui', 'openLanguageSettings'),
    {},
  )
}

/**
 * Report the active session's display title (no product suffix) so the host
 * can set the kNexus window's NATIVE title — taskbar / alt-tab / a11y, which
 * `document.title` inside the <webview> can never reach. The host composes
 * the final "{title} - {product}" string and sanitizes; empty string clears
 * back to the bare product name. Fire-and-forget; sent on boot + every
 * active-title change (switch / rename / auto-title).
 */
export async function setActiveSessionTitle(
  transport: BrowserBridgeTransport,
  title: string,
): Promise<void> {
  await requestHostBridge(
    transport,
    createBridgeRoute('ui', 'setActiveSessionTitle'),
    { title },
  )
}

/**
 * Report the topbar's OS window-drag map to the host so the frameless window
 * can be dragged from the React topbar (which is in the <webview>, where
 * `-webkit-app-region` can't reach the host frame). See {@link WindowDragRect}.
 * Fire-and-forget; called frequently (mount + every relayout), so callers
 * should debounce.
 */
export async function setWindowDragRegions(
  transport: BrowserBridgeTransport,
  regions: WindowDragRect[],
): Promise<void> {
  await requestHostBridge(
    transport,
    createBridgeRoute('ui', 'setWindowDragRegions'),
    { regions },
  )
}

/**
 * Set once `ui.showNotification` answers with an unknown-route error, so an old host stops collecting
 * unanswered requests; the same policy as the worker's `uiShowNotificationDisabled`.
 */
let uiShowNotificationDisabled = false

/** Test seam: clears the unknown-route latch. */
export function __resetHostNotificationForTest(): void {
  uiShowNotificationDisabled = false
}

/**
 * The shell's {@link NotificationSink} — the dispatch mechanism
 * `notifications/desktopNotify.ts` injects, here bound to the host bridge.
 *
 * Never rejects and never throws, which is the sink contract: a missing route
 * or a downed transport must not break a render.
 */
function hostNotificationSink(
  transport: BrowserBridgeTransport,
): NotificationSink {
  return async opts => {
    const ok = { ok: true } as const
    if (uiShowNotificationDisabled) return ok
    try {
      await requestHostBridge(
        transport,
        createBridgeRoute('ui', 'showNotification'),
        {
          message: opts.message,
          ...(opts.title !== undefined ? { title: opts.title } : {}),
          notificationType: opts.notificationType,
        },
      )
    } catch (error) {
      if (
        error instanceof BridgeRequestError &&
        ['unknown_route', 'unsupported_route', 'route_not_found'].includes(
          error.code,
        )
      ) {
        uiShowNotificationDisabled = true
      }
      // Any other failure (transport down mid-flight) is per-call and ignored.
    }
    return ok
  }
}

/**
 * Show a native OS notification through the host's `ui.showNotification` route, via the shared
 * `raiseDesktopAlert` policy. The host suppresses it while the Velloc window is active. Fire-and-forget.
 */
export async function showHostNotification(
  transport: BrowserBridgeTransport,
  notification: DesktopAlert,
): Promise<void> {
  await raiseDesktopAlert(notification, hostNotificationSink(transport))
}

export type BootTimings = {
  nexusViewContainerFirstCreatedMs: number
  loadInitialUrlReturnedMs: number
  glicNavigationCommittedMs: number
  bridgeRespondedMs: number
}

/**
 * Boot instrumentation. Fetches wall-clock millisecond timestamps
 * captured by the C++ side during boot — used to attribute the pre-React
 * phase (chrome://glic load, inner webview spawn, React bundle fetch).
 * Caller should also record `Date.now()` immediately before invoking, so
 * the bridge round-trip cost can be subtracted.
 */
export async function getBootTimings(
  transport: BrowserBridgeTransport,
): Promise<BootTimings> {
  return requestHostBridge(
    transport,
    createBridgeRoute('ui', 'getBootTimings'),
    {},
  )
}

// Retired: `subscribeApplySelection`. Model picks now ride the unified
// `session.applyAgentConfig` channel (the `model` key), handled by
// `subscribeAgentConfig` below. The C++ side may still emit a legacy
// `session.applySelection` event, but no guest code subscribes to it.

/**
 * Subscribe to host-pushed `session.applyAgentConfig` events. The C++ side
 * fires these whenever the `nexus.agent_config` pref changes. The generic
 * payload carries the whole config dict; the handler forwards it to the
 * worker, which applies the keys it recognizes. This is the fixed transport
 * for all agent runtime settings — adding a setting never touches it.
 */
export function subscribeAgentConfig(
  transport: BrowserBridgeTransport,
  handler: (event: SessionApplyAgentConfigEvent) => void,
): BridgeEventUnsubscribe {
  if (!transport.subscribeEvents) {
    return () => {}
  }
  return transport.subscribeEvents((envelope: BridgeEventEnvelope) => {
    const capability = (envelope.route as { capability: string }).capability
    const action = (envelope.route as { action: string }).action
    if (capability === 'session' && action === 'applyAgentConfig') {
      handler(envelope.payload as SessionApplyAgentConfigEvent)
    }
  })
}

/**
 * Report the active chat session to the host (at boot and on every switch). The host activates one of
 * the session's tabs and returns its tab counts; a host without the handler rejects with not-found, which
 * the caller treats as "no tabs".
 */
export async function setSessionActive(
  transport: BrowserBridgeTransport,
  sessionId: string,
): Promise<{
  ok: true
  activated: boolean
  nexusTabCount: number
  totalTabCount: number
}> {
  return requestHostBridge(
    transport,
    createBridgeRoute('session', 'setActiveSession'),
    { sessionId },
  )
}

/**
 * Subscribe to host-pushed `browser.sessionTabsChanged` events — fired by
 * the C++ NexusSessionTabTracker observer whenever a session's tab counts
 * change (first tab from a browser tool, tab closed, tab dragged between
 * windows, session deleted). Keeps the shell's per-session webview_area
 * visibility live between `setSessionActive` round-trips.
 */
export function subscribeSessionTabsChanged(
  transport: BrowserBridgeTransport,
  handler: (event: SessionTabsChangedEvent) => void,
): BridgeEventUnsubscribe {
  if (!transport.subscribeEvents) {
    return () => {}
  }
  return transport.subscribeEvents((envelope: BridgeEventEnvelope) => {
    const capability = (envelope.route as { capability: string }).capability
    const action = (envelope.route as { action: string }).action
    if (capability === 'browser' && action === 'sessionTabsChanged') {
      handler(envelope.payload as SessionTabsChangedEvent)
    }
  })
}
