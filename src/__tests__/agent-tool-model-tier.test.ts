import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NEXUS_MODEL_CONFIG } from '../config/nexusModelConfig'
import { resolveModelTier } from '../toolkit/builtin/subagentLaunch'
import {
  autoTierThinkingTier,
  topTierModel,
  getFastModel,
  getModelForSessionType,
  getTierModelForProvider,
} from '../engine/contextWindow'
import {
  resetSessionModelSettingsSnapshot,
  setSessionModelSettingsSnapshot,
} from '../models/tierSettingsSnapshot'

/**
 * Decision table for `resolveModelTier`: the tool-call `model` tier × the `agent_tool` session-model policy ×
 * whether the tier is configured. Resolves against the shipped `NEXUS_MODEL_CONFIG` (ollama declares no tiers).
 */

afterEach(() => resetSessionModelSettingsSnapshot())

// Anthropic ladder ids (asserted in nexus-model-config.test.ts).
const HAIKU = 'claude-haiku-4-5'
const SONNET = 'claude-sonnet-5-5'
const FABLE = 'claude-fable-5-1'

describe('resolveModelTier — tool-call tier only (no policy)', () => {
  it('no tier → none (frontmatter/inherit decides downstream)', () => {
    expect(resolveModelTier(undefined, 'anthropic', SONNET)).toEqual({
      kind: 'none',
    })
  })

  it('a tier resolving to a DIFFERENT model → resolved', () => {
    // parent = sonnet; fast → haiku (different) → resolved.
    expect(resolveModelTier('fast', 'anthropic', SONNET)).toEqual({
      kind: 'resolved',
      modelId: HAIKU,
      providerId: 'anthropic',
    })
    expect(resolveModelTier('best', 'anthropic', SONNET)).toEqual({
      kind: 'resolved',
      modelId: FABLE,
      providerId: 'anthropic',
    })
  })

  it('a tier resolving to the PARENT model → parent (exact-selection inherit, no third id)', () => {
    // parent = sonnet; balanced → sonnet (== parent) → parent, no note.
    expect(resolveModelTier('balanced', 'anthropic', SONNET)).toEqual({
      kind: 'parent',
    })
  })

  it('an unrecognized tier value → failed (schema enums are soft at runtime)', () => {
    const r = resolveModelTier('super', 'anthropic', SONNET)
    expect(r.kind).toBe('failed')
    if (r.kind === 'failed') expect(r.note).toContain('not recognized')
  })

  it('no active provider id → failed', () => {
    const r = resolveModelTier('fast', undefined, SONNET)
    expect(r.kind).toBe('failed')
    if (r.kind === 'failed') expect(r.note).toContain('no active provider id')
  })

  it('a tier not configured for the provider (ollama, no ladder, no pin) → failed', () => {
    const r = resolveModelTier('fast', 'ollama', 'llama3')
    expect(r.kind).toBe('failed')
    if (r.kind === 'failed') {
      expect(r.note).toContain('not configured for provider "ollama"')
    }
  })
})

describe('resolveModelTier — dictionary pin (the tier DICTIONARY)', () => {
  it('a pin redefines the tier CROSS-PROVIDER, overriding the parent ladder', () => {
    setSessionModelSettingsSnapshot({
      modelTiers: { fast: { providerId: 'deepseek', modelId: 'ds-flash' } },
    })
    expect(resolveModelTier('fast', 'anthropic', SONNET)).toEqual({
      kind: 'resolved',
      modelId: 'ds-flash',
      providerId: 'deepseek',
    })
  })

  it('a pin RESCUES an otherwise-unconfigured provider (ollama has no ladder)', () => {
    // Without the pin this is `failed` (previous describe). The pin makes the
    // tier "configured" via getModelTierPin — the other half of the check.
    setSessionModelSettingsSnapshot({
      modelTiers: { fast: { providerId: 'deepseek', modelId: 'ds-flash' } },
    })
    expect(resolveModelTier('fast', 'ollama', 'llama3')).toEqual({
      kind: 'resolved',
      modelId: 'ds-flash',
      providerId: 'deepseek',
    })
  })

  it('a pin carrying a thinkingTier surfaces it on the resolved candidate', () => {
    setSessionModelSettingsSnapshot({
      modelTiers: {
        best: { providerId: 'deepseek', modelId: 'ds-pro', thinkingTier: 'high' },
      },
    })
    expect(resolveModelTier('best', 'anthropic', SONNET)).toEqual({
      kind: 'resolved',
      modelId: 'ds-pro',
      providerId: 'deepseek',
      thinkingTier: 'high',
    })
  })

  it('a pin equal to the parent short-circuits to parent (no override)', () => {
    setSessionModelSettingsSnapshot({
      modelTiers: { fast: { providerId: 'anthropic', modelId: SONNET } },
    })
    expect(resolveModelTier('fast', 'anthropic', SONNET)).toEqual({
      kind: 'parent',
    })
  })
})

describe('resolveModelTier — policy `same-as-parent` (HARD pin to parent)', () => {
  it('no call-time tier → parent, NO note', () => {
    setSessionModelSettingsSnapshot({
      sessionModelPolicy: { agent_tool: { mode: 'same-as-parent' } },
    })
    expect(resolveModelTier(undefined, 'anthropic', SONNET)).toEqual({
      kind: 'parent',
    })
  })

  it('WITH a call-time tier → parent + note (the model is told its tier lost)', () => {
    setSessionModelSettingsSnapshot({
      sessionModelPolicy: { agent_tool: { mode: 'same-as-parent' } },
    })
    const r = resolveModelTier('best', 'anthropic', SONNET)
    expect(r.kind).toBe('parent')
    if (r.kind === 'parent') {
      expect(r.note).toContain('same as parent')
      expect(r.note).toContain('"best"')
    }
  })
})

describe('resolveModelTier — policy `specific` (HARD cross-provider pin)', () => {
  it('≠ parent, NO call-time tier → resolved, NO note', () => {
    setSessionModelSettingsSnapshot({
      sessionModelPolicy: {
        agent_tool: {
          mode: 'specific',
          providerId: 'deepseek',
          modelId: 'ds-flash',
        },
      },
    })
    expect(resolveModelTier(undefined, 'anthropic', SONNET)).toEqual({
      kind: 'resolved',
      modelId: 'ds-flash',
      providerId: 'deepseek',
    })
  })

  it('≠ parent, WITH call-time tier → resolved + note (hard pin beats the tier)', () => {
    setSessionModelSettingsSnapshot({
      sessionModelPolicy: {
        agent_tool: {
          mode: 'specific',
          providerId: 'deepseek',
          modelId: 'ds-flash',
          thinkingTier: 'high',
        },
      },
    })
    const r = resolveModelTier('fast', 'anthropic', SONNET)
    expect(r).toMatchObject({
      kind: 'resolved',
      modelId: 'ds-flash',
      providerId: 'deepseek',
      thinkingTier: 'high',
    })
    if (r.kind === 'resolved') {
      expect(r.note).toContain('overridden by the user')
      expect(r.note).toContain('deepseek/ds-flash')
    }
  })

  it('a specific pin EQUAL to the parent → parent (no override), note only when a tier was requested', () => {
    setSessionModelSettingsSnapshot({
      sessionModelPolicy: {
        agent_tool: { mode: 'specific', providerId: 'anthropic', modelId: SONNET },
      },
    })
    // No tier → plain parent, no note.
    expect(resolveModelTier(undefined, 'anthropic', SONNET)).toEqual({
      kind: 'parent',
    })
    // With a tier → parent + the "overridden" note.
    const r = resolveModelTier('fast', 'anthropic', SONNET)
    expect(r.kind).toBe('parent')
    if (r.kind === 'parent') expect(r.note).toContain('overridden by the user')
  })
})

describe('resolveModelTier — policy `tier` (SOFT route)', () => {
  it('fills in when the call carries NO tier', () => {
    setSessionModelSettingsSnapshot({
      sessionModelPolicy: { agent_tool: { mode: 'tier', tier: 'best' } },
    })
    // parent = sonnet; best → fable → resolved.
    expect(resolveModelTier(undefined, 'anthropic', SONNET)).toEqual({
      kind: 'resolved',
      modelId: FABLE,
      providerId: 'anthropic',
    })
  })

  it('YIELDS to an explicit call-time tier (the per-call judgment wins)', () => {
    setSessionModelSettingsSnapshot({
      sessionModelPolicy: { agent_tool: { mode: 'tier', tier: 'best' } },
    })
    // call-time 'fast' beats the policy's 'best'.
    expect(resolveModelTier('fast', 'anthropic', SONNET)).toEqual({
      kind: 'resolved',
      modelId: HAIKU,
      providerId: 'anthropic',
    })
  })

  it('reads the DICTIONARY when the routed tier is pinned', () => {
    setSessionModelSettingsSnapshot({
      modelTiers: { fast: { providerId: 'deepseek', modelId: 'ds-flash' } },
      sessionModelPolicy: { agent_tool: { mode: 'tier', tier: 'fast' } },
    })
    expect(resolveModelTier(undefined, 'anthropic', SONNET)).toEqual({
      kind: 'resolved',
      modelId: 'ds-flash',
      providerId: 'deepseek',
    })
  })

  it('a soft tier that is unconfigured for the provider → failed', () => {
    setSessionModelSettingsSnapshot({
      sessionModelPolicy: { agent_tool: { mode: 'tier', tier: 'fast' } },
    })
    const r = resolveModelTier(undefined, 'ollama', 'llama3')
    expect(r.kind).toBe('failed')
  })
})

describe('resolveModelTier — policy `default` behaves exactly like no policy', () => {
  it('an explicit {mode:"default"} does not disturb tier/none resolution', () => {
    setSessionModelSettingsSnapshot({
      sessionModelPolicy: { agent_tool: { mode: 'default' } },
    })
    expect(resolveModelTier(undefined, 'anthropic', SONNET)).toEqual({
      kind: 'none',
    })
    expect(resolveModelTier('fast', 'anthropic', SONNET)).toEqual({
      kind: 'resolved',
      modelId: HAIKU,
      providerId: 'anthropic',
    })
  })
})

describe('Auto tiers with no ladder and nothing to borrow — the session model at the tier effort', () => {
  // A gateway names no ladder (its starter models are the user's to remove).
  // With a listing it borrows the session model's vendor ladder
  // (gateway-tier-ladder.test.ts); here NO listing is published, so a tier
  // means the parent's own model, spread over its efforts. The
  // listing writes its rows into the catalog in place; mirror that here.
  const OPENROUTER = NEXUS_MODEL_CONFIG.providers.find(p => p.providerId === 'openrouter')!
  const GPT = 'openai/gpt-6-astra'
  const ONE = 'z-ai/glm-5'
  const PLAIN = 'meta/llama-chat'
  const savedModels = OPENROUTER.models
  beforeEach(() => {
    OPENROUTER.models = [
      { model: /^openai\/gpt-6-astra$/, availableThinkingTiers: ['none', 'minimal', 'low', 'medium', 'high', 'extra-high'] },
      { model: /^z-ai\/glm-5$/, availableThinkingTiers: ['high'] },
      { model: /^meta\/llama-chat$/ },
    ]
  })
  afterEach(() => {
    OPENROUTER.models = savedModels
  })

  it('autoTierThinkingTier: fast = lowest, best = highest, balanced = medium or the middle; none never', () => {
    const all = ['none', 'minimal', 'low', 'medium', 'high', 'extra-high', 'max']
    expect(autoTierThinkingTier('fast', all)).toBe('minimal')
    expect(autoTierThinkingTier('balanced', all)).toBe('medium')
    expect(autoTierThinkingTier('best', all)).toBe('max')
    // No `medium`: the middle effort (the lower of two).
    expect(autoTierThinkingTier('balanced', ['low', 'high'])).toBe('low')
    expect(autoTierThinkingTier('balanced', ['minimal', 'high', 'max'])).toBe('high')
    // One effort: every tier runs at it.
    for (const tier of ['fast', 'balanced', 'best'] as const) {
      expect(autoTierThinkingTier(tier, ['high'])).toBe('high')
      expect(autoTierThinkingTier(tier, ['none'])).toBeUndefined()
      expect(autoTierThinkingTier(tier, undefined)).toBeUndefined()
    }
  })

  it('autoTierThinkingTier keeps a row\'s own `xhigh` spelling, ranked as extra-high', () => {
    // The OpenAI / ChatGPT Pro rows write the wire's `xhigh`.
    expect(autoTierThinkingTier('best', ['medium', 'high', 'xhigh'])).toBe('xhigh')
    expect(autoTierThinkingTier('fast', ['xhigh'])).toBe('xhigh')
    expect(autoTierThinkingTier('best', ['low', 'medium', 'high', 'xhigh', 'max'])).toBe('max')
    expect(autoTierThinkingTier('fast', ['none', 'low', 'xhigh'])).toBe('low')
  })

  it('with no listing the gateway never resolves a tier to another model — its starter picks are not a ladder', () => {
    expect(getTierModelForProvider('openrouter', 'fast')).toBeUndefined()
    expect(getModelForSessionType('session_title', 'openrouter', GPT)).toEqual([
      { providerId: 'openrouter', modelId: GPT, thinkingTier: 'minimal' },
    ])
    expect(getModelForSessionType('memory_recall', 'openrouter', GPT)).toEqual([
      { providerId: 'openrouter', modelId: GPT, thinkingTier: 'medium' },
    ])
    expect(topTierModel('openrouter', GPT, 'agent_tool')).toEqual([
      { providerId: 'openrouter', modelId: GPT, thinkingTier: 'extra-high' },
    ])
    expect(getFastModel('openrouter', ONE, 'other')).toEqual([
      { providerId: 'openrouter', modelId: ONE, thinkingTier: 'high' },
    ])
    // A model stating no efforts inherits exactly, as before.
    expect(getFastModel('openrouter', PLAIN, 'other')).toEqual([
      { providerId: 'openrouter', modelId: PLAIN },
    ])
  })

  it('the Agent tool runs the tier as the parent model at that effort', () => {
    expect(resolveModelTier('fast', 'openrouter', GPT)).toEqual({
      kind: 'resolved',
      modelId: GPT,
      providerId: 'openrouter',
      thinkingTier: 'minimal',
    })
    expect(resolveModelTier('best', 'openrouter', ONE)).toEqual({
      kind: 'resolved',
      modelId: ONE,
      providerId: 'openrouter',
      thinkingTier: 'high',
    })
    const r = resolveModelTier('fast', 'openrouter', PLAIN)
    expect(r.kind).toBe('failed')
    if (r.kind === 'failed') expect(r.note).toContain('not configured for provider "openrouter"')
  })

  it('a user pin still wins over the effort fallback', () => {
    setSessionModelSettingsSnapshot({
      modelTiers: { fast: { providerId: 'deepseek', modelId: 'ds-flash' } },
    })
    expect(resolveModelTier('fast', 'openrouter', GPT)).toEqual({
      kind: 'resolved',
      modelId: 'ds-flash',
      providerId: 'deepseek',
    })
  })
})
