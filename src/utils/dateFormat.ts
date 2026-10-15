/**
 * Format a Date as a local-time YYYY-MM-DD string.
 *
 * Local components are used so a session crossing midnight in the user's
 * wall-clock timezone reports the new local date even if UTC has not yet
 * rolled over (and vice versa).
 */
export function formatLocalISODate(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}
