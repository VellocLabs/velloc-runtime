/**
 * `cron-parser` wrapper: `validateCronExpression`, `computeNextFireAt`
 * (null when exhausted) and `computeNextFireSlots`. Always in an explicit zone (the routine's
 * `timezone`, else the host's), so DST is handled: a skipped time moves
 * forward, a repeated one fires once.
 */

import cronParser from 'cron-parser'
import { effectiveRoutineTimeZone } from './routineTimezone'

export type CronValidationResult =
  | { ok: true }
  | { ok: false; message: string }

export function validateCronExpression(
  expr: string,
  timezone?: string,
): CronValidationResult {
  if (typeof expr !== 'string' || expr.trim().length === 0) {
    return { ok: false, message: 'Cron expression is required.' }
  }
  try {
    cronParser.parseExpression(expr, {
      tz: effectiveRoutineTimeZone(timezone),
    })
    return { ok: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, message }
  }
}

export function computeNextFireAt(
  expr: string,
  timezone: string | undefined,
  from: number = Date.now(),
): number | null {
  return computeNextFireSlots(expr, timezone, from, 1)[0] ?? null
}

/** Up to `count` successive slots after `from`; fewer when the schedule runs out. */
export function computeNextFireSlots(
  expr: string,
  timezone: string | undefined,
  from: number,
  count: number,
): number[] {
  const slots: number[] = []
  try {
    const it = cronParser.parseExpression(expr, {
      currentDate: new Date(from),
      tz: effectiveRoutineTimeZone(timezone),
    })
    while (slots.length < count) slots.push(it.next().getTime())
  } catch {
    // Invalid or exhausted: return the slots found so far.
  }
  return slots
}
