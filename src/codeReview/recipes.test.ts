import { describe, expect, it } from 'vitest'
import gatewayModelIds from '../__tests__/fixtures/gateway-model-ids.json'
import { REVIEW_LEVELS, type CapabilityProfile, type ReviewPolicyInput } from './contracts'
import { EIGHT_ANGLES, TEN_ANGLES, resolveCapabilityProfile, resolveReviewLevel, resolveReviewPolicy, resolveReviewPreferences, selectReviewRecipe, shouldRunAutomaticVerification, reviewLevelsOfTiers, thinkingTierForLevel } from './recipes'

const base: ReviewPolicyInput = {
  arguments: { fix: false, comment: false },
  source: 'user',
  output: 'terminal',
  capabilities: { agentAvailable: true, agentPermitted: true, remainingDepth: 2, outputToolAvailable: true },
}
const policy = (input: Partial<ReviewPolicyInput> = {}) => resolveReviewPolicy({ ...base, ...input })

const expectedRoutes = {
  fallback: [['quick-hunks', 4], ['local-eight', 10], ['local-eight', 10], ['local-ten', 15], ['team-ten', 15]],
  'balanced-review': [['quick-hunks', 4], ['local-eight', 8], ['team-eight-recall', 10], ['team-ten', 15], ['team-ten', 15]],
  'fast-review': [['quick-hunks', 4], ['team-eight-precise', 8], ['team-eight-recall', 10], ['team-ten', 15], ['team-ten', 15]],
  'context-specialist': [['quick-expand', 8], ['local-eight', 8], ['local-eight', 10], ['local-ten', 15], ['team-ten', 15]],
  'minimal-specialist': [['quick-hunks', 4], ['careful-pass', 15], ['careful-pass', 15], ['local-ten', 15], ['team-ten', 15]],
  'delegation-specialist': [['quick-expand', 'unlimited'], ['team-eight-precise', 8], ['team-eight-recall', 10], ['team-ten', 15], ['team-ten', 15]],
} as const

describe('recipe routes', () => {
  it.each([
    ['fallback', 'medium', undefined, 5], ['fallback', 'high', undefined, 5], ['fallback', 'xhigh', undefined, 7], ['context-specialist', 'medium', undefined, 4],
    ['fallback', 'high', 4, 2], ['fallback', 'high', 1, 1], ['fallback', 'high', 'all', 5], ['fallback', 'xhigh', 40, 7],
    ['fallback', 'low', undefined, undefined], ['minimal-specialist', 'high', undefined, undefined], ['delegation-specialist', 'high', undefined, undefined], ['fallback', 'max', undefined, undefined],
  ] as const)('%s %s with limit %s aims for %s findings', (profile, level, maxFindings, target) => {
    expect(policy({ profile, arguments: { ...base.arguments, level, ...(maxFindings === undefined ? {} : { maxFindings }) } }).findingTarget).toBe(target)
  })
  for (const profile of Object.keys(expectedRoutes) as CapabilityProfile[]) {
    it.each(REVIEW_LEVELS)(`${profile} %s selects its versioned route`, level => {
      const [recipe, defaultLimit] = expectedRoutes[profile][REVIEW_LEVELS.indexOf(level)]!
      expect(selectReviewRecipe(profile, level)).toEqual({ recipe, defaultLimit })
      const result = policy({ profile, arguments: { ...base.arguments, level } })
      expect([result.recipe, result.reportLimit, result.recipeRevision]).toEqual([recipe, defaultLimit, 2])
      expect(result).toMatchObject({ level, profile, allowWholeFileReads: level !== 'low' })
      expect(result.independentVerification).toBe(recipe.startsWith('team-'))
      expect(result.angles).toEqual(recipe.includes('ten') ? TEN_ANGLES : recipe.includes('eight') ? EIGHT_ANGLES : [])
    })
  }

  it('does not infer capabilities from arbitrary model names', () => {
    for (const name of ['unknown', 'context-specialist', 'delegation-specialist-preview', 'toString', '__proto__']) expect(resolveCapabilityProfile(name)).toBe('fallback')
    expect(resolveCapabilityProfile('unknown', 'context-specialist')).toBe('context-specialist')
  })

  it.each(['fallback', 'context-specialist', 'minimal-specialist', 'delegation-specialist', 'balanced-review', 'fast-review'] as const)('%s low remains a bounded diff-only review', profile => {
    const result = policy({ profile, arguments: { ...base.arguments, level: 'low' } })
    expect(result.agentMode).toBe('none')
    expect(result.sweep).toBe('none')
    expect(result.allowWholeFileReads).toBe(false)
    expect(result.skipTestsAndFixtures).toBe(profile !== 'context-specialist')
    expect(result.reasoningLevel).toBe(profile === 'delegation-specialist' ? 'medium' : 'low')
  })
})

describe('trusted preferences and level selection', () => {
  it('uses explicit user, saved user, session, then medium priority', () => {
    expect(policy({ arguments: { ...base.arguments, level: 'low' }, preferences: { level: 'high' }, sessionLevel: 'xhigh' }).level).toBe('low')
    expect(policy({ preferences: { level: 'high' }, sessionLevel: 'xhigh' })).toMatchObject({ level: 'high', notices: [{ code: 'level-reused', level: 'high' }] })
    expect(policy({ sessionLevel: 'xhigh' }).level).toBe('xhigh')
    expect(policy().level).toBe('medium')
  })

  it('rejects model escalation to max, including untrusted guidance', () => {
    for (const guidance of [undefined, { level: 'max' as const, trusted: false, appliesToProject: true }, { level: 'max' as const, trusted: true, appliesToProject: false }]) {
      expect(policy({ source: 'model', arguments: { ...base.arguments, level: 'max' }, guidance })).toMatchObject({ level: 'medium', notices: [{ code: 'max-not-authorized', level: 'medium' }] })
    }
    expect(policy({ sessionLevel: 'max' }).level).toBe('medium')
    expect(policy({ source: 'model', arguments: { ...base.arguments, level: 'max' }, preferences: { level: 'high' } }).level).toBe('high')
  })

  it('permits max from explicit user, valid user preference, or applicable trusted guidance', () => {
    expect(policy({ arguments: { ...base.arguments, level: 'max' } }).level).toBe('max')
    expect(policy({ source: 'model', preferences: { level: 'max' } }).level).toBe('max')
    expect(policy({ source: 'model', guidance: { level: 'max', trusted: true, appliesToProject: true } }).level).toBe('max')
    expect(policy({ arguments: { ...base.arguments, level: 'low' }, guidance: { level: 'max', trusted: true, appliesToProject: true } }).level).toBe('low')
  })

  it('does not mistake a model level for a remembered user choice', () => {
    expect(resolveReviewLevel({ arguments: { ...base.arguments, level: 'high' }, source: 'model' })).toEqual({ level: 'high', source: 'model', notices: [] })
    expect(policy({ source: 'preload', arguments: { ...base.arguments, level: 'max' } }).level).toBe('medium')
  })

  it('updates only explicit user preferences after target authorization', () => {
    const current = Object.freeze({ level: 'medium' as const, maxFindings: 8 })
    const args = { level: 'high' as const, maxFindings: 'all' as const, fix: true, comment: true }
    expect(resolveReviewPreferences({ current, arguments: args, source: 'user', targetAuthorized: true })).toEqual({ level: 'high', maxFindings: 'all' })
    for (const source of ['model', 'preload'] as const) expect(resolveReviewPreferences({ current, arguments: args, source, targetAuthorized: true })).toEqual(current)
    expect(resolveReviewPreferences({ current, arguments: args, source: 'user', targetAuthorized: false })).toEqual(current)
    expect(current).toEqual({ level: 'medium', maxFindings: 8 })
    expect(resolveReviewPreferences({ current, arguments: { ...base.arguments, maxFindings: 'default' }, source: 'user', targetAuthorized: true })).toEqual({ level: 'medium' })
  })
})

describe('output limits, capabilities and budget', () => {
  it('resolves quantity precedence and resets only the quantity', () => {
    expect(policy({ arguments: { ...base.arguments, maxFindings: 2 }, preferences: { maxFindings: 30 } }).reportLimit).toBe(2)
    expect(policy({ preferences: { maxFindings: 30 } }).reportLimit).toBe(30)
    expect(policy({ arguments: { ...base.arguments, maxFindings: 'default' }, preferences: { level: 'high', maxFindings: 30 } })).toMatchObject({ level: 'high', reportLimit: 10 })
  })

  it.each(['terminal', 'json'] as const)('supports unbounded %s results except careful-pass', output => {
    expect(policy({ output, arguments: { ...base.arguments, maxFindings: 'all' } }).reportLimit).toBe('unlimited')
    expect(policy({ output, profile: 'minimal-specialist', arguments: { ...base.arguments, maxFindings: 'all' } })).toMatchObject({ reportLimit: 32, notices: [{ code: 'careful-pass-limit', requested: 'unlimited', effective: 32 }] })
  })

  it.each([33, 100, 'all'] as const)('caps panel quantity %s without altering preferences', maxFindings => {
    const preferences = Object.freeze({ maxFindings })
    expect(policy({ output: 'panel', preferences })).toMatchObject({ reportLimit: 32, notices: [{ code: 'panel-limit', effective: 32 }] })
    expect(preferences.maxFindings).toBe(maxFindings)
  })

  it('ignores delegation low quantity but preserves its original preference', () => {
    const preferences = Object.freeze({ maxFindings: 12 })
    expect(policy({ profile: 'delegation-specialist', arguments: { ...base.arguments, level: 'low', maxFindings: 3 }, preferences })).toMatchObject({ reportLimit: 'unlimited', notices: expect.arrayContaining([{ code: 'quantity-ignored', requested: 3 }]) })
    expect(policy({ profile: 'delegation-specialist', output: 'panel', arguments: { ...base.arguments, level: 'low' } }).reportLimit).toBe(32)
    expect(preferences.maxFindings).toBe(12)
  })

  it.each([
    [{ agentAvailable: false }, 'agent-unavailable'],
    [{ agentPermitted: false }, 'agent-denied'],
    [{ remainingDepth: 0 }, 'agent-depth-exhausted'],
  ] as const)('falls back without inventing independent verification: %s', (override, reason) => {
    const result = policy({ arguments: { ...base.arguments, level: 'max' }, capabilities: { ...base.capabilities, ...override } })
    expect(result).toMatchObject({ recipe: 'team-ten', angles: TEN_ANGLES, agentMode: 'sequential-fallback', fallbackReason: reason, independentVerification: false, sweep: 'same-context', candidatesPerAngle: 8, sweepCandidateLimit: 8 })
    expect(result.notices).toContainEqual({ code: reason })
  })

  it('skips tests at quick-hunks unless every changed file is a test or fixture', () => {
    expect(policy({ arguments: { ...base.arguments, level: 'low' } })).toMatchObject({ skipTestsAndFixtures: true, notices: [{ code: 'tests-fixtures-skipped' }] })
    expect(policy({ arguments: { ...base.arguments, level: 'low' }, testsOnly: true })).toMatchObject({ skipTestsAndFixtures: false, notices: [{ code: 'tests-fixtures-reviewed' }] })
    expect(policy({ arguments: { ...base.arguments, level: 'medium' }, testsOnly: true }).notices).toEqual([])
  })

  it('keeps local recipes free of verifier tasks', () => {
    for (const level of ['medium', 'high', 'xhigh'] as const) expect(policy({ arguments: { ...base.arguments, level } })).toMatchObject({ agentMode: 'none', independentVerification: false })
  })

  it('uses available reporting tools rather than coordinator assumptions', () => {
    expect(policy({ output: 'panel', capabilities: { ...base.capabilities, outputToolAvailable: false } })).toMatchObject({ presentation: 'terminal', execution: 'isolated', notices: [{ code: 'output-tool-unavailable' }] })
    expect(policy({ capabilities: { ...base.capabilities, coordinator: true, coordinatorCanExecuteSkill: true, outputToolAvailable: false } })).toMatchObject({ presentation: 'terminal', execution: 'inline', blocked: false })
    expect(policy({ capabilities: { ...base.capabilities, coordinator: true } })).toMatchObject({ coordinatorWorkerRequired: true, blocked: true })
    expect(policy({ capabilities: { ...base.capabilities, coordinator: true, coordinatorWorkerAvailable: true } })).toMatchObject({ coordinatorWorkerRequired: true, blocked: false })
  })

  it.each([[0, 2], [1, 2], [300, 2], [301, 3], [1200, 8], [9999, 8]])('uses %s changed lines only as a finder recommendation', (changedLines, count) => {
    const result = policy({ profile: 'delegation-specialist', arguments: { ...base.arguments, level: 'high' }, changedLines, changedLinesCommittedOnly: true, capabilities: { ...base.capabilities, workerConcurrency: 1 } })
    expect(result).toMatchObject({ suggestedFinderTasks: count, reportLimit: 10, workerConcurrency: 1 })
    expect(result.notices).toContainEqual({ code: 'committed-lines-only' })
  })

  it.each([undefined, -1, NaN, Infinity, 1.5])('does not invent a diff count from %s', changedLines => {
    expect(policy({ profile: 'delegation-specialist', arguments: { ...base.arguments, level: 'high' }, changedLines }).suggestedFinderTasks).toBeUndefined()
  })

  it('maps provider reasoning independently of logical level', () => {
    expect(policy({ arguments: { ...base.arguments, level: 'xhigh' }, capabilities: { ...base.capabilities, supportedReasoningLevels: ['low', 'medium', 'high'] } })).toMatchObject({ level: 'xhigh', recipe: 'local-ten', reasoningLevel: 'high', notices: [{ code: 'reasoning-mapped', requested: 'xhigh', effective: 'high' }] })
  })

  it('reads a model listing extra-high as offering xhigh, and asks for it in the model spelling', () => {
    const tiers = ['low', 'medium', 'high', 'extra-high', 'max']
    expect(reviewLevelsOfTiers(tiers)).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(reviewLevelsOfTiers(['none', 'low', 'medium', 'high', 'xhigh'])).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(reviewLevelsOfTiers(undefined)).toBeUndefined()
    const plan = policy({ arguments: { ...base.arguments, level: 'xhigh' }, capabilities: { ...base.capabilities, supportedReasoningLevels: reviewLevelsOfTiers(tiers) } })
    expect(plan).toMatchObject({ level: 'xhigh', recipe: 'local-ten', reasoningLevel: 'xhigh' })
    expect(plan.notices.some(notice => notice.code === 'reasoning-mapped')).toBe(false)
    expect(thinkingTierForLevel('xhigh', tiers)).toBe('extra-high')
    expect(thinkingTierForLevel('xhigh', ['low', 'medium', 'high', 'xhigh', 'max'])).toBe('xhigh')
    expect(thinkingTierForLevel('high', tiers)).toBe('high')
    expect(thinkingTierForLevel('xhigh', undefined)).toBe('xhigh')
    expect(thinkingTierForLevel(undefined, tiers)).toBeUndefined()
  })

  it('returns an immutable plan and immutable routing metadata', () => {
    const result = policy()
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.angles)).toBe(true)
    expect(Object.isFrozen(result.notices)).toBe(true)
    expect(Object.isFrozen(selectReviewRecipe('fallback', 'medium'))).toBe(true)
  })
})

describe('automatic runtime verification', () => {
  it('requires an eligible route and every runtime gate', () => {
    const plan = policy({ output: 'panel', arguments: { ...base.arguments, level: 'low' } })
    const gates = { permitted: true, adapterAvailable: true, runtimeBehaviorChanged: true, alreadyVerified: false }
    expect(shouldRunAutomaticVerification(plan, gates)).toBe(true)
    for (const key of ['permitted', 'adapterAvailable', 'runtimeBehaviorChanged'] as const) expect(shouldRunAutomaticVerification(plan, { ...gates, [key]: false })).toBe(false)
    expect(shouldRunAutomaticVerification(plan, { ...gates, alreadyVerified: true })).toBe(false)
    expect(shouldRunAutomaticVerification(policy(), gates)).toBe(false)
  })

  for (const profile of Object.keys(expectedRoutes) as CapabilityProfile[]) {
    it.each(REVIEW_LEVELS)(`${profile} %s uses the explicit verification routing`, level => {
      const eligible = profile === 'delegation-specialist' || (profile === 'context-specialist' ? level === 'max' : profile === 'fast-review' || profile === 'balanced-review' ? false : level === 'low' || level === 'max')
      expect(policy({ profile, output: 'panel', arguments: { ...base.arguments, level } }).automaticVerificationEligible).toBe(eligible)
    })
  }
})

describe('level selection boundaries', () => {
  it('honors a model request ahead of session defaults and the saved level', () => {
    expect(policy({ source: 'model', arguments: { ...base.arguments, level: 'low' }, sessionLevel: 'high' })).toMatchObject({ level: 'low', levelSource: 'model' })
    expect(policy({ source: 'model', arguments: { ...base.arguments, level: 'low' }, sessionLevel: 'medium', preferences: { level: 'high' } })).toMatchObject({ level: 'low', levelSource: 'model', notices: [{ code: 'tests-fixtures-skipped' }] })
  })

  it('uses the saved level only when the run names none', () => {
    expect(policy({ source: 'model', preferences: { level: 'high' }, sessionLevel: 'medium' })).toMatchObject({ level: 'high', levelSource: 'preference', notices: [{ code: 'level-reused', level: 'high' }] })
    expect(policy({ source: 'model', arguments: { ...base.arguments, level: 'max' }, preferences: { level: 'low' } })).toMatchObject({ level: 'low', levelSource: 'preference', notices: expect.arrayContaining([{ code: 'max-not-authorized', level: 'low' }, { code: 'level-reused', level: 'low' }]) })
  })

  it('rejects unauthorized max without discarding an allowed session level', () => {
    expect(policy({ source: 'model', arguments: { ...base.arguments, level: 'max' }, sessionLevel: 'high' })).toMatchObject({ level: 'high', levelSource: 'session', notices: [{ code: 'max-not-authorized', level: 'high' }] })
  })

  it('uses applicable trusted guidance to authorize requested max without overriding explicit lower levels', () => {
    const guidance = { level: 'max' as const, trusted: true, appliesToProject: true }
    expect(policy({ source: 'model', arguments: { ...base.arguments, level: 'max' }, sessionLevel: 'low', guidance })).toMatchObject({ level: 'max', levelSource: 'model' })
    expect(policy({ source: 'model', arguments: { ...base.arguments, level: 'low' }, guidance })).toMatchObject({ level: 'low', levelSource: 'model' })
    expect(policy({ sessionLevel: 'low', guidance })).toMatchObject({ level: 'max', levelSource: 'guidance' })
    expect(policy({ source: 'model', arguments: { ...base.arguments, level: 'max' }, preferences: { level: 'low' }, guidance })).toMatchObject({ level: 'max', levelSource: 'model', notices: [] })
  })

  it.each([
    ['claude-opus-4-8', 'context-specialist'],
    ['claude-opus-5', 'minimal-specialist'],
    ['claude-sonnet-5', 'delegation-specialist'],
  ] as const)('maps only the verified canonical ID %s', (id, profile) => {
    expect(resolveCapabilityProfile(id)).toBe(profile)
    for (const variant of [`${id}-preview`, `vendor/${id}`, `${id}-5`, id.toUpperCase()]) expect(resolveCapabilityProfile(variant)).toBe('fallback')
    expect(resolveCapabilityProfile(id, 'fallback')).toBe('fallback')
  })

  for (const provider of ['openrouter', 'vercel-ai-gateway'] as const) {
    it.each([
      ['anthropic/claude-opus-4.8', 'claude-opus-4-8'],
      ['anthropic/claude-opus-5', 'claude-opus-5'],
      ['anthropic/claude-sonnet-5', 'claude-sonnet-5'],
    ])(`${provider} exact ID %s selects the same routes at every level`, (alias, canonical) => {
      expect(gatewayModelIds[provider]).toContain(alias)
      for (const level of REVIEW_LEVELS) {
        const reviewArguments = { ...base.arguments, level }
        expect(policy({ canonicalModelId: alias, arguments: reviewArguments })).toEqual(policy({ canonicalModelId: canonical, arguments: reviewArguments }))
      }
    })
  }

  it('routes the Nebius Token Factory DeepSeek V4.1 Flash like the direct Flash model, a team review at medium', () => {
    const recipes = REVIEW_LEVELS.map(level => policy({ canonicalModelId: 'deepseek-ai/DeepSeek-V4.1-Flash', arguments: { ...base.arguments, level } }).recipe)
    expect(recipes).toEqual(['quick-hunks', 'team-eight-precise', 'team-eight-recall', 'team-ten', 'team-ten'])
    expect(resolveCapabilityProfile('deepseek-ai/DeepSeek-V4-Flash')).toBe('fallback')
  })

  it.each([
    'claude-opus-5-5', 'claude-sonnet-5-5', 'anthropic/claude-opus-5.5', 'anthropic/claude-sonnet-5.5',
    'anthropic/claude-opus-4.8-fast', 'anthropic/claude-opus-5-fast', 'anthropic/claude-opus-5:batch',
    'anthropic/claude-opus-4-8', 'relay/claude-opus-5', 'claude-opus-5-latest',
    'openai/gpt-5.5', 'google/gemini-3.1-pro-preview', 'unknown-latest',
  ])('keeps new models and unverified variants on fallback: %s', id => {
    expect(resolveCapabilityProfile(id)).toBe('fallback')
    for (const level of REVIEW_LEVELS) expect(policy({ canonicalModelId: id, arguments: { ...base.arguments, level } }).recipe).toBe(selectReviewRecipe('fallback', level).recipe)
  })
})
