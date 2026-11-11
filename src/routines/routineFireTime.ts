/**
 * When a cron routine actually fires (F-15). A recurring routine fires a
 * fixed, per-routine delay after each cron slot; a one-shot fires on the slot.
 * The delay depends on the routine id alone (stable across restarts), is under
 * half the gap to the following slot, and never exceeds
 * `MAX_RECURRING_FIRE_DELAY_MS`.
 */

import { computeNextFireAt } from './cronExpression'
import type { CronRoutine } from './routineTypes'

export const RECURRING_FIRE_DELAY_SHARE = 0.5
export const MAX_RECURRING_FIRE_DELAY_MS = 30 * 60 * 1000

/** A stable fraction in [0, 1) for a routine id (FNV-1a, 32-bit). */
export function routineDelayFraction(id: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0) / 0x1_0000_0000
}

/**
 * The delay a recurring routine fires after `slot`: a fixed share of the gap
 * to the following slot, capped. 0 for one-shots and exhausted schedules.
 */
export function recurringFireDelay(
  routine: Pick<CronRoutine, 'id' | 'schedule' | 'timezone' | 'oneShot'>,
  slot: number,
): number {
  if (routine.oneShot) return 0
  const following = computeNextFireAt(routine.schedule, routine.timezone, slot)
  if (following === null || following <= slot) return 0
  const delay = Math.floor(
    routineDelayFraction(routine.id) *
      RECURRING_FIRE_DELAY_SHARE *
      (following - slot),
  )
  return Math.min(delay, MAX_RECURRING_FIRE_DELAY_MS)
}

/**
 * Unix ms the routine fires next after `anchor` (its last run, else its
 * creation): the next cron slot plus the routine's fixed delay. Null when the
 * schedule has no further slot.
 */
export function computeRoutineFireAt(
  routine: Pick<CronRoutine, 'id' | 'schedule' | 'timezone' | 'oneShot'>,
  anchor: number,
): number | null {
  const slot = computeNextFireAt(routine.schedule, routine.timezone, anchor)
  if (slot === null) return null
  return slot + recurringFireDelay(routine, slot)
}
