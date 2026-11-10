/** Same ids in the same positions. */
export function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/** How many unechoed order writes are remembered (`settleEchoedOrder`). */
export const MAX_UNECHOED_ORDERS = 16;

/**
 * Settles `written` (orders this page wrote that nothing has echoed yet,
 * oldest first) against an echoed `order`. The host echoes writes in order,
 * so the echo is the OLDEST equal write: it and every write before it are
 * dropped. Returns whether the echo may be shown: only once no write of this
 * page is unechoed — any order seen before that is older than the list's,
 * and showing it would make the next drop look current and write nothing.
 */
export function settleEchoedOrder(
  written: string[][],
  order: readonly string[],
): boolean {
  const index = written.findIndex((w) => sameOrder(w, order));
  if (index >= 0) written.splice(0, index + 1);
  return written.length === 0;
}

/**
 * Arrow-key reordering moves the row at once but writes the order only once
 * the keys have been still this long (or the grip loses focus): holding or
 * tapping an arrow is one gesture, not one `providers.setOrder` — and one
 * `providers.changed` fan-out to every open surface — per keypress.
 */
export const KEYBOARD_REORDER_COMMIT_MS = 400;
