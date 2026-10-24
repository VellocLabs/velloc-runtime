import type {
  AccessibilitySnapshotResult,
  BrowserTab,
  DOMSnapshotResult,
  OnStopReason,
  PlatformCapabilities,
} from '../../runtime/interfaces/PlatformCapabilities'
import type {
  BridgeShellSpawnPayload,
  BridgeShellSpawnResult,
  BridgeShellStreamFoundResult,
} from './protocol/shell'
import type { RuntimeConfig } from '../../runtime/interfaces/RuntimeConfig'
import type {
  BrowserHostedToolExecutionContext,
  BrowserBridgeAction,
  BrowserBridgeCapability,
  BrowserBridgeRequestPayload,
  BrowserBridgeResult,
  BrowserBridgeRoute,
  BrowserHostManifest,
  BrowserBridgeTransport,
  BrowserSessionState,
  BrowserUserProfile,
  BrowserWorkspaceMetadata,
  HostedToolDefinition,
} from './browserBridgeProtocol'
import type { BridgeCallContext } from './protocol/core'
import { createBridgeRoute } from './browserBridgeProtocol'
import { NEXUS_DIRECT_BRIDGE_CAPABILITIES } from './directBridgeCapabilities'
import { hostRouteFor, hostToolArgsError } from '../../toolkit/builtin/host'
import { renderHostErrorText } from '../../toolkit/builtin/host/resultText'
import { HostToolError } from './hostToolError'
import { appendCustomProvidersToCatalog } from '../../config/customProviderRegistry'
import {
  appendRuntimeProvidersToCatalog,
  overlayBuiltInListings,
  refreshConfiguredRuntimeProviderModels,
  runtimeProviderConfigs,
} from '../../models/drivers/runtimeProviders'
import { applyModelEntries } from '../../models/drivers/modelEntryCatalog'
import { refreshBrokerProviderBaseUrls } from '../worker/brokerProviderView'
import { awaitCatalogFigures } from '../../catalog/builtinCatalogFill'
import { publishHostModelCatalog } from '../../config/hostModelCatalog'
import { publishCatalogModelPool } from '../../config/nexusModelConfig/providerModelPool'
import { getProductName } from '../../branding/productName'
import {
  createBrowserNetworkOperations,
  type BrowserNetworkOperations,
} from '../../utils/BrowserNetworkOperations'
import { createNativePrimitives, type NativePrimitives } from './nativePrimitives'

function createFallbackUUID(): string {
  return `bridge-${Math.random().toString(16).slice(2)}-${Date.now().toString(16)}`
}

export type BrowserContextSnapshot = {
  tabs: BrowserTab[]
  activeTab: BrowserTab | null
  session: BrowserSessionState
  userProfile: BrowserUserProfile | null
  workspace: BrowserWorkspaceMetadata | null
  domSnapshot: DOMSnapshotResult | null
  accessibilitySnapshot: AccessibilitySnapshotResult | null
}

export type BrowserHostMode = 'browser' | 'nexus'

// Phase 12g: dropped `ChildHandle` and the entire `process` capability
// surface. The bridge `process` capability had no JS-side callers
// (Phase 11b deleted the only consumers — TS BashTool / GrepTool /
// GlobTool). The C++ ProcessTool calls into NexusShellService directly
// through its own launcher; no JS round-trip is needed.

export type BrowserHostBridgeOptions = {
  transport: BrowserBridgeTransport
  runtimeConfig?: RuntimeConfig
  hostMode?: BrowserHostMode
  hostManifest?: BrowserHostManifest
  // `onBrowserToolDispatched` retired: the panel reveal no longer keys
  // off dispatch — C++ pushes `browser.sessionTabsChanged` when a browser
  // tool actually creates (or closes) a session tab, and the shell's
  // webview_area geometry drives <main-contents-view> from there.
}

// Without a manifest, a Nexus host serves what its direct port registers.
const NEXUS_HOST_SUPPORTED_CAPABILITIES = NEXUS_DIRECT_BRIDGE_CAPABILITIES

/** The host facts `fs.systemInfo` contributes to `BrowserSessionState`. */
type SystemInfoFields = Partial<
  Pick<BrowserSessionState, 'platform' | 'osVersion' | 'shell' | 'powershell'>
>

export class BrowserHostBridge implements PlatformCapabilities {
  private readonly transport: BrowserBridgeTransport
  private readonly runtimeConfig?: RuntimeConfig
  private readonly hostMode: BrowserHostMode
  private readonly hostManifest?: BrowserHostManifest
  /**
   * `network.httpGet` over THIS bridge's transport, so a tool fetches through its
   * own runtime's scoped transport. Not gated on the host manifest: a host without
   * the capability answers with an error (`${code}: ${message}`).
   */
  readonly network: BrowserNetworkOperations
  /**
   * The additive native primitives (fs.watch, CAS writes, argv / persistent
   * spawns, streaming HTTP, WebSockets, secrets, alarms) over THIS bridge's
   * transport, gated on the host manifest — see `nativePrimitives.ts`.
   * Each throws `NativePrimitiveUnsupportedError` on a host that predates it.
   */
  readonly primitives: NativePrimitives

  constructor(options: BrowserHostBridgeOptions) {
    this.transport = options.transport
    this.runtimeConfig = options.runtimeConfig
    this.hostMode = options.hostMode ?? 'browser'
    this.hostManifest = options.hostManifest
    this.network = createBrowserNetworkOperations({
      transport: options.transport,
      createRequestId: () => this.createRequestId(),
    })
    this.primitives = createNativePrimitives({
      transport: options.transport,
      createRequestId: () => this.createRequestId(),
      manifest: options.hostManifest,
    })
  }

  /**
   * Raw transport accessor for callers that speak a bridge capability this
   * class doesn't wrap. Read-only escape hatch — new recurring flows
   * should still get a typed method on this class.
   */
  getBridgeTransport(): BrowserBridgeTransport {
    return this.transport
  }

  // C++-side `browser` capability hosted by `ToolsAdapter`: `callTool` dispatches
  // one model-facing browser tool by `name` and returns the `{ data, agent_meta }`
  // envelope.
  readonly browser = {
    // Dispatch one browser-actor tool call. The route is
    // `nexus.browser.<name>` — routes are dynamic so we cast
    // through the typed protocol with `as never` (the C++
    // ToolsAdapter validates the action name at dispatch time).
    callTool: async (params: {
      name: string
      args: Record<string, unknown>
      executionContext?: BrowserHostedToolExecutionContext
      onProgress?: (progress: unknown) => void
    }): Promise<unknown> => {
      // The tool's host action (`files.read`, `exec.bash`, `browser.click`).
      // Only a tool the runtime defines (toolkit/builtin/host) can reach the
      // host; the host serves no tool catalog of its own.
      const hostRoute = hostRouteFor(params.name)
      if (!hostRoute) {
        throw new Error(`unknown_tool: ${params.name} is not a host tool`)
      }
      const argsError = hostToolArgsError(params.name, params.args)
      if (argsError !== undefined) throw new Error(`invalid_args: ${argsError}`)
      const { capability, action } = hostRoute
      this.requireCapability(capability)
      const requestId = this.createRequestId()
      const unsubscribe = params.onProgress && this.transport.subscribeEvents
        ? this.transport.subscribeEvents(event => {
            if (
              event.route.capability !== capability ||
              event.route.action !== action
            ) {
              return
            }
            const payload = event.payload as { request_id?: unknown } | null
            if (payload?.request_id === requestId) {
              params.onProgress?.(event.payload)
            }
          })
        : undefined
      const sessionId = params.executionContext?.sessionId
      try {
      const response = await this.transport.request({
        id: requestId,
        route: {
          namespace: 'nexus',
          capability,
          action,
        } as never,
        payload: { ...params.args } as never,
        context: sessionId ? { sessionId } : undefined,
      }) as { ok: true; result: unknown } | {
        ok: false
        error: { code: string; message: string; data?: unknown }
      }
      if (!response.ok) {
        // The host answers `{code, params}`; the sentence the model reads is
        // the runtime's (resultText.ts). An unknown code shows as itself.
        const { code, message, data } = response.error
        const text = renderHostErrorText(params.name, code, data)
        throw new HostToolError(
          code,
          text ?? message,
          data && typeof data === 'object' && !Array.isArray(data)
            ? (data as Record<string, unknown>)
            : undefined,
        )
      }
      return response.result
      } finally {
        unsubscribe?.()
      }
    },
  }

  // C++-side `session` capability hosted by `NexusSessionBridgeAdapter`.
  // `onStop({sessionId, reason})` is idempotent; `setAgentLoopSettings` pushes
  // per-session wall-clock budgets (an older build answers not-found).
  readonly session = {
    onStop: async (
      params: {
        sessionId?: string
        reason?: OnStopReason
      } = {},
    ): Promise<{ ok: true; stopped: boolean }> => {
      this.requireCapability('session')
      return this.send(
        createBridgeRoute('session', 'onStop'),
        {
          executionContext: { sessionId: params.sessionId },
          reason: params.reason,
        },
        params.sessionId ? { sessionId: params.sessionId } : undefined,
      )
    },
    setAgentLoopSettings: async (
      params: {
        actionTimeoutMs?: number
        cwd?: string
        clearReadState?: boolean
        browserObservationDiffOptIn?: boolean
        clearBrowserObservationCache?: boolean
        executionContext?: BrowserHostedToolExecutionContext
      } = {},
    ): Promise<{
      ok: true
      appliedActionTimeoutMs?: number
      appliedCwd?: string
    }> => {
      this.requireCapability('session')
      return this.send(createBridgeRoute('session', 'setAgentLoopSettings'), {
        actionTimeoutMs: params.actionTimeoutMs,
        cwd: params.cwd,
        clearReadState: params.clearReadState,
        browserObservationDiffOptIn: params.browserObservationDiffOptIn,
        clearBrowserObservationCache: params.clearBrowserObservationCache,
        executionContext: params.executionContext,
      })
    },
  }

  // `exec.listShells` — which shells the host can run. The runtime offers
  // the Bash / PowerShell tools only for the shells reported here
  // (`toolkit/builtin/host`, `hostedToolsForHost`).
  readonly exec = {
    listShells: async (): Promise<{ bash: boolean; powershell: boolean }> => {
      this.requireCapability('exec')
      return this.send(createBridgeRoute('exec', 'listShells'), {})
    },
  }

  // `ui.*` actions drive C++ surfaces (notifications, folder picker, etc.). The
  // SharedWorker broadcasts the per-session feed and the session-list summary
  // directly to attached WebUI bridge ports.
  readonly ui = {
    // `setPermissionsCount` removed — see protocol/ui.ts. The C++
    // handler was never implemented and no JS code ever called this.
    showNotification: async (
      payload: {
        message: string
        title?: string
        notificationType?: string
      },
    ): Promise<{ ok: true }> => {
      this.requireCapability('ui')
      return this.send(createBridgeRoute('ui', 'showNotification'), payload)
    },
    // `$.ui.copy`'s first path (F-25): the OS clipboard, written by the
    // browser process. NOT_IMPLEMENTED on an older host — the caller falls
    // back to the page's clipboard.
    writeClipboard: async (payload: { text: string }): Promise<{ ok: true }> => {
      this.requireCapability('ui')
      return this.send(createBridgeRoute('ui', 'writeClipboard'), payload)
    },
    // `nexus.inspect_menu_enabled` browser pref (C++-owned): the Nexus
    // guest <webview>'s right-click "Inspect" item. Backs the hidden
    // `/debug inspect [on|off]` slash subcommand — see protocol/ui.ts.
    getInspectMenuEnabled: async (): Promise<{ enabled: boolean }> => {
      this.requireCapability('ui')
      return this.send(createBridgeRoute('ui', 'getInspectMenuEnabled'), {})
    },
    setInspectMenuEnabled: async (payload: {
      enabled: boolean
    }): Promise<{ ok: true; enabled: boolean }> => {
      this.requireCapability('ui')
      return this.send(createBridgeRoute('ui', 'setInspectMenuEnabled'), payload)
    },
  }

  // `shell.status` / `shell.kill` (the C++ background-shell registry) were
  // removed under interface 1: the registry is the worker's,
  // built on `primitives.shell` (persistent spawns).
  readonly shell = {
    // The streaming surface (F-25): see `protocol/shell.ts`.
    spawn: async (params: BridgeShellSpawnPayload): Promise<BridgeShellSpawnResult> => {
      this.requireCapability('shell')
      return this.send(createBridgeRoute('shell', 'spawn'), params)
    },
    writeStdin: async (params: { streamId: string; data: Uint8Array }): Promise<BridgeShellStreamFoundResult> => {
      this.requireCapability('shell')
      return this.send(createBridgeRoute('shell', 'writeStdin'), params)
    },
    closeStdin: async (params: { streamId: string }): Promise<BridgeShellStreamFoundResult> => {
      this.requireCapability('shell')
      return this.send(createBridgeRoute('shell', 'closeStdin'), params)
    },
    streamKill: async (params: { streamId: string }): Promise<BridgeShellStreamFoundResult> => {
      this.requireCapability('shell')
      return this.send(createBridgeRoute('shell', 'streamKill'), params)
    },
  }

  // Phase 12g: dropped the `readonly process = { capabilities, exec,
  // spawn }` namespace. Phase 11b had already deleted the only
  // callers (TS BashTool / GrepTool / GlobTool); the surface lived
  // on under a feature flag for two phases with zero use. The C++
  // ProcessTool talks to NexusShellService directly via its own
  // launcher under `tools/process_tool/`.

  async describeHostSession(): Promise<BrowserSessionState> {
    // The page knows the browser name / locale / timezone; platform /
    // osVersion / shell come from the host's `fs.systemInfo` (base::SysInfo).
    const base = this.buildFallbackSessionState()
    const systemInfo = await this.fetchSystemInfo()
    return systemInfo ? { ...base, ...systemInfo } : base
  }

  /**
   * `{ platform, osVersion, shell }` from `fs.systemInfo`, normalized to
   * `BrowserSessionState`'s shape (empty strings drop the field); undefined when
   * the route is unavailable. Memoised per bridge; an empty read is NOT cached.
   */
  private systemInfo?: Promise<SystemInfoFields | undefined>

  private fetchSystemInfo(): Promise<SystemInfoFields | undefined> {
    if (!this.supportsCapability('fs')) {
      return Promise.resolve(undefined)
    }
    if (!this.systemInfo) {
      const attempt = this.readSystemInfo().then(info => {
        if (info === undefined && this.systemInfo === attempt) {
          this.systemInfo = undefined
        }
        return info
      })
      this.systemInfo = attempt
    }
    return this.systemInfo
  }

  private async readSystemInfo(): Promise<SystemInfoFields | undefined> {
    try {
      const raw = await this.send(createBridgeRoute('fs', 'systemInfo'), {})
      const out: SystemInfoFields = {}
      if (
        raw.platform === 'win32' ||
        raw.platform === 'darwin' ||
        raw.platform === 'linux'
      ) {
        out.platform = raw.platform
      }
      if (raw.osVersion && raw.osVersion.length > 0) {
        out.osVersion = raw.osVersion
      }
      if (raw.shell && raw.shell.length > 0) {
        out.shell = raw.shell
      }
      if (typeof raw.powershell === 'string' && raw.powershell.length > 0) {
        out.powershell = raw.powershell
      }
      return Object.keys(out).length > 0 ? out : undefined
    } catch {
      // Host predates the route or returned a malformed payload. Stay
      // silent — the env block just drops the affected lines.
      return undefined
    }
  }

  /**
   * The host catalog with the user's CUSTOM providers spliced in (the C++ broker
   * knows only its compiled-in ids); a host row with the same id wins.
   */
  async getModelCatalog(): Promise<BrowserBridgeResult<'model', 'catalog'>> {
    const [catalog] = await Promise.all([
      this.send(createBridgeRoute('model', 'catalog'), {}),
      // Runtime-only providers (OpenRouter, the Vercel AI Gateway) list their
      // own models over the host transport — the host has no provider to
      // discover them. Cached for an hour; bounded so a slow listing never
      // holds up the picker (the next refresh picks it up).
      refreshConfiguredRuntimeProviderModels(this.transport),
      // The base URL a provider on its ModelProvider sends to is the
      // runtime's copy of the broker's (`resolveDriverBaseUrl`). A config the
      // host received outside the guest's providers write path — launch
      // prefs after boot, the `updateProviderConfig` chrome.send route —
      // reaches that copy here, before the catalog that offers the provider.
      refreshBrokerProviderBaseUrls(this.transport, this.createRequestId()),
      // Built-in rows read the figures they leave unset from the model
      // catalog; its first read is waited for (bounded) so the rows below
      // already carry them (catalog/builtinCatalogFill.ts).
      awaitCatalogFigures(),
    ])
    // Built-ins whose discovery runs in the runtime (openai, anthropic, kimi)
    // gain their listed models here, as the host's discovery added them.
    const listed = (await overlayBuiltInListings(this.transport, catalog)) ?? catalog
    const withProviders =
      appendRuntimeProvidersToCatalog(appendCustomProvidersToCatalog(listed) ?? listed)
      ?? listed
    // Every built-in provider's rows become model ENTRIES — a family's
    // `latest`, or a pinned version — resolved against what the provider
    // offers today (models/drivers/modelEntryCatalog.ts).
    const spliced = applyModelEntries(withProviders, runtimeProviderConfigs())
    // Publish the picker's model ids for readers that have no bridge of their
    // own (the team provider survey) — same seam, same list. See
    // `config/hostModelCatalog.ts`.
    publishHostModelCatalog(spliced)
    // …and, for the providers with no listing of their own, everything they
    // can run — the tier ladder's search space (providerModelPool.ts).
    publishCatalogModelPool(spliced)
    return spliced as BrowserBridgeResult<
      'model',
      'catalog'
    >
  }

  // Tabs / activeTab / DOM / accessibility snapshots are always `[]` / `null`;
  // `includeDomSnapshot` and `includeAccessibilitySnapshot` are no-ops.
  async getBrowserContextSnapshot(options?: {
    includeDomSnapshot?: boolean
    includeAccessibilitySnapshot?: boolean
  }): Promise<BrowserContextSnapshot> {
    void options
    return this.getFallbackBrowserContextSnapshot()
  }

  hasHostedTools(): boolean {
    return (this.hostManifest?.hostedTools.length ?? 0) > 0
  }

  supportsBridgeCapability(capability: BrowserBridgeCapability): boolean {
    return this.supportsCapability(capability)
  }

  supportsLlmDocumentParts(): boolean {
    return this.hostManifest?.llmDocumentParts === true
  }

  readHostEnv(names: string[]): Promise<Record<string, string | null>> {
    return this.primitives.shell.env(names)
  }

  private async send<
    C extends BrowserBridgeCapability,
    A extends BrowserBridgeAction<C>,
  >(
    route: BrowserBridgeRoute<C, A>,
    payload: BrowserBridgeRequestPayload<C, A>,
    context?: BridgeCallContext,
  ): Promise<BrowserBridgeResult<C, A>> {
    const response = await this.transport.request({
      id: this.createRequestId(),
      route,
      payload,
      ...(context ? { context } : {}),
    }) as { ok: true; result: BrowserBridgeResult<C, A> } | {
      ok: false
      error: { code: string; message: string }
    }

    if (!response.ok) {
      throw new Error(`${response.error.code}: ${response.error.message}`)
    }

    return response.result
  }

  private createRequestId(): string {
    if (this.runtimeConfig) {
      return this.runtimeConfig.createUUID()
    }

    return globalThis.crypto?.randomUUID?.() ?? createFallbackUUID()
  }

  private supportsCapability(capability: BrowserBridgeCapability): boolean {
    if (this.hostManifest) {
      return this.hostManifest.capabilities.includes(capability)
    }

    if (this.hostMode !== 'nexus') {
      return true
    }

    return NEXUS_HOST_SUPPORTED_CAPABILITIES.has(capability)
  }

  private requireCapability(capability: BrowserBridgeCapability): void {
    if (!this.supportsCapability(capability)) {
      throw new Error(
        `NOT_IMPLEMENTED: Bridge capability '${capability}' is not available in ${this.hostMode} mode`,
      )
    }
  }

  // No host serves a user profile or workspace. The session goes through
  // describeHostSession, which merges the host's `fs.systemInfo`.
  private async getFallbackBrowserContextSnapshot(): Promise<BrowserContextSnapshot> {
    return {
      tabs: [],
      activeTab: null,
      session: await this.describeHostSession(),
      userProfile: null,
      workspace: null,
      domSnapshot: null,
      accessibilitySnapshot: null,
    }
  }

  private buildFallbackSessionState(): BrowserSessionState {
    return {
      browserName:
        this.hostMode === 'nexus'
          ? getProductName()
          : 'Chromium-hosted runtime',
      locale:
        typeof navigator !== 'undefined' && typeof navigator.language === 'string'
          ? navigator.language
          : undefined,
      timezone:
        typeof Intl !== 'undefined'
          ? Intl.DateTimeFormat().resolvedOptions().timeZone
          : undefined,
      webviewId:
        this.hostMode === 'nexus'
          ? 'nexus-direct-bridge'
          : undefined,
      tabCount: 0,
    }
  }
}
