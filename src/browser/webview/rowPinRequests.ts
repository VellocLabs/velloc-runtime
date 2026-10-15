/**
 * A request to force-mount one virtualized message row, via the virtualizer's pin mechanism, so a search
 * jump can look inside a culled row. Module-level because the caller is imperative DOM code.
 */

type PinListener = (index: number) => void

const listeners = new Set<PinListener>()

/** Ask the thread to mount and keep row `index`. */
export function requestRowPin(index: number): void {
  if (!Number.isInteger(index) || index < 0) return
  for (const listener of listeners) listener(index)
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
