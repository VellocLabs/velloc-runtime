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
