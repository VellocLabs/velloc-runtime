import type { AgentRuntimeState } from '../runtime/AgentRuntimeState'

/** Best-effort host notification for a user-initiated interrupt. */
export function scheduleActorStopForInterrupt(
  runtime: AgentRuntimeState | null,
): void {
  const hostBridge = runtime?.hostBridge
  const sessionId = runtime?.engine.boundSessionId()
  if (!hostBridge || !sessionId) {
    return
  }
  void hostBridge.session
    .onStop({ sessionId, reason: 'user_stopped' })
    .catch(() => {
      // The main engine interrupt still unwinds the query loop.
    })
}

/**
 * Best-effort host notification that a turn ended without a user Stop: the
 * host releases the turn's agent-tab holds (F-21). Every ending sends it, as
 * the engine's own turn-end notice covers only turns that reach the Stop
 * hooks; a repeat is harmless.
 */
export function notifyTurnEnded(runtime: AgentRuntimeState | null): void {
  const session = runtime?.hostBridge?.session
  const sessionId = runtime?.engine.boundSessionId()
  if (typeof session?.onStop !== 'function' || !sessionId) {
    return
  }
  void session.onStop({ sessionId, reason: 'completed' }).catch(() => {
    // The next turn's end or the session's deletion releases them instead.
  })
}

/** Best-effort host notification that releases native per-session resources. */
export async function fireSessionDeletedStop(
  runtime: AgentRuntimeState | null,
): Promise<void> {
  const hostBridge = runtime?.hostBridge
  const sessionId = runtime?.engine.boundSessionId()
  if (!hostBridge || !sessionId) {
    return
  }
  try {
    await hostBridge.session.onStop({
      sessionId,
      reason: 'session_deleted',
    })
  } catch {
    // JS-side session removal remains authoritative.
  }
}
