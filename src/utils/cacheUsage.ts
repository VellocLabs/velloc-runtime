/**
 * Prompt-cache ratio for the composer's context ring:
 * `cache_read / (input + cache_read + cache_create)`, where `input_tokens`
 * excludes the cache fields (always 0–1).
 */

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * Single-turn cache ratio from one usage block: the share of that turn's
 * whole prompt served from cache. 0 when the denominator is 0 or the block
 * is absent.
 */
export function getCacheRatio(
  usage: Record<string, unknown> | undefined,
): number {
  if (!usage) return 0
  const input = num(usage.input_tokens)
  const cacheRead = num(usage.cache_read_input_tokens)
  const cacheCreate = num(usage.cache_creation_input_tokens)
  const total = input + cacheRead + cacheCreate
  if (total <= 0) return 0
  return cacheRead / total
}
