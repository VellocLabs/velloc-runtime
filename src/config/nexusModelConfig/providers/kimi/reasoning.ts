import type { ReasoningMapper } from '../../providerDefinition'

// Kimi Code tiers → canonical wire values: ultra / max / xhigh → max; high / medium
// → high; low / minimum / light → low; none → `thinking.type: 'disabled'`.
const KIMI_TIER_TO_EFFORT: Record<string, string> = {
  low: 'low',
  medium: 'high',
  high: 'high',
  'extra-high': 'max',
  xhigh: 'max',
  ultra: 'max',
  max: 'max',
}

/**
 * Kimi: the thinking tier → the request-body fragment the wire
 * merges last (`providerBodyExtension`). Moved verbatim from the per-id
 * chain that used to live in `thinkingTierParams.ts`; pinned for every
 * curated model by `provider-request-fields-matrix.test.ts`.
 */
export const kimiReasoning: ReasoningMapper = (tier) => {
  // `none` maps to the thinking TOGGLE, not reasoning_effort (the endpoint
  // has no 'none' effort variant).
  if (tier === 'none') {
    return { thinking: { type: 'disabled' } }
  }
  const effort = KIMI_TIER_TO_EFFORT[tier]
  if (!effort) {
    return undefined
  }
  return { reasoning_effort: effort }
}
