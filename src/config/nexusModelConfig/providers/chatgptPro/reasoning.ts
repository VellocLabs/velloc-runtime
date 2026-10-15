import type { ReasoningMapper } from '../../providerDefinition'

// ChatGPT Pro (Codex backend) accepts none | minimal | low | medium | high | xhigh,
// plus `max`; `ultra` is rejected, so it has no entry and a stale persisted `ultra` is
// dropped. Not `OPENAI_TIER_TO_EFFORT`: the two differ on `max`.
const CHATGPT_PRO_TIER_TO_EFFORT: Record<string, string> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  'extra-high': 'xhigh',
  xhigh: 'xhigh',
  max: 'max',
}

/**
 * ChatGPT Pro: the thinking tier → the request-body fragment the wire
 * merges last (`providerBodyExtension`). Moved verbatim from the per-id
 * chain that used to live in `thinkingTierParams.ts`; pinned for every
 * curated model by `provider-request-fields-matrix.test.ts`.
 */
export const chatgptProReasoning: ReasoningMapper = (tier) => {
  const effort = CHATGPT_PRO_TIER_TO_EFFORT[tier]
  if (!effort) {
    return undefined
  }
  return { reasoning_effort: effort }
}
