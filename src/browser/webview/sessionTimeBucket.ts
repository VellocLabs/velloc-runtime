import type { MessageKey } from './i18n/messages/en'

/**
 * The activity time a session is ordered by — the newest of its transcript
 * update and its last composer edit (an unsent draft floats a session up).
 * Shared by BOTH the sidebar sort (`useSessionManager.effectiveSortTime`) and
 * the recents time-bucket separators so they can never diverge — if they used
 * different keys, a draft-floated older session would sort high but bucket old,
 * producing out-of-order separators (Previous 7 days → Yesterday → …).
 */
export function sessionActivityTime(
  updatedAt: number,
  lastComposerEditAt?: number,
): number {
  return Math.max(updatedAt, lastComposerEditAt ?? 0)
}

/** i18n keys for the recents-list relative-time group headers. */
export type TimeBucketKey = Extract<
  MessageKey,
  | 'sidebar.timeToday'
  | 'sidebar.timeYesterday'
  | 'sidebar.timePrevious7Days'
  | 'sidebar.timePrevious30Days'
  | 'sidebar.timeOlder'
>

/**
 * Calendar-day-based relative-time bucket for a session row (ChatGPT-style
 * grouping: Today / Yesterday / Previous 7 days / Previous 30 days / Older).
 * `now` is passed in (captured once per render) so every row buckets against
 * the same day boundary. Boundaries are local-calendar-day, not 24h windows.
 */
export function sessionTimeBucket(
  updatedAt: number,
  now: number,
): TimeBucketKey {
  // Local-CALENDAR-day boundaries, walked back with `setDate` — NOT a rolling
  // 24h span. A session buckets by its calendar DATE, not elapsed time: at
  // 01:00, a session last active at 23:00 *yesterday* (only ~2h ago) is
  // "Yesterday", never "Today". `setDate` stays correct across month/year ends
  // and DST shifts (where a calendar day isn't 24h).
  const startOfDayBefore = (daysAgo: number): number => {
    const d = new Date(now)
    d.setHours(0, 0, 0, 0)
    d.setDate(d.getDate() - daysAgo)
    return d.getTime()
  }
  if (updatedAt >= startOfDayBefore(0)) return 'sidebar.timeToday'
  if (updatedAt >= startOfDayBefore(1)) return 'sidebar.timeYesterday'
  if (updatedAt >= startOfDayBefore(7)) return 'sidebar.timePrevious7Days'
  if (updatedAt >= startOfDayBefore(30)) return 'sidebar.timePrevious30Days'
  return 'sidebar.timeOlder'
}
