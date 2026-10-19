/**
 * Security: every C++ route a client may reach through the runtime, with its scope; typed against
 * `BrowserBridgeCapabilityMap`, so an unknown route fails `tsc`. Rows below `full` are reads a remote
 * observer needs; a new row defaults to `control`, and a `full` row must say why.
 * `search.queryTranscripts` is `control`, guarded below `full` by `searchTargetsGuard`.
 * `providerAuth.*` is `manager`; `setWebappUrl` and `relaunch` stay `full`.
 */
import type {
  BrowserBridgeAction,
  BrowserBridgeCapability,
} from '../bridge/protocol/core'
import type { ScopeMode } from '../runtimeProtocol'
import { searchTargetsGuard } from './searchTargetsGuard'
import type { ActionSpec, HostProxySpec } from './types'

type HostProxyTable = {
  readonly [C in BrowserBridgeCapability]?: Partial<Record<BrowserBridgeAction<C>, ScopeMode>>
}

export const HOST_PROXY_TABLE = {
  // Desktop chrome: dialogs, windows, the OS notification centre, the inspect
  // menu. A remote client has its own chrome for each; the boot
  // timings and provider-missing prompt describe THIS window's boot.
  ui: {
    pickProjectFolder: 'full',
    pickAttachmentFiles: 'full',
    revealProjectFolder: 'full',
    openUrl: 'full',
    showNotification: 'full',
    setActiveSessionTitle: 'full',
    setWindowDragRegions: 'full',
    openNexusSettings: 'full',
    openLanguageSettings: 'full',
    // A tab in THIS window's strip, shown by this window's own browser pane.
    openSessionTab: 'full',
    activateSessionTab: 'full',
    closeSessionTab: 'full',
    navigateSessionTab: 'full',
    getBootTimings: 'full',
    getProviderMissingPrompt: 'full',
    getInspectMenuEnabled: 'full',
    setInspectMenuEnabled: 'full',
  },
  // UI language of this Velloc install (host-side: the binary's next-launch
  // locale). The theme is per-client now: resolveTheme is a PURE resolver —
  // the client posts its own (scheme, seed, variant) and gets colours back;
  // no pref is written and no other client is repainted, so any client —
  // an observer included — may resolve its own view (`observe`).
  appearance: {
    getAppearance: 'full',
    resolveTheme: 'observe',
    setUiLocale: 'full',
  },
  // OS-level launcher / background-mode switches of the host machine.
  systemPrefs: {
    get: 'full',
    setLauncher: 'full',
    setBackgroundMode: 'full',
  },
  // The version is a read any client may show; the webapp URL is the
  // desktop's own config — readable by a manager, writable only locally —
  // and relaunch restarts the host machine's browser.
  appInfo: {
    getVersionInfo: 'observe',
    getWebappUrl: 'manager',
    setWebappUrl: 'full',
    relaunch: 'full',
  },
  // Provider credentials live on the host; OAuth opens a host browser window.
  // A manager may hold provider keys, so the whole capability is manager-level.
  providerAuth: {
    list: 'manager',
    oauthStatus: 'manager',
    beginOAuth: 'manager',
    verify: 'manager',
    refresh: 'manager',
    reset: 'manager',
  },
  // Drives the host browser's own tabs (the browser-actor tools' page side).
  browserTools: {
    snapshot: 'full',
    setField: 'full',
  },
  // Raw SQL against host files — no root or session constraint applies.
  sqlite: {
    open: 'full',
    query: 'full',
    execute: 'full',
    batch: 'full',
    close: 'full',
  },
  // Which session the host window's native tab strip shows — a property of
  // THIS window.
  session: {
    setActiveSession: 'full',
  },
  // Payload-guarded below `full` — see the header and HOST_PROXY_GUARDS.
  search: {
    queryTranscripts: 'control',
  },
} as const satisfies HostProxyTable

/** Payload guards for rows whose payload a client could aim beyond its grant. */
export const HOST_PROXY_GUARDS: Readonly<
  Partial<Record<string, Readonly<Partial<Record<string, NonNullable<ActionSpec['guard']>>>>>>
> = {
  search: { queryTranscripts: searchTargetsGuard },
}

/** The table as `registerHostProxy` specs — one per capability. */
export function hostProxySpecs(table: HostProxyTable = HOST_PROXY_TABLE): HostProxySpec[] {
  return Object.entries(table).map(([cap, actions]) => ({
    cap,
    actions: Object.fromEntries(
      Object.entries(actions as Record<string, ScopeMode>).map(([act, scope]) => {
        const guard = HOST_PROXY_GUARDS[cap]?.[act]
        return [act, guard ? { scope, guard } : { scope }]
      }),
    ),
  }))
}

/** How many routes the table exposes — pinned by the tests against the plan's count. */
export function hostProxyRouteCount(table: HostProxyTable = HOST_PROXY_TABLE): number {
  return Object.values(table).reduce<number>(
    (sum, actions) => sum + Object.keys(actions as object).length,
    0,
  )
}
