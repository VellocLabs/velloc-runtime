/**
 * "Show transcript line N of message M": a request, not a search. The message that renders the parts
 * knows which part carries the line and which container holds it, so it opens that container and the part
 * announces itself; the DOM is never queried.
 */

export type PartRevealRequest = {
  /** Rendered message that owns the line (assistant-ui message id). */
  messageId: string
  /** The transcript line to show. */
  line: number
  /** The matched keyword, bolded within the flashed line. */
  term?: string
  /** Bumped per request so a repeat of the same target still fires. */
  token: number
}

let current: PartRevealRequest | null = null
let nextToken = 1
const listeners = new Set<() => void>()

/** Ask the message rendering `line` to reveal it. */
export function requestPartReveal(
  messageId: string,
  line: number,
  term?: string,
): void {
  current = { messageId, line, term, token: nextToken++ }
  for (const listener of listeners) listener()
}

/** Clears the request once it has been served. */
export function clearPartReveal(token: number): void {
  if (current?.token !== token) return
  current = null
  for (const listener of listeners) listener()
}

export function getPartReveal(): PartRevealRequest | null {
  return current
}

export function subscribePartReveal(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Test seam. */
export function resetPartRevealForTests(): void {
  current = null
  nextToken = 1
  listeners.clear()
}
