/**
 * A request to switch the view to a teammate session, from transcript cards deep inside assistant-ui;
 * module-level, the shell subscribes once. It names the session id or the member name; the shell resolves
 * a name and silently drops one that no longer resolves.
 */

export type TeammateJumpRequest =
  | { sessionId: string }
  | { teammateName: string }

type JumpListener = (request: TeammateJumpRequest) => void

const listeners = new Set<JumpListener>()

/** Ask the shell to make this teammate the active session. */
export function requestTeammateJump(request: TeammateJumpRequest): void {
  if ('sessionId' in request && !request.sessionId) return
  if ('teammateName' in request && !request.teammateName) return
  for (const listener of listeners) listener(request)
}

/** Subscribes the shell; returns an unsubscribe. */
export function subscribeTeammateJump(listener: JumpListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Test seam: drops every subscriber. */
export function resetTeammateJumpRequestsForTests(): void {
  listeners.clear()
}
