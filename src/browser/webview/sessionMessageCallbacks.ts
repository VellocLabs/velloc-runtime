import type { AppendMessage } from '@assistant-ui/react'

export type SessionMessageCallbacks = {
  /** Fork a new session branching from a message (kept-history copy). */
  onFork: (cutUuid: string) => void
  /** Rewind the session by truncating at a message (destructive in place). */
  onRewind: (cutUuid: string) => void
  /** Send a composer message into a forked copy (the composer's Ctrl/Cmd+Alt+Enter). */
  onSendInFork?: (cutUuid: string, message: AppendMessage) => Promise<boolean>
}

/**
 * Builds a factory returning referentially stable per-session fork/rewind callbacks, so the memoized
 * mounted threads do not all re-render per token. The mutators are stable; rebuild the factory only when
 * they change identity.
 */
export function createSessionMessageCallbackFactory(
  forkSession: (sessionId: string, cutUuid: string) => void,
  rewindSession: (sessionId: string, cutUuid: string) => void,
  sendInForkedSession?: (
    sessionId: string,
    cutUuid: string,
    message: AppendMessage,
  ) => Promise<boolean>,
): (sessionId: string) => SessionMessageCallbacks {
  const cache = new Map<string, SessionMessageCallbacks>()
  return (sessionId: string) => {
    let entry = cache.get(sessionId)
    if (!entry) {
      entry = {
        onFork: (cutUuid: string) => forkSession(sessionId, cutUuid),
        onRewind: (cutUuid: string) => rewindSession(sessionId, cutUuid),
        ...(sendInForkedSession
          ? {
              onSendInFork: (cutUuid: string, message: AppendMessage) =>
                sendInForkedSession(sessionId, cutUuid, message),
            }
          : {}),
      }
      cache.set(sessionId, entry)
    }
    return entry
  }
}
