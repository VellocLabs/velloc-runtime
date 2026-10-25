import type { AgentBridgeActionMap } from './agent'
import type { AlarmsBridgeActionMap } from './alarms'
import type { WebWindowBridgeActionMap } from './webWindow'
import type { PageScriptBridgeActionMap } from './pageScript'
import type { McpSettingsBridgeActionMap } from './mcpSettings'
import type { BrowserCapabilityMap } from './browser'
import type { ExecBridgeActionMap } from './exec'
import type { FilesBridgeActionMap } from './files'
import type { FeaturesBridgeActionMap } from './features'
import type { FsBridgeActionMap } from './fs'
import type { MemoryBridgeActionMap } from './memory'
import type { SessionModelsBridgeActionMap } from './sessionModels'
import type { ModelBridgeCapabilityMap } from './nexus_llm'
import type { NetworkBridgeActionMap } from './network'
import type { PluginsBridgeActionMap } from './plugins'
import type { ProfileBridgeActionMap } from './profile'
import type { ProvidersBridgeActionMap } from './providers'
import type { SearchBridgeActionMap } from './search'
import type { SecretsBridgeActionMap } from './secrets'
import type { SessionBridgeCapabilityMap } from './session'
import type { ShellBridgeActionMap } from './shell'
import type { SqliteBridgeActionMap } from './sqlite'
import type { SkillsBridgeActionMap } from './skills'
import type { SessionImportBridgeActionMap } from './sessionImport'
import type { SystemPrefsBridgeActionMap } from './systemPrefs'
import type { AppInfoBridgeActionMap } from './appInfo'
import type { AppearanceBridgeActionMap } from './appearance'
import type { BrowserToolsBridgeActionMap } from './browserTools'
import type { ProviderAuthBridgeActionMap } from './providerAuth'
import type { RemoteAccessBridgeActionMap } from './remoteAccess'
import type { UiBridgeCapabilityMap } from './ui'

// ─── The native / worker boundary ──────────────────────────────────────────
//
// NativeCapabilityMap is served by C++ (`RegisterCapability(...)`, declared per
// NATIVE_CAPABILITY_DECLARATION_DIRS); WorkerCapabilityMap by the SharedWorker's
// JS adapters, on the same wire union for end-to-end type safety (P-3).
export type NativeCapabilityMap =
  // `browser` — the ToolsAdapter's macro-DSL tool catalog (`tools/`), the one
  // native capability with no `api/declarations/` directory.
  BrowserCapabilityMap &
  UiBridgeCapabilityMap &
  ModelBridgeCapabilityMap &
  SessionBridgeCapabilityMap &
  {
    files: FilesBridgeActionMap
    exec: ExecBridgeActionMap
    fs: FsBridgeActionMap
    network: NetworkBridgeActionMap
    // Observe/kill BACKGROUND shells the model spawned via Bash
    // run_in_background (status → ReadBackgroundOutput, kill → Mojo Kill).
    // Lets the manager surface a `local_bash` task in the Background Tasks
    // drawer without going through the model tool loop.
    shell: ShellBridgeActionMap
    // Read/write host SQLite files (one-shot via `path` or against an open
    // `handle`). See ./sqlite.ts and src/custom_browser/browser/nexus/api/sqlite/.
    sqlite: SqliteBridgeActionMap
    // Span-index transcript search (the Ctrl+K global search dialog). See
    // ./search.ts.
    search: SearchBridgeActionMap
    // Browser-global prefs + app metadata, outside the SharedWorker's
    // settings.json domain.
    systemPrefs: SystemPrefsBridgeActionMap
    appInfo: AppInfoBridgeActionMap
    // The browser theme (Settings · Appearance, PROFILE prefs via
    // ThemeService) and the UI language (Settings · General,
    // `intl.app_locale` in LOCAL STATE — it is not registered on a profile).
    // Write-only in effect — the repaint arrives over the existing
    // `nexus-theme` push from the panel. See ./appearance.ts.
    appearance: AppearanceBridgeActionMap
    // Browser-tool settings (Tools · Browser) + the provider network/keychain
    // probes (Models page).
    browserTools: BrowserToolsBridgeActionMap
    // The C++ providers adapter (`api/declarations/providers/`) under the
    // non-colliding wire name `providerAuth` — the worker keeps `providers`.
    // (The chrome:// panel port registers the same adapter as `providers`.)
    providerAuth: ProviderAuthBridgeActionMap
    // The desktop's embedded-relay status + configure (WP-5 remote access).
    // Runtime-only, manifest-gated; NOT in hostProxyTable. See
    // ./remoteAccess.ts.
    remoteAccess: RemoteAccessBridgeActionMap
    // Namespaced, origin-bound secrets sealed by the host; set / has /
    // delete / listNames — no get. Substituted only into a network request
    // to the secret's origin. See ./secrets.ts.
    secrets: SecretsBridgeActionMap
    // Persisted wall-clock alarms + the alarms.onAlarm event; a fire with no
    // runtime connected is queued and boots one. See ./alarms.ts.
    alarms: AlarmsBridgeActionMap
    // Single-web windows owned by this connection (F-29). See ./webWindow.ts.
    webWindow: WebWindowBridgeActionMap
    // Script channels to a window above or a tab in this Nexus window (F-29).
    // See ./pageScript.ts.
    pageScript: PageScriptBridgeActionMap
  }

export type WorkerCapabilityMap = {
  // `features` and `agent` — see `src/browser/bridge/adapter/
  // featuresBridgeAdapter.ts` and `agentBridgeAdapter.ts`.
  features: FeaturesBridgeActionMap
  agent: AgentBridgeActionMap
  // The General settings page's profile section (identity + per-user agent
  // instructions + appearance prefs). Same settings.json file as
  // `agent`/`features`.
  profile: ProfileBridgeActionMap
  // The Settings → Memory page's auto-memory toggles + directory override.
  memory: MemoryBridgeActionMap
  // The Settings → Session models page: the cross-provider tier dictionary +
  // per-session-type model routing.
  sessionModels: SessionModelsBridgeActionMap
  mcpSettings: McpSettingsBridgeActionMap
  plugins: PluginsBridgeActionMap
  // Remote Agent-Skill install into `~/.velloc/skills/`. Backs the Skills
  // marketplace on the Features page.
  skills: SkillsBridgeActionMap
  // Import sessions from another agent product's on-disk transcripts
  // (parsing runs in the dedicated import Worker). Backs the topbar Import
  // dialog. See ./sessionImport.ts.
  sessionImport: SessionImportBridgeActionMap
  // Provider persistence in settings.json. Not the C++ providers adapter —
  // that one is `providerAuth` above.
  providers: ProvidersBridgeActionMap
}

export type BrowserBridgeCapabilityMap = NativeCapabilityMap & WorkerCapabilityMap

export type NativeCapability = keyof NativeCapabilityMap
export type WorkerCapability = keyof WorkerCapabilityMap

/**
 * Every native capability → the `api/declarations/` directory its actions
 * are declared in, or `null` when it has none. A `Record` over the type, so
 * adding a native capability without a row here fails `tsc`.
 */
export const NATIVE_CAPABILITY_DECLARATION_DIRS: Readonly<
  Record<NativeCapability, string | null>
> = {
  alarms: 'alarms',
  appInfo: 'app_info',
  webWindow: 'web_window',
  pageScript: 'page_script',
  appearance: 'appearance',
  browserTools: 'browser_tools',
  fs: 'fs',
  model: 'llm',
  network: 'network',
  providerAuth: 'providers',
  remoteAccess: 'remote_access',
  search: 'search',
  secrets: 'secrets',
  session: 'session',
  shell: 'shell',
  sqlite: 'sqlite',
  systemPrefs: 'system_prefs',
  ui: 'ui',
  // The tool catalog: actions are registered per build from
  // `BrowserTool::DefineTools`, not declared as *.api.json.
  browser: 'browser',
  files: 'files',
  exec: 'exec',
}

export const NATIVE_CAPABILITIES = Object.keys(
  NATIVE_CAPABILITY_DECLARATION_DIRS,
) as readonly NativeCapability[]

/** Exhaustive by construction (a `Record` over the type, as above). */
const WORKER_CAPABILITY_SET: Readonly<Record<WorkerCapability, true>> = {
  features: true,
  agent: true,
  profile: true,
  memory: true,
  sessionModels: true,
  mcpSettings: true,
  plugins: true,
  skills: true,
  sessionImport: true,
  providers: true,
}

export const WORKER_CAPABILITIES = Object.keys(
  WORKER_CAPABILITY_SET,
) as readonly WorkerCapability[]

export type BrowserBridgeCapability = keyof BrowserBridgeCapabilityMap

export type BrowserBridgeAction<C extends BrowserBridgeCapability> =
  C extends BrowserBridgeCapability
    ? Extract<keyof BrowserBridgeCapabilityMap[C], string>
    : never

type BrowserBridgeDefinition<
  C extends BrowserBridgeCapability,
  A extends BrowserBridgeAction<C>,
> = C extends BrowserBridgeCapability
  ? A extends BrowserBridgeAction<C>
    ? BrowserBridgeCapabilityMap[C][A] extends {
        payload: infer P
        result: infer R
      }
      ? { payload: P; result: R }
      : never
    : never
  : never

export type BrowserBridgeRoute<
  C extends BrowserBridgeCapability = BrowserBridgeCapability,
  A extends BrowserBridgeAction<C> = BrowserBridgeAction<C>,
> = {
  namespace: 'nexus'
  capability: C
  action: A
}

export function createBridgeRoute<
  C extends BrowserBridgeCapability,
  A extends BrowserBridgeAction<C>,
>(capability: C, action: A): BrowserBridgeRoute<C, A> {
  return {
    namespace: 'nexus',
    capability,
    action,
  }
}

export function formatBridgeRoute(route: BrowserBridgeRoute): string {
  return `${route.namespace}/${route.capability}/${route.action}`
}

export type BrowserBridgeRequestPayload<
  C extends BrowserBridgeCapability,
  A extends BrowserBridgeAction<C>,
> = BrowserBridgeDefinition<C, A>['payload']

export type BrowserBridgeResult<
  C extends BrowserBridgeCapability,
  A extends BrowserBridgeAction<C>,
> = BrowserBridgeDefinition<C, A>['result']

/**
 * The frame-level call context, sent next to `payload`. Advisory and
 * guest-reported: the host uses it for routing (which tool session a call
 * belongs to) and attribution (the audit log), never for authorization.
 * Only `sessionId` exists today; the object is the place future fields go.
 */
export type BridgeCallContext = {
  sessionId?: string
}

export type BrowserBridgeRequest<
  C extends BrowserBridgeCapability = BrowserBridgeCapability,
  A extends BrowserBridgeAction<C> = BrowserBridgeAction<C>,
> = {
  id: string
  route: BrowserBridgeRoute<C, A>
  payload: BrowserBridgeRequestPayload<C, A>
  context?: BridgeCallContext
}

export type BrowserBridgeSuccessResponse<
  C extends BrowserBridgeCapability = BrowserBridgeCapability,
  A extends BrowserBridgeAction<C> = BrowserBridgeAction<C>,
> = {
  id: string
  route: BrowserBridgeRoute<C, A>
  ok: true
  result: BrowserBridgeResult<C, A>
}

export type BrowserBridgeError = {
  code: string
  message: string
  data?: unknown
}

export type BrowserBridgeErrorResponse<
  C extends BrowserBridgeCapability = BrowserBridgeCapability,
  A extends BrowserBridgeAction<C> = BrowserBridgeAction<C>,
> = {
  id: string
  route: BrowserBridgeRoute<C, A>
  ok: false
  error: BrowserBridgeError
}

export type BrowserBridgeResponse<
  C extends BrowserBridgeCapability = BrowserBridgeCapability,
  A extends BrowserBridgeAction<C> = BrowserBridgeAction<C>,
> = BrowserBridgeSuccessResponse<C, A> | BrowserBridgeErrorResponse<C, A>

// Bridge event envelope. Streaming actions (currently only
// `process.spawn`) deliver out-of-band updates — `stdout` / `stderr`
// chunks, `exit`, `error` — as `direction: "event"` JSON (+ transferred
// binary ports) on the same direct port. See
// `NexusBridgeResponseDelegate::SendEvent` in P-7.
export type BridgeEventEnvelope<
  C extends BrowserBridgeCapability = BrowserBridgeCapability,
  A extends BrowserBridgeAction<C> = BrowserBridgeAction<C>,
> = {
  route: BrowserBridgeRoute<C, A>

  // Correlation id of the originating request (e.g. the spawn call
  // that produced this stream). Consumers filter by route + id +
  // handleId depending on their subscription granularity.
  id?: string

  // Decoded payload. For routes with binary side-ports, the transport
  // layer stitches transferred `Uint8Array`s into the event payload
  // before dispatching, so consumers receive a fully-typed event.
  payload: unknown
}

export type BridgeEventHandler = (event: BridgeEventEnvelope) => void
export type BridgeEventUnsubscribe = () => void

export interface BrowserBridgeTransport {
  request<
    C extends BrowserBridgeCapability,
    A extends BrowserBridgeAction<C>,
  >(request: BrowserBridgeRequest<C, A>): Promise<BrowserBridgeResponse<C, A>>

  // Subscribe to `direction: "event"` envelopes on this transport.
  // Returns an unsubscribe function. Transports without streaming
  // support (the in-memory local transport, for one) may omit this
  // method; callers should treat it as best-effort.
  subscribeEvents?(handler: BridgeEventHandler): BridgeEventUnsubscribe

  /**
   * This transport answers the model request routes (`model.call` /
   * `streamStart` / `streamRead` / `streamCancel`) itself, so
   * `withModelProviders` (providerDrivers/driverTransport.ts) must not wrap
   * it. Only a unit test's scripted stream sets it; in the product those
   * routes are always served by the provider drivers.
   */
  readonly servesModelRoutes?: boolean
}

// Test-oriented extension. `createLocalBrowserBridgeTransport` supports
// an explicit `emitEvent` so handlers that produce streaming output
// (e.g. the `NodeRuntimeProcessHarness` in PR 6) can push events back
// through the same transport the consumer subscribes to, without any
// real port/IPC.
export interface LocalBrowserBridgeTransport extends BrowserBridgeTransport {
  emitEvent(event: BridgeEventEnvelope): void
  subscribeEvents(handler: BridgeEventHandler): BridgeEventUnsubscribe
}

export type BrowserBridgeHandlerTree = {
  [C in BrowserBridgeCapability]?: {
    [A in BrowserBridgeAction<C>]?: (
      payload: BrowserBridgeRequestPayload<C, A>,
    ) => Promise<BrowserBridgeResult<C, A>> | BrowserBridgeResult<C, A>
  }
}

export type BrowserBridgeMethod = {
  [C in BrowserBridgeCapability]: {
    [A in BrowserBridgeAction<C>]: `${C}.${A}`
  }[BrowserBridgeAction<C>]
}[BrowserBridgeCapability]

type CapabilityForMethod<M extends BrowserBridgeMethod> =
  M extends `${infer C}.${string}` ? Extract<C, BrowserBridgeCapability> : never

type ActionForMethod<M extends BrowserBridgeMethod> =
  M extends `${string}.${infer A}`
    ? A extends BrowserBridgeAction<CapabilityForMethod<M>>
      ? A
      : never
    : never

export type BrowserBridgeFlatHandlers = {
  [M in BrowserBridgeMethod]?: (
    payload: BrowserBridgeRequestPayload<
      CapabilityForMethod<M>,
      ActionForMethod<M>
    >,
  ) => Promise<
    BrowserBridgeResult<CapabilityForMethod<M>, ActionForMethod<M>>
  > | BrowserBridgeResult<CapabilityForMethod<M>, ActionForMethod<M>>
}

export type BrowserBridgeHandlers =
  | BrowserBridgeHandlerTree
  | BrowserBridgeFlatHandlers

function getNestedHandler<
  C extends BrowserBridgeCapability,
  A extends BrowserBridgeAction<C>,
>(
  handlers: BrowserBridgeHandlers,
  route: BrowserBridgeRoute<C, A>,
):
  | ((
      payload: BrowserBridgeRequestPayload<C, A>,
    ) => Promise<BrowserBridgeResult<C, A>> | BrowserBridgeResult<C, A>)
  | undefined {
  const capabilityHandlers = (handlers as Partial<BrowserBridgeHandlerTree>)[
    route.capability
  ] as BrowserBridgeHandlerTree[C] | undefined

  return capabilityHandlers?.[route.action] as
    | ((
        payload: BrowserBridgeRequestPayload<C, A>,
      ) => Promise<BrowserBridgeResult<C, A>> | BrowserBridgeResult<C, A>)
    | undefined
}

function getFlatHandler<
  C extends BrowserBridgeCapability,
  A extends BrowserBridgeAction<C>,
>(
  handlers: BrowserBridgeHandlers,
  route: BrowserBridgeRoute<C, A>,
):
  | ((
      payload: BrowserBridgeRequestPayload<C, A>,
    ) => Promise<BrowserBridgeResult<C, A>> | BrowserBridgeResult<C, A>)
  | undefined {
  const flatKey = `${route.capability}.${route.action}` as BrowserBridgeMethod
  return (handlers as BrowserBridgeFlatHandlers)[flatKey] as
    | ((
        payload: BrowserBridgeRequestPayload<C, A>,
      ) => Promise<BrowserBridgeResult<C, A>> | BrowserBridgeResult<C, A>)
    | undefined
}

export function createLocalBrowserBridgeTransport(
  handlers: BrowserBridgeHandlers,
): LocalBrowserBridgeTransport {
  const listeners = new Set<BridgeEventHandler>()

  return {
    async request<
      C extends BrowserBridgeCapability,
      A extends BrowserBridgeAction<C>,
    >(
      request: BrowserBridgeRequest<C, A>,
    ): Promise<BrowserBridgeResponse<C, A>> {
      try {
        const handler =
          getNestedHandler(handlers, request.route) ??
          getFlatHandler(handlers, request.route)

        if (!handler) {
          throw new Error(
            `No bridge handler registered for ${formatBridgeRoute(request.route)}`,
          )
        }

        const result = await handler(request.payload)
        return {
          id: request.id,
          route: request.route,
          ok: true,
          result,
        } as BrowserBridgeResponse<C, A>
      } catch (error) {
        return {
          id: request.id,
          route: request.route,
          ok: false,
          error: {
            code: 'bridge_handler_error',
            message:
              error instanceof Error ? error.message : 'Unknown bridge error',
            data: error,
          },
        } as BrowserBridgeResponse<C, A>
      }
    },

    subscribeEvents(handler: BridgeEventHandler): BridgeEventUnsubscribe {
      listeners.add(handler)
      return () => {
        listeners.delete(handler)
      }
    },

    emitEvent(event: BridgeEventEnvelope): void {
      // Snapshot so a listener that unsubscribes itself mid-dispatch
      // doesn't shift the iteration. Errors in one listener must not
      // stop the rest — matches the `postMessage` → `onmessage` fan-out
      // semantics the direct port uses in production.
      for (const handler of Array.from(listeners)) {
        try {
          handler(event)
        } catch {
          /* intentionally swallowed, see comment above */
        }
      }
    },
  }
}
