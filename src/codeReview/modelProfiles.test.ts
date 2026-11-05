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
  it('distinguishes recognized flagships from unknown fallback models', () => {
    for (const id of ['claude-opus-5-5', 'anthropic/claude-opus-5.5', 'gpt-6-astra', 'k3.1-pro', 'glm-5.3', 'deepseek-v4-pro']) {
      expect(resolveReviewModelIdentity(id)?.tier).toBe('flagship')
      expect(resolveCapabilityProfile(id)).toBe('fallback')
    }
    expect(resolveReviewModelIdentity('future-flagship')).toBeUndefined()
    expect(resolveCapabilityProfile('future-flagship')).toBe('fallback')
  })
  it.each(['gpt-7-luna', 'gpt-6-luna-fast', 'openai/gpt-6-luna-fast', 'moonshotai/kimi-k3-fast', 'k4', 'z-ai/glm-5.3-flashx', 'glm-6-flash', 'deepseek-v5-flash', '~openai/gpt-sol-latest', 'vendor/glm-5.2', 'GLM-5.2', 'openai/gpt-5.4-mini:batch'])('does not guess a tier for %s', id => {
    expect(resolveReviewModelIdentity(id)).toBeUndefined()
    expect(resolveCapabilityProfile(id)).toBe('fallback')
  })
  it('resolves virtual latest entries before exact identity lookup', () => {
    const entry = 'gpt-*-luna@latest'
    try {
      recordEntryResolution('openai', entry, { id: 'gpt-6-luna', versionLabel: '6', preview: false })
      expect(resolveCapabilityProfile(resolveModelId('openai', entry))).toBe('fast-review')
      recordEntryResolution('openai', entry, { id: 'gpt-7-luna', versionLabel: '7', preview: false })
      expect(resolveCapabilityProfile(resolveModelId('openai', entry))).toBe('fallback')
    } finally { recordEntryResolution('openai', entry, undefined) }
  })
})

describe('tier-specific review workflows', () => {
  it.each(['gpt-6.1-sol', 'gpt-6-sol', 'k3', 'glm-5.2'])('keeps %s balanced at medium and adds independent review at high', id => {
    expect(plan(id, 'medium')).toMatchObject({ recipe: 'local-eight', agentMode: 'none', level: 'medium' })
    expect(plan(id, 'high')).toMatchObject({ recipe: 'team-eight-recall', independentVerification: true, level: 'high' })
  })
  it.each(['gpt-6-luna', 'gpt-5.4-mini', 'kimi-for-coding', 'glm-5.3-flash', 'deepseek-flash'])('gives %s bounded low and independent medium verification', id => {
    expect(plan(id, 'low')).toMatchObject({ recipe: 'quick-hunks', agentMode: 'none', reportLimit: 4 })
    expect(plan(id, 'medium')).toMatchObject({ recipe: 'team-eight-precise', independentVerification: true, reportLimit: 8 })
    expect(plan(id, 'medium', false)).toMatchObject({ agentMode: 'sequential-fallback', independentVerification: false, fallbackReason: 'agent-unavailable' })
    expect(plan(id, 'xhigh')).toMatchObject({ recipe: 'team-ten', level: 'xhigh' })
  })
  it.each(['MiniMax-M3.1-Flash', 'MiniMaxAI/MiniMax-M3.1-Flash'])('gives %s the fast profile: bounded low, a team review from medium', id => {
    expect(resolveCapabilityProfile(id)).toBe('fast-review')
    expect(REVIEW_LEVELS.map(level => plan(id, level).recipe)).toEqual(['quick-hunks', 'team-eight-precise', 'team-eight-recall', 'team-ten', 'team-ten'])
  })
  it.each(['MiniMax-M3', 'MiniMax-M4-Flash', 'MiniMax-M3.1-Flash-Preview', 'minimax/minimax-m3.1-flash'])('does not guess a tier for %s', id => {
    expect(resolveReviewModelIdentity(id)).toBeUndefined()
    expect(resolveCapabilityProfile(id)).toBe('fallback')
  })
  it('keeps user limits and max authorization independent of model tier', () => {
    const result = resolveReviewPolicy({ canonicalModelId: 'gpt-6-luna', source: 'model', arguments: { level: 'max', fix: false, comment: false, maxFindings: 2 }, output: 'terminal', capabilities })
    expect(result.level).toBe('medium')
    expect(result.reportLimit).toBe(2)
    expect(result.recipe).toBe('team-eight-precise')
  })
})
