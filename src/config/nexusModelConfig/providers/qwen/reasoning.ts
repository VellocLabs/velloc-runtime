import type { ReasoningMapper } from '../../providerDefinition'

// Qwen3 (DashScope): `enable_thinking` plus an optional `thinking_budget`; `max` and
// `none` must both be mapped. The gateway requires `thinking_budget` <
// `max_completion_tokens` and takes the budget out of that envelope, so budgets are
// clamped to at most HALF of it. qwen3.8-max only accepts `enable_thinking: true`.
const QWEN_TIER_TO_BUDGET: Record<string, number> = {
  low: 2048,
  medium: 8192,
  high: 32_768,
  max: 32_768,
}

/**
 * Qwen: the thinking tier → the request-body fragment the wire
 * merges last (`providerBodyExtension`). Moved verbatim from the per-id
 * chain that used to live in `thinkingTierParams.ts`; pinned for every
 * curated model by `provider-request-fields-matrix.test.ts`.
 */
export const qwenReasoning: ReasoningMapper = (tier, { maxOutputTokens }) => {
  // `none` explicitly disables thinking via the `enable_thinking` toggle.
  // Only models that ACCEPT the toggle reach this branch (qwen3.6-flash —
  // live-verified); qwen3.8-max
  // rejects `enable_thinking: false` ("restricted to True"), so the
  // catalog never offers it a `none` pill, and a stale persisted `none`
  // is dropped by the deps.ts `availableTiers` gate before this point.
  if (tier === 'none') {
    return { enable_thinking: false }
  }
  const budget = QWEN_TIER_TO_BUDGET[tier]
  if (budget === undefined) {
    return undefined
  }
  // The gateway treats max_completion_tokens (== `maxOutputTokens` on
  // the wire) as the TOTAL output envelope and RESERVES thinking_budget
  // out of it — see the constraint note on QWEN_TIER_TO_BUDGET. Clamp
  // the tier budget to at most half the envelope so at least half
  // always remains for the actual reply (budget = max−1 truncated
  // replies at ~50 tokens). When that leaves
  // no positive budget, send the bare toggle (the endpoint accepts
  // `enable_thinking` without a budget and applies the model default).
  const clamped = Math.min(budget, Math.floor(maxOutputTokens / 2))
  if (clamped < 1) {
    return { enable_thinking: true }
  }
  return {
    enable_thinking: true,
    thinking_budget: clamped,
  }
}
