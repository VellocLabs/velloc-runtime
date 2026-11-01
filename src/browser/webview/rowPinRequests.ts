/**
 * A request to force-mount one virtualized message row, via the virtualizer's pin mechanism, so a reveal
 * (a search jump, a chapter) can look inside a culled row. Module-level because the caller is imperative
 * DOM code.
 */

/** `within` is the requesting thread's root; a listener outside it ignores the request. */
type PinListener = (index: number, within: Element | null) => void

const listeners = new Set<PinListener>()

/**
 * Ask the thread to mount and keep row `index`. With `within`, only the thread rendered inside that
 * element pins it; every mounted thread pins it otherwise.
 */
export function requestRowPin(index: number, within: Element | null = null): void {
  if (!Number.isInteger(index) || index < 0) return
  for (const listener of listeners) listener(index, within)
}

/** Subscribes the thread; returns an unsubscribe. */
export function subscribeRowPin(listener: PinListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Test seam: drops every subscriber. */
export function resetRowPinRequestsForTests(): void {
  listeners.clear()
}
