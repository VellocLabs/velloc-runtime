/**
 * The Customize page on the runtime protocol (F-35). The runtime owns this
 * window's `customize` utility tab and a page-script channel to it; a client
 * asks `customizePage.show` / `customizePage.navigate` and reads topic
 * `customizePage/status` for where the page is. All three are `full`: they
 * drive this window's own tab strip and native view, which a remote client
 * does not have.
 */
import type { ScopeMode } from '../browser/runtimeProtocol'

export const CUSTOMIZE_PAGE_CAPABILITY = 'customizePage'
export const CUSTOMIZE_PAGE_STATUS_TOPIC = 'customizePage/status'
/** The `type` of the snapshot and of every delta. */
export const CUSTOMIZE_PAGE_STATUS_EVENT = 'state'
export const CUSTOMIZE_PAGE_TOPIC_SCOPE: ScopeMode = 'full'

export const CUSTOMIZE_PAGE_ACTION_SCOPES = {
  show: 'full',
  navigate: 'full',
} as const satisfies Record<string, ScopeMode>
export type CustomizePageAction = keyof typeof CUSTOMIZE_PAGE_ACTION_SCOPES

/** The utility tab's key: one tab per window, reused across opens. */
export const CUSTOMIZE_TAB_KEY = 'customize'

/**
 * The whole state, published on every change. `available` is false while the
 * runtime has no host port. `tabId` is the utility tab once shown; `path` is
 * the page's own location as its channel last reported it (absent on a host
 * without the page channel, or before the first report).
 */
export type CustomizePageState = {
  available: boolean
  tabId?: number
  path?: string
}

/** What `show` answers. */
export type CustomizePageShowResult = { tabId: number; created: boolean }

/** `show` and `navigate` take exactly `{ url }`, an http(s) URL. */
export function isCustomizePageUrlPayload(value: unknown): value is { url: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (Object.keys(record).length !== 1 || typeof record.url !== 'string') return false
  try {
    const url = new URL(record.url)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/** A payload from the topic that is the shape a page reads, or null. */
export function readCustomizePageState(value: unknown): CustomizePageState | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (typeof v.available !== 'boolean') return null
  const state: CustomizePageState = { available: v.available }
  if (v.tabId !== undefined) {
    if (typeof v.tabId !== 'number') return null
    state.tabId = v.tabId
  }
  if (v.path !== undefined) {
    if (typeof v.path !== 'string') return null
    state.path = v.path
  }
  return state
}

/** The one message the page channel's script sends: where the page is. */
export function readRouteReport(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null
  const record = data as Record<string, unknown>
  return record.type === 'route' && typeof record.path === 'string' ? record.path : null
}

/**
 * Runs in the channel's private world of the utility tab: reports the page's
 * path now and whenever it changes. The page is a single-page app whose
 * history calls happen in its own world, so the location is watched, not
 * wrapped. Guarded so an init script and a direct run in one document start
 * one watcher.
 */
export const ROUTE_REPORT_SCRIPT = `(() => {
  const g = globalThis;
  if (g.__vellocRouteWatch) return;
  g.__vellocRouteWatch = true;
  let last = '';
  const report = () => {
    const path = location.pathname;
    if (path === last) return;
    last = path;
    try { vellocHost.send({ type: 'route', path }); } catch {}
  };
  addEventListener('popstate', report);
  addEventListener('hashchange', report);
  setInterval(report, 400);
  report();
})();`
