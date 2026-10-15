import type { Message, NoticeRow } from '../../runtime/RuntimeTypes'
import {
  MSG_TYPE_SYSTEM,
  SYSTEM_SUBTYPE_COMPACT_BOUNDARY,
} from '../../runtime/VercelModelConstants'

/**
 * Identifies a system message that marks the boundary between pre-compact
 * and post-compact transcript segments.
 */
export function isFoldLine(message: Message | undefined | null): boolean {
  if (!message || message.type !== MSG_TYPE_SYSTEM) return false
  return (message as NoticeRow).subtype === SYSTEM_SUBTYPE_COMPACT_BOUNDARY
}

/**
 * Returns the index of the most recent compact boundary in the message
 * array, or -1 if none.
 */
export function lastFoldLineIndex(
  messages: readonly Message[],
): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isFoldLine(messages[i])) return i
  }
  return -1
}

/**
 * Messages from the most recent compact boundary onward (boundary included);
 * the full array when there is none. The boundary is a system message and does
 * reach the provider (promoted to a system turn).
 */
export function rowsSinceFoldLine(
  messages: readonly Message[],
): Message[] {
  const idx = lastFoldLineIndex(messages)
  return idx === -1 ? [...messages] : messages.slice(idx)
}
