/**
 * Pairing persistence: rehydrates the pairing table from the host pref store on boot and writes the
 * full table back after every mutation. No host call before `setSupported(true)`.
 * Security: secrets ride these calls verbatim (stored in plaintext, like API keys) and go nowhere
 * else: never a topic, a log line, or localStorage.
 */
import type { HostBridge } from './types'
import type { Pairing, PairingTable } from './pairingTable'
import { isSharingStopRecord } from './sharingPairing'

/** The host row shape — `Pairing` verbatim (the adapter passes it through). */
export type PersistedPairing = Pairing

export type PairingPersistenceOptions = {
  /** Lazily read — the direct bridge may connect after construction. */
  host(): HostBridge | null
  /** The in-memory table being mirrored. */
  pairings: PairingTable
  /** Republish `remote/state` after a rehydrate (the list grew). */
  publishState(): void
  /**
   * Fired once the rehydrating `getPairings` has landed and the table holds
   * every still-valid row the host persisted (whether or not any were added).
   * The sharing-pairing coordinator (rework #20) gates its ONE ensure on
   * this: minting before the rehydrate lands duplicates a row the host is
   * about to hand back. Fires even on an empty/failed read — the gate is
   * "the read settled", not "rows arrived".
   */
  onRehydrated?(): void
}

export type PairingPersistence = {
  /**
   * Arm/disarm the manifest gate. Arming triggers the ONE rehydrating
   * `remoteAccess.getPairings`; before that, and after `false`, no host
   * calls are made and `persist()` is a no-op.
   */
  setSupported(supported: boolean): void
  /**
   * Write the full table back (fire-and-forget; the next mutation retries). NEVER before a
   * `getPairings` has succeeded: the write replaces the stored list wholesale.
   */
  persist(): void
}

export function createPairingPersistence(
  options: PairingPersistenceOptions,
): PairingPersistence {
  let supported = false
  /** `merged` = a read succeeded and its rows are in the table. */
  let read: 'idle' | 'in-flight' | 'merged' | 'failed' = 'idle'
  /** A persist() asked for before the table was safe to write. */
  let writeOwed = false
  let rehydrateAnnounced = false

  function request(action: string, payload: unknown) {
    const host = options.host()
    if (!host) return Promise.resolve(null)
    return host.request(
      { namespace: 'nexus', capability: 'remoteAccess', action } as never,
      payload,
    )
  }

  function write(): void {
    // Replace the persisted list verbatim — no delta, so a revoke and a mint
    // are the same call and a missed write self-heals on the next one.
    void request('setPairings', { pairings: options.pairings.entries() })
  }

  function rehydrate(): void {
    read = 'in-flight'
    void request('getPairings', {})
      .catch(() => null)
      .then(response => {
        if (!supported) return
        const rows =
          response && response.ok
            ? (response.result as { pairings?: PersistedPairing[] }).pairings
            : undefined
        if (Array.isArray(rows)) {
          // `rehydrate` merges (a pairId already in the table wins), so rows
          // minted while the read was in flight survive alongside the stored
          // ones — and only now is the table a superset safe to write back.
          const added = options.pairings.rehydrate(rows, isSharingStopRecord)
          read = 'merged'
          if (added > 0) options.publishState()
          if (writeOwed) {
            writeOwed = false
            write()
          }
        } else {
          read = 'failed'
        }
        // The read settled — rows or not, the sharing-pairing ensure may run
        // (#20): a failed read must not wedge minting. Its persist() is owed,
        // not written, until a read succeeds. Announced once.
        if (!rehydrateAnnounced) {
          rehydrateAnnounced = true
          options.onRehydrated?.()
        }
      })
  }

  return {
    setSupported(next: boolean): void {
      if (next === supported) return
      supported = next
      if (!supported) return
      // Armed: rehydrate. Rows past expiresAt are dropped by the table.
      rehydrate()
    },

    persist(): void {
      if (!supported) return
      if (read === 'merged') {
        write()
        return
      }
      writeOwed = true
      if (read === 'failed') rehydrate()
    },
  }
}
