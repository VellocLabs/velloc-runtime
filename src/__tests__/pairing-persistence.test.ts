/**
 * WP-4 (task #14): the pairing-persistence coordinator. The manifest gate
 * (zero host calls before setSupported(true)); rehydrate-on-arm from the
 * host's pref rows, dropping expired; and persist() writing the full table
 * back after a mutation — the shape that survives a desktop restart.
 */
import { describe, expect, it, vi } from 'vitest'
import { createPairingPersistence } from '../browser/runtimeHub/pairingPersistence'
import { createPairingTable } from '../browser/runtimeHub/pairingTable'
import type { HostBridge } from '../browser/runtimeHub/types'

function makeRig(storedRows: unknown[] = [], options: { failRead?: boolean } = {}) {
  const calls: Array<{ capability: string; action: string; payload: unknown }> = []
  const host: HostBridge = {
    request: vi.fn(async (route: { capability: string; action: string }, payload: unknown) => {
      calls.push({ capability: route.capability, action: route.action, payload })
      if (route.action === 'getPairings') {
        return options.failRead
          ? { ok: false as const, error: { code: 'x', message: 'read failed' } }
          : { ok: true as const, result: { pairings: storedRows } }
      }
      if (route.action === 'setPairings') return { ok: true as const, result: { ok: true } }
      return { ok: false as const, error: { code: 'x', message: 'no stub' } }
    }),
  }
  const pairings = createPairingTable()
  const publishState = vi.fn()
  const onRehydrated = vi.fn()
  const persistence = createPairingPersistence({
    host: () => host, pairings, publishState, onRehydrated,
  })
  return { persistence, pairings, host, calls, publishState, onRehydrated }
}

const row = (over: Record<string, unknown> = {}) => ({
  pairId: 'p1', secret: 's3cr3t', scope: { mode: 'manager', sessions: 'all' },
  label: 'remote-access sharing', createdAt: Date.now(), expiresAt: Date.now() + 60_000,
  revoked: false, lastSeenAt: null, connections: 0, ...over,
})

describe('pairingPersistence', () => {
  it('makes ZERO host calls before setSupported(true), and persist() is a no-op', async () => {
    const rig = makeRig()
    rig.persistence.persist()
    expect(rig.calls).toHaveLength(0)
    rig.persistence.setSupported(false)
    expect(rig.calls).toHaveLength(0)
  })

  it('on arm, rehydrates live rows from the host and drops expired ones', async () => {
    const rig = makeRig([
      row({ pairId: 'live' }),
      row({ pairId: 'expired', expiresAt: Date.now() - 1 }),
    ])
    rig.persistence.setSupported(true)
    await flush()
    expect(rig.calls.some(c => c.action === 'getPairings')).toBe(true)
    expect(rig.pairings.lookup('live')).not.toBeNull()
    expect(rig.pairings.lookup('expired')).toBeNull()
    // A rehydrate that added a row republishes remote/state.
    expect(rig.publishState).toHaveBeenCalled()
  })

  it('persist() writes the full table (secret included) to remoteAccess.setPairings', async () => {
    const rig = makeRig()
    rig.persistence.setSupported(true)
    await flush()
    rig.pairings.start({ mode: 'manager', sessions: 'all', label: 'x' })
    rig.persistence.persist()
    await flush()
    const set = rig.calls.find(c => c.action === 'setPairings')
    expect(set).toBeDefined()
    const rows = (set!.payload as { pairings: Array<{ secret?: unknown }> }).pairings
    expect(rows).toHaveLength(1)
    expect(rows[0].secret).toBeTypeOf('string')
  })

  // The sharing-pairing gate waits on this callback. It
  // must fire when the READ SETTLES, not when rows arrive — a fresh profile
  // (no stored rows) and a host whose read fails both have to open the gate,
  // or the runtime never mints a link at all.
  it('fires onRehydrated once the read settles, even with no stored rows', async () => {
    const rig = makeRig([])
    expect(rig.onRehydrated).not.toHaveBeenCalled()
    rig.persistence.setSupported(true)
    await flush()
    expect(rig.onRehydrated).toHaveBeenCalledTimes(1)
  })

  it('fires onRehydrated even when the host read FAILS', async () => {
    const rig = makeRig([], { failRead: true })
    rig.persistence.setSupported(true)
    await flush()
    expect(rig.onRehydrated).toHaveBeenCalledTimes(1)
  })

  it('does not fire onRehydrated while unsupported (no host call is made)', async () => {
    const rig = makeRig()
    rig.persistence.setSupported(false)
    await flush()
    expect(rig.calls).toHaveLength(0)
    expect(rig.onRehydrated).not.toHaveBeenCalled()
  })

  // setPairings REPLACES the stored list, so a write made
  // from a table the stored rows were never merged into deletes them — every
  // stored link and the Stop-sharing record.
  it('a FAILED read writes nothing; the next persist() re-reads, merges, then writes the union', async () => {
    const opts = { failRead: true }
    const rig = makeRig([row({ pairId: 'stored' })], opts)
    rig.persistence.setSupported(true)
    await flush()
    const minted = rig.pairings.start({ mode: 'control', sessions: 'all', label: 'x' })
    rig.persistence.persist()
    await flush()
    // Still failing: the stored list must be untouched.
    expect(rig.calls.filter(c => c.action === 'setPairings')).toHaveLength(0)

    opts.failRead = false
    rig.persistence.persist()
    await flush()
    const sets = rig.calls.filter(c => c.action === 'setPairings')
    expect(sets).toHaveLength(1)
    const ids = (sets[0].payload as { pairings: Array<{ pairId: string }> }).pairings.map(p => p.pairId).sort()
    expect(ids).toEqual([minted.pairId, 'stored'].sort())
    // The gate opened once, on the first settle — not again on the retry.
    expect(rig.onRehydrated).toHaveBeenCalledTimes(1)
  })

  it('a persist() racing the boot read is owed, not written early: it lands after the merge, stored rows intact', async () => {
    const rig = makeRig([row({ pairId: 'stored' })])
    rig.persistence.setSupported(true)
    // pairStart lands BEFORE the rehydrate does.
    const minted = rig.pairings.start({ mode: 'control', sessions: 'all', label: 'x' })
    rig.persistence.persist()
    expect(rig.calls.filter(c => c.action === 'setPairings')).toHaveLength(0)
    await flush()
    const sets = rig.calls.filter(c => c.action === 'setPairings')
    expect(sets).toHaveLength(1)
    const ids = (sets[0].payload as { pairings: Array<{ pairId: string }> }).pairings.map(p => p.pairId).sort()
    expect(ids).toEqual([minted.pairId, 'stored'].sort())
  })

  it('a host read that REJECTS still opens the gate and still writes nothing', async () => {
    const rig = makeRig()
    ;(rig.host.request as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('bridge gone'))
    rig.persistence.setSupported(true)
    await flush()
    expect(rig.onRehydrated).toHaveBeenCalledTimes(1)
    expect(rig.calls.filter(c => c.action === 'setPairings')).toHaveLength(0)
  })

  // The Stop-sharing record must outlive its row's expiry.
  it('rehydrate retains the NEWEST expired stop record, and only that expired row', async () => {
    const past = Date.now() - 1000
    const rig = makeRig([
      row({ pairId: 'old-stop', revoked: true, createdAt: 1, expiresAt: past }),
      row({ pairId: 'stop', revoked: true, createdAt: 2, expiresAt: past }),
      row({ pairId: 'expired-live', createdAt: 3, expiresAt: past }),
      row({ pairId: 'hand-revoked', label: 'mine', revoked: true, createdAt: 4, expiresAt: past }),
    ])
    rig.persistence.setSupported(true)
    await flush()
    expect(rig.pairings.entries().map(p => p.pairId)).toEqual(['stop'])
    // Retained for the record only — an expired row never authenticates.
    expect(rig.pairings.lookup('stop')).toBeNull()
  })

  it('a minted-then-persisted row rehydrates identically after a restart (round-trip)', async () => {
    const rig = makeRig()
    rig.persistence.setSupported(true)
    await flush()
    const minted = rig.pairings.start({ mode: 'manager', sessions: 'all', label: 'remote-access sharing' })
    rig.persistence.persist()
    await flush()
    const persisted = (rig.calls.find(c => c.action === 'setPairings')!.payload as { pairings: unknown[] }).pairings

    // A fresh runtime (new table) rehydrates from those rows: the link still works.
    const rig2 = makeRig(persisted)
    rig2.persistence.setSupported(true)
    await flush()
    const revived = rig2.pairings.lookup(minted.pairId)
    expect(revived).not.toBeNull()
    expect(revived!.secret).toBe(minted.secret)
    expect(revived!.scope).toEqual(minted.scope)
  })
})

function flush(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}
