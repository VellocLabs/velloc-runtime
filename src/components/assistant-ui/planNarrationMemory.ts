/**
 * Bounded page-lifetime memory for the plan / tool-run header's narration line, so a new
 * tool or an empty text part never blanks it. Evicted keys re-learn on the next render;
 * capped tighter than the disclosure maps because values are strings.
 */
import { rememberBounded } from './boundedUiMemory'

/** Max distinct keys retained per Map across the page's lifetime. Generous: a
 *  single session rarely holds this many distinct messages / plan sections at
 *  once, and eviction is purely a memory bound. */
export const NARRATION_MEMORY_MAX = 256

/**
 * Idempotent, bounded `map.set(key, value)` — the value is the narration
 * string, or a small record carrying it (the tool-plan card also remembers
 * whether the narration was a thought). When inserting a NEW key would
 * exceed {@link NARRATION_MEMORY_MAX}, evict the oldest entry first
 * (insertion order — `Map` preserves it). Updating an existing key never
 * evicts, since re-setting keeps its original slot.
 */
export function rememberNarration<V>(
  map: Map<string, V>,
  key: string,
  value: V,
): void {
  rememberBounded(map, key, value, NARRATION_MEMORY_MAX)
}
