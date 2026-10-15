import type { ReasoningMapper } from '../../providerDefinition'

// OpenAI `reasoning_effort` wire strings (`extra-high` = `xhigh`, `max` passes
// through). Which pills a model exposes is `availableThinkingTiers`'s, and a stale
// persisted tier is dropped before this map.
const OPENAI_TIER_TO_EFFORT: Record<string, string> = {
  none: 'none',
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  'extra-high': 'xhigh',
  xhigh: 'xhigh',
  max: 'max',
}

/**
 * OpenAI: the thinking tier → the request-body fragment the wire
 * merges last (`providerBodyExtension`). Moved verbatim from the per-id
 * chain that used to live in `thinkingTierParams.ts`; pinned for every
 * curated model by `provider-request-fields-matrix.test.ts`.
 */
export const openaiReasoning: ReasoningMapper = (tier) => {
  const effort = OPENAI_TIER_TO_EFFORT[tier]
  if (!effort) {
    return undefined
  }
  return { reasoning_effort: effort }
}
