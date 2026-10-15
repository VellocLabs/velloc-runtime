import type { ReasoningMapper } from '../../providerDefinition'

// Newer Claude models reject `thinking: { type: 'enabled', budget_tokens }`, so tier
// names map onto the effort vocabulary (`extra-high` = `xhigh`). Per-model tier
// gating is `availableThinkingTiers`'s, before this map.
const ANTHROPIC_TIER_TO_EFFORT: Record<string, string> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  'extra-high': 'xhigh',
  max: 'max',
}

/**
 * Anthropic: the thinking tier → the request-body fragment the wire
 * merges last (`providerBodyExtension`). Moved verbatim from the per-id
 * chain that used to live in `thinkingTierParams.ts`; pinned for every
 * curated model by `provider-request-fields-matrix.test.ts`.
 */
export const anthropicReasoning: ReasoningMapper = (tier, { maxOutputTokens }) => {
  const effort = ANTHROPIC_TIER_TO_EFFORT[tier]
  if (!effort) {
    return undefined
  }
  // Adaptive thinking lets the model decide its own budget; we only
  // signal the desired effort. Anthropic no longer requires the
  // budget_tokens / max_tokens / temperature=1 trio that the legacy
  // `enabled` shape did, so we omit them entirely. `maxOutputTokens`
  // is reserved here in case a future tier needs it again.
  void maxOutputTokens
  return {
    thinking: { type: 'adaptive' },
    output_config: { effort },
  }
}
