/**
 * The guest's "last active session" pointer. A HINT, never a fact: DOM storage commits are batched,
 * so a restored id can name a deleted session. `resolveBootSession` reports whether the id was restored;
 * that travels as `restoredSessionId` so the worker does not re-create a deleted session's directory.
 */

export const ACTIVE_SESSION_STORAGE_KEY = 'shift-active-session'

export type BootSession = {
  sessionId: string
  /**
   * True when `sessionId` came from the persisted pointer rather than being
   * minted by this document. Only ids minted here are known to be real.
   */
  restored: boolean
}

/** Read the persisted pointer. `null` when unset or storage is unavailable. */
export function readStoredActiveSessionId(): string | null {
  try {
    return globalThis.localStorage?.getItem(ACTIVE_SESSION_STORAGE_KEY) ?? null
  } catch {
    // localStorage may be unavailable in some environments.
    return null
  }
}

/** Persist the pointer. Best-effort — see the durability caveat above. */
export function writeStoredActiveSessionId(sessionId: string): void {
  try {
    globalThis.localStorage?.setItem(ACTIVE_SESSION_STORAGE_KEY, sessionId)
  } catch {
    // localStorage may be unavailable.
  }
}

/**
 * Decide which session the shell boots into, and whether that id is trusted.
 *
 * Precedence: an explicit host-supplied id (a deep link — deliberate, so it
 * stays creatable) → the persisted pointer (restored) → a fresh id.
 */
export function resolveBootSession(options: {
  /** Host-supplied session id (`?sessionId=` → `initPayload.sessionId`). */
  initialSessionId?: string
  storedSessionId: string | null
  mintSessionId: () => string
}): BootSession {
  if (options.initialSessionId) {
    return { sessionId: options.initialSessionId, restored: false }
  }
  if (options.storedSessionId) {
    return { sessionId: options.storedSessionId, restored: true }
  }
  return { sessionId: options.mintSessionId(), restored: false }
}

/**
 * Whether `sessionId` is the restored pointer, the only id this document did not mint; an absent
 * record for any other id means brand-new and is persisted at bind. The worker scrubs the flag from
 * replayed init payloads too (F-17).
 */
export function isRestoredSessionPointer(
  boot: BootSession,
  sessionId: string,
): boolean {
  return boot.restored && sessionId === boot.sessionId
}
