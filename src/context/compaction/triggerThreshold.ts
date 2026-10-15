// Auto-compact threshold math, split out of autoCompact.ts so the composer's
// context popover ("180k until auto-compact") can import it without pulling
// the compaction runtime into the UI bundle. Pure: depends only on the model
// catalog lookups in utils/context.
import {
  contextWindowOf,
  outputBudgetOf,
} from '../../engine/contextWindow.js'

// Reserve for the compact summary's own output.
export const SUMMARY_OUTPUT_RESERVE = 20_000

// Headroom kept below the effective window so the post-compact turn (boundary
// + summary + the model's reply) doesn't immediately re-overflow. The
// small-window 80% floor below keeps local models from compacting on every
// turn.
export const FOLD_HEADROOM_TOKENS = 13_000

// Context window minus the reserved summary output. `getMaxOutputTokensForModel` returns
// undefined for uncatalogued models, so reserve the full cap in that case.
export function usableWindowTokens(
  model: string | undefined,
  providerId?: string,
): number {
  const reserved = Math.min(
    outputBudgetOf(model, providerId) ?? SUMMARY_OUTPUT_RESERVE,
    SUMMARY_OUTPUT_RESERVE,
  )
  return contextWindowOf(model, providerId) - reserved
}

// Token count at which autocompact fires: effective window − buffer, floored at
// 80% of the effective window (small windows would otherwise go negative and
// compact every turn). `windowTokens`, the user's auto-compact window, is used
// as is, capped only by the model's own threshold.
export function foldTriggerTokens(
  model: string | undefined,
  providerId?: string,
  windowTokens?: number,
): number {
  const effectiveContextWindow = usableWindowTokens(model, providerId)
  const modelThreshold = Math.max(
    effectiveContextWindow - FOLD_HEADROOM_TOKENS,
    Math.floor(effectiveContextWindow * 0.8),
  )
  return windowTokens === undefined
    ? modelThreshold
    : Math.min(windowTokens, modelThreshold)
}
