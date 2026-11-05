/** The bounds of a first-request output allowance derived from a model's output cap. */
export const FIRST_REQUEST_OUTPUT_CEILING = 131_072
export const FIRST_REQUEST_OUTPUT_FLOOR = 4_096

/**
 * The output allowance a first request carries for a model whose cap is
 * `maxOutputTokens`: half the cap, at most the ceiling, at least the floor,
 * never above the cap. Truncation recovery raises it toward the cap.
 */
export function firstRequestOutputTokens(maxOutputTokens: number): number {
  const half = Math.floor(maxOutputTokens / 2)
  return Math.min(maxOutputTokens, Math.max(FIRST_REQUEST_OUTPUT_FLOOR, Math.min(FIRST_REQUEST_OUTPUT_CEILING, half)))
}

/** The allowance for a model that states neither a cap nor an allowance, from its window alone. */
export function firstRequestOutputTokensForWindow(contextWindow: number): number {
  if (contextWindow > 900_000) return 65_536
  if (contextWindow > 200_000) return 32_768
  return 8_192
}
