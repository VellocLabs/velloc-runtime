// Auto tiers on a provider with no ladder (a gateway, a custom endpoint) are borrowed from the session model's
// vendor under the same provider and vendor prefix (models/borrowedTierLadder.ts). Chain, first that names a
// model: user pin → own ladder → borrowed ladder → session model at the tier's effort → session model.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BrowserLlmCatalog } from '../browser/bridge/protocol/nexus_llm'
import { sessionModelsHandlers } from '../browser/bridge/adapter/sessionModelsBridgeAdapter'
import { NEXUS_MODEL_CONFIG } from '../config/nexusModelConfig'
import {
  recordEntryResolution,
  resetEntryResolutions,
} from '../config/nexusModelConfig/modelEntryResolution'
import {
  providerModelName,
  providerModelPool,
  publishCatalogModelPool,
  publishListedModelPool,
  resetProviderModelPool,
} from '../config/nexusModelConfig/providerModelPool'
import { parseModelVersion } from '../config/nexusModelConfig/providers/shared/modelVersions'
import type { NexusModelConfig } from '../config/nexusModelConfig/types'
import { resolveSelection } from '../browser/worker/modelSelection'
import { resolveModelTier } from '../toolkit/builtin/subagentLaunch'
import {
  getAutoTierModel,
  getBalancedModel,
  topTierModel,
  getFastModel,
  getModelForSessionType,
  getTierModelForProvider,
} from '../engine/contextWindow'
import { borrowTierModel } from '../models/borrowedTierLadder'
import {
  resetSessionModelSettingsSnapshot,
  setSessionModelSettingsSnapshot,
} from '../models/tierSettingsSnapshot'
import gatewayIds from './fixtures/gateway-model-ids.json'

const OR = 'openrouter'
const VC = 'vercel-ai-gateway'
const LISTINGS: Record<string, string[]> = { [OR]: gatewayIds.openrouter, [VC]: gatewayIds['vercel-ai-gateway'] }
const TIERS = ['fast', 'balanced', 'best'] as const

const list = (providerId: string, ids: readonly string[]) =>
  publishListedModelPool(providerId, ids.map(id => ({ id })))
const prefixOf = (id: string): string => id.slice(0, id.lastIndexOf('/') + 1)

/** [fast, balanced, best] as model ids; undefined = no other model. */
const auto = (providerId: string, sessionModelId: string, config?: NexusModelConfig) =>
  TIERS.map(tier => getAutoTierModel(providerId, sessionModelId, tier, config))

afterEach(() => {
  resetProviderModelPool()
  resetEntryResolutions()
  resetSessionModelSettingsSnapshot()
})

describe('providerModelPool — everything a provider can run', () => {
  const catalog = (models: BrowserLlmCatalog['providers'][number]['models'], id = 'custom-x'): BrowserLlmCatalog =>
    ({ providers: [{ id, label: id, iconSvg: '', enabled: true, models }] }) as BrowserLlmCatalog

  it('a listing is adopted whole, with the names it states', () => {
    publishListedModelPool(OR, [{ id: 'a/b-1', name: 'B One' }, { id: 'a/b-2' }])
    expect(providerModelPool(OR)).toEqual(['a/b-1', 'a/b-2'])
    expect(providerModelName(OR, 'a/b-1')).toBe('B One')
    expect(providerModelName(OR, 'a/b-2')).toBeUndefined()
    expect(providerModelPool('nope')).toEqual([])
  })

  it('a catalog gives every enabled, tool-capable row — an entry as the model it resolves to, hidden rows too', () => {
    publishCatalogModelPool(catalog([
      { id: 'm-*@latest', label: 'M', enabled: true, entry: { kind: 'latest', family: 'm-*', familyLabel: 'M', version: 'latest', resolvedId: 'm-3', resolvedLabel: 'M 3', preview: false } },
      { id: 'm-3', label: 'M 3', enabled: true, pickerAliasId: 'm-*@latest' }, // the same model, hidden
      { id: 'm-2', label: 'M 2', enabled: true, pickerAliasId: 'm-*@2' },
      { id: 'off', label: 'Off', enabled: false },
      { id: 'no-tools', label: 'No tools', enabled: true, supportsTools: false },
    ]))
    expect(providerModelPool('custom-x')).toEqual(['m-3', 'm-2'])
    expect(providerModelName('custom-x', 'm-3')).toBe('M 3')
  })

  it('a fetched listing wins over the catalog; the catalog still serves the other providers', () => {
    list(OR, ['a/b-1', 'a/b-2', 'a/b-3'])
    publishCatalogModelPool({
      providers: [
        ...catalog([{ id: 'a/b-1', label: 'B', enabled: true }], OR).providers,
        ...catalog([{ id: 'x-1', label: 'X', enabled: true }]).providers,
      ],
    } as BrowserLlmCatalog)
    expect(providerModelPool(OR)).toEqual(['a/b-1', 'a/b-2', 'a/b-3'])
    expect(providerModelPool('custom-x')).toEqual(['x-1'])
  })

  it('an empty or null catalog is ignored; a provider that lost its rows loses its pool', () => {
    publishCatalogModelPool(catalog([{ id: 'x-1', label: 'X', enabled: true }]))
    publishCatalogModelPool(null)
    publishCatalogModelPool({ providers: [] } as unknown as BrowserLlmCatalog)
    expect(providerModelPool('custom-x')).toEqual(['x-1'])
    publishCatalogModelPool(catalog([]))
    expect(providerModelPool('custom-x')).toEqual([])
  })
})

// ── The scenario matrix, over the real listings ────────────────────────────

describe('the borrowed ladder over the gateways\' real listings', () => {
  beforeEach(() => {
    list(OR, LISTINGS[OR]!)
    list(VC, LISTINGS[VC]!)
  })

  // [provider, session model, fast, balanced, best] — `undefined` = no other
  // model for that tier (the session's own model runs it).
  it.each([
    // Anthropic: fast = Haiku, balanced = Sonnet, best = Fable — each line's
    // newest stable version the gateway lists.
    [OR, 'anthropic/claude-fable-5.1', 'anthropic/claude-haiku-4.5', 'anthropic/claude-sonnet-5.5', 'anthropic/claude-fable-5.1'],
    [OR, 'anthropic/claude-opus-5.5', 'anthropic/claude-haiku-4.5', 'anthropic/claude-sonnet-5.5', 'anthropic/claude-fable-5.1'],
    [VC, 'anthropic/claude-sonnet-5', 'anthropic/claude-haiku-4.5', 'anthropic/claude-sonnet-5.5', 'anthropic/claude-fable-5.1'],
    // OpenAI: Luna / Sol / Astra.
    [OR, 'openai/gpt-6-astra', 'openai/gpt-6-luna', 'openai/gpt-6.1-sol', 'openai/gpt-6-astra'],
    [VC, 'openai/gpt-5.6-sol', 'openai/gpt-6-luna', 'openai/gpt-6.1-sol', 'openai/gpt-6-astra'],
    // Google: balanced is a FIXED id (3.6 Flash) — that very version; best is
    // the Pro family's newest STABLE version (3.1 Pro is preview-only).
    [OR, 'google/gemini-3.8-flash', 'google/gemini-3.5-flash-lite', 'google/gemini-3.6-flash', 'google/gemini-2.5-pro'],
    [VC, 'google/gemini-2.5-pro', 'google/gemini-3.5-flash-lite', 'google/gemini-3.6-flash', 'google/gemini-2.5-pro'],
    // GLM: one vendor, a different prefix on each gateway — the session's own
    // prefix is what is searched, no vendor-name table is involved.
    [OR, 'z-ai/glm-5.3', 'z-ai/glm-5.3-flash', 'z-ai/glm-5.2', 'z-ai/glm-5.3'],
    [VC, 'zai/glm-5.1', 'zai/glm-5.3-flash', 'zai/glm-5.2', 'zai/glm-5.3'],
    // Qwen: `qwen/` vs `alibaba/`; OpenRouter lists 3.8 Max only as a dated
    // snapshot, which is then the id.
    [OR, 'qwen/qwen3.7-max', 'qwen/qwen3.8-flash', 'qwen/qwen3.7-max', 'qwen/qwen3.8-max-0902'],
    [VC, 'alibaba/qwen3.8-flash', 'alibaba/qwen3.8-flash', 'alibaba/qwen3.7-max', 'alibaba/qwen3.8-max'],
    // MiniMax: the vendor writes `MiniMax-M3`, the gateways `minimax-m3`.
    [OR, 'minimax/minimax-m3', 'minimax/minimax-m2.7', 'minimax/minimax-m2.7', 'minimax/minimax-m3'],
    // DeepSeek: the gateways list the Pro line but no `deepseek-flash` — a
    // partial ladder: best is borrowed, fast and balanced are not.
    [OR, 'deepseek/deepseek-v4-pro', undefined, undefined, 'deepseek/deepseek-v4-pro'],
  ] as const)('%s on %s → fast %s, balanced %s, best %s', (providerId, session, fast, balanced, best) => {
    expect(LISTINGS[providerId], 'the session model is listed').toContain(session)
    expect(auto(providerId, session)).toEqual([fast, balanced, best])
    for (const id of [fast, balanced, best]) if (id) expect(LISTINGS[providerId]).toContain(id)
  })

  it.each([
    [OR, 'meta-llama/llama-4-maverick', 'no first-party table owns the family'],
    [OR, 'moonshotai/kimi-k2.5', 'Kimi\'s gateway ids are not the Kimi Code ids'],
    [OR, 'anthropic/claude-opus-5.5-fast', 'a variant is another family'],
    [OR, 'openrouter/auto', 'the gateway\'s own router'],
    [VC, 'xai/grok-4', 'no first-party table'],
  ])('%s on %s borrows nothing: %s', (providerId, session) => {
    expect(auto(providerId, session)).toEqual([undefined, undefined, undefined])
  })

  it('a `:free` variant is its own family and borrows nothing', () => {
    const free = LISTINGS[OR]!.find(id => id.endsWith(':free'))!
    expect(auto(OR, free)).toEqual([undefined, undefined, undefined])
  })

  // INVARIANTS — every listed model of both gateways × every tier.
  it('never leaves the provider, the prefix or the listing; never names a family key', () => {
    let borrowed = 0
    for (const [providerId, ids] of Object.entries(LISTINGS)) {
      const pool = new Set(ids)
      for (const session of ids) {
        for (const tier of TIERS) {
          const id = borrowTierModel(providerId, session, tier, NEXUS_MODEL_CONFIG)
          if (id === undefined) continue
          borrowed += 1
          const at = `${providerId} ${session} ${tier} → ${id}`
          expect(pool.has(id), at).toBe(true)
          expect(prefixOf(id), at).toBe(prefixOf(session))
          expect(id.includes('*') || id.includes('@'), at).toBe(false)
          // A borrowed model is never a preview: `latest` is stable-only and
          // no first-party ladder pins a preview.
          expect(parseModelVersion(id).preview, at).toBe(false)
        }
      }
    }
    // The matrix is not vacuous: hundreds of (model, tier) pairs resolve.
    expect(borrowed).toBeGreaterThan(300)
  })

  it('the candidates a child session gets: the borrowed model then the session model, never a third', () => {
    for (const [providerId, ids] of Object.entries(LISTINGS)) {
      for (const session of ids) {
        for (const helper of [getFastModel, getBalancedModel, topTierModel]) {
          const candidates = helper(providerId, session, 'agent_tool')
          const at = `${providerId} ${session}`
          expect(candidates.length === 1 || candidates.length === 2, at).toBe(true)
          expect(candidates.every(c => c.providerId === providerId), at).toBe(true)
          expect(candidates[candidates.length - 1]!.modelId, at).toBe(session)
          if (candidates.length === 2) expect(candidates[0]!.modelId, at).not.toBe(session)
        }
      }
    }
  })

  it('a session already on the tier\'s model gets itself alone', () => {
    expect(topTierModel(OR, 'anthropic/claude-fable-5.1', 'agent_tool')).toEqual([
      { providerId: OR, modelId: 'anthropic/claude-fable-5.1' },
    ])
    expect(getFastModel(OR, 'anthropic/claude-fable-5.1', 'agent_tool')).toEqual([
      { providerId: OR, modelId: 'anthropic/claude-haiku-4.5' },
      { providerId: OR, modelId: 'anthropic/claude-fable-5.1' },
    ])
  })

  it('every side call goes through it (the per-session-type policy)', () => {
    expect(getModelForSessionType('session_title', OR, 'openai/gpt-6-astra')[0])
      .toEqual({ providerId: OR, modelId: 'openai/gpt-6-luna' })
    expect(getModelForSessionType('memory_recall', OR, 'openai/gpt-6-astra')[0])
      .toEqual({ providerId: OR, modelId: 'openai/gpt-6.1-sol' })
    // `compact` inherits by policy: no tier, no borrowing.
    expect(getModelForSessionType('compact', OR, 'openai/gpt-6-astra'))
      .toEqual([{ providerId: OR, modelId: 'openai/gpt-6-astra' }])
  })
})

// ── The chain, and its edges (synthetic pools) ─────────────────────────────

describe('the Auto chain', () => {
  it('a user pin wins over a borrowed ladder', () => {
    list(OR, LISTINGS[OR]!)
    setSessionModelSettingsSnapshot({ modelTiers: { fast: { providerId: 'deepseek', modelId: 'deepseek-flash' } } })
    expect(getFastModel(OR, 'anthropic/claude-fable-5.1', 'agent_tool')[0])
      .toEqual({ providerId: 'deepseek', modelId: 'deepseek-flash' })
    // Auto itself (what the pin replaced) is unchanged, and the other tiers still borrow.
    expect(getAutoTierModel(OR, 'anthropic/claude-fable-5.1', 'fast')).toBe('anthropic/claude-haiku-4.5')
    expect(topTierModel(OR, 'anthropic/claude-opus-5.5', 'agent_tool')[0]!.modelId).toBe('anthropic/claude-fable-5.1')
  })

  it('a provider with a ladder of its own never borrows — even with a pool that would allow it', () => {
    list('anthropic', ['claude-fable-5-1', 'claude-haiku-9', 'gpt-6-luna'])
    expect(auto('anthropic', 'claude-fable-5-1')).toEqual(['claude-haiku-4-5', 'claude-sonnet-5-5', 'claude-fable-5-1'])
    // deepseek declares all three: `deepseek-flash` twice, never borrowed.
    list('deepseek', ['deepseek-flash', 'gpt-6-luna'])
    expect(auto('deepseek', 'gpt-6-luna')).toEqual(['deepseek-flash', 'deepseek-flash', 'deepseek-v4-pro'])
  })

  it('only under the session\'s own prefix: two upstreams of one family stay apart', () => {
    list(OR, [
      'a/claude-fable-5.1', 'a/claude-haiku-4.5', 'a/claude-sonnet-5',
      'b/claude-fable-5.1', 'b/claude-haiku-5',
      'c/claude-fable-5.1',
    ])
    expect(auto(OR, 'a/claude-fable-5.1')).toEqual(['a/claude-haiku-4.5', 'a/claude-sonnet-5', 'a/claude-fable-5.1'])
    // `b` lists a newer Haiku and no Sonnet: its own Haiku, no balanced.
    expect(auto(OR, 'b/claude-fable-5.1')).toEqual(['b/claude-haiku-5', undefined, 'b/claude-fable-5.1'])
    // `c` lists Fable only: nothing is taken from `a` or `b`.
    expect(auto(OR, 'c/claude-fable-5.1')).toEqual([undefined, undefined, 'c/claude-fable-5.1'])
  })

  it('a custom endpoint with bare ids borrows by the same rule (the empty prefix)', () => {
    list('custom-openai', ['claude-fable-5-1', 'claude-haiku-4-5-20251001', 'gpt-6-sol', 'gpt-5.6-luna'])
    // The dated snapshot is the only Haiku listed: that id.
    expect(auto('custom-openai', 'claude-fable-5-1')).toEqual(['claude-haiku-4-5-20251001', undefined, 'claude-fable-5-1'])
    expect(auto('custom-openai', 'gpt-6-sol')).toEqual(['gpt-5.6-luna', 'gpt-6-sol', undefined])
    // A bare id never takes a prefixed sibling, or the reverse.
    list('custom-openai', ['claude-fable-5-1', 'anthropic/claude-haiku-4.5'])
    expect(auto('custom-openai', 'claude-fable-5-1')[0]).toBeUndefined()
  })

  it('the pool comes from the catalog for a provider without a listing', () => {
    publishCatalogModelPool({
      providers: [{
        id: 'custom-abc', label: 'Relay', iconSvg: '', enabled: true,
        models: [
          { id: 'claude-opus-5-5', label: 'Opus', enabled: true },
          { id: 'claude-haiku-4-5', label: 'Haiku', enabled: true },
        ],
      }],
    } as BrowserLlmCatalog)
    expect(auto('custom-abc', 'claude-opus-5-5')).toEqual(['claude-haiku-4-5', undefined, undefined])
  })

  it('the owner row\'s version range bounds what is borrowed', () => {
    // Haiku 3 is below the Haiku row's floor (4.5): not Anthropic's fast tier.
    list(OR, ['anthropic/claude-fable-5.1', 'anthropic/claude-haiku-3'])
    expect(auto(OR, 'anthropic/claude-fable-5.1')[0]).toBeUndefined()
    list(OR, ['anthropic/claude-fable-5.1', 'anthropic/claude-haiku-3', 'anthropic/claude-haiku-4.5', 'anthropic/claude-haiku-5'])
    expect(auto(OR, 'anthropic/claude-fable-5.1')[0]).toBe('anthropic/claude-haiku-5')
    // …and a `maxVersion` on the owner row is the brake here too.
    const haiku = NEXUS_MODEL_CONFIG.providers.find(p => p.providerId === 'anthropic')!
      .models.find(row => row.family === 'claude-haiku-*')!
    haiku.maxVersion = '4.9'
    try {
      expect(auto(OR, 'anthropic/claude-fable-5.1')[0]).toBe('anthropic/claude-haiku-4.5')
    } finally {
      delete haiku.maxVersion
    }
  })

  it('Latest is the newest STABLE sibling; a preview-only line borrows nothing', () => {
    list(OR, ['anthropic/claude-fable-5.1', 'anthropic/claude-haiku-4.5', 'anthropic/claude-haiku-5-preview'])
    expect(auto(OR, 'anthropic/claude-fable-5.1')[0]).toBe('anthropic/claude-haiku-4.5')
    list(OR, ['anthropic/claude-fable-5.1', 'anthropic/claude-haiku-5-preview'])
    expect(auto(OR, 'anthropic/claude-fable-5.1')[0]).toBeUndefined()
  })

  it('a FIXED ladder id is borrowed at that very version, or not at all', () => {
    // GLM balanced is `glm-5.2`; a provider listing only 5.3 has no balanced.
    list(OR, ['z-ai/glm-5.3', 'z-ai/glm-5.3-flash'])
    expect(auto(OR, 'z-ai/glm-5.3')).toEqual(['z-ai/glm-5.3-flash', undefined, 'z-ai/glm-5.3'])
  })

  it('a session model that reads through no vendor table: an older version still names its vendor', () => {
    // Opus 4.1 is below the Opus row's floor, but the family is Anthropic's.
    list(OR, ['anthropic/claude-opus-4.1', 'anthropic/claude-haiku-4.5'])
    expect(auto(OR, 'anthropic/claude-opus-4.1')[0]).toBe('anthropic/claude-haiku-4.5')
  })

  it('two first-party tables own one family: the first in catalog order answers (openai before chatgpt-pro)', () => {
    // Both name the Luna family as fast; chatgpt-pro's row is verified at 5.6
    // and openai's at 6 — the result is the same family's Latest either way.
    list(OR, ['openai/gpt-6-sol', 'openai/gpt-5.6-luna', 'openai/gpt-6-luna'])
    expect(auto(OR, 'openai/gpt-6-sol')[0]).toBe('openai/gpt-6-luna')
    const order = NEXUS_MODEL_CONFIG.providers.map(p => p.providerId)
    expect(order.indexOf('openai')).toBeLessThan(order.indexOf('chatgpt-pro'))
  })

  it('a session selection that is a model ENTRY borrows by its family, resolved or not', () => {
    list(OR, LISTINGS[OR]!)
    // Not resolved yet (no catalog built): the entry id still names the family.
    expect(auto(OR, 'anthropic/claude-opus-*@latest')[0]).toBe('anthropic/claude-haiku-4.5')
    recordEntryResolution(OR, 'anthropic/claude-opus-*@latest', { id: 'anthropic/claude-opus-5.5', versionLabel: '5.5', preview: false })
    expect(auto(OR, 'anthropic/claude-opus-*@latest')).toEqual(['anthropic/claude-haiku-4.5', 'anthropic/claude-sonnet-5.5', 'anthropic/claude-fable-5.1'])
    // The session's entry resolving to the tier's own model is "the same model".
    recordEntryResolution(OR, 'anthropic/claude-fable-*@latest', { id: 'anthropic/claude-fable-5.1', versionLabel: '5.1', preview: false })
    expect(sessionModelsHandlers.autoTiers({ providerId: OR, modelId: 'anthropic/claude-fable-*@latest' }).tiers.best).toBeUndefined()
  })

  it('a session ENTRY resolving to the tier\'s model is the parent, not an override', () => {
    list(OR, LISTINGS[OR]!)
    const entry = 'anthropic/claude-fable-*@latest'
    recordEntryResolution(OR, entry, { id: 'anthropic/claude-fable-5.1', versionLabel: '5.1', preview: false })
    expect(topTierModel(OR, entry, 'agent_tool')).toEqual([{ providerId: OR, modelId: entry }])
    expect(resolveModelTier('best', OR, entry)).toEqual({ kind: 'parent' })
    // First-party: anthropic's fast tier is Haiku 4.5.
    const haiku = 'claude-haiku-*@latest'
    recordEntryResolution('anthropic', haiku, { id: 'claude-haiku-4-5', versionLabel: '4.5', preview: false })
    expect(getFastModel('anthropic', haiku, 'agent_tool')).toEqual([{ providerId: 'anthropic', modelId: haiku }])
  })

  describe('nothing to borrow: the session model, at the tier\'s effort when it states efforts', () => {
    const OPENROUTER = NEXUS_MODEL_CONFIG.providers.find(p => p.providerId === OR)!
    const saved = OPENROUTER.models
    beforeEach(() => {
      // The listing writes its rows into the catalog in place; mirror that.
      OPENROUTER.models = [
        { model: /^meta\/llama-chat$/, availableThinkingTiers: ['low', 'medium', 'high'] },
        { model: /^meta\/llama-plain$/ },
        { model: /^anthropic\/claude-fable-5\.1$/, availableThinkingTiers: ['low', 'high', 'max'] },
      ]
    })
    afterEach(() => {
      OPENROUTER.models = saved
    })

    it('before the listing arrives (no pool) — then the same call borrows', () => {
      const session = 'anthropic/claude-fable-5.1'
      expect(getFastModel(OR, session, 'other')).toEqual([{ providerId: OR, modelId: session, thinkingTier: 'low' }])
      list(OR, [session, 'anthropic/claude-haiku-4.5'])
      expect(getFastModel(OR, session, 'other')).toEqual([
        { providerId: OR, modelId: 'anthropic/claude-haiku-4.5' },
        { providerId: OR, modelId: session },
      ])
    })

    it('a model no vendor table owns', () => {
      list(OR, ['meta/llama-chat', 'meta/llama-plain', 'anthropic/claude-haiku-4.5'])
      expect(getFastModel(OR, 'meta/llama-chat', 'other')).toEqual([{ providerId: OR, modelId: 'meta/llama-chat', thinkingTier: 'low' }])
      expect(topTierModel(OR, 'meta/llama-chat', 'other')).toEqual([{ providerId: OR, modelId: 'meta/llama-chat', thinkingTier: 'high' }])
      // No efforts stated: the session model exactly.
      expect(getFastModel(OR, 'meta/llama-plain', 'other')).toEqual([{ providerId: OR, modelId: 'meta/llama-plain' }])
    })

    it('a partial ladder: the tiers that are not found fall back one by one', () => {
      list(OR, ['anthropic/claude-fable-5.1', 'anthropic/claude-haiku-4.5'])
      const session = 'anthropic/claude-fable-5.1'
      expect(getFastModel(OR, session, 'other')[0]!.modelId).toBe('anthropic/claude-haiku-4.5')
      // No Sonnet listed: balanced is the session model at its middle effort.
      expect(getBalancedModel(OR, session, 'other')).toEqual([{ providerId: OR, modelId: session, thinkingTier: 'high' }])
    })
  })
})

// ── The consumers ──────────────────────────────────────────────────────────

describe('the Agent tool and the Settings page see the borrowed ladder', () => {
  beforeEach(() => list(OR, LISTINGS[OR]!))

  it('a borrowed tier is a configured tier: the sub-agent runs it, with no "not configured" note', () => {
    expect(getTierModelForProvider(OR, 'fast')).toBeUndefined() // the gateway declares none
    expect(resolveModelTier('fast', OR, 'anthropic/claude-opus-5.5')).toEqual({
      kind: 'resolved',
      modelId: 'anthropic/claude-haiku-4.5',
      providerId: OR,
    })
    // The session is already on the tier's model: the parent, no override.
    expect(resolveModelTier('best', OR, 'anthropic/claude-fable-5.1')).toEqual({ kind: 'parent' })
    // Nothing to borrow and no efforts: still "not configured".
    const none = resolveModelTier('fast', OR, 'openrouter/auto')
    expect(none.kind).toBe('failed')
  })

  it('`sessionModels/autoTiers` names the other model per tier, and leaves out the session\'s own', () => {
    publishListedModelPool(OR, [
      { id: 'anthropic/claude-opus-5.5', name: 'Claude Opus 5.5' },
      { id: 'anthropic/claude-haiku-4.5', name: 'Claude Haiku 4.5' },
      { id: 'anthropic/claude-fable-5.1' },
    ])
    expect(sessionModelsHandlers.autoTiers({ providerId: OR, modelId: 'anthropic/claude-opus-5.5' })).toEqual({
      tiers: {
        fast: { modelId: 'anthropic/claude-haiku-4.5', label: 'Claude Haiku 4.5' },
        best: { modelId: 'anthropic/claude-fable-5.1' }, // no name listed
        // balanced: no Sonnet listed → the session's own model → absent
      },
    })
    expect(sessionModelsHandlers.autoTiers({ providerId: OR, modelId: 'anthropic/claude-fable-5.1' }).tiers)
      .toEqual({ fast: { modelId: 'anthropic/claude-haiku-4.5', label: 'Claude Haiku 4.5' } })
    // A first-party provider answers with its own ladder.
    expect(sessionModelsHandlers.autoTiers({ providerId: 'anthropic', modelId: 'claude-sonnet-5-5' }).tiers).toEqual({
      fast: { modelId: 'claude-haiku-4-5' },
      best: { modelId: 'claude-fable-5-1' },
    })
    expect(sessionModelsHandlers.autoTiers({ providerId: 'ollama', modelId: 'qwen3.5' }).tiers).toEqual({})
  })
})

describe('a sub-agent spawned on a borrowed tier runs it', () => {
  // A gateway's catalog rows are only the user's entries; the borrowed tier
  // comes from the whole pool. The worker's spawn resolution must admit it
  // rather than fall back to the parent's model.
  const catalog = {
    providers: [{
      id: OR,
      label: 'OpenRouter',
      iconSvg: '',
      enabled: true,
      models: [{ id: 'anthropic/claude-opus-5.5', label: 'Opus', enabled: true }],
    }],
  } as unknown as BrowserLlmCatalog
  const parent = { providerId: OR, modelId: 'anthropic/claude-opus-5.5' }

  it('a requested pooled model wins over the parent fallback', () => {
    list(OR, ['anthropic/claude-opus-5.5', 'anthropic/claude-haiku-4.5'])
    const tier = resolveModelTier('fast', OR, 'anthropic/claude-opus-5.5')
    expect(tier).toMatchObject({ kind: 'resolved', modelId: 'anthropic/claude-haiku-4.5' })
    const requested = { providerId: OR, modelId: 'anthropic/claude-haiku-4.5' }
    expect(resolveSelection(catalog, { requestedSelection: requested, fallbackSelection: parent }))
      .toEqual(requested)
  })

  it('a model outside the pool, or a persisted one, still falls back', () => {
    list(OR, ['anthropic/claude-opus-5.5'])
    const requested = { providerId: OR, modelId: 'anthropic/claude-haiku-4.5' }
    expect(resolveSelection(catalog, { requestedSelection: requested, fallbackSelection: parent }))
      .toEqual(parent)
    list(OR, ['anthropic/claude-opus-5.5', 'anthropic/claude-haiku-4.5'])
    expect(resolveSelection(catalog, { persistedSelection: requested, fallbackSelection: parent }))
      .toEqual(parent)
  })
})
