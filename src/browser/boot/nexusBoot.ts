import { getProductName } from '../../branding/productName'
import { RUNTIME_DIR_NAME } from '../../branding/runtimeDir'
import { getBuildTime } from '../../branding/buildInfo'
// The PURE i18n core, not `../webview/i18n` — that one pulls in React, and
// this module runs before the React chunk is even imported.
import {
  createTranslate,
  ensureCatalog,
  readLocaleAssetMap,
  resolveLocale,
  resolveLocaleAssetUrl,
} from '../webview/i18n/translate'
import { localizeRuntimeNotification } from '../webview/i18n/modNotification'
import type { BrowserBridgeTransport } from '../bridge/browserBridgeProtocol'
import {
  createBridgeRoute,
  normalizeBrowserHostManifest,
} from '../bridge/browserBridgeProtocol'
import { DirectPortBridgeTransport } from '../bridge/DirectPortBridgeTransport'
import type { HostShells } from '../../toolkit/builtin/host'
import { createNativePrimitives, type NativePrimitives } from '../bridge/nativePrimitives'
import {
  installBridgeTracerIfEnabled,
  installRuntimeHostTracerIfEnabled,
  isBridgeTraceEnabled,
} from '../bridge/tracer'
import {
  combineTracerSignals,
  loadAgentTracerFlags,
  resolveTracerFlagsWithinBudget,
} from './loadAgentTracerFlags'
import {
  BrowserRuntimeClient,
  createBrowserRuntimeSharedWorker,
  type BrowserWorkerClientTransport,
} from '../webview/BrowserRuntimeClient'
import {
  connectRuntimeOverSharedWorker,
  createHostBridgeTransportOverConnection,
  createRuntimeFileAccess,
  createSessionListChannel,
  createSessionStatusChannel,
  createSettingsBridgeOverConnection,
  createShellChannel,
  subscribeRuntimeNotifications,
  createWorkerTransportOverConnection,
  type RuntimeConnection,
  type RuntimeFileAccess,
  type SessionListChannel,
  type SessionStatusChannel,
  type SettingsBridge,
  type ShellChannel,
} from '../runtimeClient'
import type { AgentRuntimeWorkerInitPayload } from '../worker/workerProtocol'
import { attachWorkspaceStore } from '../webview/workspaceStore'
import { attachProviderLoginStore } from '../webview/providerLoginStore'
import { attachProviderUsageStore } from '../webview/providerUsageStore'
import { showHostNotification } from '../webview/nexusBridgeActions'
import { notificationIsForPanel, type RuntimeNotification } from '../runtimeProtocol'
import { hostEnvironmentOf } from '../runtimeHub/sessionSurface'
import { DEFAULT_PANEL_ID } from '../runtimeHub/shellCapability'
import { installPerClientTheme } from './perClientTheme'
import { isTrustedHostOrigin } from './hostTheme'
import { migrateAppearanceFromHostPrefs } from './appearanceMigration'
import { renderShell } from './renderShell'
import { createRuntimeConnections } from './runtimeConnections'
import { installUpdateRestartGate } from './updateRestartGate'
import { holdRuntimeKeepAliveLock } from './runtimeKeepAlive'
import { fetchManagedBinaryRegistry } from '../../utils/binaryRegistry'
import { isTraceLogUrlFlagEnabled } from '../../utils/traceLogGate'
import type {
  AgentLoopSettings,
  MessageCompactionSettings,
} from '../../config/agentLoopConfig'

/**
 * e2e-only URL overrides for the agent-loop tunables (`e2eAutoCompactTokens`, `e2eCompactEnabled`),
 * read only behind `isBridgeTraceEnabled()`. `undefined` when off or unset.
 */
function readE2eAgentLoopOverridesFromUrl():
  | Partial<AgentLoopSettings>
  | undefined {
  if (!isBridgeTraceEnabled()) return undefined
  let params: URLSearchParams
  try {
    params = new URLSearchParams(globalThis.location?.search ?? '')
  } catch {
    return undefined
  }
  const compactionFields: Partial<MessageCompactionSettings> = {}
  const tt = params.get('e2eAutoCompactTokens')
  if (tt !== null) {
    const n = parseInt(tt, 10)
    if (Number.isFinite(n) && n > 0) {
      compactionFields.autoCompactTokenThreshold = n
    }
  }
  const ena = params.get('e2eCompactEnabled')
  if (ena !== null) {
    compactionFields.enabled = ena === '1'
  }
  if (Object.keys(compactionFields).length === 0) return undefined
  // The merger in QueryEngine deep-merges the messageCompaction
  // sub-object, so a partial here lands as expected.
  return {
    messageCompaction: compactionFields as MessageCompactionSettings,
  }
}

function nexusTrace(message: string, details?: unknown): void {
  // Boot narration is opt-in: without a debug URL flag these lines are
  // pure DevTools noise for every session. Same gate as the rest of the
  // trace plumbing (`?log=1` / `?trace=1` / `?traceModelRequests=1`).
  if (!isTraceLogUrlFlagEnabled()) {
    return
  }
  if (details === undefined) {
    console.info(`[NexusTrace][GuestBoot] ${message}`)
    return
  }

  console.info(`[NexusTrace][GuestBoot] ${message}`, details)
}

/**
 * Boot milestones the guest reports to the boot-welcome overlay after the host's `loading` stage, each
 * when it happens: `rendering`, `sessions`, `opening`, `finalizing`. Mirrored by the host's `LoadingStage`.
 */
export type GuestBootStage = 'rendering' | 'sessions' | 'opening' | 'finalizing'

/**
 * Wait for the host's 'nexus-init'; its `event.source` is the only route to the embedder's window.
 * Security: only a trusted WebUI origin is believed, since every later check compares against it.
 */
function waitForNexusHostInit(): Promise<{
  hostWindow: WindowProxy
  hostOrigin: string
  /** Which panel hosts this guest, when the host says (ignore-if-absent). */
  panelId?: string
}> {
  return new Promise((resolve) => {
    const handler = (event: MessageEvent) => {
      const data = event.data as Record<string, unknown> | null
      if (data?.type === 'nexus-init' && data?.nexus === true && event.source) {
        if (!isTrustedHostOrigin(event.origin)) {
          nexusTrace('ignored nexus-init from an untrusted origin', { origin: event.origin })
          return
        }
        nexusTrace('received nexus-init', { origin: event.origin })
        globalThis.removeEventListener('message', handler)
        try {
          ;(event.source as WindowProxy).postMessage(
            { type: 'nexus-init-ack' },
            event.origin,
          )
          nexusTrace('sent nexus-init-ack', { origin: event.origin })
        } catch (_e) { /* ignore */ }
        const panelId = typeof data['panelId'] === 'string' ? data['panelId'] : undefined
        resolve({
          hostWindow: event.source as WindowProxy,
          hostOrigin: event.origin,
          ...(panelId ? { panelId } : {}),
        })
      }
    }
    globalThis.addEventListener('message', handler)
  })
}

function waitForNexusBridgeBootstrap(
  hostWindow: WindowProxy,
  hostOrigin: string,
): Promise<{
  pagePort: MessagePort
  workerPort: MessagePort
  hostManifest: ReturnType<typeof normalizeBrowserHostManifest>
}> {
  return new Promise((resolve) => {
    const handler = (event: MessageEvent) => {
      const data = event.data as Record<string, unknown> | null
      if (
        event.source !== hostWindow ||
        event.origin !== hostOrigin ||
        data?.type !== 'nexus-bridge-bootstrap' ||
        data?.nexus !== true ||
        !event.ports ||
        event.ports.length < 2
      ) {
        return
      }

      globalThis.removeEventListener('message', handler)
      nexusTrace('received nexus bridge bootstrap', {
        origin: event.origin,
        portCount: event.ports.length,
      })
      const manifest =
        data?.manifest && typeof data.manifest === 'object'
          ? (data.manifest as { capabilities?: unknown })
          : undefined
      resolve({
        pagePort: event.ports[0],
        workerPort: event.ports[1],
        hostManifest: normalizeBrowserHostManifest(data?.manifest),
      })
    }

    globalThis.addEventListener('message', handler)
  })
}

export type NexusBootOptions = {
  requestTimeoutMs?: number
  initPayload?: Partial<AgentRuntimeWorkerInitPayload>
  createWorkerTransport?: () => BrowserWorkerClientTransport
  onReady?: (ctx: NexusBootContext) => void
}

type PreparedNexusBootContext = {
  /** The page's host calls — over the runtime connection. */
  transport: BrowserBridgeTransport
  /** The page's file access — `fsx` on the runtime connection. */
  files: RuntimeFileAccess
  /** Session list + task traffic on the runtime connection. */
  sessionChannel: SessionListChannel
  /** One session's status (topbar pill, composer gate). */
  sessionStatusChannel: SessionStatusChannel
  /** The settings capabilities, on the connection instead of a WebUI port. */
  settingsBridge: SettingsBridge
  /** The window chrome around this guest (`shell.*`). */
  shellChannel: ShellChannel
  initPayload: AgentRuntimeWorkerInitPayload
  createWorkerTransport: () => BrowserWorkerClientTransport
  /**
   * The page's one runtime connection, opened lazily. The shell reads its
   * state (the reconnect banner) and its grant (`useCan`) from it; both
   * are inert on the desktop, where the connection is `full` and never
   * reconnects.
   */
  runtimeConnection: () => Promise<RuntimeConnection>
  /**
   * The page's own SharedWorker port — host-only. The remote path has none,
   * so this lives ONLY on the prepared context (not on renderShell's
   * RenderableBootContext); `MultiSessionShell`'s dead prop of the same name
   * was deleted in the same change.
   */
  sharedWorkerPort: MessagePort
  /** Captured from the `nexus-init` handshake. Used by
   *  `setupFeaturesHostBridge` to source-/origin-check requests from the
   *  outer Chromium WebUI settings page and to post responses back. */
  hostWindow: WindowProxy
  hostOrigin: string
}

export type NexusBootContext = PreparedNexusBootContext & {
  client: BrowserRuntimeClient | null
}

/**
 * A client the host serves no toasts for falls back to browser notifications, only when the user has
 * already allowed them (never prompting from a background event).
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

export const DEFAULT_NEXUS_RUNTIME_CWD = '.'
export const DEFAULT_NEXUS_SESSION_STORAGE_PATH = RUNTIME_DIR_NAME

// Env keys accepted as guest-URL query params (the guest has no OS env). `e2eTrace` and
// `e2eEnableExtractMemories` are test-only; production URLs never set them.
const QUERY_PARAM_ENV_KEYS = [
  // (The per-skill `defer<Skill>` deferral overrides were REMOVED — deferral is
  // template-only now, driven solely by each template.md's `deferredTools`.)
  // Per-session runtime provider specs (JSON {providerId: format | spec},
  // models/drivers/driverRegistry.ts). Tests and diagnostics; production
  // configures providers through the catalog's `wire`.
  'providerDrivers',
  'e2eTrace',
  'e2eEnableExtractMemories',
  // periodic tidy consolidation service: an init opt-in (mirrors
  // `e2eEnableExtractMemories`) plus threshold overrides so the dedicated spec
  // can fire the fork in a single turn. Production guest URLs never set these.
  'e2eEnablePeriodicTidy',
  'e2ePeriodicTidyMinSessions',
  'e2ePeriodicTidyMinHours',
  'e2eProviderMaxRetries',
  // Shrinks the JS-side stream-idle hold window (ms) so an e2e can reach the
  // host's hold verdicts (`timeout` / `queued`) in seconds instead of 90s.
  'e2eStreamIdleTimeoutMs',
] as const

// Read the allow-listed env keys from `location.search`. Empty when not
// in a browser context (worker/test). Caller-provided `initPayload.env`
// takes precedence over these (see buildGlicInitPayload).
function readEnvFromQueryParams(): Record<string, string> {
  const out: Record<string, string> = {}
  const search = globalThis.location?.search
  if (!search) {
    return out
  }
  const params = new URLSearchParams(search)
  for (const key of QUERY_PARAM_ENV_KEYS) {
    const value = params.get(key)
    if (value !== null && value !== '') {
      out[key] = value
    }
  }
  return out
}

/**
 * The BCP-47 tag the session runs in: the host/boot locale, else Chrome's.
 * Shared by the init payload and the boot-time catalog preload so the two can
 * never resolve to different languages.
 */
export function resolveBootLocaleTag(explicit?: string): string | undefined {
  return (
    explicit ??
    (typeof navigator !== 'undefined' ? navigator.language : undefined)
  )
}


/**
 * Start fetching the active locale's catalog early, from the URL map injected into index.html.
 * English is only the fallback and is fetched lazily.
 */
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
    // Fall back to English rather than rendering raw keys. Only reachable when
    // the active locale was never cached AND the network is unavailable.
    const enUrl = resolveLocaleAssetUrl('en', map)
    if (!enUrl) return
    await ensureCatalog('en', enUrl).catch(() => {
      // Nothing left to try — `t()` degrades to BOOTSTRAP_MESSAGES.
    })
  })
}

export function buildGlicInitPayload(options: {
  initPayload?: Partial<AgentRuntimeWorkerInitPayload>
  hostManifest?: ReturnType<typeof normalizeBrowserHostManifest> | null
}): AgentRuntimeWorkerInitPayload {
  return {
    cwd: options.initPayload?.cwd ?? DEFAULT_NEXUS_RUNTIME_CWD,
    // Per-session project-root override.
    // Pass-through only — no default: when absent, createBrowserRuntime
    // falls back to the shared `${cwd}/.velloc/shared-workspace/<type>/`
    // sandbox. A `code` session bound to a real folder supplies it so cwd
    // anchors to the real directory, while agent/chat keep the
    // per-type sandbox.
    projectRoot: options.initPayload?.projectRoot,
    sessionId: options.initPayload?.sessionId,
    sessionStoragePath:
      options.initPayload?.sessionStoragePath ??
      DEFAULT_NEXUS_SESSION_STORAGE_PATH,
    hostMode: options.initPayload?.hostMode ?? 'nexus',
    runtimeName: options.initPayload?.runtimeName ?? 'chromium-runtime-glic',
    locale: resolveBootLocaleTag(options.initPayload?.locale),
    // Where the worker can fetch the ENGLISH catalog. The worker renders the
    // model-facing text of slash output (system messages ride into the LLM
    // request as role:"system"), which is protocol and stays English; display
    // translation happens in the webview. See i18n/translate.ts.
    enCatalogUrl: resolveLocaleAssetUrl('en', readLocaleAssetMap()),
    timezone:
      options.initPayload?.timezone ??
      (typeof Intl !== 'undefined'
        ? Intl.DateTimeFormat().resolvedOptions().timeZone
        : undefined),
    userAgent:
      options.initPayload?.userAgent ??
      (typeof navigator !== 'undefined' ? navigator.userAgent : undefined),
    // URL-param env keys (e.g. toolDeferral) merged under
    // any caller-provided env — explicit initPayload.env (test
    // harnesses, embedders) still wins.
    env: { ...readEnvFromQueryParams(), ...(options.initPayload?.env ?? {}) },
    customSystemPrompt: options.initPayload?.customSystemPrompt,
    appendSystemPrompt: options.initPayload?.appendSystemPrompt,
    // Per-session agent-template type. Caller-provided wins; else the guest
    // URL `?templateType=` (how e2e + embedders select a type); else undefined
    // → createBrowserRuntime defaults to 'agent'.
    templateType:
      options.initPayload?.templateType ?? readTemplateTypeFromUrl(),
    userSpecifiedProviderId: options.initPayload?.userSpecifiedProviderId,
    userSpecifiedModel: options.initPayload?.userSpecifiedModel,
    userSpecifiedThinkingTier:
      options.initPayload?.userSpecifiedThinkingTier,
    fallbackModel: options.initPayload?.fallbackModel,
    maxTurns: options.initPayload?.maxTurns,
    maxBudgetUsd: options.initPayload?.maxBudgetUsd,
    taskBudget: options.initPayload?.taskBudget,
    // Caller-provided agentLoopSettings (e.g. test harness) take
    // precedence; otherwise we fall back to the URL-param overrides
    // (e2e-only). Production callers leave both undefined so
    // QueryEngine's `mergeAgentLoopSettings(undefined)` returns the
    // documented defaults.
    agentLoopSettings:
      options.initPayload?.agentLoopSettings ??
      readE2eAgentLoopOverridesFromUrl(),
    // Diagnostic flag — when the guest URL carries `?logCallModel=1`,
    // tell the worker to enable `[NexusCallModelTrace]` logging in
    // its `engine/turn/callModelTrace.ts` consumer. Off in production.
    logCallModel:
      options.initPayload?.logCallModel ??
      readLogCallModelFlagFromUrl(),
    // Model-upload trace gate (the request payload + messages[] sent
    // to the model on every call). Opt-in only, via `?log=1` /
    // `?trace=1` / `?traceModelRequests=1` (settings.json flags are
    // ORed in later by `resolveWorkerTraceFlags`).
    // Off-by-default in production is load-bearing: the payload is
    // megabytes for large transcripts.
    traceModelRequests:
      options.initPayload?.traceModelRequests ??
      shouldEnableModelUploadTrace(),
    toolPreset:
      options.initPayload?.toolPreset ??
      (options.hostManifest ? undefined : 'nexus'),
    hostManifest: options.hostManifest ?? undefined,
    // Boot snapshot of the unified agent runtime config. Passed through
    // verbatim; the worker applies it once after building the runtime via
    // engine.applyRuntimeSettings. Live changes arrive via the
    // `session.applyAgentConfig` bridge event.
    runtimeSettings:
      options.initPayload?.runtimeSettings ??
      options.hostManifest?.agentConfig,
  }
}

/**
 * Read `?templateType=<type>` from the guest URL (e.g. `chat`/`code`;
 * `agent` is the default so it needn't be named — the live set is
 * agent/chat/code). Returns `undefined` when
 * absent so the payload stays clean and the runtime default applies. An unknown
 * type resolves to no template ⇒ the full discovered tool set (safe fallback).
 */
function readTemplateTypeFromUrl(): string | undefined {
  try {
    const params = new URLSearchParams(globalThis.location?.search ?? '')
    const v = params.get('templateType')?.trim()
    return v ? v : undefined
  } catch {
    return undefined
  }
}

/**
 * Read `?rtScope=manager|control|observe` from the guest URL: the scope ceiling
 * the page asks its own runtime for (`hello.scopeCeiling`). A dev / e2e knob —
 * `NEXUS_E2E_SCOPE` sets it — that makes every host route the UI reaches for
 * pass the hub's scope table as a remote client would. These are the sub-`full`
 * rungs of `SCOPE_MODES`; a rung missing here is silently dropped. Absent,
 * `full`, or any other value ⇒ no ceiling (the desktop's `full`).
 */
export function readRuntimeScopeCeilingFromUrl(): 'manager' | 'control' | 'observe' | undefined {
  try {
    const params = new URLSearchParams(globalThis.location?.search ?? '')
    const v = params.get('rtScope')
    return v === 'manager' || v === 'control' || v === 'observe' ? v : undefined
  } catch {
    return undefined
  }
}
/**
 * Read `?rtDevRelay=<ws-url>&rtDevRelayToken=<token>` from the guest URL: the
 * dev / e2e knob that points the runtime's relay dialer at a Node dev relay
 * (`scripts/dev_remote_relay.mjs`) instead of
 * the in-process listener. Absent on any production URL. The token travels in the
 * query string because this is a DEVELOPMENT credential only — a real pairing
 * secret never touches the query (remotePairing.ts).
 */
export type DevRelayParams = { controlUrl: string; token: string }
export function readDevRelayFromUrl(): DevRelayParams | null {
  try {
    const params = new URLSearchParams(globalThis.location?.search ?? '')
    const controlUrl = params.get('rtDevRelay')
    const token = params.get('rtDevRelayToken')
    if (!controlUrl || !token) return null
    return { controlUrl, token }
  } catch {
    return null
  }
}


/**
 * Read `?logCallModel=1` from the guest URL. Returns `undefined` if
 * the param is absent so `buildGlicInitPayload` can elide the field
 * entirely (production payload stays clean).
 */
function readLogCallModelFlagFromUrl(): boolean | undefined {
  try {
    const params = new URLSearchParams(globalThis.location?.search ?? '')
    const v = params.get('logCallModel')
    if (v === null) return undefined
    return v === '1' || v === 'true'
  } catch {
    return undefined
  }
}

/**
 * Whether the model-upload trace plumbing runs: opt-in only (`?trace=1`, `?log=1`,
 * `?traceModelRequests=1`, or the settings flags upstream). DEV builds are not force-enabled.
 */
export function shouldEnableModelUploadTrace(): boolean {
  // Same flag set as the boot-narration console gate — one URL opt-in
  // drives both the payload capture and the diagnostic logging.
  return isTraceLogUrlFlagEnabled()
}

/**
 * Worker-realm trace gates from the URL flags plus the persisted settings: `logCallModel` from
 * `agent.log` only; `traceModelRequests` from either toggle (`enableBus`).
 */
export function resolveWorkerTraceFlags(
  fromUrl: { logCallModel?: boolean; traceModelRequests?: boolean },
  settings: { log: boolean; trace: boolean },
  tracerDecision: { enableBus: boolean },
): { logCallModel: boolean; traceModelRequests: boolean } {
  return {
    logCallModel: (fromUrl.logCallModel ?? false) || settings.log,
    traceModelRequests:
      (fromUrl.traceModelRequests ?? false) || tracerDecision.enableBus,
  }
}

async function prepareNexusBoot(
  options: NexusBootOptions = {},
): Promise<PreparedNexusBootContext> {
  nexusTrace('nexusBoot start', {
    href: globalThis.location?.href,
  })

  // The host tool definitions are a large module the entry chunk does not
  // need until the manifest arrives; loading starts here so it overlaps the
  // host handshake. The detached catch keeps an unused failure from becoming
  // an unhandled rejection; the await below still sees it.
  const hostToolsModule = import('../../toolkit/builtin/host')
  hostToolsModule.catch(() => {})

  const { hostWindow, hostOrigin, panelId } = await waitForNexusHostInit()
  nexusTrace('host init resolved', { hostOrigin, panelId: panelId ?? '(default)' })

  const {
    pagePort,
    workerPort,
    hostManifest: bootstrapManifest,
  } = await waitForNexusBridgeBootstrap(hostWindow, hostOrigin)
  nexusTrace('bridge bootstrap resolved', {
    hostOrigin,
    hasPagePort: !!pagePort,
    hasWorkerPort: !!workerPort,
  })

  const hostManifest = options.initPayload?.hostManifest ?? bootstrapManifest

  // The direct SharedWorker port is the sole bridge transport now. Both
  // tool dispatch (`browser.callTool`) and host-pushed events
  // (`session.applySelection` etc.) flow through it.
  const transport = new DirectPortBridgeTransport({
    port: pagePort,
    requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
  })

  installBridgeTracerIfEnabled({ direct: transport })
  installNativePrimitivesTestHookIfEnabled(transport, hostManifest ?? undefined)

  // The host tools are the runtime's own definitions (toolkit/builtin/host).
  // The host only says which families it serves (`capabilities`: files /
  // exec / browser) and which shells it can run (`exec.listShells`); the
  // tool list, the skill that goes with the browser tools, and the text the
  // model reads are decided here.
  let hostedTools = hostManifest?.hostedTools ?? []
  if (hostManifest) {
    const { hostedSkillsForHost, hostedToolsForHost } = await hostToolsModule
    let shells: HostShells | undefined
    if (hostManifest.capabilities.includes('exec')) {
      try {
        const response = await transport.request({
          id: `boot-list-shells-${Date.now().toString(36)}`,
          route: createBridgeRoute('exec', 'listShells'),
          payload: {},
        })
        if (response.ok) {
          shells = response.result
        } else {
          nexusTrace('exec.listShells returned error', response.error)
        }
      } catch (error) {
        nexusTrace('exec.listShells dispatch failed', {
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }
    hostedTools = hostedToolsForHost(hostManifest.capabilities, shells)
    hostManifest.hostedTools = hostedTools
    // `toolNames` is derived from `hostedTools` by the manifest normalizer;
    // keep it consistent for the consumers that read it (the registry's
    // `toolNames` fallback path, slash-command pickers).
    hostManifest.toolNames = hostedTools.map(tool => tool.name)
    const hostedSkills = hostedSkillsForHost(hostedTools)
    hostManifest.hostedSkills = hostedSkills.length > 0 ? hostedSkills : undefined
  }

  // Publish the managed-binary registry BEFORE the SharedWorker can process the
  // first user turn. The worker also publishes this as a reconnect/fallback path,
  // but doing it only fire-and-forget in the worker lets a first-turn `Grep`
  // race ahead and trigger the host's compiled-in registry. E2e overrides
  // `/managed-binaries.json` to a local fake `/rg.tgz`, so this ordering is the
  // difference between deterministic fake-server fetches and intermittent
  // fallback downloads.
  try {
    const registry = await fetchManagedBinaryRegistry()
    if (registry) {
      await transport.request({
        id: `boot-publish-binary-registry-${Date.now().toString(36)}`,
        route: createBridgeRoute('model', 'publishBinaryRegistry'),
        payload: registry,
      })
    }
  } catch (error) {
    nexusTrace('model.publishBinaryRegistry failed', {
      message: error instanceof Error ? error.message : String(error),
    })
  }

  if (isTraceLogUrlFlagEnabled()) {
    console.info('[HostedToolsGuest] bootstrap manifest', {
      capabilities: hostManifest?.capabilities ?? [],
      toolCount: hostedTools.length,
      toolNames: hostedTools.map(tool => tool.name),
      skillNames: (hostManifest?.hostedSkills ?? []).map(s => s.name),
    })
  }

  const sharedWorker = createBrowserRuntimeSharedWorker()
  nexusTrace('created shared worker for direct bridge')
  const sharedWorkerPort = sharedWorker.port
  sharedWorker.port.start()
  sharedWorker.port.postMessage(
    { type: 'bridge.setPort' },
    [workerPort],
  )

  // Model-upload trace + overlay gate: URL params win when present, else settings.json
  // `agent.log` / `agent.trace`. Neither → no module loads.
  const urlParams =
    typeof globalThis.location !== 'undefined'
      ? new URLSearchParams(globalThis.location.search)
      : null
  const urlTracerFlags = {
    log: urlParams?.get('log') === '1',
    trace: urlParams?.get('trace') === '1',
    traceModelRequests: urlParams?.get('traceModelRequests') === '1',
  }

  // Idempotent installer — runs once with the boot-budget decision below,
  // and possibly a second time if the settings read resolves after the
  // budget (the late pass only installs what the first pass didn't).
  let tracerBusInstalled = false
  let tracerOverlayInstalled = false
  const installModelUploadTracer = async (
    decision: { enableBus: boolean; enableOverlay: boolean },
  ): Promise<void> => {
    // Opt-in ONLY. `enableBus` already folds in every signal — URL params
    // (the set `shouldEnableModelUploadTrace()` reads) and the persisted
    // settings.json flags. There is deliberately no `import.meta.env.DEV`
    // shortcut anymore: the always-on DEV branch made every dev session
    // collect span rings + megabyte model payloads nobody asked for.
    if (decision.enableBus && !tracerBusInstalled) {
      tracerBusInstalled = true
      const bus = await import('../../utils/modelUploadBus')
      bus.setModelUploadBusEnabled(true)
      const { setModelUploadHandler } = await import(
        '../webview/BrowserRuntimeClient'
      )
      setModelUploadHandler(data => {
        if (bus.isModelUploadEntry(data)) {
          bus.publishModelUpload(data)
        }
      })

      // Page-realm session tracer (span ring) — off by default; collect
      // only while the debug plumbing is on. Spans recorded before this
      // point are no-ops, which is the accepted cost of opt-in: with a
      // URL param the enable lands here (early); with settings.json it
      // lands after the settings read (early-boot spans are lost).
      const { getSessionTracer } = await import('../../utils/sessionTrace')
      getSessionTracer().setEnabled(true)

      // Devtools-console helper (`globalThis.__nexusTrace.dumpAll()`).
      // Loads ONLY when the debug plumbing is on — an idle session never
      // fetches the chunk or installs the global. Fire-and-forget: it's
      // a developer affordance, not on the boot-critical path.
      void import('../../utils/sessionTraceConsole').then(
        ({ installSessionTraceConsole }) => {
          installSessionTraceConsole({ port: sharedWorkerPort })
        },
      )
    }

    // The trace overlay ships in release as a lazy chunk, loaded only when `enableOverlay`
    // (which implies `enableBus`).
    if (decision.enableOverlay && !tracerOverlayInstalled) {
      tracerOverlayInstalled = true
      const { installTraceOverlay } = await import(
        '../../utils/traceOverlay'
      )
      installTraceOverlay({ port: sharedWorkerPort })
    }
  }

  // Settings read capped at 1s; a late result still installs the bus/overlay. The worker init
  // payload carries the budget-time flags.
  const settingsTracerFlags = await resolveTracerFlagsWithinBudget(
    loadAgentTracerFlags(transport),
    1_000,
    lateFlags => {
      console.info(
        '[NexusTracer] settings.json tracer flags resolved after the 1s '
        + 'boot budget; applying to this page late',
        lateFlags,
      )
      void installModelUploadTracer(
        combineTracerSignals(urlTracerFlags, lateFlags),
      )
    },
  )
  const tracerDecision = combineTracerSignals(
    urlTracerFlags,
    settingsTracerFlags,
  )
  await installModelUploadTracer(tracerDecision)
  const initPayload = buildGlicInitPayload({
    initPayload: options.initPayload,
    hostManifest,
  })
  // One page connection to the RuntimeHub carries every session transport, opened on first use;
  // the handshake is not awaited (the seam queues until `welcome`).
  const bootEnv = (initPayload as { env?: Record<string, string> }).env ?? {}
  const scopeCeiling = readRuntimeScopeCeilingFromUrl()
  const connectToRuntime = (ceiling: typeof scopeCeiling) =>
    connectRuntimeOverSharedWorker(sharedWorkerPort, {
      homeDir: bootEnv.HOME ?? bootEnv.USERPROFILE ?? '',
      kind: 'desktop-shell',
      // Report which build booted the runtime so it can name its immutable
      // entry (runtime.getBuildEntry). '' (dev / no meta) omits the key.
      ...(getBuildTime() ? { build: getBuildTime() } : {}),
      // The panel this guest lives in: its `shell/<panelId>` topic is where the
      // window chrome meets it. Absent on a host that predates the handshake
      // field — both halves then fall back to the default panel.
      ...(panelId !== undefined ? { panelId } : {}),
      // No handshake budget: the peer is this page's own SharedWorker. A worker that fails to load
      // fails the connection via its `error` event or a `bye runtime_unavailable` frame.
      handshakeTimeoutMs: 0,
      worker: sharedWorker,
      ...(ceiling !== undefined ? { scopeCeiling: ceiling } : {}),
    })
  // The desktop publishes the HOST half of every init payload (manifest, env,
  // locale, storage paths, trace gates) so the runtime can build a session's
  // init from `session.open` — for this page and for any client that is not
  // the desktop. Read at first connect, after boot has settled the payload.
  const publishHostEnvironment = (connection: RuntimeConnection) =>
    connection.request('runtime.publishHostEnvironment', {
      environment: hostEnvironmentOf(initPayload),
    })
  // The UI's connection, and the shell's unscoped one: the same connection on
  // the desktop, two under `?rtScope=` (runtimeConnections.ts says why).
  const runtimeConnections = createRuntimeConnections({
    connect: connectToRuntime,
    scopeCeiling,
    publishHostEnvironment,
    // Dev / e2e only: `?rtDevRelay=` + `?rtDevRelayToken=` point the runtime's
    // relay dialer at a Node dev relay (scripts/dev_remote_relay.mjs) instead
    // of the in-process listener.
    devRelay: readDevRelayFromUrl(),
    trace: nexusTrace,
  })
  const getRuntimeConnection = runtimeConnections.runtime
  const getDesktopConnection = runtimeConnections.desktop
  const createWorkerTransport =
    options.createWorkerTransport ??
    (() =>
      createWorkerTransportOverConnection(getRuntimeConnection(), undefined, {
        onError: error =>
          nexusTrace('runtime transport error', {
            message: error instanceof Error ? error.message : String(error),
          }),
      }))
  // Make the about-page debug toggles take effect in the WORKER (not just the
  // page-side bus + overlay): OR the persisted `agent.log` / `agent.trace`
  // settings into the worker trace gates buildGlicInitPayload derived from the
  // URL. Without this, "Verbose logging" in release logged nothing and the
  // overlay's Model-JSON tab stayed empty.
  const workerTraceFlags = resolveWorkerTraceFlags(
    initPayload,
    settingsTracerFlags,
    tracerDecision,
  )
  initPayload.logCallModel = workerTraceFlags.logCallModel
  initPayload.traceModelRequests = workerTraceFlags.traceModelRequests

  // Exit ③ on the protocol: every host call the
  // page makes — `nexusBridgeActions.ts`, `BrowserRuntimeClient`, the
  // boot-timings probe — rides the same connection through the hub's
  // host-proxy table, scope-checked like any client's, and its file access is
  // the runtime's `fsx`. Only host-pushed events still ride the page's own C++
  // port. A boot that injects its own worker
  // transport keeps the direct transport whole — it never opened a connection
  // to ride.
  const hostBridgeTransport = options.createWorkerTransport
    ? transport
    : createHostBridgeTransportOverConnection({
        connection: getRuntimeConnection,
        events: transport,
      })
  // The e2e bridge trace records every host request the page makes, labelled
  // `runtime`; the raw port's own trace holds only the page's boot-time calls.
  if (hostBridgeTransport !== transport) {
    installRuntimeHostTracerIfEnabled(hostBridgeTransport)
  }
  const files = createRuntimeFileAccess({ connection: getRuntimeConnection })
  // The sidebar's session list, fork / rename / delete and the task drawer.
  const sessionChannel = createSessionListChannel({ connection: getRuntimeConnection })
  // The topbar pill / composer gate read the session's own status topic
  // instead of a fan-out on the WebUI settings port.
  const sessionStatusChannel = createSessionStatusChannel({ connection: getRuntimeConnection })
  // Settings: the ten worker-served capabilities, no second port.
  const settingsBridge = createSettingsBridgeOverConnection({ connection: getRuntimeConnection })
  // Layout, boot progress, build info and the reveal — the page's last traffic
  // on the raw SharedWorker port, now `shell.*` on the connection.
  const shellChannel = createShellChannel({
    connection: getRuntimeConnection,
    bootConnection: getDesktopConnection,
    onError: (error: unknown) =>
      nexusTrace('shell publish failed', {
        message: error instanceof Error ? error.message : String(error),
      }),
  })
  // The runtime publishes what a user should be told; showing it is this
  // client's job. This window asks the host for its OS toast —
  // which the host still suppresses while the window is focused. A client
  // without that route (a scoped one, and any future remote client) shows it
  // with the browser's own notifications when the user has allowed them.
  if (!options.createWorkerTransport) {
    subscribeRuntimeNotifications({
      connection: getRuntimeConnection,
      show: published => {
        // A mod's state (F-25) travels as data; the line is composed here, in
        // the user's language — the runtime never authors user-visible text.
        const notification = localizeRuntimeNotification(
          published,
          createTranslate(resolveLocale(options.initPayload?.locale)),
        )
        const hostServesToasts = scopeCeiling === undefined
        if (hostServesToasts) {
          // Every window hears it; only the one owning the session asks, or
          // N windows raise N toasts and the unfocused ones' calls escape the
          // host's focus suppression. The default panel matches the runtime's
          // fallback for a session opened with no panel named.
          if (!notificationIsForPanel(notification, panelId ?? DEFAULT_PANEL_ID)) return
          // The page's own host call, so it rides the connection like every
          // other one (`ui.showNotification` is in the host-proxy table);
          // the raw port is not a client path.
          void showHostNotification(hostBridgeTransport, {
            message: notification.message,
            ...(notification.title !== undefined ? { title: notification.title } : {}),
            notificationType: notification.notificationType,
          })
          return
        }
        showLocalNotification(notification)
      },
      onError: error =>
        nexusTrace('notifications subscribe failed', {
          message: error instanceof Error ? error.message : String(error),
        }),
    })
  }
  // The user's workspace index (projects, recent folders, last folder per type,
  // search history) is the runtime's; the page mirrors it over the same
  // connection. Not awaited: reads answer from the seeded copy meanwhile. A
  // boot that injects its own worker transport opens no connection for it.
  if (!options.createWorkerTransport) attachWorkspaceStore(getRuntimeConnection)
  // Provider usage / credit balance for the composer: the runtime's table,
  // mirrored the same way.
  if (!options.createWorkerTransport) attachProviderUsageStore(getRuntimeConnection)
  // Provider sign-in (the dialog is the runtime's published state): likewise.
  if (!options.createWorkerTransport) attachProviderLoginStore(getRuntimeConnection)
  // The background updater reloads a hidden page into a newer build only when
  // the runtime says a restart loses nothing. The desktop's own window only:
  // a scoped window must not decide for the runtime it shares.
  if (!options.createWorkerTransport && scopeCeiling === undefined) {
    installUpdateRestartGate(getDesktopConnection)
  }

  return {
    transport: hostBridgeTransport,
    files,
    sessionChannel,
    sessionStatusChannel,
    settingsBridge,
    shellChannel,
    initPayload,
    createWorkerTransport,
    runtimeConnection: getRuntimeConnection,
    sharedWorkerPort,
    hostWindow,
    hostOrigin,
  }
}

export async function nexusBootAndRender(
  container: HTMLElement,
  options: NexusBootOptions = {},
): Promise<NexusBootContext> {
  // FIRST, before anything that awaits: this page is the runtime's client,
  // and it is hidden a lot of the time while a turn is still running
  // (minimized, covered, or parked after the window closed). Hold a Web Lock
  // so Chromium's freezing policy never freezes it — and, with it, its workers
  // and the SharedWorker. A covered guest boots slowly, so a lock taken later
  // in the boot can still be missing when the window closes; see
  // runtimeKeepAlive.ts.
  nexusTrace('runtime keep-alive lock', { requested: holdRuntimeKeepAliveLock() })

  // Start the React + shell chunk imports now, in parallel with prepareNexusBoot's IPC waits.
  const reactPromise = import('react')
  const reactDomPromise = import('react-dom/client')
  const shellPromise = import('../webview/MultiSessionShell')
  // Same reasoning, same moment: the catalog is a network fetch the first
  // render depends on, so start it here and let it overlap the imports and
  // the IPC waits rather than paying for it serially before render.
  const localePromise = startLocalePreload(
    resolveBootLocaleTag(options.initPayload?.locale),
  )

  const prepared = await prepareNexusBoot(options)

  // One-shot migration: an existing user's theme lived in the host's profile
  // prefs; copy it into THIS panel's localStorage before the first
  // `resolveTheme` posts, so the very first paint already reflects the
  // migrated choice. Awaits — a frame painted on the wrong theme is worse
  // than one bridge round-trip on boot.
  await migrateAppearanceFromHostPrefs(prepared.transport)

  // Per-client theme: post this client's (scheme, seed, variant) to the
  // host's resolver and apply what comes back. Runs once here — the transport
  // exists only after prepareNexusBoot — and re-runs on every local change
  // via its own subscriptions. The classic palette skips the resolve (there
  // is nothing for the host to do), so a client that never picked a Chrome
  // swatch costs nothing.
  if (typeof document !== 'undefined' && typeof window !== 'undefined') {
    installPerClientTheme(prepared.transport, window, document.documentElement, (message, details) =>
      console.info('[NexusTrace][GuestEntry]', message, details),
    )
  }

  // Publish real boot milestones (`shell.publishBootProgress`), fire-and-forget; `rendering` now,
  // the rest from the shell.
  const reportBootStage = (stage: GuestBootStage): void => {
    prepared.shellChannel.publishBootProgress(stage)
  }
  reportBootStage('rendering')

  // Boot instrumentation. The transport is now ready; capture the moment
  // and fire-and-forget a getBootTimings request so the C++ side's marks
  // (NexusViewContainer first-construction wall-clock time, bridge
  // round-trip latency) get stashed in globalThis.__nexusBootMarks before
  // MultiSessionShell renders. Failures are non-fatal — the boot signal
  // simply lacks the C++-side attrs in the trace event.
  const bootMarks = (globalThis as { __nexusBootMarks?: Record<string, number> })
    .__nexusBootMarks ?? {}
  bootMarks.transportReadyMs = Date.now()
  ;(globalThis as { __nexusBootMarks?: Record<string, number> })
    .__nexusBootMarks = bootMarks
  void (async () => {
    try {
      const requestSentMs = Date.now()
      // Response type is inferred from the typed `createBridgeRoute(...)`
      // call — the codegen-emitted `BrowserBridgeResult<'ui',
      // 'getBootTimings'>` includes every field this site reads
      // (`nexusViewContainerFirstCreatedMs`, `loadInitialUrlReturnedMs`,
      // `glicNavigationCommittedMs`, `bridgeRespondedMs`). No hand-rolled
      // cast — pre-Phase-12g this used an inline `as` that omitted two
      // fields and surfaced as TS2339 errors.
      const timings = await prepared.transport.request({
        id: `boot-get-timings-${Date.now().toString(36)}`,
        route: createBridgeRoute('ui', 'getBootTimings'),
        payload: {},
      })
      const responseReceivedMs = Date.now()
      if (timings.ok) {
        bootMarks.nexusViewContainerFirstCreatedMs =
          timings.result.nexusViewContainerFirstCreatedMs
        bootMarks.loadInitialUrlReturnedMs =
          timings.result.loadInitialUrlReturnedMs
        bootMarks.glicNavigationCommittedMs =
          timings.result.glicNavigationCommittedMs
        bootMarks.bridgeRespondedMs = timings.result.bridgeRespondedMs
        bootMarks.bootTimingsRoundTripMs =
          responseReceivedMs - requestSentMs
      } else {
        nexusTrace('getBootTimings returned error', timings.error)
      }
    } catch (error) {
      nexusTrace('getBootTimings dispatch failed', {
        message: error instanceof Error ? error.message : String(error),
      })
    }
  })()

  // WebUI ↔ SharedWorker bridge: the page thread only forwards the outer page's port. Security: the
  // surface is an explicit allow-list of registered handlers. HOME / USERPROFILE are a hint only.
  // Installed unconditionally.
  void (async () => {
    try {
      const env = (prepared.initPayload as { env?: Record<string, string> })
        .env ?? {}
      const homeDir = env.HOME ?? env.USERPROFILE ?? ''
      const { setupPanelHostBootstrap } = await import('./panelHostBootstrap')
      setupPanelHostBootstrap({
        hostWindow: prepared.hostWindow,
        hostOrigin: prepared.hostOrigin,
        sharedWorkerPort: prepared.sharedWorkerPort,
        homeDir,
      })
      nexusTrace('webUi bridge bootstrap installed', {
        hostOrigin: prepared.hostOrigin,
        homeDirKnown: homeDir.length > 0,
      })
    } catch (e) {
      nexusTrace('webUi bridge bootstrap install failed', {
        message: e instanceof Error ? e.message : String(e),
      })
    }
  })()

  // Isolated-worker kernel: the SharedWorker cannot spawn Workers, so the window owns them (via a
  // sandboxed frame outside this page's origin); the SharedWorker gets the control channel's other end.
  void (async () => {
    try {
      const [{ installKernelWindowHost }, { installWindowAudioHost }] = await Promise.all([
        import('../workerKernel/KernelWindowHost'),
        import('../workerKernel/windowAudioHost'),
      ])
      const runJsControl = new MessageChannel()
      prepared.sharedWorkerPort.postMessage(
        { type: 'workerHost.attachControlPort' },
        [runJsControl.port2],
      )
      // Both listen before the port starts, so nothing the kernel sends is missed.
      installWindowAudioHost(runJsControl.port1)
      installKernelWindowHost(runJsControl.port1)
      nexusTrace('run_js window host installed')
    } catch (e) {
      nexusTrace('run_js window host install failed', {
        message: e instanceof Error ? e.message : String(e),
      })
    }
  })()

  // Boot instrumentation: subdivide ms_mount_to_first_paint into 5
  // sub-deltas so we know whether the 1.3 s window is dominated by:
  //   - waiting on react / react-dom imports to finish
  //   - waiting on the MultiSessionShell chunk
  //   - createRoot construction
  //   - root.render synchronous work (initial reconciliation)
  //   - everything from render-returns to ThreadWelcome useEffect (commit
  //     phase + browser paint + first effects firing)
  const markBoot = (key: string) => {
    const m = (globalThis as { __nexusBootMarks?: Record<string, number> })
      .__nexusBootMarks ?? {}
    if (m[key] == null) {
      m[key] = Date.now()
      ;(globalThis as { __nexusBootMarks?: Record<string, number> })
        .__nexusBootMarks = m
    }
  }

  const ctx: NexusBootContext = {
    ...prepared,
    client: null,
  }

  // Fires once at the shell's interactive moment: `shell.dismissBootWelcome` on the connection,
  // published on this panel's `shell/<panelId>` topic.
  const handleGuestFullyReady = () => {
    // Non-fatal if it fails (the channel reports it): the parent WebUI's
    // fallback timer (~10 s) dismisses the welcome regardless.
    prepared.shellChannel.dismissBootWelcome()
  }

  // Push the guest's build time to the boot-welcome footer (the worker replays it to late panels);
  // skipped when unset. Read lazily: `setBuildTime()` runs after this module is evaluated.
  const buildTime = getBuildTime()
  if (buildTime) {
    prepared.shellChannel.publishBuildInfo(buildTime)
  }

  // The render itself is shared with the remote boot path (renderShell.tsx) —
  // everything above this line is the desktop's own ceremony.
  await renderShell(
    container,
    prepared,
    { reactPromise, reactDomPromise, shellPromise, localePromise },
    {
      title: getProductName(),
      // Gates the transcript-search dialog (topbar button + Ctrl+K);
      // an older binary that doesn't serve `search` hides the feature.
      searchCapable:
        prepared.initPayload.hostManifest?.capabilities?.includes('search') ??
        false,
      onGuestFullyReady: handleGuestFullyReady,
      onBootStage: reportBootStage,
    },
  )

  options.onReady?.(ctx)
  return ctx
}

declare global {
  // eslint-disable-next-line no-var
  var __NEXUS_E2E_PRIMITIVES__: NativePrimitives | undefined
}

/**
 * Opt-in e2e hook (the `?e2eTrace=1` / `__NEXUS_E2E_TRACE__` switch that also
 * turns the bridge tracer on; a no-op in production): the native-primitive
 * wrappers over the PAGE's own C++ port, so the P-3 e2e spec can drive
 * fs.watch, CAS writes, persistent spawns, streaming HTTP, WebSockets,
 * secrets and alarms against the real binary without a model turn.
 */
function installNativePrimitivesTestHookIfEnabled(
  transport: BrowserBridgeTransport,
  hostManifest: Parameters<typeof createNativePrimitives>[0]['manifest'],
): void {
  if (!isBridgeTraceEnabled()) return
  let seq = 0
  // For e2e: a raw request on the page's bridge port with an
  // optional frame context, for driving the host tool families directly.
  ;(globalThis as unknown as {
    __NEXUS_E2E_BRIDGE_REQUEST__?: unknown
  }).__NEXUS_E2E_BRIDGE_REQUEST__ = (
    capability: string,
    action: string,
    payload: Record<string, unknown>,
    context?: { sessionId?: string },
  ) =>
    transport.request({
      id: `e2e-bridge-${Date.now().toString(36)}-${seq++}`,
      route: { namespace: 'nexus', capability, action } as never,
      payload: payload as never,
      ...(context ? { context } : {}),
    })
  globalThis.__NEXUS_E2E_PRIMITIVES__ = createNativePrimitives({
    transport,
    createRequestId: () => `e2e-primitive-${Date.now().toString(36)}-${++seq}`,
    manifest: hostManifest,
  })
}
