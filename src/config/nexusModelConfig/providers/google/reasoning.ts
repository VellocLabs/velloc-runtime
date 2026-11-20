import type { ReasoningMapper } from '../../providerDefinition'

// Gemini: `generationConfig.thinkingConfig.thinkingLevel` (minimal | low |
// medium | high, and `xhigh` on the models in GEMINI_NATIVE_XHIGH). A tier
// above what the model takes degrades to `high`. Thinking cannot be switched
// off, so `none` sends nothing.
const GEMINI_TIER_TO_LEVEL: Record<string, string> = {
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  'extra-high': 'high',
  xhigh: 'high',
  max: 'high',
}

/** Model ids whose API takes `thinkingLevel: 'xhigh'`. */
export const GEMINI_NATIVE_XHIGH = /^gemini-4-(?:hydrogen|neon)(?:$|-)/i

const ABOVE_HIGH = new Set(['extra-high', 'xhigh', 'max'])

/** Google: the thinking tier -> the `generationConfig` fragment the Gemini wire merges. */
export const googleReasoning: ReasoningMapper = (tier, context) => {
  const level =
    ABOVE_HIGH.has(tier) && context.model && GEMINI_NATIVE_XHIGH.test(context.model)
      ? 'xhigh'
      : GEMINI_TIER_TO_LEVEL[tier]
  if (!level) {
    return undefined
  }
  return { generationConfig: { thinkingConfig: { thinkingLevel: level } } }
}
