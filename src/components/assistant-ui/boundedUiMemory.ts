/**
 * Page-lifetime memory for transcript UI state (disclosure maps keyed by tool-call /
 * message id), bounded by {@link rememberBounded}, which evicts the oldest key at the cap.
 * The maps are memory, never a source of truth: an evicted key falls back to the card's
 * default. Only `set` touches the ordering; reads never promote.
 */

/** Max distinct keys retained per map. Generous — a single long session rarely
 *  holds this many distinct tool calls, and eviction is purely a memory bound. */
export const UI_MEMORY_MAX = 512

/**
 * Idempotent, bounded `map.set(key, value)`. Inserting a NEW key when the map
 * is already at `max` evicts the least-recently-WRITTEN entry (`Map` preserves
 * insertion order, and re-setting an existing key moves it to the back), so a
 * card the user still toggles outlives one nobody has touched since it
 * streamed by. Write-recency only — reads deliberately never promote (a
 * promoting `get` is the iterator-invalidation trap described above).
 */
export function rememberBounded<K, V>(
  map: Map<K, V>,
  key: K,
  value: V,
  max: number = UI_MEMORY_MAX,
): void {
  if (map.has(key)) {
    // Refresh the slot: delete+set moves the key to the back of the order.
    map.delete(key)
  } else if (map.size >= max) {
    const oldest = map.keys().next()
    if (!oldest.done) map.delete(oldest.value)
  }
  map.set(key, value)
}
