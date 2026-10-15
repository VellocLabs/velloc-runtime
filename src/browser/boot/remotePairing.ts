/**
 * Security: the remote client's pairing, read off the URL fragment `#rt=<base64url(JSON)>`.
 * 1. The secret never goes on the wire: fragment → web storage and memory only; never a query
 *    string, cookie or log line. The connection answers the challenge with an HMAC.
 * 2. The fragment is erased (`history.replaceState`) as soon as it is read.
 * 3. A malformed or expired link is a screen, not a throw.
 * 4. A listener link is also remembered in `localStorage` and the address shortened to the bare
 *    origin; the runtime checks the pairing on every connection. A dev-relay link (`ws`) is tab-only.
 */

/** Where the parsed pairing lives for the rest of the tab's life. */
export const REMOTE_PAIRING_SESSION_KEY = 'nexus.remotePairing'

/**
 * Where a listener link's pairing is remembered for this DEVICE — the
 * listener's origin, i.e. one desktop at one address. `local-storage-allowlist`
 * lists it as `client`: it is who this device is to that desktop, not user
 * data.
 */
export const REMOTE_PAIRING_DEVICE_KEY = 'nexus.remoteDevicePairing'

/** The fragment's parameter name: `#rt=<base64url payload>`. */
export const REMOTE_PAIRING_FRAGMENT_PARAM = 'rt'

/**
 * What the desktop minted. `v` is the envelope version — an unknown one is
 * rejected rather than guessed at, because the fields it would carry are
 * exactly the security-relevant ones.
 */
export type RemotePairing = {
  /** Names the pairing row in the runtime's table; safe to log. */
  pairId: string
  /**
   * Proves possession of that row. NEVER logged, never persisted beyond
   * `sessionStorage`, never put on the wire — `RuntimeConnection` sends an
   * HMAC over the runtime's nonce, not this (D9).
   */
  pairSecret: string
  /** Epoch ms the link stops being accepted. Checked here so a dead link
   *  costs no socket. */
  exp: number
  /**
   * Where to reach the runtime. Absent = same origin (`/rt` on the page's own
   * host), which is the shape the in-process listener serves. Present only for the
   * dev relay, where vite and the relay are two different ports.
   */
  ws?: string
}

/** Why a link did not produce a pairing. Each maps to a `RemoteConnectScreen`
 *  state; `malformed` and `expired` are told apart because the user's next
 *  action differs (reload vs. mint a new link). */
export type RemotePairingError = 'malformed' | 'expired'

export type RemotePairingParse =
  | { ok: true; pairing: RemotePairing }
  | { ok: false; error: RemotePairingError }

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

function defaultSessionStorage(): StorageLike | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage
  } catch {
    // A tab with storage disabled (or a sandboxed iframe): the pairing then
    // lives only in the caller's memory, which is enough for one page view.
    return null
  }
}

function defaultDeviceStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    // Storage disabled: the device simply does not remember — the link still
    // works in the tab it was opened in.
    return null
  }
}

/**
 * May this device remember the pairing? Only a listener link — one with no
 * `ws` override, dialling its own page's `/rt`. See rule 4 in the header for
 * why a dev-relay link never is.
 */
export function isDeviceRememberable(pairing: RemotePairing): boolean {
  return pairing.ws === undefined
}

/** base64url → utf-8. Returns null on any malformed input rather than
 *  throwing, so one bad character is an error screen, not a boot crash. */
function decodeBase64Url(raw: string): string | null {
  try {
    const padded = raw.replace(/-/g, '+').replace(/_/g, '/')
    const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0))
    return new TextDecoder().decode(bytes)
  } catch {
    return null
  }
}

/** The same shape check both the fragment path and the sessionStorage path
 *  run — storage is not more trusted than a URL, it just persists longer. */
function narrowPairing(value: unknown): RemotePairing | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (record.v !== 1) return null
  const { pairId, pairSecret, exp, ws } = record
  if (typeof pairId !== 'string' || pairId === '') return null
  if (typeof pairSecret !== 'string' || pairSecret === '') return null
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return null
  if (ws !== undefined && (typeof ws !== 'string' || ws === '')) return null
  return {
    pairId,
    pairSecret,
    exp,
    ...(ws !== undefined ? { ws: ws as string } : {}),
  }
}

/**
 * Parse `#rt=…` out of a location hash (leading `#` optional, other parameters tolerated). `null`
 * when there is no `rt`: the desktop's own boot.
 */
export function parsePairingFragment(
  hash: string | undefined | null,
  now: number = Date.now(),
): RemotePairingParse | null {
  if (!hash) return null
  const params = new URLSearchParams(
    hash.startsWith('#') ? hash.slice(1) : hash,
  )
  const encoded = params.get(REMOTE_PAIRING_FRAGMENT_PARAM)
  if (encoded === null || encoded === '') return null

  const json = decodeBase64Url(encoded)
  if (json === null) return { ok: false, error: 'malformed' }

  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return { ok: false, error: 'malformed' }
  }

  const pairing = narrowPairing(parsed)
  if (pairing === null) return { ok: false, error: 'malformed' }
  // Checked before the socket, not instead of it: the runtime re-checks
  // expiry on every hello, and its clock is the one that decides.
  // This only spares the user a connection that is certain to be refused.
  if (pairing.exp <= now) return { ok: false, error: 'expired' }
  return { ok: true, pairing }
}

const isLoopbackHostname = (hostname: string): boolean =>
  hostname === 'localhost' || hostname === '[::1]' || /^127(\.\d{1,3}){3}$/.test(hostname)

/**
 * Whether a link's `ws` override may be dialled from a page on `pageHost`.
 * Only the development shape passes: a ws(s) URL on the page's own host (the
 * relay on another port), or loopback from a loopback page (vite on
 * `localhost`, the relay on `127.0.0.1`). Anything else would let a crafted
 * link on the real origin pair the real client with someone else's runtime.
 */
function isAllowedSocketOverride(ws: string, pageHost: string): boolean {
  let socket: URL
  let page: URL
  try {
    socket = new URL(ws)
    page = new URL(`http://${pageHost}`)
  } catch {
    return false
  }
  if (socket.protocol !== 'ws:' && socket.protocol !== 'wss:') return false
  if (socket.hostname === page.hostname) return true
  return isLoopbackHostname(socket.hostname) && isLoopbackHostname(page.hostname)
}

/**
 * The WebSocket URL to dial for a pairing.
 *
 * Default is same-origin `/rt` — what the in-process listener serves, and
 * the only form a minted link carries in production. The `ws` override exists
 * for development, where the page comes from vite on one port and the relay
 * listens on another; an override outside that shape is ignored.
 */
export function resolveRemoteSocketUrl(
  pairing: RemotePairing,
  location: { protocol: string; host: string },
): string {
  if (pairing.ws !== undefined && isAllowedSocketOverride(pairing.ws, location.host)) {
    return pairing.ws
  }
  return `${location.protocol === 'https:' ? 'wss://' : 'ws://'}${location.host}/rt`
}

/** Read the pairing stored under `key`. Same validation as a fresh fragment,
 *  including expiry — storage is not more trusted than a URL, it just
 *  persists longer. */
function readPairingAt(
  storage: StorageLike | null,
  key: string,
  now: number,
): RemotePairingParse | null {
  let raw: string | null = null
  try {
    raw = storage?.getItem(key) ?? null
  } catch {
    return null
  }
  if (raw === null || raw === '') return null

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, error: 'malformed' }
  }
  const pairing = narrowPairing(parsed)
  if (pairing === null) return { ok: false, error: 'malformed' }
  if (pairing.exp <= now) return { ok: false, error: 'expired' }
  return { ok: true, pairing }
}

/** Store under `key`, in the SAME envelope shape the fragment carries, so one
 *  narrowing function validates both. */
function writePairingAt(
  pairing: RemotePairing,
  storage: StorageLike | null,
  key: string,
): void {
  try {
    storage?.setItem(key, JSON.stringify({ v: 1, ...pairing }))
  } catch {
    // Storage unavailable — the pairing still drives this page view; only a
    // reload would lose it, and a reload re-reads the (now erased) fragment.
  }
}

/** Re-read what a previous call stored for this tab. A tab left open past the
 *  link's life reconnects to nothing, so it should say so rather than retry. */
export function readStoredPairing(
  storage: StorageLike | null = defaultSessionStorage(),
  now: number = Date.now(),
): RemotePairingParse | null {
  return readPairingAt(storage, REMOTE_PAIRING_SESSION_KEY, now)
}

/** Persist for this tab. */
export function storePairing(
  pairing: RemotePairing,
  storage: StorageLike | null = defaultSessionStorage(),
): void {
  writePairingAt(pairing, storage, REMOTE_PAIRING_SESSION_KEY)
}

export function clearStoredPairing(
  storage: StorageLike | null = defaultSessionStorage(),
): void {
  try {
    storage?.removeItem(REMOTE_PAIRING_SESSION_KEY)
  } catch {
    // Nothing to do; the tab is closing or storage is gone either way.
  }
}

/**
 * The pairing this device remembers for this listener origin, or null. An
 * entry carrying a `ws` override is not one this module ever writes (rule 4),
 * so it is ignored rather than dialled.
 */
export function readDevicePairing(
  storage: StorageLike | null = defaultDeviceStorage(),
  now: number = Date.now(),
): RemotePairingParse | null {
  const stored = readPairingAt(storage, REMOTE_PAIRING_DEVICE_KEY, now)
  if (stored?.ok === true && !isDeviceRememberable(stored.pairing)) return null
  return stored
}

/** Remember a listener link's pairing for this device. A no-op for a
 *  dev-relay link (rule 4). The latest link wins: this overwrites. */
export function rememberDevicePairing(
  pairing: RemotePairing,
  storage: StorageLike | null = defaultDeviceStorage(),
): void {
  if (!isDeviceRememberable(pairing)) return
  writePairingAt(pairing, storage, REMOTE_PAIRING_DEVICE_KEY)
}

/**
 * Forget this device's remembered link — the page's *Log out*
 * (`RemoteHostIndicator`). Deliberately separate from `clearStoredPairing`
 * (which drops only the TAB's copy): logging out has to survive closing the
 * tab, or the next visit to the bare address would silently reconnect with
 * the credential the user just discarded.
 */
export function forgetDevicePairing(
  storage: StorageLike | null = defaultDeviceStorage(),
): void {
  try {
    storage?.removeItem(REMOTE_PAIRING_DEVICE_KEY)
  } catch {
    // Storage is gone or blocked; there is nothing remembered to forget.
  }
}

/** What `readRemotePairing` needs of the document: somewhere to pin `<base>`. */
export type BaseDocument = Pick<Document, 'querySelector' | 'createElement'> & {
  head: Pick<HTMLHeadElement, 'prepend'> | null
}

export type ReadRemotePairingOptions = {
  location?: { hash: string; pathname: string; search: string; origin?: string }
  history?: Pick<History, 'replaceState'>
  /** This tab's store (`sessionStorage`). */
  storage?: StorageLike | null
  /** This device's store (`localStorage`) — listener links only. */
  deviceStorage?: StorageLike | null
  /** Where the entry's `<base>` is pinned before the address is shortened. */
  document?: BaseDocument | null
  now?: number
}

/**
 * Is this page a remote client, and for which pairing? Fragment, then `sessionStorage`, then
 * `localStorage`; a fresh link supersedes. The fragment is erased as soon as it parses, even when
 * malformed. `null` = the desktop path.
 */
export function readRemotePairing(
  options: ReadRemotePairingOptions = {},
): RemotePairingParse | null {
  const loc = options.location ??
    (typeof globalThis.location !== 'undefined' ? globalThis.location : undefined)
  const storage = options.storage === undefined
    ? defaultSessionStorage()
    : options.storage
  const deviceStorage = options.deviceStorage === undefined
    ? defaultDeviceStorage()
    : options.deviceStorage
  const doc = options.document === undefined
    ? (typeof globalThis.document !== 'undefined' ? globalThis.document : null)
    : options.document
  const now = options.now ?? Date.now()

  const fromFragment = parsePairingFragment(loc?.hash, now)
  if (fromFragment !== null) {
    // Erase first, keep second: if anything below throws, the secret is
    // already out of the URL.
    const shortened = fromFragment.ok &&
      isDeviceRememberable(fromFragment.pairing) &&
      showShortAddress(options.history, loc, doc)
    if (!shortened) eraseFragment(options.history, loc)
    if (fromFragment.ok) {
      storePairing(fromFragment.pairing, storage)
      rememberDevicePairing(fromFragment.pairing, deviceStorage)
    } else {
      // A superseding link that turned out to be bad must not leave the tab
      // silently running on the OLD pairing — the user would see a working
      // page and believe the new link worked. The DEVICE's pairing stays: the
      // bad link was reported on this screen, and one bad paste should not
      // unpair a device that was working.
      clearStoredPairing(storage)
    }
    return fromFragment
  }

  const fromTab = readStoredPairing(storage, now)
  if (fromTab !== null) {
    if (fromTab.ok && isDeviceRememberable(fromTab.pairing)) {
      showShortAddress(options.history, loc, doc)
    }
    return fromTab
  }

  const fromDevice = readDevicePairing(deviceStorage, now)
  if (fromDevice?.ok === true) {
    storePairing(fromDevice.pairing, storage)
    showShortAddress(options.history, loc, doc)
  }
  return fromDevice
}

/** Drop the fragment without navigating or adding a history entry. */
function eraseFragment(
  history: Pick<History, 'replaceState'> | undefined,
  loc: { pathname: string; search: string } | undefined,
): void {
  const target = history ??
    (typeof globalThis.history !== 'undefined' ? globalThis.history : undefined)
  if (!target || !loc) return
  try {
    target.replaceState(null, '', `${loc.pathname}${loc.search}`)
  } catch {
    // A document that refuses replaceState (about:blank, a sandboxed frame):
    // boot continues; the fragment stays visible but is not otherwise used.
  }
}

/**
 * Show a listener page at its bare origin, dropping the fragment, after pinning a `<base>` to the
 * served entry; not shortened when that fails. Returns whether it was.
 */
function showShortAddress(
  history: Pick<History, 'replaceState'> | undefined,
  loc: { hash: string; pathname: string; search: string; origin?: string } | undefined,
  doc: BaseDocument | null,
): boolean {
  const target = history ??
    (typeof globalThis.history !== 'undefined' ? globalThis.history : undefined)
  if (!target || !loc) return false
  const atRoot = loc.pathname === '/' && loc.search === ''
  if (!atRoot && !pinDocumentBase(doc, loc)) return false
  if (atRoot && loc.hash === '') return true
  try {
    target.replaceState(null, '', '/')
    return true
  } catch {
    return false
  }
}

/** Pin `<base href>` to the entry the document was served from. True when a
 *  base now governs resolution (an existing one counts). */
function pinDocumentBase(
  doc: BaseDocument | null,
  loc: { pathname: string; search: string; origin?: string },
): boolean {
  if (!doc?.head) return false
  try {
    if (doc.querySelector('base[href]')) return true
    const base = doc.createElement('base')
    // Absolute, so no later address change can move what it resolves to.
    base.setAttribute('href', `${loc.origin ?? ''}${loc.pathname}${loc.search}`)
    doc.head.prepend(base)
    return true
  } catch {
    return false
  }
}

/** What `reloadOnPairingLink` needs of the window. */
export type PairingLinkWindow = Pick<Window, 'addEventListener' | 'removeEventListener'> & {
  location: Pick<Location, 'hash' | 'reload'>
}

/**
 * Reload when a pairing link is opened in this page (a fragment-only navigation does not re-run the
 * boot). A hash with no `rt` is ignored. Returns an unsubscribe.
 */
export function reloadOnPairingLink(
  win: PairingLinkWindow | undefined = typeof window === 'undefined' ? undefined : window,
): () => void {
  if (!win) return () => {}
  const onHashChange = (): void => {
    if (parsePairingFragment(win.location.hash) === null) return
    win.location.reload()
  }
  win.addEventListener('hashchange', onHashChange)
  return () => win.removeEventListener('hashchange', onHashChange)
}
