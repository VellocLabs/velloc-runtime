/**
 * Routes a due routine to the runner for its delivery mode
 * (`HeadlessRunner` or `SessionDeliveryRunner`).
 */

import type { HeadlessRunner } from './HeadlessRunner'
import type { Routine } from './routineTypes'
import type { SessionDeliveryRunner } from './SessionDeliveryRunner'

export type RoutineFireDispatcher = {
  /**
   * Consulted by the scheduler BEFORE it consumes the routine's slot.
   * `'skip'` leaves the routine due, so it re-attempts next tick instead of
   * queueing a fire that would pile up behind a busy session, so missed
   * fires coalesce into one. Headless
   * routines always fire; the HeadlessRunner owns its own queueing.
   */
  prepare(routine: Routine): 'fire' | 'skip'
  fire(routine: Routine): void
}

export type RoutineFireDispatcherDeps = {
  headless: HeadlessRunner
  /**
   * Absent when the host wired no session seam (e.g. SDK / test harness).
   * Session-delivered routines then defer indefinitely — see `prepare()`.
   */
  session: SessionDeliveryRunner | null
  logEvent?: (event: string, data: Record<string, unknown>) => void
}

export function createRoutineFireDispatcher(
  deps: RoutineFireDispatcherDeps,
): RoutineFireDispatcher {
  // Routine ids already warned about a missing session seam. The warning is
  // once-per-process, not once-per-tick: the condition is a fixed host
  // capability, so re-logging it every 30s forever would be pure noise.
  const warnedNoSeam = new Set<string>()

  return {
    prepare(routine: Routine): 'fire' | 'skip' {
      if (routine.delivery?.mode !== 'session') return 'fire'
      if (!deps.session) {
        // No session-injection seam on this host: the routine is deferred
        // indefinitely, never run headless (a session prompt run cold answers
        // uselessly) and never deleted (the registry is shared across hosts).
        if (!warnedNoSeam.has(routine.id)) {
          warnedNoSeam.add(routine.id)
          deps.logEvent?.('nexus_routine_session_delivery_unavailable', {
            routineId: routine.id,
            sessionId: routine.delivery.sessionId,
          })
        }
        return 'skip'
      }
      return deps.session.prepare(routine)
    },
    fire(routine: Routine): void {
      if (routine.delivery?.mode !== 'session') {
        // Absent `delivery` means headless — every routine written before
        // the field shipped takes this branch unchanged.
        deps.headless.enqueue(routine)
        return
      }
      // Defensive: `prepare()` already returns 'skip' with no seam, so the
      // scheduler never reaches here. Silent (the warning belongs to the
      // decision, not to a path that should not run) and explicitly NOT a
      // headless fallback.
      if (!deps.session) return
      deps.session.enqueue(routine)
    },
  }
}
