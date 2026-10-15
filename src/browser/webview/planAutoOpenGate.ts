/**
 * When the Plan panel auto-opens for a pending plan approval. Keyed per (sessionId, toolCallId): the
 * same pending plan never re-opens the panel, and each session tracks its own last plan. Entries are never
 * cleared; the map is bounded by the session count.
 */
export function createPlanAutoOpenGate(): (
  sessionId: string | null | undefined,
  toolCallId: string | null | undefined,
) => boolean {
  const lastBySession = new Map<string, string>()
  return (sessionId, toolCallId) => {
    if (!sessionId || !toolCallId) return false
    if (lastBySession.get(sessionId) === toolCallId) return false
    lastBySession.set(sessionId, toolCallId)
    return true
  }
}
