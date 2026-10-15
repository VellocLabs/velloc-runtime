/**
 * Contract: the page-level "first screen shown" signal — a `window` event the
 * shell dispatches once, when the boot splash is dismissed. Work that must not
 * compete with the boot (the background cache warm-up) waits for it. The
 * listener in `glic/backgroundCacheUpdate.ts` keeps its own copy of the event
 * name; a unit test pins the two together.
 */
export const FIRST_SCREEN_EVENT = 'nexus:first-screen'

/** Dispatch the first-screen event on `target` (the page's `window`). */
export function signalFirstScreen(target: Pick<EventTarget, 'dispatchEvent'>): void {
  target.dispatchEvent(new Event(FIRST_SCREEN_EVENT))
}
