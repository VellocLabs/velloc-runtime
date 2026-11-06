import type { CapabilityProfile } from './contracts'

export const REVIEW_MODEL_MAPPING_REVISION = 5
export type ReviewModelTier = 'specialist' | 'flagship' | 'balanced' | 'fast'
export type ReviewModelIdentity = Readonly<{
  id: string
  family: 'claude' | 'openai' | 'kimi' | 'zhipu' | 'deepseek'
    | 'minimax' | 'google' | 'qwen'
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
  identity('claude-fable-5-1', 'claude', 'flagship', 'fallback'),
  identity('claude-fable-5', 'claude', 'flagship', 'fallback'),
  identity('claude-opus-4-7', 'claude', 'flagship', 'fallback'),
  identity('claude-opus-4-6', 'claude', 'flagship', 'fallback'),
  identity('claude-sonnet-4-6', 'claude', 'balanced', 'fallback'),
  identity('claude-haiku-4-5', 'claude', 'fast', 'fallback'),
  identity('gpt-6-astra', 'openai', 'flagship', 'fallback', ['openai/gpt-6-astra']),
  identity('gpt-5.5-pro', 'openai', 'flagship', 'fallback', ['openai/gpt-5.5-pro']),
  identity('gpt-5.4-pro', 'openai', 'flagship', 'fallback', ['openai/gpt-5.4-pro']),
  identity('gpt-5.5', 'openai', 'flagship', 'fallback'),
  identity('gpt-5.4', 'openai', 'flagship', 'fallback'),
  identity('gpt-6.1-sol', 'openai', 'balanced', 'delegation-specialist', ['openai/gpt-6.1-sol']),
  identity('gpt-6-sol', 'openai', 'balanced', 'delegation-specialist', ['openai/gpt-6-sol']),
  identity('gpt-5.6-sol', 'openai', 'balanced', 'delegation-specialist', ['openai/gpt-5.6-sol']),
  identity('gpt-5.6-terra', 'openai', 'balanced', 'delegation-specialist', ['openai/gpt-5.6-terra']),
  identity('gpt-6-luna', 'openai', 'fast', 'delegation-specialist', ['openai/gpt-6-luna']),
  identity('gpt-5.6-luna', 'openai', 'fast', 'delegation-specialist', ['openai/gpt-5.6-luna']),
  identity('gpt-5.4-mini', 'openai', 'fast', 'delegation-specialist', ['openai/gpt-5.4-mini']),
  identity('k3.1-pro', 'kimi', 'flagship', 'delegation-specialist'),
  identity('k3.1-pro-highspeed', 'kimi', 'flagship', 'delegation-specialist'),
  identity('k3', 'kimi', 'balanced', 'delegation-specialist', ['moonshotai/kimi-k3']),
  identity('k3-256k', 'kimi', 'balanced', 'fallback-no-team'),
  identity('kimi-for-coding', 'kimi', 'fast', 'fallback-no-team'),
  identity('kimi-for-coding-highspeed', 'kimi', 'fast', 'fallback-no-team'),
  identity('glm-5.3', 'zhipu', 'flagship', 'fallback-no-team', ['z-ai/glm-5.3', 'zai/glm-5.3']),
  identity('glm-5.2', 'zhipu', 'balanced', 'fallback-no-team', ['z-ai/glm-5.2', 'zai/glm-5.2']),
  identity('glm-5.3-flash', 'zhipu', 'fast', 'fallback-no-team', ['z-ai/glm-5.3-flash', 'zai/glm-5.3-flash']),
  identity('glm-4.6', 'zhipu', 'balanced', 'fallback-no-team'),
  identity('glm-4', 'zhipu', 'balanced', 'fallback-no-team'),
  identity('glm-4-flash', 'zhipu', 'fast', 'fallback-no-team'),
  identity('glm-4-plus', 'zhipu', 'balanced', 'fallback-no-team'),
  identity('glm-4-air', 'zhipu', 'fast', 'fallback-no-team'),
  identity('glm-4v-plus', 'zhipu', 'balanced', 'fallback-no-team'),
  identity('deepseek-v4-pro', 'deepseek', 'flagship', 'delegation-specialist', ['deepseek/deepseek-v4-pro']),
  identity('deepseek-flash', 'deepseek', 'fast', 'delegation-specialist', ['deepseek/deepseek-v4.1-flash', 'deepseek-ai/DeepSeek-V4.1-Flash']),
  identity('MiniMax-M3.1-Flash', 'minimax', 'fast', 'fallback-no-team', ['MiniMaxAI/MiniMax-M3.1-Flash']),
  identity('MiniMax-M3', 'minimax', 'flagship', 'fallback-no-team'),
  identity('MiniMax-M2.7', 'minimax', 'balanced', 'fallback-no-team'),
  identity('MiniMax-M2.5', 'minimax', 'balanced', 'fallback-no-team'),
  identity('MiniMax-M2.1', 'minimax', 'balanced', 'fallback-no-team'),
  identity('MiniMax-M2', 'minimax', 'balanced', 'fallback-no-team'),
  identity('MiniMax-M2.7-highspeed', 'minimax', 'fast', 'fallback-no-team'),
  identity('MiniMax-M2.5-highspeed', 'minimax', 'fast', 'fallback-no-team'),
  identity('MiniMax-M2.1-highspeed', 'minimax', 'fast', 'fallback-no-team'),
  identity('gemini-2.5-pro', 'google', 'flagship', 'fallback-no-team'),
  identity('gemini-3.8-flash', 'google', 'balanced', 'fallback-no-team'),
  identity('gemini-3.7-flash', 'google', 'balanced', 'fallback-no-team'),
  identity('gemini-3.6-flash', 'google', 'balanced', 'fallback-no-team'),
  identity('gemini-3.5-flash', 'google', 'balanced', 'fallback-no-team'),
  identity('gemini-2.5-flash', 'google', 'balanced', 'fallback-no-team'),
  identity('gemini-3.5-flash-lite', 'google', 'fast', 'fallback-no-team'),
  identity('gemini-2.5-flash-lite', 'google', 'fast', 'fallback-no-team'),
  identity('qwen3.8-max', 'qwen', 'flagship', 'fallback-no-team'),
  identity('qwen3.7-max', 'qwen', 'flagship', 'fallback-no-team'),
  identity('qwen3.7-plus', 'qwen', 'balanced', 'fallback-no-team'),
  identity('qwen3.8-flash', 'qwen', 'fast', 'fallback-no-team'),
  identity('qwen3.6-flash', 'qwen', 'fast', 'fallback-no-team'),
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
