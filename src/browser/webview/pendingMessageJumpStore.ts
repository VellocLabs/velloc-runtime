/**
 * One-shot "jump to this message when the session's thread is ready", from the transcript search dialog
 * to the mounted thread. Consume-once: a later visit to the same session must not re-scroll.
 */
export type PendingMessageJump = {
  /** Top-level uuid of the transcript line to reveal. */
  uuid: string
  /** 0-based physical line ordinal — the fallback anchor when the uuid
   *  has no rendered row of its own (e.g. a tool_result merged into a
   *  tool card). */
  lineOrdinal: number
  /** Reveal attempts already spent on this jump; see MAX_JUMP_ATTEMPTS. */
  attempts?: number
  /** The matched sentence. The uuid alone is not enough: several
   *  transcript entries can fold into ONE rendered message, so an
   *  index derived from a uuid can point at a neighbour. The text is
   *  what the user actually clicked, so the reveal confirms the row
   *  contains it and corrects course when it does not. */
  needle?: string
  /** The matched term. Used to pick the LINE within the row to flash,
   *  because flashing a long message tells the user nothing about where
   *  in it the match actually is. */
  term?: string
}

const pending = new Map<string, PendingMessageJump>()
const listeners = new Set<() => void>()
let version = 0

function emit(): void {
  version += 1
  for (const listener of listeners) listener()
}

export function setPendingMessageJump(
  sessionId: string,
  jump: PendingMessageJump,
): void {
  pending.set(sessionId, jump)
  emit()
}

/** Non-destructive read — the thread peeks while waiting for messages. */
export function peekPendingMessageJump(
  sessionId: string,
): PendingMessageJump | null {
  return pending.get(sessionId) ?? null
}

/** Destructive read — call only when the jump is actually performed. */
export function consumePendingMessageJump(
  sessionId: string,
): PendingMessageJump | null {
  const jump = pending.get(sessionId) ?? null
  if (jump) pending.delete(sessionId)
  return jump
}

/**
 * Drops a jump WITHOUT performing it. A jump waits here until the target
 * row renders — the thread peeks, not consumes, while its transcript is
 * still loading — so one left behind by a hit whose reveal never completed
 * (the user switched away first) is still armed when the session is next
 * opened WITHOUT a hit, and would scroll that plain open to an old message.
 * A non-jump open of the session clears it first.
 */
export function clearPendingMessageJump(sessionId: string): void {
  if (pending.delete(sessionId)) emit()
}

/** Bumps on every set; threads subscribe so an effect re-runs when a new
 *  jump targets an already-mounted session. */
export function getPendingMessageJumpVersion(): number {
  return version
}

export function subscribePendingMessageJump(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Index of the last entry whose `transcriptLine` is at or before `lineOrdinal`, or -1. Both are physical
 * file lines, so the entry found owns the hit line (or precedes it). Entries without a `transcriptLine`
 * (not yet flushed) are skipped. Never key this on an entry-count ordinal: it overshoots.
 */
export function findLastEntryAtOrBeforeLine(
  entries: readonly { transcriptLine?: unknown }[],
  lineOrdinal: number,
): number {
  let found = -1
  for (let i = 0; i < entries.length; i++) {
    const line = entries[i]?.transcriptLine
    if (typeof line !== 'number') continue
    if (line > lineOrdinal) break
    found = i
  }
  return found
}
