/**
 * Security: the in-memory set of remote-access pairings (F-24) — (pairId, secret, scope), proved by
 * HMAC over the nonce in the `pair` handshake. The secret is returned once by `start`; afterwards
 * only `entries()` (for persistence) carries it, `list` omits it. `DEFAULT_TTL_MS` is for hand-minted pairings.
 */
import type { Scope, ScopeMode } from '../runtimeProtocol'

export type Pairing = {
  pairId: string
  /** base64url, 32 bytes. Only ever read by the handshake verifier. */
  secret: string
  scope: Scope
  label: string
  createdAt: number
  expiresAt: number
  revoked: boolean
  lastSeenAt: number | null
  connections: number
}

export type PairingStartInput = {
  mode: 'observe' | 'control' | 'manager'
  sessions: 'all' | string[]
  ttlMs?: number
  label?: string
}

export interface PairingTable {
  start(input: PairingStartInput): Pairing
  /** Expired or revoked → null. */
  lookup(pairId: string): Pairing | null
  revoke(pairId: string): boolean
  /** secret omitted — it surfaces only in `start`'s return and `entries()`. */
  list(): Array<Omit<Pairing, 'secret'>>
  /**
   * Rehydrate from the host-persisted rows: seed rows a
   * previous runtime wrote, dropping any already past `expiresAt`. An id that
   * collides with a live row is skipped — the in-memory row is the truth.
   */
  rehydrate(rows: readonly Pairing[], retainExpired?: (row: Pairing) => boolean): number
  /**
   * The full rows, secret INCLUDED — the exact shape the host persists
   * (`remoteAccess.setPairings`). This is the ONLY other place a secret leaves
   * the table; it goes to the profile pref store, never a topic/log/localStorage.
   */
  entries(): Pairing[]
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000
const MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000

function randomBase64Url(bytes: number): string {
  const buf = new Uint8Array(bytes)
  globalThis.crypto.getRandomValues(buf)
  // base64url without padding, RFC 4648 section 5.
  let binary = ''
  for (const b of buf) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function createPairingTable(now: () => number = () => Date.now()): PairingTable {
  const table = new Map<string, Pairing>()

  return {
    start(input) {
      const ttl = Math.min(input.ttlMs ?? DEFAULT_TTL_MS, MAX_TTL_MS)
      const createdAt = now()
      // mode:'full' is not in PairingStartInput's type — a paired link tops
      // out at manager; the desktop's own local surface stays local.
      const scope: Scope = { mode: input.mode as ScopeMode, sessions: input.sessions }
      const pairing: Pairing = {
        pairId: randomBase64Url(16),
        secret: randomBase64Url(32),
        scope,
        label: input.label ?? '',
        createdAt,
        expiresAt: createdAt + ttl,
        revoked: false,
        lastSeenAt: null,
        connections: 0,
      }
      table.set(pairing.pairId, pairing)
      return pairing
    },

    lookup(pairId) {
      const p = table.get(pairId)
      if (!p || p.revoked || p.expiresAt <= now()) return null
      return p
    },

    revoke(pairId) {
      const p = table.get(pairId)
      if (!p || p.revoked) return false
      p.revoked = true
      return true
    },

    list() {
      return Array.from(table.values(), ({ secret: _secret, ...rest }) => rest)
    },

    rehydrate(rows, retainExpired) {
      const at = now()
      let added = 0
      // An expired row is dropped on load — except the NEWEST one the caller
      // asks to retain (the sharing coordinator's stop record, which must
      // outlive its own expiry). Only the newest: one record carries the
      // intent, and keeping them all would grow the stored list forever.
      let retained: Pairing | null = null
      if (retainExpired) {
        for (const row of rows) {
          if (!row || typeof row.pairId !== 'string' || row.expiresAt > at) continue
          if (retainExpired(row) && (!retained || row.createdAt > retained.createdAt)) retained = row
        }
      }
      for (const row of rows) {
        // Expired rows are dropped on load; revoked ones are kept so a revoked
        // id stays revoked across a restart rather than becoming mintable again.
        if (!row || typeof row.pairId !== 'string') continue
        if (row.expiresAt <= at && row !== retained) continue
        if (table.has(row.pairId)) continue
        table.set(row.pairId, { ...row, connections: 0 })
        added += 1
      }
      return added
    },

    entries() {
      return Array.from(table.values(), row => ({ ...row }))
    },
  }
}
