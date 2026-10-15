import { describe, expect, it, vi } from 'vitest'

import {
  REMOTE_PAIRING_DEVICE_KEY,
  REMOTE_PAIRING_SESSION_KEY,
  clearStoredPairing,
  isDeviceRememberable,
  parsePairingFragment,
  readDevicePairing,
  readRemotePairing,
  readStoredPairing,
  reloadOnPairingLink,
  rememberDevicePairing,
  resolveRemoteSocketUrl,
  storePairing,
  type BaseDocument,
  type RemotePairing,
} from '@/browser/boot/remotePairing'

/**
 * The remote client's pairing link (F-24). Security: the pairSecret never reaches the query string, a cookie or any
 * storage key but the tab's (and a listener link's device's), and the fragment is erased once read. A malformed
 * link renders an error screen, never a thrown boot.
 */

const FUTURE = 4_102_444_800_000 // 2100-01-01
const PAST = 1_000_000_000_000 // 2001-09-09
const NOW = 1_700_000_000_000 // 2023-11-14

function encode(payload: unknown): string {
  const json = JSON.stringify(payload)
  const bytes = new TextEncoder().encode(json)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fragment(payload: unknown): string {
  return `#rt=${encode(payload)}`
}

function validPayload(overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    pairId: 'pair-abc',
    pairSecret: 's3cr3t-value',
    exp: FUTURE,
    ...overrides,
  }
}

/** A storage double that also lets a test see everything ever written. */
function makeStorage() {
  const map = new Map<string, string>()
  const writes: Array<{ key: string; value: string }> = []
  return {
    map,
    writes,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value)
      writes.push({ key, value })
    },
    removeItem: (key: string) => void map.delete(key),
  }
}

function makeLocation(hash: string) {
  return { hash, pathname: '/v9/b/20260918T0000Z/', search: '?product=Velloc' }
}

describe('parsePairingFragment', () => {
  it('decodes a well-formed link', () => {
    const result = parsePairingFragment(fragment(validPayload()), NOW)
    expect(result).toEqual({
      ok: true,
      pairing: { pairId: 'pair-abc', pairSecret: 's3cr3t-value', exp: FUTURE },
    })
  })

  it('carries the ws override when the link has one', () => {
    const result = parsePairingFragment(
      fragment(validPayload({ ws: 'ws://127.0.0.1:8787/rt' })),
      NOW,
    )
    expect(result?.ok).toBe(true)
    expect(result?.ok === true && result.pairing.ws).toBe('ws://127.0.0.1:8787/rt')
  })

  it('accepts a hash with or without the leading #, and alongside other params', () => {
    const encoded = encode(validPayload())
    expect(parsePairingFragment(`rt=${encoded}`, NOW)?.ok).toBe(true)
    expect(parsePairingFragment(`#other=1&rt=${encoded}`, NOW)?.ok).toBe(true)
  })

  it('returns null — not an error — when there is no rt at all', () => {
    // This is the desktop's own boot. An error here would divert it.
    expect(parsePairingFragment('', NOW)).toBeNull()
    expect(parsePairingFragment(undefined, NOW)).toBeNull()
    expect(parsePairingFragment('#section=general', NOW)).toBeNull()
    expect(parsePairingFragment('#rt=', NOW)).toBeNull()
  })

  it('reports an expired link as expired, not malformed', () => {
    // The two differ in what the user must do next: mint a new link, or reload.
    const result = parsePairingFragment(fragment(validPayload({ exp: PAST })), NOW)
    expect(result).toEqual({ ok: false, error: 'expired' })
  })

  it('treats exp exactly at now as expired', () => {
    const result = parsePairingFragment(fragment(validPayload({ exp: NOW })), NOW)
    expect(result).toEqual({ ok: false, error: 'expired' })
  })

  it.each([
    ['not base64url at all', '#rt=@@@not-base64@@@'],
    ['base64 of non-JSON', `#rt=${btoa('hello')}`],
    ['an unknown envelope version', fragment(validPayload({ v: 2 }))],
    ['a missing envelope version', fragment({ pairId: 'a', pairSecret: 'b', exp: FUTURE })],
    ['a missing pairId', fragment(validPayload({ pairId: undefined }))],
    ['an empty pairId', fragment(validPayload({ pairId: '' }))],
    ['a missing pairSecret', fragment(validPayload({ pairSecret: undefined }))],
    ['an empty pairSecret', fragment(validPayload({ pairSecret: '' }))],
    ['a non-numeric exp', fragment(validPayload({ exp: 'soon' }))],
    ['a non-finite exp', fragment(validPayload({ exp: Number.POSITIVE_INFINITY }))],
    ['a non-string ws', fragment(validPayload({ ws: 8787 }))],
    ['a JSON array', fragment([1, 2, 3])],
    ['JSON null', fragment(null)],
  ])('rejects %s as malformed', (_label, hash) => {
    expect(parsePairingFragment(hash, NOW)).toEqual({ ok: false, error: 'malformed' })
  })
})

describe('resolveRemoteSocketUrl', () => {
  const pairing: RemotePairing = { pairId: 'p', pairSecret: 's', exp: FUTURE }

  it('defaults to same-origin /rt', () => {
    expect(resolveRemoteSocketUrl(pairing, { protocol: 'http:', host: '10.0.0.5:47615' }))
      .toBe('ws://10.0.0.5:47615/rt')
  })

  it('uses wss when the page is https', () => {
    expect(resolveRemoteSocketUrl(pairing, { protocol: 'https:', host: 'beta.velloc.app' }))
      .toBe('wss://beta.velloc.app/rt')
  })

  it('honours the ws override (the dev relay on another port)', () => {
    expect(
      resolveRemoteSocketUrl(
        { ...pairing, ws: 'ws://127.0.0.1:8787/rt' },
        { protocol: 'http:', host: 'localhost:5173' },
      ),
    ).toBe('ws://127.0.0.1:8787/rt')
  })

  it("honours an override on the page's own host, another port", () => {
    expect(
      resolveRemoteSocketUrl(
        { ...pairing, ws: 'ws://10.0.0.5:8787/rt' },
        { protocol: 'http:', host: '10.0.0.5:47615' },
      ),
    ).toBe('ws://10.0.0.5:8787/rt')
  })

  it.each([
    ['another host, from the real origin', 'wss://attacker.example/rt', 'app.velloc.app'],
    ['loopback, from a non-loopback page', 'ws://127.0.0.1:8787/rt', 'app.velloc.app'],
    ['a non-websocket scheme', 'https://app.velloc.app/rt', 'app.velloc.app'],
    ['an unparseable URL', 'not a url', 'app.velloc.app'],
  ])('ignores an override to %s and dials same-origin /rt', (_label, ws, host) => {
    expect(resolveRemoteSocketUrl({ ...pairing, ws }, { protocol: 'https:', host }))
      .toBe(`wss://${host}/rt`)
  })
})

/**
 * A `document` double for the `<base>` pin. `order` is shared with the
 * history double below, so a test can assert the pin lands BEFORE the address
 * changes — the other order would resolve the entry's relative URLs against
 * the bare origin for however long the gap lasts.
 */
function makeDocument(order: string[] = [], options: { existingBase?: boolean; head?: boolean } = {}) {
  const pinned: string[] = []
  const doc = {
    pinned,
    querySelector: (selector: string) =>
      selector === 'base[href]' && (options.existingBase || pinned.length > 0) ? {} : null,
    createElement: () => {
      const attrs = new Map<string, string>()
      return {
        setAttribute: (name: string, value: string) => void attrs.set(name, value),
        getAttribute: (name: string) => attrs.get(name) ?? null,
      }
    },
    head: options.head === false
      ? null
      : {
          prepend: (el: { getAttribute(name: string): string | null }) => {
            pinned.push(el.getAttribute('href') ?? '')
            order.push('pin')
          },
        },
  }
  return doc as typeof doc & BaseDocument
}

function makeHistory(order: string[] = []) {
  return {
    replaceState: vi.fn((_data: unknown, _unused: string, url?: string | URL | null) => {
      order.push(`replace:${String(url)}`)
    }),
  }
}

/** The listener's shape: an immutable build entry on the desktop's address. */
function listenerLocation(hash: string) {
  return {
    hash,
    origin: 'http://192.168.1.10:47615',
    pathname: '/v9/b/20260918T0000Z/',
    search: '',
  }
}

describe('readRemotePairing', () => {
  it('erases the fragment of a dev-relay link, keeping path and query', () => {
    // A `ws` link lives on the guest's own dev origin: its path and query are
    // the dev server's, so only the fragment goes.
    const replaceState = vi.fn()
    readRemotePairing({
      location: makeLocation(fragment(validPayload({ ws: 'ws://127.0.0.1:8787/rt' }))),
      history: { replaceState },
      storage: makeStorage(),
      deviceStorage: makeStorage(),
      document: makeDocument(),
      now: NOW,
    })

    expect(replaceState).toHaveBeenCalledTimes(1)
    expect(replaceState).toHaveBeenCalledWith(null, '', '/v9/b/20260918T0000Z/?product=Velloc')
  })

  it('erases the fragment even when the link is malformed', () => {
    // A bad secret in the address bar has every downside of a good one.
    const replaceState = vi.fn()
    readRemotePairing({
      location: makeLocation('#rt=@@@'),
      history: { replaceState },
      storage: makeStorage(),
      deviceStorage: makeStorage(),
      document: makeDocument(),
      now: NOW,
    })
    expect(replaceState).toHaveBeenCalledTimes(1)
    // Not shortened: nothing says this page is a listener's.
    expect(replaceState).toHaveBeenCalledWith(null, '', '/v9/b/20260918T0000Z/?product=Velloc')
  })

  it('does not touch the URL when there is no pairing (the desktop path)', () => {
    const replaceState = vi.fn()
    const doc = makeDocument()
    const result = readRemotePairing({
      location: makeLocation(''),
      history: { replaceState },
      storage: makeStorage(),
      deviceStorage: makeStorage(),
      document: doc,
      now: NOW,
    })
    expect(result).toBeNull()
    expect(replaceState).not.toHaveBeenCalled()
    expect(doc.pinned).toEqual([])
  })

  it('keeps a dev-relay pairing for the tab only', () => {
    const storage = makeStorage()
    const deviceStorage = makeStorage()
    readRemotePairing({
      location: makeLocation(fragment(validPayload({ ws: 'ws://127.0.0.1:8787/rt' }))),
      history: { replaceState: vi.fn() },
      storage,
      deviceStorage,
      document: makeDocument(),
      now: NOW,
    })
    expect([...storage.map.keys()]).toEqual([REMOTE_PAIRING_SESSION_KEY])
    expect([...deviceStorage.map.keys()]).toEqual([])
  })

  it('falls back to the stored pairing when the URL has no fragment', () => {
    const storage = makeStorage()
    storePairing({ pairId: 'stored', pairSecret: 'shh', exp: FUTURE }, storage)

    const result = readRemotePairing({
      location: makeLocation(''),
      history: { replaceState: vi.fn() },
      storage,
      deviceStorage: makeStorage(),
      document: makeDocument(),
      now: NOW,
    })
    expect(result?.ok).toBe(true)
    expect(result?.ok === true && result.pairing.pairId).toBe('stored')
  })

  it('lets a fresh link supersede a stored one', () => {
    const storage = makeStorage()
    storePairing({ pairId: 'old', pairSecret: 'old-secret', exp: FUTURE }, storage)

    const result = readRemotePairing({
      location: makeLocation(fragment(validPayload({ pairId: 'new' }))),
      history: { replaceState: vi.fn() },
      storage,
      deviceStorage: makeStorage(),
      document: makeDocument(),
      now: NOW,
    })
    expect(result?.ok === true && result.pairing.pairId).toBe('new')
    expect(readStoredPairing(storage, NOW)).toEqual({
      ok: true,
      pairing: { pairId: 'new', pairSecret: 's3cr3t-value', exp: FUTURE },
    })
  })

  it('drops the tab pairing when a superseding link is bad', () => {
    // Otherwise the user opens a new link, sees a working page, and believes
    // the new link worked — while the tab runs on the old grant.
    const storage = makeStorage()
    storePairing({ pairId: 'old', pairSecret: 'old-secret', exp: FUTURE }, storage)

    const result = readRemotePairing({
      location: makeLocation('#rt=@@@'),
      history: { replaceState: vi.fn() },
      storage,
      deviceStorage: makeStorage(),
      document: makeDocument(),
      now: NOW,
    })
    expect(result).toEqual({ ok: false, error: 'malformed' })
    expect(readStoredPairing(storage, NOW)).toBeNull()
  })

  it('reports a stored pairing that has since expired', () => {
    const storage = makeStorage()
    storePairing({ pairId: 'p', pairSecret: 's', exp: PAST }, storage)
    expect(readStoredPairing(storage, NOW)).toEqual({ ok: false, error: 'expired' })
  })

  it('reports stored garbage as malformed rather than throwing', () => {
    const storage = makeStorage()
    storage.setItem(REMOTE_PAIRING_SESSION_KEY, 'not json')
    expect(readStoredPairing(storage, NOW)).toEqual({ ok: false, error: 'malformed' })
  })

  it('survives storage being unavailable', () => {
    const result = readRemotePairing({
      location: makeLocation(fragment(validPayload())),
      history: { replaceState: vi.fn() },
      storage: null,
      deviceStorage: null,
      document: makeDocument(),
      now: NOW,
    })
    expect(result?.ok).toBe(true)
  })

  it('clearStoredPairing removes it', () => {
    const storage = makeStorage()
    storePairing({ pairId: 'p', pairSecret: 's', exp: FUTURE }, storage)
    clearStoredPairing(storage)
    expect(readStoredPairing(storage, NOW)).toBeNull()
  })
})

/**
 * A listener link — no `ws`, served by the desktop's own listener — is opened
 * once per device (F-24). The address bar then shows the bare
 * origin, and typing that origin again boots on the remembered pairing.
 */
describe('a listener link on this device', () => {
  it('shows the bare origin once read, pinning <base> to the entry first', () => {
    const order: string[] = []
    const doc = makeDocument(order)
    readRemotePairing({
      location: listenerLocation(fragment(validPayload())),
      history: makeHistory(order),
      storage: makeStorage(),
      deviceStorage: makeStorage(),
      document: doc,
      now: NOW,
    })
    // Absolute, so the address change cannot move what it resolves against.
    expect(doc.pinned).toEqual(['http://192.168.1.10:47615/v9/b/20260918T0000Z/'])
    expect(order).toEqual(['pin', 'replace:/'])
  })

  it('does not add a second <base> when the entry already has one', () => {
    const order: string[] = []
    const doc = makeDocument(order, { existingBase: true })
    readRemotePairing({
      location: listenerLocation(fragment(validPayload())),
      history: makeHistory(order),
      storage: makeStorage(),
      deviceStorage: makeStorage(),
      document: doc,
      now: NOW,
    })
    expect(doc.pinned).toEqual([])
    expect(order).toEqual(['replace:/'])
  })

  it('keeps the entry path when <base> cannot be pinned', () => {
    // Shortening without the pin would resolve the locale catalogs against
    // the listener's root, which serves none of them.
    const history = makeHistory()
    readRemotePairing({
      location: listenerLocation(fragment(validPayload())),
      history,
      storage: makeStorage(),
      deviceStorage: makeStorage(),
      document: makeDocument([], { head: false }),
      now: NOW,
    })
    expect(history.replaceState).toHaveBeenCalledTimes(1)
    expect(history.replaceState).toHaveBeenCalledWith(null, '', '/v9/b/20260918T0000Z/')
  })

  it('needs no <base> on a page already at the root — only the fragment goes', () => {
    // The Debug listener serves the dev server's own `/`.
    const doc = makeDocument()
    const history = makeHistory()
    readRemotePairing({
      location: { hash: fragment(validPayload()), pathname: '/', search: '' },
      history,
      storage: makeStorage(),
      deviceStorage: makeStorage(),
      document: doc,
      now: NOW,
    })
    expect(doc.pinned).toEqual([])
    expect(history.replaceState).toHaveBeenCalledWith(null, '', '/')
  })

  it('remembers the pairing for the device as well as the tab', () => {
    const storage = makeStorage()
    const deviceStorage = makeStorage()
    readRemotePairing({
      location: listenerLocation(fragment(validPayload())),
      history: makeHistory(),
      storage,
      deviceStorage,
      document: makeDocument(),
      now: NOW,
    })
    expect([...storage.map.keys()]).toEqual([REMOTE_PAIRING_SESSION_KEY])
    expect([...deviceStorage.map.keys()]).toEqual([REMOTE_PAIRING_DEVICE_KEY])
    expect(readDevicePairing(deviceStorage, NOW)).toEqual({
      ok: true,
      pairing: { pairId: 'pair-abc', pairSecret: 's3cr3t-value', exp: FUTURE },
    })
  })

  it('boots a new tab on the bare origin from the remembered pairing, and shortens it', () => {
    // The bare address typed again: `GET /` redirected to the entry, with no
    // fragment and nothing in this (new) tab's sessionStorage.
    const deviceStorage = makeStorage()
    rememberDevicePairing({ pairId: 'device', pairSecret: 'dev-secret', exp: FUTURE }, deviceStorage)
    const storage = makeStorage()
    const order: string[] = []

    const result = readRemotePairing({
      location: listenerLocation(''),
      history: makeHistory(order),
      storage,
      deviceStorage,
      document: makeDocument(order),
      now: NOW,
    })

    expect(result?.ok === true && result.pairing.pairId).toBe('device')
    expect(order).toEqual(['pin', 'replace:/'])
    // The tab adopts it: a link opened later in ANOTHER tab updates the
    // device, not this tab.
    expect(readStoredPairing(storage, NOW)?.ok === true).toBe(true)
  })

  it('prefers the tab pairing over the device one', () => {
    const storage = makeStorage()
    storePairing({ pairId: 'tab', pairSecret: 't', exp: FUTURE }, storage)
    const deviceStorage = makeStorage()
    rememberDevicePairing({ pairId: 'device', pairSecret: 'd', exp: FUTURE }, deviceStorage)

    const result = readRemotePairing({
      location: listenerLocation(''),
      history: makeHistory(),
      storage,
      deviceStorage,
      document: makeDocument(),
      now: NOW,
    })
    expect(result?.ok === true && result.pairing.pairId).toBe('tab')
  })

  it('overwrites the remembered pairing when a fresh link is opened', () => {
    const deviceStorage = makeStorage()
    rememberDevicePairing({ pairId: 'old', pairSecret: 'old-secret', exp: FUTURE }, deviceStorage)

    readRemotePairing({
      location: listenerLocation(fragment(validPayload({ pairId: 'new' }))),
      history: makeHistory(),
      storage: makeStorage(),
      deviceStorage,
      document: makeDocument(),
      now: NOW,
    })
    expect(readDevicePairing(deviceStorage, NOW)).toEqual({
      ok: true,
      pairing: { pairId: 'new', pairSecret: 's3cr3t-value', exp: FUTURE },
    })
  })

  it('keeps the remembered pairing when a bad link is opened', () => {
    // The bad link gets its own error screen; one bad paste does not unpair
    // a device that was working.
    const deviceStorage = makeStorage()
    rememberDevicePairing({ pairId: 'kept', pairSecret: 'k', exp: FUTURE }, deviceStorage)

    readRemotePairing({
      location: listenerLocation('#rt=@@@'),
      history: makeHistory(),
      storage: makeStorage(),
      deviceStorage,
      document: makeDocument(),
      now: NOW,
    })
    expect(readDevicePairing(deviceStorage, NOW)?.ok === true).toBe(true)
  })

  it('reports a remembered pairing that has expired, so the page says so', () => {
    const deviceStorage = makeStorage()
    rememberDevicePairing({ pairId: 'p', pairSecret: 's', exp: PAST }, deviceStorage)

    const result = readRemotePairing({
      location: listenerLocation(''),
      history: makeHistory(),
      storage: makeStorage(),
      deviceStorage,
      document: makeDocument(),
      now: NOW,
    })
    expect(result).toEqual({ ok: false, error: 'expired' })
  })

  it('never remembers a dev-relay pairing, and ignores one found remembered', () => {
    const deviceStorage = makeStorage()
    rememberDevicePairing({ pairId: 'p', pairSecret: 's', exp: FUTURE, ws: 'ws://x/rt' }, deviceStorage)
    expect(deviceStorage.map.size).toBe(0)

    deviceStorage.setItem(
      REMOTE_PAIRING_DEVICE_KEY,
      JSON.stringify({ v: 1, pairId: 'p', pairSecret: 's', exp: FUTURE, ws: 'ws://x/rt' }),
    )
    expect(readDevicePairing(deviceStorage, NOW)).toBeNull()
  })

  it('marks only listener links as rememberable', () => {
    expect(isDeviceRememberable({ pairId: 'p', pairSecret: 's', exp: FUTURE })).toBe(true)
    expect(isDeviceRememberable({ pairId: 'p', pairSecret: 's', exp: FUTURE, ws: 'ws://x/rt' }))
      .toBe(false)
  })
})

describe('secret hygiene', () => {
  it('never writes the secret anywhere but the tab and device keys', () => {
    const storage = makeStorage()
    const deviceStorage = makeStorage()
    const secret = 'top-secret-do-not-leak'
    readRemotePairing({
      location: listenerLocation(fragment(validPayload({ pairSecret: secret }))),
      history: makeHistory(),
      storage,
      deviceStorage,
      document: makeDocument(),
      now: NOW,
    })

    const leaks = [...storage.writes, ...deviceStorage.writes].filter(
      write =>
        write.key !== REMOTE_PAIRING_SESSION_KEY &&
        write.key !== REMOTE_PAIRING_DEVICE_KEY &&
        write.value.includes(secret),
    )
    expect(leaks).toEqual([])
  })

  it('never puts the secret in the URL it replaces the fragment with, or the <base>', () => {
    const secret = 'top-secret-do-not-leak'
    for (const location of [
      makeLocation(fragment(validPayload({ pairSecret: secret, ws: 'ws://127.0.0.1:8787/rt' }))),
      listenerLocation(fragment(validPayload({ pairSecret: secret }))),
    ]) {
      const history = makeHistory()
      const doc = makeDocument()
      readRemotePairing({
        location,
        history,
        storage: makeStorage(),
        deviceStorage: makeStorage(),
        document: doc,
        now: NOW,
      })
      const url = String(history.replaceState.mock.calls[0]?.[2] ?? '')
      expect(url).not.toContain(secret)
      expect(url).not.toContain('rt=')
      expect(doc.pinned.join(' ')).not.toContain('rt=')
    }
  })
})

describe('reloadOnPairingLink', () => {
  /** A window double: fires `hashchange` the way the browser does for a
   *  fragment-only navigation — the document stays, only the hash moves. */
  function makeWindow(hash = '') {
    const listeners = new Set<() => void>()
    const win = {
      location: { hash, reload: vi.fn() },
      addEventListener: vi.fn((type: string, fn: () => void) => {
        if (type === 'hashchange') listeners.add(fn)
      }),
      removeEventListener: vi.fn((type: string, fn: () => void) => {
        if (type === 'hashchange') listeners.delete(fn)
      }),
      navigate(next: string) {
        win.location.hash = next
        for (const fn of listeners) fn()
      },
    }
    return win
  }

  it('reloads when a link is pasted into a page already at its address', () => {
    // The reset-link screen sits at the bare origin; the new link is that
    // origin + `#rt=…`, which the browser treats as a same-document hop.
    const win = makeWindow()
    reloadOnPairingLink(win as never)
    win.navigate(fragment(validPayload({ pairId: 'pair-new' })))
    expect(win.location.reload).toHaveBeenCalledTimes(1)
  })

  it('reloads for a bad link too, so the reloaded boot can say why', () => {
    const win = makeWindow()
    reloadOnPairingLink(win as never)
    win.navigate(fragment(validPayload({ exp: PAST })))
    win.navigate('#rt=%%%not-base64')
    expect(win.location.reload).toHaveBeenCalledTimes(2)
  })

  it('leaves a hash that carries no link alone', () => {
    const win = makeWindow()
    reloadOnPairingLink(win as never)
    win.navigate('#section-2')
    win.navigate('')
    expect(win.location.reload).not.toHaveBeenCalled()
  })

  it('stops listening once unsubscribed', () => {
    const win = makeWindow()
    const stop = reloadOnPairingLink(win as never)
    stop()
    win.navigate(fragment(validPayload()))
    expect(win.location.reload).not.toHaveBeenCalled()
  })
})
