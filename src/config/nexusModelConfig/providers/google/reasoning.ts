import type { ReasoningMapper } from '../../providerDefinition'

// Gemini 3.x: `generationConfig.thinkingConfig.thinkingLevel` (minimal | low |
// medium | high). A tier above `high` from another provider degrades to `high`.
// Thinking cannot be switched off, so `none` sends nothing.
const GEMINI_TIER_TO_LEVEL: Record<string, string> = {
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  'extra-high': 'high',
  xhigh: 'high',
  max: 'high',
}

/** Google: the thinking tier -> the `generationConfig` fragment the Gemini wire merges. */
export const googleReasoning: ReasoningMapper = (tier) => {
  const level = GEMINI_TIER_TO_LEVEL[tier]
  if (!level) {
    return undefined
  }
  return { generationConfig: { thinkingConfig: { thinkingLevel: level } } }
}
