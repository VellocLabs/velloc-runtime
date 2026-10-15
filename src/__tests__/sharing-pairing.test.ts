/**
 * The sharing-pairing coordinator wired to the two real modules whose async landings gate it
 * (`remoteAccessDriver`, `pairingPersistence`), as `RuntimeHub`'s constructor wires them; the tests drive the
 * restart orderings a real boot can produce. Lifetime / renewal: remote-capability.test.ts.
 */
import { describe, expect, it, vi } from 'vitest'
import { createPairingTable } from '../browser/runtimeHub/pairingTable'
import { createPairingPersistence } from '../browser/runtimeHub/pairingPersistence'
import { createRemoteAccessDriver } from '../browser/runtimeHub/remoteAccessDriver'
import {
  createSharingPairing,
  SHARING_PAIRING_LABEL,
  SHARING_PAIRING_TTL_MS,
} from '../browser/runtimeHub/sharingPairing'
import type { RemoteAccessStatus } from '../browser/bridge/protocol/remoteAccess'
import type { HostBridge } from '../browser/runtimeHub/types'
import type { RelayDialer } from '../browser/runtimeHub/relayDialer'

const LISTENING: RemoteAccessStatus = {
  enabled: true, bindAddress: '0.0.0.0', port: 47615, state: 'listening',
  controlUrl: 'ws://127.0.0.1:47615/host/control', controlToken: 'tok',
  addresses: [], clients: 0,
}
const OFF: RemoteAccessStatus = {
  enabled: false, bindAddress: '0.0.0.0', port: 47615, state: 'off',
  addresses: [], clients: 0,
}

/** A stored row as the host's pref list holds it (secret included). */
function storedRow(over: Record<string, unknown> = {}) {
  const createdAt = 1_000_000
  return {
    pairId: 'stored-1', secret: 'stored-secret',
    scope: { mode: 'manager', sessions: 'all' },
    label: SHARING_PAIRING_LABEL,
    createdAt, expiresAt: createdAt + SHARING_PAIRING_TTL_MS,
    revoked: false, lastSeenAt: null, connections: 0,
    ...over,
  }
}

/**
 * The three objects RuntimeHub owns, wired the way it wires them. The host
 * stub leaves the two boot reads (`getStatus`, `getPairings`) UNRESOLVED and
 * hands back `landStatus()` / `landRehydrate()`, so a test lands them in a
 * chosen order — which is the whole point.
 */
function makeRig(options: {
  stored?: unknown[]
  status?: RemoteAccessStatus
  now?: () => number
} = {}) {
  const now = options.now ?? (() => 2_000_000)
  const status = options.status ?? LISTENING
  const stored = options.stored ?? []

  const resolvers: Record<string, (value: unknown) => void> = {}
  const calls: Array<{ action: string; payload: unknown }> = []
  const host: HostBridge = {
    request: vi.fn((route: { capability: string; action: string }, payload: unknown) => {
      calls.push({ action: route.action, payload })
      if (route.action === 'getStatus') {
        return new Promise(resolve => {
          resolvers.getStatus = resolve as (value: unknown) => void
        })
      }
      if (route.action === 'getPairings') {
        return new Promise(resolve => {
          resolvers.getPairings = resolve as (value: unknown) => void
        })
      }
      return Promise.resolve({ ok: true as const, result: { ok: true } })
    }) as HostBridge['request'],
  }

  const pairings = createPairingTable(now)
  const publishState = vi.fn()
  const dialer = {
    state: 'off' as const, connect: vi.fn(), disconnect: vi.fn(),
  } as unknown as RelayDialer

  const remoteAccess = createRemoteAccessDriver({
    host: () => host,
    subscribeEvents: () => () => {},
    dialer,
    publishState,
    onStatusApplied: () => {
      sharing.noteStatusLanded()
      sharing.ensure(remoteAccess.access().enabled)
    },
  })
  const persistence = createPairingPersistence({
    host: () => host,
    pairings,
    publishState,
    onRehydrated: () => {
      sharing.noteRehydrateLanded()
      sharing.ensure(remoteAccess.access().enabled)
    },
  })
  const sharing = createSharingPairing({
    pairings,
    now,
    persist: () => persistence.persist(),
    publishState,
  })

  return {
    pairings, sharing, remoteAccess, persistence, calls, publishState,
    /** What RuntimeHub.setRemoteAccessSupported does: arm both, ensure nothing. */
    arm() {
      remoteAccess.setSupported(true)
      persistence.setSupported(true)
    },
    landStatus: async () => {
      resolvers.getStatus?.({ ok: true, result: status })
      await flush()
    },
    landRehydrate: async () => {
      resolvers.getPairings?.({ ok: true, result: { pairings: stored } })
      await flush()
    },
    managerRows: () => pairings.entries().filter(p => p.scope.mode === 'manager'),
    persistedRows: () => {
      const writes = calls.filter(c => c.action === 'setPairings')
      const last = writes[writes.length - 1]
      return last ? (last.payload as { pairings: unknown[] }).pairings : null
    },
  }
}

const flush = async (rounds = 3) => {
  for (let i = 0; i < rounds; i += 1) await new Promise<void>(r => setTimeout(r, 0))
}

describe('sharing pairing — boot ordering', () => {
  it('mints nothing while arming: both boot reads are still in flight', async () => {
    const rig = makeRig()
    rig.arm()
    await flush()
    // The tick the old inline ensure ran in. `access().enabled` is still the
    // pre-boot false here, which is why that ensure never fired at all.
    expect(rig.remoteAccess.access().enabled).toBe(false)
    expect(rig.managerRows()).toHaveLength(0)
    expect(rig.persistedRows()).toBeNull()
  })

  it('status first, then rehydrate: adopts the stored pairing, mints nothing', async () => {
    const rig = makeRig({ stored: [storedRow()] })
    rig.arm()
    await rig.landStatus()
    // Enabled is now true and the table is still EMPTY — this is the window in
    // which the old code would have minted a second pairing and persisted it
    // over the host's stored list.
    expect(rig.remoteAccess.access().enabled).toBe(true)
    expect(rig.managerRows()).toHaveLength(0)

    await rig.landRehydrate()
    expect(rig.managerRows()).toHaveLength(1)
    expect(rig.sharing.live()?.pairId).toBe('stored-1')
    // Nothing was written back: adopting a row is not a mutation.
    expect(rig.persistedRows()).toBeNull()
  })

  it('rehydrate first, then status: same result, no duplicate', async () => {
    const rig = makeRig({ stored: [storedRow()] })
    rig.arm()
    await rig.landRehydrate()
    expect(rig.managerRows()).toHaveLength(1)

    await rig.landStatus()
    expect(rig.managerRows()).toHaveLength(1)
    expect(rig.sharing.live()?.pairId).toBe('stored-1')
  })

  it('enabled with NOTHING stored (a fresh profile): mints exactly one, once both land', async () => {
    const rig = makeRig({ stored: [] })
    rig.arm()
    await rig.landStatus()
    expect(rig.managerRows()).toHaveLength(0)

    await rig.landRehydrate()
    const rows = rig.managerRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].label).toBe(SHARING_PAIRING_LABEL)
    expect(rows[0].expiresAt - rows[0].createdAt).toBe(SHARING_PAIRING_TTL_MS)
    // And it was persisted, so the next boot rehydrates it instead of minting.
    expect(rig.persistedRows()).toHaveLength(1)
  })

  it('disabled across the restart: nothing is minted', async () => {
    const rig = makeRig({ status: OFF, stored: [] })
    rig.arm()
    await rig.landStatus()
    await rig.landRehydrate()
    expect(rig.remoteAccess.access().enabled).toBe(false)
    expect(rig.managerRows()).toHaveLength(0)
  })

  it('a stored pairing that EXPIRED while the desktop was off is replaced, not duplicated', async () => {
    const dead = storedRow({ pairId: 'dead', expiresAt: 1_500_000 })
    const rig = makeRig({ stored: [dead], now: () => 2_000_000 })
    rig.arm()
    await rig.landStatus()
    await rig.landRehydrate()
    // rehydrate drops the expired row; the ensure then renews.
    const rows = rig.managerRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].pairId).not.toBe('dead')
    expect(rig.sharing.live()).not.toBeNull()
  })

  it('a stored pairing REVOKED by Stop sharing stays stopped across the restart', async () => {
    const stopped = storedRow({ pairId: 'stopped', revoked: true })
    const rig = makeRig({ stored: [stopped] })
    rig.arm()
    await rig.landStatus()
    await rig.landRehydrate()
    // Remote access is still enabled, but the user had stopped sharing — the
    // boot ensure must not hand the link back.
    expect(rig.remoteAccess.access().enabled).toBe(true)
    expect(rig.sharing.live()).toBeNull()
    expect(rig.managerRows()).toHaveLength(1)
    expect(rig.managerRows()[0].pairId).toBe('stopped')
  })

  // The stop record used to die with its row's expiresAt —
  // the rehydrate dropped it, and the next restart minted a link nobody asked for.
  it('stays stopped across a restart even after the revoked row itself has EXPIRED', async () => {
    const stopped = storedRow({ pairId: 'stopped', revoked: true, expiresAt: 1_500_000 })
    const rig = makeRig({ stored: [stopped] }) // now = 2_000_000, past its expiry
    rig.arm()
    await rig.landStatus()
    await rig.landRehydrate()
    expect(rig.sharing.live()).toBeNull()
    expect(rig.managerRows().map(p => p.pairId)).toEqual(['stopped'])
  })

  it('an enable that beats the boot reads is deferred, not dropped and not doubled', async () => {
    // The user clicking the toggle in the first milliseconds: mintForEnable
    // cannot run yet, so it is remembered and runs once the gate opens.
    const rig = makeRig({ stored: [] })
    rig.arm()
    expect(rig.sharing.mintForEnable()).toBeNull()
    expect(rig.managerRows()).toHaveLength(0)

    await rig.landStatus()
    expect(rig.managerRows()).toHaveLength(0)
    await rig.landRehydrate()
    expect(rig.managerRows()).toHaveLength(1)

    // The deferred intent is consumed exactly once.
    rig.sharing.ensure(true)
    expect(rig.managerRows()).toHaveLength(1)
  })

  it('an early enable does NOT mint alongside the row the host is about to return', async () => {
    // The duplicate case, at its sharpest: an enable that runs
    // before the rehydrate lands used to mint a pairing AND persist() the
    // one-row table over the host's stored list — losing the stored pairing
    // and leaving two manager rows where there must be one.
    const rig = makeRig({ stored: [storedRow()] })
    rig.arm()
    rig.sharing.mintForEnable()
    expect(rig.persistedRows()).toBeNull()

    await rig.landStatus()
    await rig.landRehydrate()
    expect(rig.managerRows()).toHaveLength(1)
    expect(rig.sharing.live()?.pairId).toBe('stored-1')
  })

  it('an enable deferred past a restart that restores a STOPPED pairing still shares', async () => {
    // mintForEnable outranks the stop record: the user asked for a link.
    const rig = makeRig({ stored: [storedRow({ pairId: 'stopped', revoked: true })] })
    rig.arm()
    expect(rig.sharing.mintForEnable()).toBeNull()
    await rig.landStatus()
    await rig.landRehydrate()
    expect(rig.sharing.live()).not.toBeNull()
    expect(rig.sharing.live()?.pairId).not.toBe('stopped')
  })

  it('drops a deferred enable the user reversed before the gate opened', async () => {
    // Enable, then disable again, both before boot settles: the pending intent
    // is spent, not owed — minting here would leave a link behind a listener
    // the user turned off.
    const rig = makeRig({ status: OFF, stored: [] })
    rig.arm()
    rig.sharing.mintForEnable()
    await rig.landStatus()
    await rig.landRehydrate()
    expect(rig.remoteAccess.access().enabled).toBe(false)
    expect(rig.managerRows()).toHaveLength(0)
  })

  it('never opens the gate on the status alone, however many statuses arrive', async () => {
    const rig = makeRig({ stored: [] })
    rig.arm()
    await rig.landStatus()
    rig.sharing.ensure(true)
    rig.sharing.ensure(true)
    expect(rig.sharing.ready()).toBe(false)
    expect(rig.managerRows()).toHaveLength(0)
  })
})
