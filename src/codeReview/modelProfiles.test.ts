import { describe, expect, it } from 'vitest'
import gatewayIds from '../__tests__/fixtures/gateway-model-ids.json'
import { REVIEW_MODEL_IDENTITIES, resolveReviewModelIdentity } from './modelProfiles'
import { resolveCapabilityProfile, resolveReviewPolicy } from './recipes'
import { REVIEW_LEVELS } from './contracts'
import { recordEntryResolution, resolveModelId } from '../config/nexusModelConfig/modelEntryResolution'

const capabilities = { agentAvailable: true, agentPermitted: true, remainingDepth: 2, outputToolAvailable: true }
const plan = (id: string, level: typeof REVIEW_LEVELS[number], agents = true) => resolveReviewPolicy({ canonicalModelId: id, source: 'user', arguments: { level, fix: false, comment: false }, output: 'terminal', capabilities: { ...capabilities, agentAvailable: agents } })

describe('review model identities', () => {
  it('keeps alias ownership unique and immutable', () => {
    const aliases = REVIEW_MODEL_IDENTITIES.flatMap(model => model.aliases)
    expect(new Set(aliases).size).toBe(aliases.length)
    expect(Object.isFrozen(REVIEW_MODEL_IDENTITIES)).toBe(true)
    for (const model of REVIEW_MODEL_IDENTITIES) expect(Object.isFrozen(model.aliases)).toBe(true)
  })
  for (const model of REVIEW_MODEL_IDENTITIES) {
    it(`${model.id} aliases share identity and every recipe`, () => {
      for (const alias of model.aliases) {
        expect(resolveReviewModelIdentity(alias)).toBe(model)
        expect(resolveCapabilityProfile(alias)).toBe(model.profile)
        for (const level of REVIEW_LEVELS) expect(plan(alias, level)).toEqual(plan(model.id, level))
      }
    })
  }
  it('pins gateway spellings to recorded provider listings', () => {
    // Nebius Token Factory spellings keep the vendor's capitals; gateway spellings are lower case.
    const gatewaySpelling = (alias: string) => alias.includes('/') && alias === alias.toLowerCase()
    for (const model of REVIEW_MODEL_IDENTITIES) for (const alias of model.aliases.filter(gatewaySpelling)) {
      const providers = alias.startsWith('z-ai/') ? ['openrouter'] as const : alias.startsWith('zai/') ? ['vercel-ai-gateway'] as const : ['openrouter', 'vercel-ai-gateway'] as const
      for (const provider of providers) expect(gatewayIds[provider], `${provider}: ${alias}`).toContain(alias)
    }
  })
  it('distinguishes recognized flagships from unknown models', () => {
    for (const [id, profile] of [['claude-opus-5-5', 'fallback'], ['anthropic/claude-opus-5.5', 'fallback'], ['gpt-6-astra', 'fallback'], ['k3.1-pro', 'delegation-specialist'], ['glm-5.3', 'fallback-no-team'], ['deepseek-v4-pro', 'delegation-specialist']] as const) {
      expect(resolveReviewModelIdentity(id)?.tier).toBe('flagship')
      expect(resolveCapabilityProfile(id)).toBe(profile)
    }
    expect(resolveReviewModelIdentity('future-flagship')).toBeUndefined()
    expect(resolveCapabilityProfile('future-flagship')).toBe('fallback-no-team')
  })
  it.each(['gpt-7-luna', 'gpt-6-luna-fast', 'openai/gpt-6-luna-fast', 'moonshotai/kimi-k3-fast', 'k4', 'z-ai/glm-5.3-flashx', 'glm-6-flash', 'deepseek-v5-flash', '~openai/gpt-sol-latest', 'vendor/glm-5.2', 'GLM-5.2', 'openai/gpt-5.4-mini:batch'])('does not guess a tier for %s', id => {
    expect(resolveReviewModelIdentity(id)).toBeUndefined()
    expect(resolveCapabilityProfile(id)).toBe('fallback-no-team')
  })
  it('resolves virtual latest entries before exact identity lookup', () => {
    const entry = 'gpt-*-luna@latest'
    try {
      recordEntryResolution('openai', entry, { id: 'gpt-6-luna', versionLabel: '6', preview: false })
      expect(resolveCapabilityProfile(resolveModelId('openai', entry))).toBe('delegation-specialist')
      recordEntryResolution('openai', entry, { id: 'gpt-7-luna', versionLabel: '7', preview: false })
      expect(resolveCapabilityProfile(resolveModelId('openai', entry))).toBe('fallback-no-team')
    } finally { recordEntryResolution('openai', entry, undefined) }
  })
})

describe('profile-specific review workflows', () => {
  it.each(['gpt-6.1-sol', 'gpt-6-sol', 'gpt-5.6-terra', 'gpt-6-luna', 'gpt-5.4-mini', 'k3', 'k3.1-pro', 'deepseek-v4-pro', 'deepseek-flash', 'deepseek-ai/DeepSeek-V4.1-Flash'])('runs %s as a team from medium', id => {
    expect(resolveCapabilityProfile(id)).toBe('delegation-specialist')
    expect(REVIEW_LEVELS.map(level => plan(id, level).recipe)).toEqual(['quick-expand', 'team-eight-precise', 'team-eight-recall', 'team-ten', 'team-ten'])
    expect(plan(id, 'medium')).toMatchObject({ independentVerification: true, reportLimit: 8 })
    expect(plan(id, 'medium', false)).toMatchObject({ agentMode: 'sequential-fallback', independentVerification: false, fallbackReason: 'agent-unavailable' })
  })
  it.each(['gpt-6-astra', 'gpt-5.5-pro', 'gpt-5.5', 'claude-fable-5-1', 'claude-haiku-4-5'])('keeps %s single-context below max', id => {
    expect(resolveCapabilityProfile(id)).toBe('fallback')
    expect(REVIEW_LEVELS.map(level => plan(id, level).recipe)).toEqual(['quick-hunks', 'local-eight', 'local-eight', 'local-ten', 'team-ten'])
  })
  it.each(['MiniMax-M3.1-Flash', 'MiniMaxAI/MiniMax-M3.1-Flash', 'MiniMax-M3', 'k3-256k', 'kimi-for-coding', 'glm-5.3', 'glm-5.2', 'glm-5.3-flash', 'gemini-2.5-pro', 'qwen3.8-max'])('never starts a team for %s', id => {
    expect(resolveCapabilityProfile(id)).toBe('fallback-no-team')
    expect(REVIEW_LEVELS.map(level => plan(id, level).recipe)).toEqual(['quick-hunks', 'local-eight', 'local-eight', 'local-ten', 'local-ten'])
    for (const level of REVIEW_LEVELS) expect(plan(id, level)).toMatchObject({ agentMode: 'none', independentVerification: false })
  })
  it.each(['MiniMax-M4-Flash', 'MiniMax-M3.1-Flash-Preview', 'minimax/minimax-m3.1-flash'])('does not guess a tier for %s', id => {
    expect(resolveReviewModelIdentity(id)).toBeUndefined()
    expect(resolveCapabilityProfile(id)).toBe('fallback-no-team')
  })
  it('keeps user limits and max authorization independent of model tier', () => {
    const result = resolveReviewPolicy({ canonicalModelId: 'gpt-6-luna', source: 'model', arguments: { level: 'max', fix: false, comment: false, maxFindings: 2 }, output: 'terminal', capabilities })
    expect(result.level).toBe('medium')
    expect(result.reportLimit).toBe(2)
    expect(result.recipe).toBe('team-eight-precise')
  })
})
