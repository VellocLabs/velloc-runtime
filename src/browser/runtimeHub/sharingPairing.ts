/**
 * The single place that decides whether the long-lived manager sharing pairing exists, and mints it.
 * Gated until both the driver's first status and the pairing rehydrate have landed; an earlier
 * request waits. Minted with the MAX TTL and renewed when the newest manager pairing EXPIRED, but
 * not when it was REVOKED (Stop sharing); that stop record is retained across restarts until
 * `mintForEnable()`.
 */
import type { Pairing, PairingTable } from './pairingTable'

/**
 * The auto-managed pairing's label (the settings page never names it). It is
 * also what IDENTIFIES the sharing pairing: `remote.pairStart` refuses it, so
 * no hand-minted pairing can carry it. Keying on `mode === 'manager'` alone
 * let a hand-minted manager link be adopted as "the" link, read its revoke as
 * *Stop sharing*, and have `stopSharing` revoke it too.
 */
export const SHARING_PAIRING_LABEL = 'remote-access sharing'

/** True for the auto-managed sharing pairing, live or not. */
export function isSharingPairing(p: Pairing): boolean {
  return p.scope.mode === 'manager' && p.label === SHARING_PAIRING_LABEL
}

/**
 * The sharing pairing's lifetime: the pairing table's MAX_TTL_MS, applied
 * EXPLICITLY. `pairingTable.start` clamps to the same ceiling, so this is the
 * longest a pairing can live — and `ensure` renews it when it finally runs out.
 */
export const SHARING_PAIRING_TTL_MS = 30 * 24 * 60 * 60 * 1000

/** A revoked sharing row: the record that the user pressed *Stop sharing*. */
export function isSharingStopRecord(p: Pairing): boolean {
  return p.revoked && isSharingPairing(p)
}

export type SharingPairingOptions = {
  pairings: PairingTable
  /** Injected clock for every expiry comparison. */
  now(): number
  /** Write the full table back to the host after a mint. */
  persist(): void
  /** Republish `remote/state` after a mint (the pairing list grew). */
  publishState(): void
}

export type SharingPairing = {
  /** The driver's first getStatus applied: `access().enabled` is now truthful. */
  noteStatusLanded(): void
  /** The persistence layer's first getPairings rehydrate applied. */
  noteRehydrateLanded(): void
  /** True once both landings are in and a mint may run. */
  ready(): boolean
  /** The one live sharing pairing, or null. */
  live(): Pairing | null
  /**
   * Keep one live pairing while `enabled` — renewing an expired one, but never
   * resurrecting one the user stopped sharing. A no-op before the gate opens
   * or while disabled. Returns the live pairing when there is one.
   */
  ensure(enabled: boolean): Pairing | null
  /**
   * The user just turned remote access ON: there must be a link, even if the
   * previous one was revoked by *Stop sharing*. Deferred until the gate opens
   * if it is called before boot has settled.
   */
  mintForEnable(): Pairing | null
}

export function createSharingPairing(options: SharingPairingOptions): SharingPairing {
  let statusLanded = false
  let rehydrateLanded = false
  /** A `mintForEnable()` that arrived before the gate opened. */
  let pendingEnable = false

  const ready = () => statusLanded && rehydrateLanded

  const managerRows = (): Pairing[] => options.pairings.entries().filter(isSharingPairing)

  function live(): Pairing | null {
    const now = options.now()
    // Newest-first, so two live rows (a rehydrate racing a mint) resolve
    // deterministically to the one a fresh link was built from.
    return (
      managerRows()
        .filter(p => !p.revoked && p.expiresAt > now)
        .sort((a, b) => b.createdAt - a.createdAt)[0] ?? null
    )
  }

  /**
   * Did the user stop sharing? The newest manager row being revoked is the
   * record of it — see the file comment. An older revoked row under a newer
   * expired one is history, not intent.
   */
  function stoppedByUser(): boolean {
    const newest = managerRows().sort((a, b) => b.createdAt - a.createdAt)[0]
    return newest !== undefined && newest.revoked
  }

  function mint(): Pairing {
    const minted = options.pairings.start({
      mode: 'manager',
      sessions: 'all',
      ttlMs: SHARING_PAIRING_TTL_MS,
      label: SHARING_PAIRING_LABEL,
    })
    options.persist()
    options.publishState()
    return minted
  }

  function ensure(enabled: boolean): Pairing | null {
    if (!ready()) return null
    // A deferred enable outranks the stop-sharing record below: the user asked
    // for a link. It does NOT outrank the listener being off — an enable the
    // user reversed before boot settled is spent, not owed.
    if (pendingEnable) {
      pendingEnable = false
      if (enabled) return live() ?? mint()
      return live()
    }
    if (!enabled) return live()
    const existing = live()
    if (existing) return existing
    if (stoppedByUser()) return null
    return mint()
  }

  return {
    noteStatusLanded() {
      statusLanded = true
    },
    noteRehydrateLanded() {
      rehydrateLanded = true
    },
    ready,
    live,
    ensure,
    mintForEnable(): Pairing | null {
      if (!ready()) {
        // Boot has not settled — minting now would race the rehydrate (#4).
        // Remember the intent; the next `ensure` after the gate opens runs it.
        pendingEnable = true
        return null
      }
      return live() ?? mint()
    },
  }
}
