// CLI sessions a launcher created in this window (F-34): their view starts a
// new conversation once, on first sight, instead of offering the start card.
const fresh = new Set<string>()

/** Mark `sessionId` as just launched. */
export function markCliSessionFresh(sessionId: string): void {
  fresh.add(sessionId)
}

/** True once for a session marked fresh; the mark is consumed. */
export function takeCliSessionFresh(sessionId: string): boolean {
  return fresh.delete(sessionId)
}
