/**
 * The zone a routine's cron fields are read in. Every cron routine carries
 * an explicit IANA zone: the caller's, or — when the caller names none —
 * the host's zone at creation, so a routine keeps its wall-clock meaning
 * when the profile moves to another machine.
 */

export const FALLBACK_TIMEZONE = 'UTC'

export function isValidTimeZone(zone: unknown): zone is string {
  if (typeof zone !== 'string' || zone.trim().length === 0) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

export type HostTimeZone = {
  zone: string
  /** Set when the host reported no usable zone and UTC was used instead. */
  diagnostic?: string
}

/** The host's IANA zone, or UTC (with a diagnostic) when it reports none. */
export function resolveHostTimeZone(): HostTimeZone {
  let reported: string | undefined
  try {
    reported = Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    reported = undefined
  }
  if (isValidTimeZone(reported)) return { zone: reported }
  return {
    zone: FALLBACK_TIMEZONE,
    diagnostic: `The host reported no usable timezone (${JSON.stringify(reported ?? null)}); the schedule is read in ${FALLBACK_TIMEZONE}.`,
  }
}

/** The routine's own zone when it has a valid one, else the host zone. */
export function effectiveRoutineTimeZone(zone: string | undefined): string {
  const trimmed = zone?.trim()
  if (trimmed && isValidTimeZone(trimmed)) return trimmed
  return resolveHostTimeZone().zone
}
