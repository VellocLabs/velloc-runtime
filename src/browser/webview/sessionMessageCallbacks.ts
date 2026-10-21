import type { AppendMessage } from '@assistant-ui/react'

export type SessionMessageCallbacks = {
  /** Fork a new session branching from a message (kept-history copy). */
  onFork: (cutUuid: string) => void
  /** Rewind the session by truncating at a message (destructive in place). */
  onRewind: (cutUuid: string) => void
  /** Send a composer message into a forked copy (the composer's Ctrl/Cmd+Alt+Enter). */
  onSendInFork?: (cutUuid: string, message: AppendMessage) => Promise<boolean>
  /** Continue the conversation in a new Code session bound to `folder` (or the one the user picks). */
  onContinueInCode?: (cutUuid: string, folder: ContinueInCodeFolder) => Promise<boolean>
}

/** A folder path, or `pick` to ask the host's folder dialog. */
export type ContinueInCodeFolder = { path: string } | { pick: true }

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
  continueInCode?: (
    sessionId: string,
    cutUuid: string,
    folder: ContinueInCodeFolder,
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
        ...(continueInCode
          ? {
              onContinueInCode: (cutUuid: string, folder: ContinueInCodeFolder) =>
                continueInCode(sessionId, cutUuid, folder),
            }
          : {}),
      }
      cache.set(sessionId, entry)
    }
    return entry
  }
}
