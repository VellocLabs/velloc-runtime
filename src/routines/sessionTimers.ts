import { computeRoutineFireAt } from './routineFireTime'
import type { Routine } from './routineTypes'

/** A recurring routine delivered into a session — what `/loop` registers (F-15). */
export type SessionTimer = {
  id: string
  name: string
  /** The session each fire is delivered to. */
  sessionId: string
  schedule: string
  /** Unix ms the scheduler fires next (slot plus the routine's fixed delay). In the past while a fire is
   *  due but held back (the session is busy); null when the cron has no slot. */
  nextFireAt: number | null
}

/**
 * The enabled, recurring, session-delivered cron routines, in registry order.
 * Headless routines and one-shots are not timers of a session.
 */
export function listSessionTimers(routines: Iterable<Routine>): SessionTimer[] {
  const timers: SessionTimer[] = []
  for (const routine of routines) {
    if (routine.kind !== 'cron' || !routine.enabled || routine.oneShot) continue
    const delivery = routine.delivery
    if (delivery?.mode !== 'session') continue
    // The scheduler's own anchor, so the countdown ends when the fire is due.
    const anchor = routine.lastRunAt ?? routine.createdAt
    timers.push({
      id: routine.id,
      name: routine.name,
      sessionId: delivery.sessionId,
      schedule: routine.schedule,
      nextFireAt: computeRoutineFireAt(routine, anchor),
    })
  }
  return timers
}
