/**
 * One-shot scheduling for `ScheduleCron`: an ISO timestamp (future only) or
 * `in 30m` / `in 2h` / `in 3d` → a cron expression matching the target time
 * plus the target timestamp, used with `oneShot: true`.
 */

export type OneShotParseResult =
  | {
      ok: true
      schedule: string
      target: Date
    }
  | { ok: false; message: string }

const RELATIVE_PATTERN = /^in\s+(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/i

export function parseOneShotAt(
  input: string,
  now: number = Date.now(),
): OneShotParseResult {
  if (typeof input !== 'string' || input.trim().length === 0) {
    return { ok: false, message: '`at` is required.' }
  }
  const trimmed = input.trim()

  // 1. Relative offset.
  const relMatch = trimmed.match(RELATIVE_PATTERN)
  if (relMatch) {
    const n = parseInt(relMatch[1]!, 10)
    if (!Number.isFinite(n) || n <= 0) {
      return { ok: false, message: `Invalid offset: ${trimmed}.` }
    }
    const unit = relMatch[2]!.toLowerCase()
    const ms = unitToMs(unit)
    if (ms === null) {
      return { ok: false, message: `Unknown time unit: ${unit}.` }
    }
    const target = new Date(now + n * ms)
    return {
      ok: true,
      schedule: cronExprForTarget(target),
      target,
    }
  }

  // 2. ISO / Date-parseable string.
  const parsed = new Date(trimmed)
  if (Number.isNaN(parsed.getTime())) {
    return {
      ok: false,
      message: `Could not parse \`at\` value: ${JSON.stringify(input)}. Use either an ISO timestamp ("2026-05-16T09:00:00Z") or a relative offset ("in 30m", "in 2h", "in 1d").`,
    }
  }
  if (parsed.getTime() <= now) {
    return {
      ok: false,
      message: `\`at\` must be in the future. Got: ${parsed.toISOString()}.`,
    }
  }
  return {
    ok: true,
    schedule: cronExprForTarget(parsed),
    target: parsed,
  }
}

function unitToMs(unit: string): number | null {
  if (unit.startsWith('m')) return 60 * 1000
  if (unit.startsWith('h')) return 60 * 60 * 1000
  if (unit.startsWith('d')) return 24 * 60 * 60 * 1000
  return null
}

/** The zone a one-shot schedule is written in and must be evaluated in.
 *  `cronExprForTarget` uses the UTC fields of the target, so the routine
 *  carries this zone explicitly; without it the matcher reads the fields in
 *  the host's local zone and the run lands off by the local UTC offset. */
export const ONE_SHOT_TIMEZONE = 'UTC'

/**
 * Build a 5-field cron expression that fires at the target instant, written
 * in UTC (see `ONE_SHOT_TIMEZONE`). The expression has no year, so it would
 * match again a year later; the `oneShot` routine flag disables the routine
 * after its first run.
 */
function cronExprForTarget(target: Date): string {
  const minute = target.getUTCMinutes()
  const hour = target.getUTCHours()
  const dayOfMonth = target.getUTCDate()
  const month = target.getUTCMonth() + 1 // cron months are 1-12
  return `${minute} ${hour} ${dayOfMonth} ${month} *`
}
