/**
 * Fires a routine into an EXISTING session: one `enqueueSubmit` at
 * `SUBMIT_PRIORITY.delivery`. Fires never accumulate: `prepare()` is checked
 * before the scheduler advances `lastRunAt`, so a busy session (or one parked
 * on a permission prompt) skips the tick, and missed slots collapse into one
 * fire. A user Stop drops a queued fire (`isMeta` turns are non-revivable on
 * purpose); the routine resumes at its next slot.
 */

import type { RoutineRegistry } from './RoutineRegistry'
import { getRoutineRegistry, RoutineNotFoundError } from './RoutineRegistry'
import type { Routine } from './routineTypes'

/**
 * Manager seam that pushes the prompt into a live session: `accepted`
 * (queued), `session_gone` (deleted), `busy_ask` (parked on a permission
 * prompt; skip this slot).
 */
export type DeliverRoutineToSession = (params: {
  sessionId: string
  routine: Routine
}) => 'accepted' | 'session_gone' | 'busy_ask'

/**
 * Read-only probe, asked before the slot is consumed: `ready`,
 * `session_gone` (unrunnable forever) or `busy` (skip this tick).
 */
export type CanDeliverRoutineToSession = (
  sessionId: string,
) => 'ready' | 'session_gone' | 'busy'

/**
 * Both halves of session delivery as one dependency: `deliver` does not check
 * busy, so without `canDeliver` hidden turns would pile up.
 */
export type SessionDeliverySeam = {
  deliver: DeliverRoutineToSession
  canDeliver: CanDeliverRoutineToSession
}

export type SessionDeliveryRunnerOptions = {
  logEvent?: (event: string, data: Record<string, unknown>) => void
}

export class SessionDeliveryRunner {
  private readonly logEvent?: (
    event: string,
    data: Record<string, unknown>,
  ) => void

  /**
   * `canDeliver` is REQUIRED, deliberately. It used to default to
   * `() => 'ready'`, which failed open: a host that wired `deliver` but not
   * the probe got `prepare()` returning 'fire' on every due tick, and since
   * `deliver` does not check `isBusy`, fires piled up on the turn queue —
   * silently reintroducing the accumulation this class exists to prevent.
   * Pair them at the type level instead (see `SessionDeliverySeam`).
   */
  constructor(
    private readonly deliver: DeliverRoutineToSession,
    private readonly canDeliver: CanDeliverRoutineToSession,
    options: SessionDeliveryRunnerOptions = {},
  ) {
    this.logEvent = options.logEvent
  }

  /**
   * Should the scheduler consume this routine's slot and fire it?
   *
   * Called BEFORE the optimistic `lastRunAt` write, so a `'skip'` leaves the
   * routine due and it re-attempts on the next 30s tick — no accumulated
   * backlog, no registry churn. A dead target is reaped here rather than
   * skipped forever.
   */
  prepare(routine: Routine): 'fire' | 'skip' {
    const delivery = routine.delivery
    if (delivery?.mode !== 'session') return 'fire'

    let readiness: 'ready' | 'session_gone' | 'busy'
    try {
      readiness = this.canDeliver(delivery.sessionId)
    } catch {
      // A probe that throws must not consume the slot.
      return 'skip'
    }
    if (readiness === 'ready') return 'fire'
    if (readiness === 'busy') {
      this.logEvent?.('nexus_routine_session_delivery_deferred', {
        routineId: routine.id,
        sessionId: delivery.sessionId,
      })
      return 'skip'
    }
    void this.dropRoutine(routine, delivery.sessionId)
    return 'skip'
  }

  /**
   * Deliver one fire. Synchronous handoff (the enqueue itself never
   * blocks); the follow-up registry write is fire-and-forget so a slow
   * disk cannot stall the scheduler tick.
   */
  enqueue(routine: Routine): void {
    const delivery = routine.delivery
    if (delivery?.mode !== 'session') {
      // Defensive: the dispatcher is what routes by mode, so reaching here
      // means a caller bypassed it.
      this.logEvent?.('nexus_routine_session_delivery_wrong_mode', {
        routineId: routine.id,
        mode: delivery?.mode ?? 'headless',
      })
      return
    }

    const { sessionId } = delivery
    let outcome: 'accepted' | 'session_gone' | 'busy_ask'
    try {
      outcome = this.deliver({ sessionId, routine })
    } catch (err) {
      this.logEvent?.('nexus_routine_session_delivery_failed', {
        routineId: routine.id,
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      })
      return
    }

    this.logEvent?.('nexus_routine_session_delivery', {
      routineId: routine.id,
      sessionId,
      outcome,
    })

    if (outcome === 'busy_ask') {
      // Race-only path: `prepare()` already screened for this, but the
      // session can go busy between probe and delivery. Skip WITHOUT
      // writing a run status; the slot is already consumed, so this one
      // resolves as "miss this slot" rather than a backlog.
      return
    }

    if (outcome === 'session_gone') {
      void this.dropRoutine(routine, sessionId)
      return
    }

    void this.persistAccepted(routine, sessionId)
  }

  /**
   * The target session no longer exists, so the routine can never fire
   * again. Delete rather than disable: a disabled routine with a dead
   * target is un-resumable — re-enabling it from the routines panel would
   * just re-fail on the next tick, and a recurring one would loop until
   * auto-expiry.
   */
  private async dropRoutine(
    routine: Routine,
    sessionId: string,
  ): Promise<void> {
    const registry = getRoutineRegistry()
    if (!registry) return
    try {
      await registry.delete(routine.id)
      this.logEvent?.('nexus_routine_session_gone_deleted', {
        routineId: routine.id,
        sessionId,
      })
    } catch (err) {
      // A concurrent CronDelete may have removed it first — the registry
      // throws rather than no-opping, and that race is a success for us.
      if (err instanceof RoutineNotFoundError) return
      this.logEvent?.('nexus_routine_session_gone_delete_failed', {
        routineId: routine.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /**
   * Record the delivery. `lastRunStatus` is deliberately NOT written: the
   * turn's outcome is never observed here, and claiming `'success'` for a
   * turn that may still be queued would be a lie. `oneShot` still
   * auto-disables — mirroring `HeadlessRunner.persistLastRun` — since for
   * session delivery "accepted" is as final as it gets.
   */
  private async persistAccepted(
    routine: Routine,
    sessionId: string,
  ): Promise<void> {
    const registry: RoutineRegistry | null = getRoutineRegistry()
    if (!registry) return
    const patch: Partial<Routine> = { lastRunSessionId: sessionId }
    if (routine.oneShot) patch.enabled = false
    try {
      await registry.update(routine.id, patch)
    } catch (err) {
      if (err instanceof RoutineNotFoundError) return
      this.logEvent?.('nexus_routine_session_delivery_persist_failed', {
        routineId: routine.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
}
