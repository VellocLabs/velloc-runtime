/**
 * Security: routine ORIGIN, the predicate the recursion guard denies on.
 * `isHeadless` marks a routine SESSION and `routineId` attributes
 * `RoutineSignal`; neither is inherited. `routineOriginId` is provenance:
 * set on the routine session and inherited transitively by every session
 * spawned from it, so a routine cannot register routines through an `Agent`.
 * A session-delivered fire turn also counts. Imports only `routineTurnScope`.
 */

import { getRoutineFireTurn } from './routineTurnScope'

/**
 * The subset of `ToolUseContext['options']` / `AgentRuntimeWorkerInitPayload`
 * this predicate reads. Neither `isHeadless` nor `routineOriginId` is on the
 * static options type (they ride the init-payload spread), so callers pass
 * `context.options` and it is narrowed here rather than at each call site.
 */
export type RoutineOriginOptions = {
  isHeadless?: boolean
  routineId?: string
  routineOriginId?: string
  /** Read for the turn-scope arm: a session-delivered fire marks the TURN
   *  (`routineTurnScope`), not the payload, and is looked up by session id. */
  sessionId?: string
}

/**
 * Origin id used when a session is known to be a routine fire but carries no
 * `routineId` to attribute it to. The guard is a boolean question, so a
 * missing attribution must never downgrade to "not a routine" — it degrades to
 * this sentinel instead. (Reachable only via a headless spawn that omits
 * `routineId`; `RoutineCoordinator` always sets one.)
 */
export const UNATTRIBUTED_ROUTINE_ORIGIN = 'unattributed-routine'

/**
 * The routine this context's work originates from, or undefined for ordinary
 * user-driven work. Propagate the return value into any session spawned from
 * this context; deny routine-registering tools when it is set.
 */
export function routineOriginIdOf(options: unknown): string | undefined {
  const opts = (options ?? {}) as RoutineOriginOptions
  if (typeof opts.routineOriginId === 'string' && opts.routineOriginId !== '') {
    return opts.routineOriginId
  }
  // A headless routine session is the ROOT of a routine-originated tree: it
  // carries `isHeadless` rather than an inherited origin. Reading it here (and
  // not only the propagated field) keeps the original guard arm intact even if
  // a spawn path forgets to stamp `routineOriginId`.
  if (opts.isHeadless === true) {
    return typeof opts.routineId === 'string' && opts.routineId !== ''
      ? opts.routineId
      : UNATTRIBUTED_ROUTINE_ORIGIN
  }
  // A SESSION-delivered fire is the other root: the routine marks the TURN
  // (`routineTurnScope`, keyed by session id) rather than the init payload.
  // Reading it here is what lets an `Agent` spawn made during such a turn
  // stamp its sub-agent — without this, only headless fires propagated.
  if (typeof opts.sessionId === 'string' && opts.sessionId !== '') {
    const turnOrigin = getRoutineFireTurn(opts.sessionId)
    if (turnOrigin !== undefined) return turnOrigin
  }
  return undefined
}

/** True when routine-registering tools must refuse in this context. */
export function isRoutineOriginated(options: unknown): boolean {
  return routineOriginIdOf(options) !== undefined
}
