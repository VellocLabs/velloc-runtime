/**
 * Security: turn-lifetime marker "this session's current turn is a routine
 * fire", so `CronCreate` / `ScheduleCron` / `RemoteTrigger.register` refuse
 * inside session-delivered fires too. `AgentRuntimeWorker` must call
 * `beginRoutineFireTurn` and `endRoutineFireTurn` (in the `finally`); see
 * `routine-recursion-guard.test.ts`. Keyed by sessionId; a leaf module.
 */

/** sessionId → routineId of the fire currently executing in that session. */
const ACTIVE_ROUTINE_FIRE_TURNS = new Map<string, string>()

/**
 * Mark the turn about to run in `sessionId` as originating from a routine
 * fire. Idempotent per session: a second `begin` before `end` overwrites
 * the routineId rather than nesting — turns do not interleave within a
 * session, so nesting would signal a bug elsewhere, and last-write-wins
 * keeps the guard armed either way.
 */
export function beginRoutineFireTurn(
  sessionId: string,
  routineId: string,
): void {
  ACTIVE_ROUTINE_FIRE_TURNS.set(sessionId, routineId)
}

/** Clear the marker. MUST run on every exit path — see the module docstring. */
export function endRoutineFireTurn(sessionId: string): void {
  ACTIVE_ROUTINE_FIRE_TURNS.delete(sessionId)
}

/**
 * The routineId whose fire is executing in `sessionId`, or `undefined` when
 * the current turn is ordinary user input.
 */
export function getRoutineFireTurn(sessionId: string): string | undefined {
  return ACTIVE_ROUTINE_FIRE_TURNS.get(sessionId)
}

/** Is the turn executing in `sessionId` a routine fire? */
export function isRoutineFireTurn(sessionId: string | undefined): boolean {
  if (!sessionId) return false
  return ACTIVE_ROUTINE_FIRE_TURNS.has(sessionId)
}

/** Test-only — wipe all markers so state cannot leak between tests. */
export function __resetRoutineTurnScopeForTests(): void {
  ACTIVE_ROUTINE_FIRE_TURNS.clear()
}
