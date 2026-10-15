/**
 * (F-24): the `remote` capability and the
 * `remote/state` topic. Every action is `full` (only the desktop manages
 * remote access); state is published, never called back (R5); the secret
 * surfaces exactly once (in pairStart's fragment); the topic is full-scoped
 * and snapshot-only.
 */
import { describe, expect, it, vi } from 'vitest'
import { CapabilityRegistry } from '../browser/runtimeHub/CapabilityRegistry'
import { TopicBroker } from '../browser/runtimeHub/TopicBroker'
import { createPairingTable } from '../browser/runtimeHub/pairingTable'
import {
  createSharingPairing,
  SHARING_PAIRING_TTL_MS,
} from '../browser/runtimeHub/sharingPairing'
import {
  REMOTE_STATE_TOPIC,
  registerRemoteCapability,
  remoteStateTopicProvider,
  type RemoteState,
} from '../browser/runtimeHub/remoteCapability'
import type { RelayDialerState } from '../browser/runtimeHub/relayDialer'
import type { RemoteAccessDriver, RemoteAccessState } from '../browser/runtimeHub/remoteAccessDriver'

import type { ConnectionInfo, HandlerRequest } from '../browser/runtimeHub/types'

type Mode = 'full' | 'manager' | 'control' | 'observe'
const conn = (mode: Mode): ConnectionInfo =>
  ({ connectionId: 'c', clientId: 'c', kind: 'desktop-shell', scope: { mode, sessions: 'all' }, transport: 'message-port', connectedAt: 0 })

function makeRig(options: { now?: () => number; settled?: boolean } = {}) {
  const registry = new CapabilityRegistry()
  const broker = new TopicBroker()
  const now = options.now ?? (() => Date.now())
  const pairings = createPairingTable(now)
  const published: Array<{ payload: unknown }> = []
  const dialer = {
    state: 'off' as RelayDialerState,
    connect: vi.fn(),
    disconnect: vi.fn(() => { dialer.state = 'off' }),
  }
  let revoked: string[] = []
  const accessState: RemoteAccessState = {
    supported: true, enabled: true, bindAddress: '192.168.1.10', port: 47615,
    state: 'listening', addresses: [], clients: 0,
  }
  const remoteAccess: RemoteAccessDriver = {
    setSupported: vi.fn(),
    noteManualDial: vi.fn(),
    access: () => accessState,
    getAccess: vi.fn(async () => accessState),
    setAccess: vi.fn(async (input) => {
      Object.assign(accessState, input)
      if (input && typeof (input as { enabled?: unknown }).enabled === 'boolean') {
        accessState.enabled = (input as { enabled: boolean }).enabled
        accessState.state = accessState.enabled ? 'listening' : 'off'
      }
      // The real driver applies the status it just got, so `access()` reports
      // it from here on. The rig has to do the same: `currentPairing`'s
      // renewal asks the driver whether sharing is still meant to be on.
      return { ...accessState } as never
    }),
  }
  const persistPairings = vi.fn()
  // The sharing coordinator the runtime owns. Its gate models the two async
  // boot landings; unless a test is ABOUT the gate it starts settled, which is
  // what every post-boot call sees in production.
  const sharing = createSharingPairing({
    pairings,
    now,
    persist: persistPairings,
    publishState: () => broker.publish(REMOTE_STATE_TOPIC, stateOf(), { type: 'state' }),
  })
  if (options.settled !== false) {
    sharing.noteStatusLanded()
    sharing.noteRehydrateLanded()
  }
  registerRemoteCapability(registry, {
    pairings,
    revokePairing: pairId => { revoked.push(pairId); return pairings.revoke(pairId) },
    dialer: dialer as never,
    relayError: () => undefined,
    publishState: () => broker.publish(REMOTE_STATE_TOPIC, stateOf(), { type: 'state' }),
    remoteAccess,
    entryPath: () => '/v1/b/20260917T103000000Z/',
    persistPairings,
    sharing,
    now,
  })
  const stateOf = (): RemoteState => ({ relay: dialer.state, pairings: pairings.list(), access: accessState })
  broker.registerProvider(remoteStateTopicProvider(stateOf))
  // capture publishes
  const origPublish = broker.publish.bind(broker)
  broker.publish = ((id, payload, opts) => {
    if (id === REMOTE_STATE_TOPIC) published.push({ payload })
    return origPublish(id, payload, opts)
  }) as typeof broker.publish
  return { registry, broker, pairings, dialer, remoteAccess, accessState, published, persistPairings, sharing, getRevoked: () => revoked }
}

async function call(rig: ReturnType<typeof makeRig>, act: string, payload: unknown, scope: Mode = 'full') {
  const entry = rig.registry.resolve('remote', act)
  if (!entry) throw new Error(`no action remote.${act}`)
  // The registry gates scope BEFORE the handler runs; assert the gate here the
  // way the hub would (full is the only scope that reaches these actions).
  const request: HandlerRequest = {
    id: 'r1',
    route: { cap: 'remote', act } as never,
    payload,
    conn: conn(scope),
    signal: new AbortController().signal,
    blobs: { offer: () => { throw new Error('no blobs') } } as never,
  }
  return entry.handle(request, {} as never)
}

describe('remote capability (WP-3)', () => {
  it('every action is manager-scoped (an ordinary remote may not manage its own access)', () => {
    const rig = makeRig()
    for (const act of ['pairStart', 'pairList', 'pairRevoke', 'connectRelay', 'disconnectRelay', 'getAccess', 'setAccess']) {
      const control = rig.registry.advertise({ mode: 'control', sessions: 'all' })
        .find(c => c.cap === 'remote')?.acts ?? []
      const observe = rig.registry.advertise({ mode: 'observe', sessions: 'all' })
        .find(c => c.cap === 'remote')?.acts ?? []
      expect(control, `control must not see remote.${act}`).not.toContain(act)
      expect(observe, `observe must not see remote.${act}`).not.toContain(act)
    }
    const manager = rig.registry.advertise({ mode: 'manager', sessions: 'all' })
      .find(c => c.cap === 'remote')?.acts ?? []
    expect(manager).toEqual(expect.arrayContaining(['pairStart', 'pairList', 'pairRevoke', 'disconnectRelay', 'getAccess', 'setAccess']))
    // Pointing the desktop's dialer at an arbitrary ws(s):// URL is the
    // desktop's alone (`?rtDevRelay=` rides its unscoped connection): a
    // manager remote steering it would have the desktop dial an attacker.
    expect(manager, 'a manager remote must not see remote.connectRelay').not.toContain('connectRelay')
    expect(rig.registry.resolve('remote', 'connectRelay')?.spec.scope).toBe('full')
    const full = rig.registry.advertise({ mode: 'full', sessions: 'all' })
      .find(c => c.cap === 'remote')?.acts ?? []
    expect(full).toEqual(expect.arrayContaining(['pairStart', 'pairList', 'pairRevoke', 'connectRelay', 'disconnectRelay', 'getAccess', 'setAccess']))
  })

  it('pairStart returns a fragment whose payload decodes to the pairing, secret included once', async () => {
    const rig = makeRig()
    const result = await call(rig, 'pairStart', { mode: 'control', label: 'phone' }) as { pairId: string; fragment: string }
    expect(result.fragment.startsWith('rt=')).toBe(true)
    const payload = JSON.parse(Buffer.from(result.fragment.slice(3), 'base64url').toString('utf8'))
    expect(payload.v).toBe(1)
    expect(payload.pairId).toBe(result.pairId)
    expect(typeof payload.pairSecret).toBe('string')
    expect(typeof payload.exp).toBe('number')
    // The pairing is in the table; the secret is NOT re-readable.
    const list = rig.pairings.list()
    expect(list).toHaveLength(1)
    expect((list[0] as { secret?: unknown }).secret).toBeUndefined()
    expect(list[0].label).toBe('phone')
  })

  it('pairStart assembles url from the listener address + entry path (WP-5)', async () => {
    const rig = makeRig()
    // makeRig's stub access is 'listening' on 192.168.1.10:47615 with entryPath
    // '/v1/b/20260917T103000000Z/'.
    const result = await call(rig, 'pairStart', { mode: 'control' }) as { fragment: string; url: string | null }
    expect(result.url).toBe(
      `http://192.168.1.10:47615/v1/b/20260917T103000000Z/#${result.fragment}`,
    )
  })

  it('pairStart.url names loopback under the wildcard bind — 0.0.0.0 is not a destination', async () => {
    const rig = makeRig()
    rig.accessState.bindAddress = '0.0.0.0'
    const result = await call(rig, 'pairStart', { mode: 'control' }) as { fragment: string; url: string | null }
    expect(result.url).toBe(
      `http://127.0.0.1:47615/v1/b/20260917T103000000Z/#${result.fragment}`,
    )
  })

  it('pairStart.url is null when the listener is not listening', async () => {
    const rig = makeRig()
    rig.accessState.state = 'off'
    const result = await call(rig, 'pairStart', { mode: 'control' }) as { url: string | null }
    expect(result.url).toBeNull()
  })

  it('getAccess/setAccess forward to the remoteAccess driver (WP-5)', async () => {
    const rig = makeRig()
    const got = await call(rig, 'getAccess', {}) as { state: string }
    expect(rig.remoteAccess.getAccess).toHaveBeenCalled()
    expect(got.state).toBe('listening')
    await call(rig, 'setAccess', { enabled: true, bindAddress: '192.168.1.10', port: 47615 })
    expect(rig.remoteAccess.setAccess).toHaveBeenCalledWith({ enabled: true, bindAddress: '192.168.1.10', port: 47615 })
  })

  it('setAccess rejects a bad payload type', async () => {
    const rig = makeRig()
    await expect(call(rig, 'setAccess', { enabled: 'yes' })).rejects.toThrow()
    await expect(call(rig, 'setAccess', { port: 'x' })).rejects.toThrow()
  })

  it('pairStart defaults to sessions:all and rejects a bad mode', async () => {
    const rig = makeRig()
    const result = await call(rig, 'pairStart', { mode: 'control' }) as { pairId: string }
    expect(rig.pairings.list()[0].scope.sessions).toBe('all')
    await expect(call(rig, 'pairStart', { mode: 'full' })).rejects.toMatchObject({ code: 'bad_payload' })
  })

  it("pairStart accepts mode 'manager' (and still refuses 'full')", async () => {
    const rig = makeRig()
    await call(rig, 'pairStart', { mode: 'manager', label: 'second-desktop' })
    expect(rig.pairings.list()[0].scope).toEqual({ mode: 'manager', sessions: 'all' })
    await expect(call(rig, 'pairStart', { mode: 'full' })).rejects.toMatchObject({ code: 'bad_payload' })
    await expect(call(rig, 'pairStart', { mode: 'bogus' })).rejects.toMatchObject({ code: 'bad_payload' })
  })

  it('pairList omits secrets; pairRevoke revokes via the hub hook', async () => {
    const rig = makeRig()
    const a = await call(rig, 'pairStart', { mode: 'control' }) as { pairId: string }
    const list = await call(rig, 'pairList', {}) as { pairings: Array<{ pairId: string; secret?: unknown }> }
    expect(list.pairings).toHaveLength(1)
    expect(list.pairings[0].secret).toBeUndefined()
    const revoked = await call(rig, 'pairRevoke', { pairId: a.pairId }) as { revoked: boolean }
    expect(revoked.revoked).toBe(true)
    expect(rig.getRevoked()).toContain(a.pairId)
    expect(rig.pairings.lookup(a.pairId)).toBeNull()
  })

  it('connectRelay / disconnectRelay steer the dialer', async () => {
    const rig = makeRig()
    await call(rig, 'connectRelay', { controlUrl: 'ws://x/host/control', token: 't' })
    expect(rig.dialer.connect).toHaveBeenCalledWith('ws://x/host/control', 't')
    await call(rig, 'disconnectRelay', {})
    expect(rig.dialer.disconnect).toHaveBeenCalled()
    await expect(call(rig, 'connectRelay', { controlUrl: 1 })).rejects.toMatchObject({ code: 'bad_payload' })
  })

  it('publishes remote/state on pairStart and pairRevoke, snapshot-only and manager-scoped', async () => {
    const rig = makeRig()
    const before = rig.published.length
    await call(rig, 'pairStart', { mode: 'control' })
    expect(rig.published.length).toBeGreaterThan(before)
    const last = rig.published[rig.published.length - 1].payload as RemoteState
    expect(last.relay).toBe('off')
    expect(last.pairings).toHaveLength(1)
    // The topic authorizes manager-and-above connections.
    expect(rig.broker.authorize(REMOTE_STATE_TOPIC, conn('full'))).toBe('ok')
    expect(rig.broker.authorize(REMOTE_STATE_TOPIC, conn('manager'))).toBe('ok')
    expect(rig.broker.authorize(REMOTE_STATE_TOPIC, conn('control'))).not.toBe('ok')
  })
})

describe('one long-lived sharing pairing (task #14)', () => {
  it('enabling remote access mints exactly one manager pairing and persists it', async () => {
    const rig = makeRig()
    rig.accessState.enabled = false
    rig.accessState.state = 'off'
    await call(rig, 'setAccess', { enabled: true })
    const live = rig.pairings.entries().filter(p => !p.revoked)
    expect(live).toHaveLength(1)
    expect(live[0].scope).toEqual({ mode: 'manager', sessions: 'all' })
    expect(rig.persistPairings).toHaveBeenCalled()
  })

  it('re-enabling reuses the still-valid pairing rather than minting a second', async () => {
    const rig = makeRig()
    rig.accessState.enabled = false
    rig.accessState.state = 'off'
    await call(rig, 'setAccess', { enabled: true })
    const first = rig.pairings.entries()[0].pairId
    await call(rig, 'setAccess', { enabled: false })
    await call(rig, 'setAccess', { enabled: true })
    expect(rig.pairings.entries()).toHaveLength(1)
    expect(rig.pairings.entries()[0].pairId).toBe(first)
  })

  it('currentPairing returns the live pairing\'s fragment (secret inside), or null when none', async () => {
    const rig = makeRig()
    rig.accessState.enabled = false
    rig.accessState.state = 'off'
    // Disabled and never enabled: no link, and the read does not mint one.
    expect(await call(rig, 'currentPairing', {})).toBeNull()
    await call(rig, 'setAccess', { enabled: true })
    const result = await call(rig, 'currentPairing', {}) as { pairId: string; fragment: string }
    expect(result.fragment.startsWith('rt=')).toBe(true)
    const payload = JSON.parse(Buffer.from(result.fragment.slice(3), 'base64url').toString('utf8'))
    expect(payload.pairId).toBe(result.pairId)
    expect(typeof payload.pairSecret).toBe('string')
    // The fragment NEVER reaches remote/state: the published list omits secrets.
    const last = rig.published[rig.published.length - 1].payload as RemoteState
    expect(JSON.stringify(last)).not.toContain(payload.pairSecret)
  })

  it('stopSharing revokes the sharing pairing (old links die) and re-enabling mints a fresh one', async () => {
    const rig = makeRig()
    rig.accessState.enabled = false
    rig.accessState.state = 'off'
    await call(rig, 'setAccess', { enabled: true })
    const first = (await call(rig, 'currentPairing', {})) as { pairId: string }
    const stopped = await call(rig, 'stopSharing', {}) as { revoked: number }
    expect(stopped.revoked).toBe(1)
    expect(rig.pairings.lookup(first.pairId)).toBeNull()
    expect(await call(rig, 'currentPairing', {})).toBeNull()
    // Re-enable mints a fresh pairing with a NEW id (the old links stay dead).
    await call(rig, 'setAccess', { enabled: true })
    const second = (await call(rig, 'currentPairing', {})) as { pairId: string }
    expect(second.pairId).not.toBe(first.pairId)
  })

  // ---- Reset link (the settings page) -------------------------

  it('resetSharing replaces the link in one step: the old one dies, a new one is live', async () => {
    const rig = makeRig()
    rig.accessState.enabled = false
    rig.accessState.state = 'off'
    await call(rig, 'setAccess', { enabled: true })
    const first = (await call(rig, 'currentPairing', {})) as { pairId: string }
    rig.persistPairings.mockClear()
    const publishedBefore = rig.published.length

    const reset = await call(rig, 'resetSharing', {}) as { revoked: number; pairId: string | null }

    expect(reset.revoked).toBe(1)
    expect(rig.getRevoked()).toContain(first.pairId)
    expect(rig.pairings.lookup(first.pairId)).toBeNull()
    // No window with an enabled listener and no link: the replacement is
    // already the current pairing when the call returns.
    const second = (await call(rig, 'currentPairing', {})) as { pairId: string }
    expect(second.pairId).toBe(reset.pairId)
    expect(second.pairId).not.toBe(first.pairId)
    expect(rig.pairings.lookup(second.pairId)).not.toBeNull()
    expect(rig.persistPairings).toHaveBeenCalled()
    expect(rig.published.length).toBeGreaterThan(publishedBefore)
  })

  it('resetSharing while remote access is off revokes and mints nothing; the next enable mints', async () => {
    const rig = makeRig()
    rig.accessState.enabled = false
    rig.accessState.state = 'off'
    await call(rig, 'setAccess', { enabled: true })
    const first = (await call(rig, 'currentPairing', {})) as { pairId: string }
    await call(rig, 'setAccess', { enabled: false })

    const reset = await call(rig, 'resetSharing', {}) as { revoked: number; pairId: string | null }
    expect(reset).toEqual({ revoked: 1, pairId: null })
    expect(rig.pairings.entries().filter(p => !p.revoked)).toHaveLength(0)

    await call(rig, 'setAccess', { enabled: true })
    const second = (await call(rig, 'currentPairing', {})) as { pairId: string }
    expect(second.pairId).not.toBe(first.pairId)
  })

  it('resetSharing brings a link back after an earlier Stop sharing', async () => {
    // A desktop left enabled-but-stopped by the old Stop sharing button has
    // no link; Reset link is the page's way out of that state.
    const rig = makeRig()
    rig.accessState.enabled = false
    rig.accessState.state = 'off'
    await call(rig, 'setAccess', { enabled: true })
    await call(rig, 'stopSharing', {})
    expect(await call(rig, 'currentPairing', {})).toBeNull()

    const reset = await call(rig, 'resetSharing', {}) as { revoked: number; pairId: string | null }
    expect(reset.revoked).toBe(0)
    expect(reset.pairId).not.toBeNull()
    expect(await call(rig, 'currentPairing', {})).toMatchObject({ pairId: reset.pairId })
  })

  it('resetSharing spares a hand-minted manager pairing', async () => {
    const rig = makeRig()
    rig.accessState.enabled = false
    rig.accessState.state = 'off'
    const hand = await call(rig, 'pairStart', { mode: 'manager', label: 'second-desktop' }) as { pairId: string }
    await call(rig, 'setAccess', { enabled: true })

    await call(rig, 'resetSharing', {})
    expect(rig.pairings.lookup(hand.pairId)).not.toBeNull()
    expect(rig.getRevoked()).not.toContain(hand.pairId)
  })

  it('a port-only setAccess while enabled does NOT undo stopSharing', async () => {
    const rig = makeRig()
    rig.accessState.enabled = false
    rig.accessState.state = 'off'
    await call(rig, 'setAccess', { enabled: true })
    await call(rig, 'stopSharing', {})
    // Still enabled; only the port changes. Only an explicit enable mints.
    await call(rig, 'setAccess', { port: 47616 })
    expect(await call(rig, 'currentPairing', {})).toBeNull()
    expect(rig.pairings.entries().filter(p => !p.revoked)).toHaveLength(0)
  })

  // ---- lifetime ------------------------------------------------------------

  it('mints the sharing pairing at the table MAX ttl, not the 24 h default', async () => {
    let now = 1_000_000
    const rig = makeRig({ now: () => now })
    rig.accessState.enabled = false
    rig.accessState.state = 'off'
    await call(rig, 'setAccess', { enabled: true })
    const minted = rig.pairings.entries()[0]
    // The bug this pins: `start` with no ttlMs takes DEFAULT_TTL_MS (24 h), so
    // the one pairing an always-on feature depends on died after a day.
    expect(minted.expiresAt - minted.createdAt).toBe(SHARING_PAIRING_TTL_MS)
    expect(minted.expiresAt - minted.createdAt).toBeGreaterThan(24 * 60 * 60 * 1000)
  })

  it('renews an EXPIRED sharing pairing on the next currentPairing read', async () => {
    let now = 1_000_000
    const rig = makeRig({ now: () => now })
    rig.accessState.enabled = false
    rig.accessState.state = 'off'
    await call(rig, 'setAccess', { enabled: true })
    const first = (await call(rig, 'currentPairing', {})) as { pairId: string }
    expect(first).not.toBeNull()

    // Past the pairing's life, with remote access still enabled: without the
    // renewal the page shows "enabled" with no link and no way back.
    now += SHARING_PAIRING_TTL_MS + 1
    const second = (await call(rig, 'currentPairing', {})) as { pairId: string }
    expect(second).not.toBeNull()
    expect(second.pairId).not.toBe(first.pairId)
    expect(rig.pairings.lookup(second.pairId)).not.toBeNull()
  })

  it('does NOT renew after stopSharing — the button stays pressed', async () => {
    let now = 1_000_000
    const rig = makeRig({ now: () => now })
    rig.accessState.enabled = false
    rig.accessState.state = 'off'
    await call(rig, 'setAccess', { enabled: true })
    await call(rig, 'stopSharing', {})

    // Repeated reads must not resurrect a link the user just killed — the
    // renewal path distinguishes "expired" from "revoked".
    expect(await call(rig, 'currentPairing', {})).toBeNull()
    now += 60_000
    expect(await call(rig, 'currentPairing', {})).toBeNull()
    expect(rig.pairings.entries().filter(p => !p.revoked)).toHaveLength(0)
  })

  it('renews when the newest pairing expired even though an older one was revoked', async () => {
    // stop-sharing, re-enable, then let the NEW pairing run out: the stale
    // revoked row from the first cycle must not block the renewal.
    let now = 1_000_000
    const rig = makeRig({ now: () => now })
    rig.accessState.enabled = false
    rig.accessState.state = 'off'
    await call(rig, 'setAccess', { enabled: true })
    await call(rig, 'stopSharing', {})
    now += 1_000
    await call(rig, 'setAccess', { enabled: true })
    const second = (await call(rig, 'currentPairing', {})) as { pairId: string }

    now += SHARING_PAIRING_TTL_MS + 1
    const third = (await call(rig, 'currentPairing', {})) as { pairId: string }
    expect(third).not.toBeNull()
    expect(third.pairId).not.toBe(second.pairId)
  })

  // ---- boot order ----------------------------------------------------------

  it('mints NOTHING before both boot landings, then runs the deferred enable once', async () => {
    const rig = makeRig({ settled: false })
    rig.accessState.enabled = false
    rig.accessState.state = 'off'

    // A user enable that beats the boot reads: minting here would race the
    // rehydrate and persist an empty-table mint over the host's stored rows.
    await call(rig, 'setAccess', { enabled: true })
    expect(rig.pairings.entries()).toHaveLength(0)
    expect(await call(rig, 'currentPairing', {})).toBeNull()

    // One landing is not enough.
    rig.sharing.noteStatusLanded()
    expect(rig.sharing.ensure(true)).toBeNull()
    expect(rig.pairings.entries()).toHaveLength(0)

    // Both in: the deferred enable runs, exactly once.
    rig.sharing.noteRehydrateLanded()
    expect(rig.sharing.ensure(true)).not.toBeNull()
    expect(rig.pairings.entries()).toHaveLength(1)
    rig.sharing.ensure(true)
    expect(rig.pairings.entries()).toHaveLength(1)
  })

  it('reuses a rehydrated pairing instead of minting a second one', async () => {
    // The restart shape: the host's stored row lands first, then the gate
    // opens. The ensure must adopt that row, not mint alongside it.
    const rig = makeRig({ settled: false })
    const restored = rig.pairings.start({
      mode: 'manager', sessions: 'all', ttlMs: SHARING_PAIRING_TTL_MS, label: 'remote-access sharing',
    })
    rig.sharing.noteRehydrateLanded()
    rig.sharing.noteStatusLanded()
    const live = rig.sharing.ensure(true)
    expect(live?.pairId).toBe(restored.pairId)
    expect(rig.pairings.entries()).toHaveLength(1)
  })

  it('does not mint while remote access is disabled', async () => {
    const rig = makeRig()
    rig.accessState.enabled = false
    rig.accessState.state = 'off'
    expect(rig.sharing.ensure(false)).toBeNull()
    expect(rig.pairings.entries()).toHaveLength(0)
    expect(await call(rig, 'currentPairing', {})).toBeNull()
  })

  // The sharing pairing is identified by its reserved
  // label, not by `mode === 'manager'` — a hand-minted manager link is the
  // user's own and the coordinator must leave it alone in every direction.
  it('a hand-minted manager pairing is never adopted as the link, and stopSharing spares it', async () => {
    const rig = makeRig()
    rig.accessState.enabled = false
    rig.accessState.state = 'off'
    const hand = await call(rig, 'pairStart', { mode: 'manager', label: 'second-desktop' }) as { pairId: string }
    await call(rig, 'setAccess', { enabled: true })
    const current = (await call(rig, 'currentPairing', {})) as { pairId: string }
    expect(current.pairId).not.toBe(hand.pairId)

    const stopped = await call(rig, 'stopSharing', {}) as { revoked: number }
    expect(stopped.revoked).toBe(1)
    expect(rig.pairings.lookup(hand.pairId)).not.toBeNull()
    expect(rig.pairings.lookup(current.pairId)).toBeNull()
  })

  it('revoking a hand-minted manager pairing is NOT read as Stop sharing', async () => {
    let now = 1_000_000
    const rig = makeRig({ now: () => now })
    rig.accessState.enabled = false
    rig.accessState.state = 'off'
    await call(rig, 'setAccess', { enabled: true })
    now += 1000
    const hand = await call(rig, 'pairStart', { mode: 'manager', label: 'second-desktop' }) as { pairId: string }
    await call(rig, 'pairRevoke', { pairId: hand.pairId })
    // The sharing link expires; the newest MANAGER row is the revoked hand one,
    // but the newest SHARING row merely expired — so it renews.
    now += SHARING_PAIRING_TTL_MS + 1
    expect(await call(rig, 'currentPairing', {})).not.toBeNull()
  })

  it('pairStart refuses the reserved sharing label', async () => {
    const rig = makeRig()
    await expect(call(rig, 'pairStart', { mode: 'manager', label: 'remote-access sharing' }))
      .rejects.toMatchObject({ code: 'bad_payload' })
    expect(rig.pairings.entries()).toHaveLength(0)
  })

  it('stopSharing is a no-op when nothing is live, and is manager-gated', async () => {
    const rig = makeRig()
    const stopped = await call(rig, 'stopSharing', {}) as { revoked: number }
    expect(stopped.revoked).toBe(0)
    // control must not see the new actions at all.
    const control = rig.registry.advertise({ mode: 'control', sessions: 'all' })
      .find(c => c.cap === 'remote')?.acts ?? []
    expect(control).not.toContain('currentPairing')
    expect(control).not.toContain('stopSharing')
    expect(control).not.toContain('resetSharing')
    const manager = rig.registry.advertise({ mode: 'manager', sessions: 'all' })
      .find(c => c.cap === 'remote')?.acts ?? []
    expect(manager).toContain('resetSharing')
  })
})
