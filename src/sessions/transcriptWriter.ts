/**
 * Daily-log midnight transcript flush (`rollOverAtMidnight`). Transcripts
 * persist every turn, so this is a near-no-op seam.
 */

import type { Message } from '../runtime/RuntimeTypes'

/**
 * Called from the daily-log date-rollover path on midnight. Near-no-op in Nexus
 * (continuous persistence); takes `(messages, currentDate)` so a future
 * buffered backend has what it needs to hook here.
 */
export function rollOverAtMidnight(
  messages: Message[],
  currentDate: string,
): void {
  // Nothing buffered to flush — Nexus writes the transcript every turn. Guard
  // references both params so the seam stays honest (and lint-clean).
  if (messages.length === 0 || currentDate.length === 0) return
}
