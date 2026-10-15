import type { ReasoningMapper } from '../../providerDefinition'

// DeepSeek: `thinking: {type}` plus `reasoning_effort` (low | high | max). The
// compat spellings are mapped explicitly so a tier from another provider degrades
// predictably; `none` must use the thinking toggle (`reasoning_effort: 'none'` is
// rejected).
const DEEPSEEK_TIER_TO_EFFORT: Record<string, string> = {
  low: 'low',
  medium: 'high',
  high: 'high',
  // Sent as `max`, not the vendor's `xhigh` compat spelling: that one folds
  // DOWN to `high`, and a user who picked the top pill meant the top level.
  'extra-high': 'max',
  xhigh: 'max',
  max: 'max',
}

/**
 * DeepSeek: the thinking tier → the request-body fragment the wire
 * merges last (`providerBodyExtension`). Moved verbatim from the per-id
 * chain that used to live in `thinkingTierParams.ts`; pinned for every
 * curated model by `provider-request-fields-matrix.test.ts`.
 */
export const deepseekReasoning: ReasoningMapper = (tier) => {
  // `none` cannot ride `reasoning_effort` (the API rejects the variant);
  // it maps to the thinking TOGGLE. Effort tiers ride `reasoning_effort`
  // alone — thinking defaults to enabled, and the effort-only shape is
  // the live-verified one.
  if (tier === 'none') {
    return { thinking: { type: 'disabled' } }
  }
  const effort = DEEPSEEK_TIER_TO_EFFORT[tier]
  if (!effort) {
    return undefined
  }
  return { reasoning_effort: effort }
}
