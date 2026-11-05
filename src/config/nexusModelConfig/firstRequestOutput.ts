/** The bounds of a first-request output allowance derived from a model's output cap. */
export const FIRST_REQUEST_OUTPUT_CEILING = 131_072
export const FIRST_REQUEST_OUTPUT_FLOOR = 32_768

/** A window past this is a wide one: models served with it finish replies of the wide allowance. */
export const WIDE_WINDOW_TOKENS = 900_000
export const WIDE_WINDOW_FIRST_REQUEST_OUTPUT = 128_000

/**
 * Whether `maxOutputTokens` is a placeholder on a wide window: a cap as large
 * as the window itself is not an output size the model was measured to finish.
 */
export function isPlaceholderOutputCap(maxOutputTokens: number, contextWindow: number | undefined): boolean {
  return contextWindow !== undefined && contextWindow > WIDE_WINDOW_TOKENS && maxOutputTokens >= contextWindow
}

/**
 * The output allowance a first request carries for a model whose cap is
 * `maxOutputTokens`: half the cap, at most the ceiling, at least the floor,
 * never above the cap — a cap at or under the floor is sent whole, since
 * halving it would cut replies the model is able to finish. A placeholder cap
 * on a wide `contextWindow` reads the wide-window allowance instead.
 */
export function firstRequestOutputTokens(maxOutputTokens: number, contextWindow?: number): number {
  if (isPlaceholderOutputCap(maxOutputTokens, contextWindow)) return WIDE_WINDOW_FIRST_REQUEST_OUTPUT
  const half = Math.floor(maxOutputTokens / 2)
  return Math.min(maxOutputTokens, Math.max(FIRST_REQUEST_OUTPUT_FLOOR, Math.min(FIRST_REQUEST_OUTPUT_CEILING, half)))
}

/** The allowance for a model that states neither a cap nor an allowance, from its window alone. */
export function firstRequestOutputTokensForWindow(contextWindow: number): number {
  if (contextWindow > WIDE_WINDOW_TOKENS) return WIDE_WINDOW_FIRST_REQUEST_OUTPUT
  if (contextWindow > 200_000) return 32_768
  return 8_192
}
