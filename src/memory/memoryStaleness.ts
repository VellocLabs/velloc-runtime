/**
 * A saved memory's age (whole 24-hour periods since mtime; future = today) and
 * the caveat it carries from two days old on.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000

/** First age, in whole days, that earns a staleness caveat. */
const CAVEAT_FROM_DAYS = 2

/** Whole days between `savedAtMs` and now; never negative. */
export function wholeDaysSince(savedAtMs: number, nowMs: number = Date.now()): number {
  const elapsed = nowMs - savedAtMs
  return elapsed <= 0 ? 0 : Math.floor(elapsed / MS_PER_DAY)
}

/** `today`, `yesterday`, or `N days ago`. */
export function describeSavedAge(savedAtMs: number): string {
  const days = wholeDaysSince(savedAtMs)
  switch (days) {
    case 0:
      return 'today'
    case 1:
      return 'yesterday'
    default:
      return `${days} days ago`
  }
}

/**
 * One-line caveat for a memory at least two days old, or '' for a fresher
 * one. Plain text: for callers that already wrap their output in a reminder
 * block of their own.
 */
export function staleMemoryCaveat(savedAtMs: number): string {
  const days = wholeDaysSince(savedAtMs)
  if (days < CAVEAT_FROM_DAYS) return ''
  return [
    `Saved ${days} days ago, so read this memory as a snapshot from then, not as current state:`,
    'the code it describes, and any file:line references in it, may have changed since.',
    'Check the current code before stating any of it as fact.',
  ].join(' ')
}

/** `staleMemoryCaveat` inside a `<system-reminder>` block, newline-terminated. */
export function staleMemoryReminder(savedAtMs: number): string {
  const caveat = staleMemoryCaveat(savedAtMs)
  return caveat ? `<system-reminder>${caveat}</system-reminder>\n` : ''
}
