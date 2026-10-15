import type { ReasoningMapper } from '../../providerDefinition'

/** Runtime tier id → the wire's effort value. */
const TIER_TO_EFFORT: Record<string, string> = {
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
 * The gateways' unified `reasoning: {effort}` object, translated by the gateway to
 * each vendor's control. `none` switches reasoning off where the listing allows it.
 */
export const reasoningObject: ReasoningMapper = tier => {
  const effort = TIER_TO_EFFORT[tier]
  return effort ? { reasoning: { effort } } : undefined
}
