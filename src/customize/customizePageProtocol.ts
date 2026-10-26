/**
 * The Customize page on the runtime protocol (F-35). The runtime owns this
 * window's `customize` utility tab and a page-script channel to it; a client
 * asks `customizePage.show` / `customizePage.navigate`, installs the item the
 * page shows with `customizePage.addPageItem`, and reads topic
 * `customizePage/status` for where the page is and that item. All are
 * `full`: they drive this window's own tab strip and native view and install
 * onto this machine, which a remote client does not reach.
 */
import type { ScopeMode } from '../browser/runtimeProtocol'
import type { DirectoryPageItem } from './directoryOffer'
import {
  DIRECTORY_CONSENT_COOKIE,
  DIRECTORY_CONSENT_REFUSED,
  DIRECTORY_CONSENT_REJECT_SELECTOR,
  DIRECTORY_HEADER_SIGN_IN_SELECTOR,
  DIRECTORY_SITE_HOST,
} from './directorySite'

export const CUSTOMIZE_PAGE_CAPABILITY = 'customizePage'
export const CUSTOMIZE_PAGE_STATUS_TOPIC = 'customizePage/status'
/** The `type` of the snapshot and of every delta. */
export const CUSTOMIZE_PAGE_STATUS_EVENT = 'state'
export const CUSTOMIZE_PAGE_TOPIC_SCOPE: ScopeMode = 'full'

export const CUSTOMIZE_PAGE_ACTION_SCOPES = {
  show: 'full',
  navigate: 'full',
  addPageItem: 'full',
} as const satisfies Record<string, ScopeMode>
export type CustomizePageAction = keyof typeof CUSTOMIZE_PAGE_ACTION_SCOPES

/** The utility tab's key: one tab per window, reused across opens. */
export const CUSTOMIZE_TAB_KEY = 'customize'

/**
 * The whole state, published on every change. `available` is false while the
 * runtime has no host port. `tabId` is the utility tab once shown; `path` is
 * the page's own location as its channel last reported it (absent on a host
 * without the page channel, or before the first report). `pageItem` is the
 * plugin or connector that path shows, while it shows one.
 */
export type CustomizePageState = {
  available: boolean
  tabId?: number
  path?: string
  pageItem?: DirectoryPageItem
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

/** `addPageItem` takes exactly `{ id }`, the page item's id. */
export function isCustomizePageItemPayload(value: unknown): value is { id: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return Object.keys(record).length === 1 && Number.isSafeInteger(record.id)
}

const ITEM_KINDS = new Set(['plugin', 'connector'])
const ITEM_PHASES = new Set(['resolving', 'ready', 'installing', 'installed', 'failed'])

function readPageItem(value: unknown): DirectoryPageItem | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (!Number.isSafeInteger(v.id) || !ITEM_KINDS.has(v.kind as string) || !ITEM_PHASES.has(v.phase as string)) {
    return null
  }
  const details = v.details as Record<string, unknown> | undefined
  if (details !== undefined && (typeof details !== 'object' || details === null || typeof details.name !== 'string')) {
    return null
  }
  if (v.installedAs !== undefined && typeof v.installedAs !== 'string') return null
  return value as DirectoryPageItem
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
  if (v.pageItem !== undefined) {
    const pageItem = readPageItem(v.pageItem)
    if (!pageItem) return null
    state.pageItem = pageItem
  }
  return state
}

/** The page script's one message: where the page is. */
export function readRouteReport(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null
  const record = data as Record<string, unknown>
  return record.type === 'route' && typeof record.path === 'string' ? record.path : null
}

/** The directory's start page. */
export const DIRECTORY_HOME_PATH = '/directory'

/**
 * Contract: runs in the channel's private world of the utility tab (F-35):
 * - reports the page's path now and whenever it changes;
 * - writes the site's cookie-preference cookie with optional cookies off
 *   before its banner reads it, and presses the banner's reject button if
 *   the banner shows anyway;
 * - hides the header's sign-in link;
 * - keeps the page off `/login`: a cancelable navigation there is stopped
 *   (the page stays on the item it shows, whose Add is Velloc's); a document
 *   that lands there anyway is replaced by the directory page the tab last
 *   showed (kept in the tab's session storage), else by its `returnTo` when
 *   that is a directory page, else by the start page. Nothing is installed.
 * The page is a single-page app whose history calls happen in its own world,
 * so navigations are watched (navigate events, the location), not wrapped.
 * Runs in the top document only, and once per document (an init script and
 * a direct run in one document start once).
 */
export const DIRECTORY_PAGE_SCRIPT = `(() => {
  const g = globalThis;
  if (g.top !== g || g.__vellocDirectoryPage) return;
  g.__vellocDirectoryPage = true;
  const HOME = ${JSON.stringify(DIRECTORY_HOME_PATH)};
  const SHOWN_KEY = 'velloc-directory-shown';
  const isDirectoryPath = path => /^\\/(directory|customize\\/plugins)(\\/|$)/.test(path) && !path.startsWith('//');
  const CONSENT = ${JSON.stringify(DIRECTORY_CONSENT_COOKIE)};
  const SITE = ${JSON.stringify(DIRECTORY_SITE_HOST)};
  const STYLE_ID = 'velloc-directory-style';
  const STYLE = ${JSON.stringify(DIRECTORY_HEADER_SIGN_IN_SELECTOR + ' { display: none !important; }')};
  const send = message => { try { vellocHost.send(message); } catch {} };
  if (!document.cookie.split(/;\\s*/).some(c => c.startsWith(CONSENT + '='))) {
    const host = location.hostname;
    const domain = host === SITE || host.endsWith('.' + SITE) ? '; domain=.' + SITE : '';
    const secure = location.protocol === 'https:' ? '; secure' : '';
    document.cookie = CONSENT + '=' + encodeURIComponent(${JSON.stringify(DIRECTORY_CONSENT_REFUSED)}) +
      '; path=/; max-age=31536000; samesite=lax' + secure + domain;
  }
  const loginOf = href => {
    let url;
    try { url = new URL(href, location.href); } catch { return null; }
    if (url.origin !== location.origin) return null;
    return url.pathname === '/login' || url.pathname.startsWith('/login/') ? url : null;
  };
  const shown = () => { try { return sessionStorage.getItem(SHOWN_KEY) || ''; } catch { return ''; } };
  const remember = () => {
    const page = location.pathname + location.search;
    if (isDirectoryPath(page)) try { sessionStorage.setItem(SHOWN_KEY, page); } catch {}
  };
  const leaveLogin = url => {
    const kept = shown();
    const back = url.searchParams.get('returnTo') || '';
    const target = isDirectoryPath(kept) ? kept : isDirectoryPath(back) ? back : HOME;
    location.replace(location.origin + target);
  };
  const tidy = () => {
    if (!document.getElementById(STYLE_ID) && document.documentElement) {
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = STYLE;
      (document.head || document.documentElement).appendChild(style);
    }
    const reject = document.querySelector(${JSON.stringify(DIRECTORY_CONSENT_REJECT_SELECTOR)});
    if (reject) reject.click();
  };
  let last = '';
  const watch = () => {
    tidy();
    const login = loginOf(location.href);
    if (login) {
      if (last !== login.href) { last = login.href; leaveLogin(login); }
      return;
    }
    remember();
    const path = location.pathname;
    if (path === last) return;
    last = path;
    send({ type: 'route', path });
  };
  if (g.navigation && typeof g.navigation.addEventListener === 'function') {
    g.navigation.addEventListener('navigate', event => {
      if (event.cancelable && loginOf(event.destination.url)) event.preventDefault();
    });
  }
  addEventListener('popstate', watch);
  addEventListener('hashchange', watch);
  addEventListener('DOMContentLoaded', watch);
  setInterval(watch, 400);
  watch();
})();`
