/**
 * When a cron routine actually fires (F-15). A recurring routine fires a delay
 * after each cron slot; a one-shot fires on the slot. The delay is the
 * routine's stable fraction (from its id) of half the gap to the following
 * slot less one scheduler tick, capped at `MAX_RECURRING_FIRE_DELAY_MS`. The
 * tick of headroom keeps a fire that lags its due time by one tick ahead of the
 * following slot, so no slot is skipped.
 */

import { computeNextFireSlots } from './cronExpression'
import type { CronRoutine } from './routineTypes'

export const ROUTINE_SCHEDULER_TICK_MS = 30 * 1000
export const MAX_RECURRING_FIRE_DELAY_MS = 30 * 60 * 1000

type FireTimeRoutine = Pick<CronRoutine, 'id' | 'schedule' | 'timezone' | 'oneShot'>

/** A stable fraction in [0, 1) for a routine id (FNV-1a, 32-bit). */
export function routineDelayFraction(id: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0) / 0x1_0000_0000
}

function delayForGap(id: string, gap: number): number {
  const room = gap / 2 - ROUTINE_SCHEDULER_TICK_MS
  if (room <= 0) return 0
  return Math.min(
    Math.floor(routineDelayFraction(id) * room),
    MAX_RECURRING_FIRE_DELAY_MS,
  )
}

/**
 * Unix ms the routine fires next after `anchor` (its last run, else its
 * creation): the next cron slot plus the routine's delay. Null when the
 * schedule has no further slot.
 */
export function computeRoutineFireAt(
  routine: FireTimeRoutine,
  anchor: number,
): number | null {
  const [slot, following] = computeNextFireSlots(
    routine.schedule,
    routine.timezone,
    anchor,
    routine.oneShot ? 1 : 2,
  )
  if (slot === undefined) return null
  if (routine.oneShot || following === undefined || following <= slot) return slot
  return slot + delayForGap(routine.id, following - slot)
}
