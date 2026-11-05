import type { CapabilityProfile } from './contracts'

export const REVIEW_MODEL_MAPPING_REVISION = 3
export type ReviewModelTier = 'specialist' | 'flagship' | 'balanced' | 'fast'
export type ReviewModelIdentity = Readonly<{
  id: string
  family: 'claude' | 'openai' | 'kimi' | 'zhipu' | 'deepseek'
  tier: ReviewModelTier
  profile: CapabilityProfile
  aliases: readonly string[]
}>

const identity = (id: string, family: ReviewModelIdentity['family'], tier: ReviewModelTier, profile: CapabilityProfile, aliases: string[] = []): ReviewModelIdentity =>
  Object.freeze({ id, family, tier, profile, aliases: Object.freeze([id, ...aliases]) })

export const REVIEW_MODEL_IDENTITIES: readonly ReviewModelIdentity[] = Object.freeze([
  identity('claude-opus-4-8', 'claude', 'specialist', 'context-specialist', ['anthropic/claude-opus-4.8']),
  identity('claude-opus-5', 'claude', 'specialist', 'minimal-specialist', ['anthropic/claude-opus-5']),
  identity('claude-sonnet-5', 'claude', 'specialist', 'delegation-specialist', ['anthropic/claude-sonnet-5']),
  identity('claude-opus-5-5', 'claude', 'flagship', 'fallback', ['anthropic/claude-opus-5.5']),
  identity('claude-sonnet-5-5', 'claude', 'flagship', 'fallback', ['anthropic/claude-sonnet-5.5']),
  identity('gpt-6-astra', 'openai', 'flagship', 'fallback', ['openai/gpt-6-astra']),
  identity('gpt-5.5-pro', 'openai', 'flagship', 'fallback', ['openai/gpt-5.5-pro']),
  identity('gpt-5.4-pro', 'openai', 'flagship', 'fallback', ['openai/gpt-5.4-pro']),
  identity('gpt-6.1-sol', 'openai', 'balanced', 'balanced-review', ['openai/gpt-6.1-sol']),
  identity('gpt-6-sol', 'openai', 'balanced', 'balanced-review', ['openai/gpt-6-sol']),
  identity('gpt-5.6-sol', 'openai', 'balanced', 'balanced-review', ['openai/gpt-5.6-sol']),
  identity('gpt-5.6-terra', 'openai', 'balanced', 'balanced-review', ['openai/gpt-5.6-terra']),
  identity('gpt-6-luna', 'openai', 'fast', 'fast-review', ['openai/gpt-6-luna']),
  identity('gpt-5.6-luna', 'openai', 'fast', 'fast-review', ['openai/gpt-5.6-luna']),
  identity('gpt-5.4-mini', 'openai', 'fast', 'fast-review', ['openai/gpt-5.4-mini']),
  identity('k3.1-pro', 'kimi', 'flagship', 'fallback'),
  identity('k3.1-pro-highspeed', 'kimi', 'flagship', 'fallback'),
  identity('k3', 'kimi', 'balanced', 'balanced-review', ['moonshotai/kimi-k3']),
  identity('k3-256k', 'kimi', 'balanced', 'balanced-review'),
  identity('kimi-for-coding', 'kimi', 'fast', 'fast-review'),
  identity('glm-5.3', 'zhipu', 'flagship', 'fallback', ['z-ai/glm-5.3', 'zai/glm-5.3']),
  identity('glm-5.2', 'zhipu', 'balanced', 'balanced-review', ['z-ai/glm-5.2', 'zai/glm-5.2']),
  identity('glm-5.3-flash', 'zhipu', 'fast', 'fast-review', ['z-ai/glm-5.3-flash', 'zai/glm-5.3-flash']),
  identity('deepseek-v4-pro', 'deepseek', 'flagship', 'fallback', ['deepseek/deepseek-v4-pro']),
  identity('deepseek-flash', 'deepseek', 'fast', 'fast-review', ['deepseek/deepseek-v4.1-flash', 'deepseek-ai/DeepSeek-V4.1-Flash']),
])

const identitiesByAlias = new Map<string, ReviewModelIdentity>()
for (const model of REVIEW_MODEL_IDENTITIES) {
  for (const alias of model.aliases) {
    if (identitiesByAlias.has(alias)) throw new Error('Duplicate review model alias')
    identitiesByAlias.set(alias, model)
  }
}

export function resolveReviewModelIdentity(modelId: string | undefined): ReviewModelIdentity | undefined {
  return modelId === undefined ? undefined : identitiesByAlias.get(modelId)
}
