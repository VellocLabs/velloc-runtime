/**
 * The Customize page on the runtime protocol (F-35). The runtime owns this
 * window's `customize` utility tab and a page-script channel to it; a client
 * asks `show` / `navigate`, installs or removes the item the page shows with
 * `addPageItem` / `removePageItem`, and reads topic `customizePage/status`.
 * All are `full`: they drive this window's own tab strip and native view and
 * change this machine, which a remote client does not reach.
 */
import type { ScopeMode } from '../browser/runtimeProtocol'
import type { DirectoryItemDetails, DirectoryPageItem } from './directoryOffer'
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
  back: 'full',
  addPageItem: 'full',
  removePageItem: 'full',
  describeMarketplace: 'full',
} as const satisfies Record<string, ScopeMode>
export type CustomizePageAction = keyof typeof CUSTOMIZE_PAGE_ACTION_SCOPES

/** The utility tab's key: one tab per window, reused across opens. */
export const CUSTOMIZE_TAB_KEY = 'customize'

/**
 * The whole state, published on every change. `available`: the runtime has
 * a host port. `tabId`: the utility tab once shown. `path` / `canGoBack`:
 * where the page is and whether it has an earlier entry, as its channel
 * last reported (absent without the channel). `pageItem`: the plugin or
 * connector that path shows. `addRequest`: the page's own add button asking
 * for `pageItem`; a client confirms it with the person once per `seq`.
 */
export type CustomizePageState = {
  available: boolean
  tabId?: number
  path?: string
  canGoBack?: boolean
  pageItem?: DirectoryPageItem
  addRequest?: CustomizeAddRequest
}

/** `seq` grows with each request; `itemId` is the page item it asks for. */
export type CustomizeAddRequest = { seq: number; itemId: number }

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

/** `addPageItem` and `removePageItem` take exactly `{ id }`, the page item's id. */
export function isCustomizePageItemPayload(value: unknown): value is { id: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return Object.keys(record).length === 1 && Number.isSafeInteger(record.id)
}

/** `back` takes an empty object. */
export function isCustomizePageEmptyPayload(value: unknown): value is Record<string, never> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0
}

/** `describeMarketplace` takes exactly `{ marketplace }`, a marketplace name. */
export function isCustomizeMarketplacePayload(value: unknown): value is { marketplace: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    Object.keys(record).length === 1 &&
    typeof record.marketplace === 'string' &&
    record.marketplace.length > 0 &&
    record.marketplace.length <= 200
  )
}

/** What `describeMarketplace` answers: the directory's details per plugin name, for the plugins it carries. */
export type CustomizeMarketplaceDescription = { plugins: Record<string, DirectoryItemDetails> }

const ITEM_KINDS = new Set(['plugin', 'connector'])
const ITEM_PHASES = new Set(['resolving', 'ready', 'installing', 'installed', 'removing', 'failed'])

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
  if (v.unsupported !== undefined && v.unsupported !== 'needs_registered_client') return null
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
  if (v.canGoBack !== undefined) {
    if (typeof v.canGoBack !== 'boolean') return null
    state.canGoBack = v.canGoBack
  }
  if (v.pageItem !== undefined) {
    const pageItem = readPageItem(v.pageItem)
    if (!pageItem) return null
    state.pageItem = pageItem
  }
  if (v.addRequest !== undefined) {
    const request = v.addRequest as Record<string, unknown> | null
    if (!request || !Number.isSafeInteger(request.seq) || !Number.isSafeInteger(request.itemId)) return null
    state.addRequest = { seq: request.seq as number, itemId: request.itemId as number }
  }
  return state
}

/**
 * What the page script says:
 * - `route`: where the page is (`path`; `href`, the whole address; whether
 *   it has an earlier entry of its own);
 * - `add`: the page's own add or sign-in-to-add button was pressed and the
 *   sign-in navigation stopped; `returnTo` is the page it would come back to;
 * - `external`: a navigation to another site was stopped; `url` is where it went.
 */
export type DirectoryPageMessage =
  | { type: 'route'; path: string; href?: string; canGoBack?: boolean }
  | { type: 'add'; returnTo: string }
  | { type: 'external'; url: string }

/** A page-script message of a known shape, or null. */
export function readPageMessage(data: unknown): DirectoryPageMessage | null {
  if (typeof data !== 'object' || data === null) return null
  const record = data as Record<string, unknown>
  if (record.type === 'route' && typeof record.path === 'string') {
    return {
      type: 'route',
      path: record.path,
      ...(typeof record.href === 'string' ? { href: record.href } : {}),
      ...(typeof record.canGoBack === 'boolean' ? { canGoBack: record.canGoBack } : {}),
    }
  }
  if (record.type === 'add') return { type: 'add', returnTo: typeof record.returnTo === 'string' ? record.returnTo : '' }
  if (record.type === 'external' && typeof record.url === 'string') return { type: 'external', url: record.url }
  return null
}

/** The path of a route report, or null for any other message. */
export function readRouteReport(data: unknown): string | null {
  const message = readPageMessage(data)
  return message?.type === 'route' ? message.path : null
}

/** The directory's start page. */
export const DIRECTORY_HOME_PATH = '/directory'

/**
 * Contract: runs in the channel's private world of the utility tab (F-35):
 * - reports the page's path, address and whether it can go back, now and
 *   whenever one changes;
 * - writes the site's cookie-preference cookie with optional cookies off
 *   before its banner reads it, and presses the banner's reject button if
 *   the banner shows anyway;
 * - hides the header's sign-in link;
 * - keeps the page off `/login`: a cancelable navigation there (or a click
 *   on a link there) is stopped and reported as `add`, so the page stays on
 *   the item it shows and Velloc asks to add it; a document that lands
 *   there anyway reports `add` too and is replaced by the directory page
 *   the tab last showed (kept in the tab's session storage), else by its
 *   `returnTo` when that is a directory page, else by the start page.
 *   Nothing is installed by the script;
 * - keeps the page on its site: a cancelable navigation to another origin
 *   (or a click on a link to one, in any target) is stopped and reported as
 *   `external`, once per address within a second.
 * The page is a single-page app whose history calls happen in its own world,
 * so navigations are watched (navigate events, clicks, the location), not
 * wrapped.
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
  const foreignOf = href => {
    let url;
    try { url = new URL(href, location.href); } catch { return null; }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin !== location.origin ? url : null;
  };
  const askToAdd = url => send({ type: 'add', returnTo: url.searchParams.get('returnTo') || '' });
  let opened = { href: '', at: 0 };
  const openElsewhere = url => {
    const now = Date.now();
    if (opened.href === url.href && now - opened.at < 1000) return;
    opened = { href: url.href, at: now };
    send({ type: 'external', url: url.href });
  };
  const canGoBack = () => {
    try { return g.navigation ? !!g.navigation.canGoBack : history.length > 1; } catch { return false; }
  };
  const leaveLogin = url => {
    askToAdd(url);
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
    const back = canGoBack();
    const key = location.href + ' ' + back;
    if (key === last) return;
    last = key;
    send({ type: 'route', path, href: location.href, canGoBack: back });
  };
  if (g.navigation && typeof g.navigation.addEventListener === 'function') {
    g.navigation.addEventListener('navigate', event => {
      if (!event.cancelable) return;
      const login = loginOf(event.destination.url);
      if (login) {
        event.preventDefault();
        askToAdd(login);
        // A route rendered before its URL was refused leaves the sign-in view
        // on this address; the page is loaded again.
        const title = document.title;
        setTimeout(() => { if (document.title !== title) location.replace(location.href); }, 300);
        return;
      }
      const foreign = foreignOf(event.destination.url);
      if (foreign) { event.preventDefault(); openElsewhere(foreign); }
    });
  }
  // The page's router renders a route before it commits the URL, so a link it
  // must not follow is stopped at the click, before the page's own handler.
  const swallow = event => { event.preventDefault(); event.stopImmediatePropagation(); };
  const onLink = event => {
    if (event.defaultPrevented || (event.button !== 0 && event.button !== 1)) return;
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!link) return;
    const login = loginOf(link.href);
    if (login) { swallow(event); askToAdd(login); return; }
    const foreign = foreignOf(link.href);
    if (foreign) { swallow(event); openElsewhere(foreign); }
  };
  addEventListener('click', onLink, true);
  addEventListener('auxclick', onLink, true);
  addEventListener('popstate', watch);
  addEventListener('hashchange', watch);
  addEventListener('DOMContentLoaded', watch);
  setInterval(watch, 400);
  watch();
})();`
