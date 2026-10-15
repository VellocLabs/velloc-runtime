// Providers as directories with one uniform interface, and the two runtime-only
// gateways built on it (OpenRouter, the Vercel AI Gateway): the definitions,
// each provider's own listing / usage parsers, the provider-neutral document
// fetch, the user's model entries and their reconciliation, the usage service,
// the transport interceptor, and the settings actions.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserBridgeTransport } from '../browser/bridge/browserBridgeProtocol'
import {
  handleDismissRemoved,
  handleFreshModelIds,
  handleModelFamilies,
  handleVerify,
} from '../browser/bridge/adapter/providersBridgeAdapter'
import { NEXUS_MODEL_CONFIG, buildThinkingBodyExtension } from '../config/nexusModelConfig'
import { listedFigures } from '../config/nexusModelConfig/familyRows'
import { BrowserHostBridge } from '../browser/bridge/BrowserHostBridge'
import { __resetEndpointTrustForTest } from '../models/endpoints/endpointTrust'
import { resolveDriverBaseUrl } from '../models/drivers/driverRegistry'
import {
  getProviderDefinition,
  BUILTIN_PROVIDER_DEFINITIONS as PROVIDER_DEFINITIONS,
} from '../config/nexusModelConfig/providers'
import { isBatchOnlyId, modelName, openrouterModels } from '../config/nexusModelConfig/providers/openrouter/models'
import {
  nextUtcBoundary,
  openrouterBalance,
  openrouterUsage,
} from '../config/nexusModelConfig/providers/openrouter/usage'
import { withProviderSecretMirror } from '../config/providerSecrets'
import { providerSecretFields } from '../models/drivers/driverRegistry'
import { reasoningObject } from '../config/nexusModelConfig/providers/shared/reasoningObject'
import { vercelModels } from '../config/nexusModelConfig/providers/vercelAiGateway/models'
import { vercelUsage } from '../config/nexusModelConfig/providers/vercelAiGateway/usage'
import { resolveModelRequestFields } from '../engine/turn/modelRequestFields'
import { isOfficialEndpointUrl } from '../models/endpoints/officialEndpoints'
import { withModelProviders } from '../models/drivers/driverTransport'
import { openaiChatDriver } from '../models/drivers/openaiChatDriver'
import {
  fetchProviderUsage,
  listProviderModels,
  verifyProvider,
} from '../models/drivers/providerDocuments'
import {
  providerUsageState,
  refreshProviderUsage,
  resetProviderUsage,
  setProviderUsagePublisher,
  USAGE_MIN_INTERVAL_MS,
} from '../models/drivers/providerUsageService'
import { providerModelFamilies } from '../models/drivers/modelFamilies'
import { displayModelLabel, usageForModel, usageSummary } from '../config/nexusModelConfig/modelDisplay'
import { isAmountExhausted, isUsageExhausted, isWindowExhausted } from '../models/usage/planUsage'
import { isRuntimeOnlyProvider, runtimeOnlyProviderIds } from '../models/drivers/driverRegistry'
import {
  appendRuntimeProvidersToCatalog,
  configureRuntimeProviders,
  dismissRemovedNotice,
  fetchFreshModelIds,
  listRuntimeProviderModels,
  LISTING_RETRY_MS,
  overlayBuiltInListings,
  reconcileEntries,
  refreshConfiguredRuntimeProviderModels,
  refreshRuntimeProviderModels,
  resetRuntimeProviders,
  runtimeProviderCatalogRows,
  setRuntimeProviderConfigs,
  staleEntryIds,
  verifyRuntimeProvider,
  withRuntimeProviderBaseUrls,
  runtimeProviderDefaultBaseUrl,
  type RuntimeProvidersHost,
} from '../models/drivers/runtimeProviders'
import type { DriverStreamEvent } from '../models/drivers/driverTypes'
import {
  getAvailableThinkingTiersForModel,
  contextWindowOf,
  getDefaultMaxOutputTokensForModel,
  outputBudgetOf,
} from '../engine/contextWindow'
import { defaultProviderTrust } from '../settings/providerTrust'
import type { NexusProviderConfig } from '../settings/settingsTypes'

afterEach(() => {
  resetRuntimeProviders()
  resetProviderUsage()
})

const enc = new TextEncoder()
const NOW = Date.UTC(2026, 8, 30, 14, 30) // Wednesday 2026-09-30 14:30 UTC

// ── Live-shaped documents (trimmed rows of the 2026-09-30 responses) ───────
const OPENROUTER_LISTING = {
  data: [
    {
      id: 'anthropic/claude-sonnet-5.5',
      name: 'Anthropic: Claude Sonnet 5.5',
      context_length: 1_000_000,
      architecture: { input_modalities: ['text', 'image', 'file'] },
      top_provider: { context_length: 1_000_000, max_completion_tokens: 128_000 },
      supported_parameters: ['max_tokens', 'reasoning', 'tool_choice', 'tools'],
      reasoning: { mandatory: true, supported_efforts: ['max', 'xhigh', 'high', 'medium', 'low'], default_effort: 'high' },
    },
    {
      id: 'anthropic/claude-haiku-4.5',
      name: 'Anthropic: Claude Haiku 4.5',
      context_length: 200_000,
      top_provider: { max_completion_tokens: 64_000 },
      supported_parameters: ['tools'],
    },
    {
      id: 'openai/gpt-6-astra',
      name: 'OpenAI: GPT-6 Astra',
      context_length: 400_000,
      architecture: { input_modalities: ['text'] },
      top_provider: { max_completion_tokens: 16_000 },
      supported_parameters: ['reasoning', 'tools'],
      reasoning: { mandatory: false, supported_efforts: ['high', 'medium', 'low', 'minimal', 'none'] },
    },
    { id: 'z-ai/glm-5', context_length: 200_000, supported_parameters: ['reasoning', 'tools'] },
    { id: 'meta/llama-chat', context_length: 8_000, supported_parameters: ['max_tokens'] },
  ],
}

const VERCEL_LISTING = {
  object: 'list',
  data: [
    {
      id: 'anthropic/claude-sonnet-5.5',
      name: 'Claude Sonnet 5.5',
      type: 'language',
      context_window: 1_000_000,
      max_tokens: 128_000,
      tags: ['reasoning', 'tool-use', 'vision', 'file-input'],
      modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
      reasoning_options: [
        { type: 'toggle' },
        { type: 'effort', values: ['none', 'low', 'medium', 'high', 'xhigh', 'max'] },
        { type: 'budget_tokens' },
      ],
    },
    { id: 'deepseek/deepseek-v4', type: 'language', context_window: 128_000, tags: ['tool-use'], reasoning_options: [{ type: 'toggle' }] },
    { id: 'google/gemini-3-pro', type: 'language', tags: ['tool-use'], reasoning_options: [{ type: 'effort', values: ['low', 'high'] }] },
    { id: 'openai/text-embedding-4', type: 'embedding', tags: [] },
    { id: 'mistral/tiny', type: 'language', tags: [] },
  ],
}

// ── The uniform interface ─────────────────────────────────────────────────
describe('provider definitions', () => {
  it('one definition per catalog entry, in catalog order; the catalog is built from them', () => {
    expect(NEXUS_MODEL_CONFIG.providers.map(p => p.providerId))
      .toEqual(PROVIDER_DEFINITIONS.map(d => d.config.providerId))
    expect(new Set(PROVIDER_DEFINITIONS.map(d => d.config.providerId)).size).toBe(PROVIDER_DEFINITIONS.length)
    expect(getProviderDefinition('openrouter')?.config.providerId).toBe('openrouter')
    expect(getProviderDefinition('custom-abc')).toBeUndefined()
  })

  it('runtime-only = the definition lists its models: exactly the two gateways', () => {
    expect(runtimeOnlyProviderIds()).toEqual(['openrouter', 'vercel-ai-gateway'])
    expect(isRuntimeOnlyProvider('kimi')).toBe(false)
  })

  it('usage sources: OpenRouter, Vercel, Kimi — each its own document', () => {
    expect(PROVIDER_DEFINITIONS.filter(d => d.usage).map(d => [d.config.providerId, d.usage!.path]))
      .toEqual([['kimi', '/usages'], ['openrouter', '/key'], ['vercel-ai-gateway', '/credits']])
  })

  it('thinking mapping dispatches to the provider (gateways share the reasoning object)', () => {
    expect(buildThinkingBodyExtension('openrouter', 'extra-high', 1)).toEqual({ reasoning: { effort: 'xhigh' } })
    expect(buildThinkingBodyExtension('vercel-ai-gateway', 'none', 1)).toEqual({ reasoning: { effort: 'none' } })
    expect(buildThinkingBodyExtension('kimi', 'none', 1)).toEqual({ thinking: { type: 'disabled' } })
    expect(buildThinkingBodyExtension('glm', 'high', 1)).toBeUndefined()
    expect(buildThinkingBodyExtension('custom-abc', 'high', 1)).toBeUndefined()
    expect(reasoningObject('ultra', { maxOutputTokens: 1 })).toBeUndefined()
  })

  it('each gateway carries its own brand mark, and names starter models — never a tier ladder', () => {
    for (const id of ['openrouter', 'vercel-ai-gateway']) {
      const definition = getProviderDefinition(id)!
      expect(definition.iconSvg).toMatch(/^<svg[^>]*viewBox="0 0 24 24"/)
      // A ladder would run Auto tiers on models the user may never have
      // picked; with none, Auto tiers stay on the session's own model.
      expect(definition.config.fastModel).toBeUndefined()
      expect(definition.config.balancedModel).toBeUndefined()
      expect(definition.config.bestModel).toBeUndefined()
      expect(definition.config.starterModels?.length).toBeGreaterThan(0)
    }
    expect(getProviderDefinition('openrouter')!.iconSvg).not.toBe(getProviderDefinition('vercel-ai-gateway')!.iconSvg)
    // Both marks follow the theme (OpenRouter's is the user's monochrome
    // asset) — no hard-coded brand colour.
    expect(getProviderDefinition('vercel-ai-gateway')!.iconSvg).toMatch(/fill="currentColor"/)
    expect(getProviderDefinition('openrouter')!.iconSvg).toMatch(/fill="currentColor"/)
    expect(getProviderDefinition('openrouter')!.iconSvg).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
  })

  it('both gateways are trusted by default on their official hosts', () => {
    for (const id of ['openrouter', 'vercel-ai-gateway']) {
      expect(isOfficialEndpointUrl(getProviderDefinition(id)!.config.defaultBaseUrl!)).toBe(true)
      expect(defaultProviderTrust(undefined, id)).toBe('trusted')
      expect(defaultProviderTrust({ configs: { [id]: { apiKey: 'NEXUSENC1:x' } } }, id)).toBe('trusted')
    }
  })
})

// ── Each provider's own parsers ───────────────────────────────────────────
describe('model listings', () => {
  it('openrouter: tools gate, tiers in house order and spelling, mandatory drops none', () => {
    const models = openrouterModels.parse(OPENROUTER_LISTING, NOW)
    expect(models[0]).toEqual({
      id: 'anthropic/claude-sonnet-5.5',
      // The vendor lead (`Anthropic: `) is dropped: the provider groups rows.
      name: 'Claude Sonnet 5.5',
      supportsTools: true,
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      supportsImageInput: true,
      supportsPdfInput: true,
      thinkingTiers: ['low', 'medium', 'high', 'extra-high', 'max'],
      defaultThinkingTier: 'high',
    })
    expect(models[2]!.thinkingTiers).toEqual(['none', 'minimal', 'low', 'medium', 'high'])
    expect(models[3]!.thinkingTiers).toEqual(['low', 'medium', 'high'])
    expect(models[4]).toEqual({ id: 'meta/llama-chat', supportsTools: false, contextWindow: 8_000 })
    expect(() => openrouterModels.parse({ error: { message: 'x' } }, NOW)).toThrow(/no data array/)
  })

  it('openrouter: a name drops its `Vendor: ` lead; a name without one stays whole', () => {
    expect(modelName('Anthropic: Claude Sonnet 5.5')).toBe('Claude Sonnet 5.5')
    expect(modelName('OpenAI: GPT-6 Astra')).toBe('GPT-6 Astra')
    expect(modelName('Qwen: Qwen3 Coder: Exacto')).toBe('Qwen3 Coder: Exacto')
    expect(modelName('Auto Router')).toBe('Auto Router')
    expect(modelName(': nothing before')).toBe(': nothing before')
    expect(modelName('Vendor: ')).toBe('Vendor: ')
    expect(openrouterModels.parse(OPENROUTER_LISTING, NOW).map(m => m.name))
      .toEqual(['Claude Sonnet 5.5', 'Claude Haiku 4.5', 'GPT-6 Astra', undefined, undefined])
  })

  it('openrouter: free = prompt AND completion priced at zero; a missing price is not free', () => {
    const models = openrouterModels.parse(
      {
        data: [
          { id: 'a/free:free', supported_parameters: ['tools'], pricing: { prompt: '0', completion: '0' } },
          { id: 'b/half', supported_parameters: ['tools'], pricing: { prompt: '0', completion: '0.000002' } },
          { id: 'c/paid', supported_parameters: ['tools'], pricing: { prompt: '0.000001', completion: '0.000002' } },
          { id: 'd/unpriced', supported_parameters: ['tools'] },
        ],
      },
      NOW,
    )
    expect(models.map(m => m.free)).toEqual([true, undefined, undefined, undefined])
  })

  it('openrouter: a `:batch` row is dropped — chat/completions answers it with a 404', () => {
    const models = openrouterModels.parse(
      {
        data: [
          { id: 'openai/gpt-6-luna-pro', supported_parameters: ['tools'] },
          { id: 'openai/gpt-6-luna-pro:batch', name: 'OpenAI: GPT-6 Luna Pro (batch)', supported_parameters: ['tools'] },
          { id: 'anthropic/claude-sonnet-5.5:batch', supported_parameters: ['tools'] },
          { id: 'a/free:free', supported_parameters: ['tools'] },
        ],
      },
      NOW,
    )
    expect(models.map(m => m.id)).toEqual(['openai/gpt-6-luna-pro', 'a/free:free'])
    expect(isBatchOnlyId('openai/gpt-6-luna-pro:batch')).toBe(true)
    expect(isBatchOnlyId('openai/gpt-6-luna-pro')).toBe(false)
    expect(isBatchOnlyId('openai/batch-model')).toBe(false)
  })

  it('vercel: free = input AND output priced at zero', () => {
    const models = vercelModels.parse(
      {
        data: [
          { id: 'a/free', type: 'language', tags: ['tool-use'], pricing: { input: '0', output: '0' } },
          { id: 'b/half', type: 'language', tags: ['tool-use'], pricing: { input: '0', output: '0.000002' } },
          { id: 'c/unpriced', type: 'language', tags: ['tool-use'] },
        ],
      },
      NOW,
    )
    expect(models.map(m => m.free)).toEqual([true, undefined, undefined])
  })

  it('openrouter: the price per million tokens, from per-token strings; a router "-1" or no price gives none', () => {
    const models = openrouterModels.parse(
      {
        data: [
          { id: 'openai/gpt-6-luna', supported_parameters: ['tools'], pricing: { prompt: '0.0000001', completion: '0.0000005' } },
          { id: 'openai/gpt-6-luna-pro', supported_parameters: ['tools'], pricing: { prompt: '0.00000005', completion: '0.00000025' } },
          { id: 'a/free:free', supported_parameters: ['tools'], pricing: { prompt: '0', completion: '0' } },
          { id: 'openrouter/auto', supported_parameters: ['tools'], pricing: { prompt: '-1', completion: '-1' } },
          { id: 'b/half', supported_parameters: ['tools'], pricing: { prompt: '0.000001' } },
          { id: 'd/unpriced', supported_parameters: ['tools'] },
        ],
      },
      NOW,
    )
    expect(models.map(m => m.price)).toEqual([
      { input: 0.1, output: 0.5 },
      { input: 0.05, output: 0.25 },
      { input: 0, output: 0 },
      undefined,
      undefined,
      undefined,
    ])
  })

  it('vercel: the price per million tokens from input / output', () => {
    const models = vercelModels.parse(
      {
        data: [
          { id: 'anthropic/claude-sonnet-5.5', type: 'language', tags: ['tool-use'], pricing: { input: '0.000002', output: '0.00001' } },
          { id: 'c/unpriced', type: 'language', tags: ['tool-use'] },
        ],
      },
      NOW,
    )
    expect(models.map(m => m.price)).toEqual([{ input: 2, output: 10 }, undefined])
  })

  it('vercel: language rows only; tool-use tag; toggle adds none', () => {
    const models = vercelModels.parse(VERCEL_LISTING, NOW)
    expect(models.map(m => m.id)).toEqual(['anthropic/claude-sonnet-5.5', 'deepseek/deepseek-v4', 'google/gemini-3-pro', 'mistral/tiny'])
    expect(models[0]!.thinkingTiers).toEqual(['none', 'low', 'medium', 'high', 'extra-high', 'max'])
    expect(models[1]!.thinkingTiers).toEqual(['none', 'medium'])
    expect(models[2]!.thinkingTiers).toEqual(['low', 'high'])
    expect(models[3]!.supportsTools).toBe(false)
  })
})

describe('display rules — each provider its own, the page only asks', () => {
  const USAGE = {
    windows: [
      { kind: 'monthly' as const, usedPercent: 25 },
      { kind: 'daily' as const, subject: 'free_requests' as const, usedPercent: 80 },
    ],
    amounts: [{ kind: 'limit_remaining' as const, amount: 37.5, currency: 'USD' as const }],
  }

  it('openrouter: a free model drops its "(free)" — last or before a version — a paid one keeps its name', () => {
    expect(displayModelLabel('openrouter', 'Acme: Free Chat (free)', { free: true })).toBe('Acme: Free Chat')
    expect(displayModelLabel('openrouter', 'Zeta (free) 6.1', { free: true })).toBe('Zeta 6.1')
    expect(displayModelLabel('openrouter', 'Acme: Free Chat (free)', {})).toBe('Acme: Free Chat (free)')
  })

  it('openrouter: a free model is metered by the free-request quota alone, a paid one by the rest', () => {
    expect(usageForModel('openrouter', USAGE, { free: true })).toEqual({
      windows: [USAGE.windows[1]],
      amounts: undefined,
    })
    expect(usageForModel('openrouter', USAGE, {})).toEqual({ windows: [USAGE.windows[0]], amounts: USAGE.amounts })
    // A free model is not metered by the balance either: its note goes too.
    expect(usageForModel('openrouter', { ...USAGE, balanceNote: 'needs_key' }, { free: true }))
      .toEqual({ windows: [USAGE.windows[1]] })
    expect(usageForModel('openrouter', { ...USAGE, balanceNote: 'needs_key' }, {}).balanceNote).toBe('needs_key')
  })

  it('openrouter: a summary folds balance and key limit into one Available — the lower — and keeps spend', () => {
    const usd = 'USD' as const
    const spent = { kind: 'spent' as const, period: 'day' as const, amount: 0.07, currency: usd }
    const both = {
      windows: [],
      amounts: [
        { kind: 'balance' as const, amount: 12.5, currency: usd },
        { kind: 'limit_remaining' as const, amount: 99.93, currency: usd },
        spent,
      ],
    }
    expect(usageSummary('openrouter', both).amounts).toEqual([
      { kind: 'available', amount: 12.5, currency: 'USD' },
      spent,
    ])
    // The key limit is the lower bound.
    expect(usageSummary('openrouter', {
      windows: [],
      amounts: [
        { kind: 'balance', amount: 50, currency: usd },
        { kind: 'limit_remaining', amount: 3, currency: usd },
      ],
    }).amounts).toEqual([{ kind: 'available', amount: 3, currency: 'USD' }])
    // Balance alone (a key without a limit): it is what is available.
    expect(usageSummary('openrouter', {
      windows: [],
      amounts: [{ kind: 'balance', amount: 7, currency: usd }],
    }).amounts).toEqual([{ kind: 'available', amount: 7, currency: 'USD' }])
    // Balance unreadable (no management key): no Available at all — the key
    // limit alone is a cap, not money the account holds. Spend stays, the
    // note stays out.
    const noKey = usageSummary('openrouter', {
      windows: [],
      amounts: [{ kind: 'limit_remaining', amount: 99.93, currency: usd }, spent],
      balanceNote: 'needs_key',
    })
    expect(noKey.amounts).toEqual([spent])
    expect(noKey.balanceNote).toBeUndefined()
    expect(usageSummary('openrouter', {
      windows: [],
      amounts: [{ kind: 'limit_remaining', amount: 99.93, currency: usd }],
      balanceNote: 'needs_key',
    })).toEqual({ windows: [] })
    // Nothing to fold: no amounts key is invented.
    expect(usageSummary('openrouter', { windows: USAGE.windows })).toEqual({ windows: USAGE.windows })
  })

  it('a provider without rules shows the name as listed and its usage whole', () => {
    expect(getProviderDefinition('kimi')?.display).toBeUndefined()
    expect(displayModelLabel('kimi', 'Some (free)', { free: true })).toBe('Some (free)')
    expect(usageForModel('kimi', USAGE, { free: true })).toBe(USAGE)
    expect(usageSummary('kimi', USAGE)).toBe(USAGE)
    expect(displayModelLabel(undefined, 'X', {})).toBe('X')
  })
})

describe('usage exhaustion', () => {
  const usd = 'USD' as const
  it('a window is used up at 100%, not before', () => {
    expect(isWindowExhausted({ kind: 'five_hour', usedPercent: 100 })).toBe(true)
    expect(isWindowExhausted({ kind: 'weekly', usedPercent: 99.9 })).toBe(false)
  })
  it('a bounding money figure is used up at or below zero; spend never is', () => {
    expect(isAmountExhausted({ kind: 'balance', amount: 0, currency: usd })).toBe(true)
    expect(isAmountExhausted({ kind: 'balance', amount: -1, currency: usd })).toBe(true)
    expect(isAmountExhausted({ kind: 'limit_remaining', amount: 0, currency: usd })).toBe(true)
    expect(isAmountExhausted({ kind: 'available', amount: 0, currency: usd })).toBe(true)
    expect(isAmountExhausted({ kind: 'available', amount: 0.01, currency: usd })).toBe(false)
    expect(isAmountExhausted({ kind: 'spent', period: 'day', amount: 0, currency: usd })).toBe(false)
  })
  it('a snapshot is used up when any of its limits is', () => {
    expect(isUsageExhausted({ windows: [{ kind: 'weekly', usedPercent: 10 }] })).toBe(false)
    expect(isUsageExhausted({ windows: [], amounts: [{ kind: 'available', amount: 0, currency: usd }] })).toBe(true)
    expect(isUsageExhausted({ windows: [], balanceNote: 'needs_key' })).toBe(false)
  })
})

describe('usage documents', () => {
  const key = (data: Record<string, unknown>) => ({ data })

  it('openrouter: a capped key with a reset period is a window plus what is left', () => {
    expect(openrouterUsage.parse(key({
      limit: 20, limit_remaining: 15, limit_reset: 'weekly',
      usage: 40, usage_daily: 1.25, usage_weekly: 5, usage_monthly: 12.5, is_free_tier: false,
    }), NOW)).toEqual({
      windows: [{ kind: 'weekly', usedPercent: 25, resetsAt: Date.UTC(2026, 9, 5) }],
      amounts: [
        { kind: 'limit_remaining', amount: 15, currency: 'USD' },
        { kind: 'spent', amount: 1.25, currency: 'USD', period: 'day' },
        { kind: 'spent', amount: 12.5, currency: 'USD', period: 'month' },
      ],
    })
  })

  it('openrouter: no cap = spend only; the free tier shows its free-model requests', () => {
    expect(openrouterUsage.parse(key({ limit: null, usage_daily: 0, usage_monthly: 3 }), NOW)).toEqual({
      windows: [],
      amounts: [
        { kind: 'spent', amount: 0, currency: 'USD', period: 'day' },
        { kind: 'spent', amount: 3, currency: 'USD', period: 'month' },
      ],
    })
    const free = openrouterUsage.parse(key({
      limit: null, is_free_tier: true, free_model_daily_requests: { used: 40, limit: 50, remaining: 10 },
    }), NOW)
    expect(free?.windows).toEqual([
      { kind: 'daily', subject: 'free_requests', usedPercent: 80, resetsAt: Date.UTC(2026, 9, 1) },
    ])
    // A cap that never resets: what is left, no window.
    expect(openrouterUsage.parse(key({ limit: 10, limit_remaining: 4, limit_reset: null }), NOW)).toEqual({
      windows: [],
      amounts: [{ kind: 'limit_remaining', amount: 4, currency: 'USD' }],
    })
    expect(() => openrouterUsage.parse({}, NOW)).toThrow(/no data object/)
  })

  it('openrouter /credits: the account balance is purchased minus spent, and may go negative', () => {
    expect(openrouterBalance.parse(key({ total_credits: 100, total_usage: 100 }), NOW))
      .toEqual([{ kind: 'balance', amount: 0, currency: 'USD' }])
    expect(openrouterBalance.parse(key({ total_credits: 20, total_usage: 21.5 }), NOW))
      .toEqual([{ kind: 'balance', amount: -1.5, currency: 'USD' }])
    expect(() => openrouterBalance.parse({}, NOW)).toThrow(/no data object/)
    expect(() => openrouterBalance.parse(key({ total_credits: 5 }), NOW)).toThrow(/total_usage/)
    // Read with the management key, never the API key.
    expect(openrouterBalance.headers).toEqual({ authorization: 'Bearer {{secret:management_key}}' })
    expect(providerSecretFields('openrouter').map(f => f.name)).toEqual(['management_key'])
    expect(providerSecretFields('vercel-ai-gateway')).toEqual([])
  })

  it('UTC boundaries: next day, next Monday, first of next month', () => {
    expect(nextUtcBoundary('daily', NOW)).toBe(Date.UTC(2026, 9, 1))
    expect(nextUtcBoundary('weekly', NOW)).toBe(Date.UTC(2026, 9, 5))
    expect(nextUtcBoundary('weekly', Date.UTC(2026, 9, 5, 0, 0, 1))).toBe(Date.UTC(2026, 9, 12))
    expect(nextUtcBoundary('monthly', NOW)).toBe(Date.UTC(2026, 9, 1))
  })

  it('vercel: the balance and the total spend, from decimal strings', () => {
    expect(vercelUsage.parse({ balance: '95.50', total_used: '4.50' }, NOW)).toEqual({
      windows: [],
      amounts: [
        { kind: 'balance', amount: 95.5, currency: 'USD' },
        { kind: 'spent', amount: 4.5, currency: 'USD', period: 'total' },
      ],
    })
    expect(vercelUsage.parse({}, NOW)).toBeUndefined()
  })
})

// ── A scripted host: rawStream* answered from a table of responses ────────
type RawResponse =
  | { status: number; body: string }
  | { refuse: { code: string; message: string } }
  | { readError: { code: string; message: string } }

function scriptedHost(responses: Record<string, RawResponse>) {
  const opens: Array<Record<string, any>> = []
  const hostCalls: string[] = []
  const pending = new Map<string, Uint8Array | { code: string; message: string }>()
  let n = 0
  const transport: BrowserBridgeTransport = {
    async request(req: any) {
      const action = String(req.route.action)
      if (action === 'rawStreamOpen') {
        opens.push(req.payload)
        const response = responses[`${req.payload.method ?? 'POST'} ${req.payload.url}`]
        if (!response) return { ok: false, error: { code: 'TARGET_NOT_ALLOWED', message: req.payload.url } } as any
        if ('refuse' in response) return { ok: false, error: response.refuse } as any
        n += 1
        const streamId = `raw-${n}`
        pending.set(streamId, 'readError' in response ? response.readError : enc.encode(response.body))
        const status = 'status' in response ? response.status : 200
        return { ok: true, result: { streamId, status, statusText: '', finalUrl: req.payload.url, headers: {} } } as any
      }
      if (action === 'rawStreamRead') {
        const queued = pending.get(req.payload.streamId)
        pending.delete(req.payload.streamId)
        if (queued && !(queued instanceof Uint8Array)) {
          return { ok: true, result: { done: true, chunk: new Uint8Array(), errorCode: queued.code, errorMessage: queued.message } } as any
        }
        return { ok: true, result: { done: true, chunk: queued ?? new Uint8Array() } } as any
      }
      if (action === 'rawStreamCancel') return { ok: true, result: { ok: true } } as any
      hostCalls.push(`${req.route.capability}.${action}`)
      return { ok: false, error: { code: 'PROVIDER_UNKNOWN', message: `host: ${action}` } } as any
    },
  }
  return { transport, opens, hostCalls }
}

const OR = 'https://openrouter.ai/api/v1'
const VC = 'https://ai-gateway.vercel.sh/v1'
const json = (value: unknown): RawResponse => ({ status: 200, body: JSON.stringify(value) })

describe('providerDocuments — the provider-neutral fetch', () => {
  it('lists over a GET with the format auth and the spec headers, relative to the base URL', async () => {
    const { transport, opens } = scriptedHost({ [`GET ${OR}/models`]: json(OPENROUTER_LISTING) })
    expect(await listProviderModels(transport, 'openrouter', { now: NOW })).toHaveLength(5)
    expect(opens[0]).toMatchObject({
      providerId: 'openrouter',
      url: `${OR}/models`,
      method: 'GET',
      headers: {
        'http-referer': 'https://velloc.app',
        'x-openrouter-title': 'Velloc',
      },
    })
    expect(opens[0]!.body.byteLength).toBe(0)
  })

  it('the listing is asked for WITHOUT the key, so it opens before one is entered', async () => {
    const { transport, opens } = scriptedHost({
      [`GET ${OR}/models`]: json(OPENROUTER_LISTING),
      [`GET ${VC}/models`]: json(VERCEL_LISTING),
    })
    await listProviderModels(transport, 'openrouter', { now: NOW })
    await listProviderModels(transport, 'vercel-ai-gateway', { now: NOW })
    for (const open of opens) {
      expect(JSON.stringify(open.headers)).not.toContain('{{secret:')
      expect(Object.keys(open.headers)).not.toContain('authorization')
    }
  })

  it('the key probe still carries the key: only the listing is anonymous', async () => {
    const { transport, opens } = scriptedHost({ [`GET ${OR}/key`]: json({ data: {} }) })
    expect(await verifyProvider(transport, 'openrouter')).toEqual({ ok: true })
    expect(opens[0]!.headers.authorization).toBe('Bearer {{secret:api_key}}')
  })

  it('a non-2xx or non-JSON listing rejects — never an empty list', async () => {
    const down = scriptedHost({ [`GET ${OR}/models`]: { status: 503, body: '{"error":{"message":"down"}}' } })
    await expect(listProviderModels(down.transport, 'openrouter')).rejects.toThrow('HTTP 503: down')
    const html = scriptedHost({ [`GET ${OR}/models`]: { status: 200, body: '<html>' } })
    await expect(listProviderModels(html.transport, 'openrouter')).rejects.toThrow(/did not answer with JSON/)
  })

  it('verify probes the definition path and speaks the host verify vocabulary', async () => {
    const cases: Array<[RawResponse, unknown]> = [
      [json({ data: {} }), { ok: true }],
      [{ status: 401, body: '{"error":{"message":"No auth credentials found"}}' }, { ok: false, code: 'auth_unauthorized', message: 'No auth credentials found', httpStatus: 401 }],
      [{ status: 403, body: '' }, { ok: false, code: 'auth_forbidden', message: 'HTTP 403', httpStatus: 403 }],
      [{ status: 500, body: '' }, { ok: false, code: 'system_unexpected', message: 'HTTP 500', httpStatus: 500 }],
      [{ refuse: { code: 'SECRET_UNAVAILABLE', message: 'no key' } }, { ok: false, code: 'auth_unauthorized' }],
      [{ readError: { code: 'TIMEOUT', message: 'slow' } }, { ok: false, code: 'network_timeout' }],
      [{ readError: { code: 'NETWORK_ERROR', message: 'reset' } }, { ok: false, code: 'network_unreachable' }],
    ]
    for (const [response, expected] of cases) {
      const { transport, opens } = scriptedHost({ [`GET ${VC}/credits`]: response })
      expect(await verifyProvider(transport, 'vercel-ai-gateway')).toMatchObject(expected as object)
      expect(opens[0]!.url).toBe(`${VC}/credits`)
    }
  })

  // Regression: a key with $100 of limit left on an account at $0 — every
  // request 402'd while every surface showed "$100". The account balance is
  // `/credits`, read with the management key; it leads the snapshot.
  describe('openrouter: the account balance beside the key figures', () => {
    const KEY_DOC = json({ data: { limit: 100, limit_remaining: 100, limit_reset: null, usage_daily: 0 } })

    it('a stored management key: the balance leads, read with that key', async () => {
      const { transport, opens } = scriptedHost({
        [`GET ${OR}/key`]: KEY_DOC,
        [`GET ${OR}/credits`]: json({ data: { total_credits: 100, total_usage: 100 } }),
      })
      const usage = await fetchProviderUsage(transport, 'openrouter', { now: NOW })
      expect(usage?.amounts).toEqual([
        { kind: 'balance', amount: 0, currency: 'USD' },
        { kind: 'limit_remaining', amount: 100, currency: 'USD' },
        { kind: 'spent', amount: 0, currency: 'USD', period: 'day' },
      ])
      expect(usage?.balanceNote).toBeUndefined()
      expect(opens[0]!.headers.authorization).toBe('Bearer {{secret:api_key}}')
      expect(opens[1]).toMatchObject({ url: `${OR}/credits`, headers: { authorization: 'Bearer {{secret:management_key}}' } })
      expect(Object.keys(opens[1]!.headers).filter(h => h.toLowerCase() === 'authorization')).toHaveLength(1)
    })

    it('no management key stored: the key figures stand, the note says what is missing', async () => {
      const { transport } = scriptedHost({
        [`GET ${OR}/key`]: KEY_DOC,
        [`GET ${OR}/credits`]: { refuse: { code: 'SECRET_UNAVAILABLE', message: 'Provider has no secret named management_key.' } },
      })
      const usage = await fetchProviderUsage(transport, 'openrouter', { now: NOW })
      expect(usage?.balanceNote).toBe('needs_key')
      expect(usage?.amounts?.map(a => a.kind)).toEqual(['limit_remaining', 'spent'])
    })

    it('a rejected management key never sinks the key figures', async () => {
      const { transport } = scriptedHost({
        [`GET ${OR}/key`]: KEY_DOC,
        [`GET ${OR}/credits`]: { status: 403, body: '{"error":{"message":"Only management keys can perform this operation"}}' },
      })
      const usage = await fetchProviderUsage(transport, 'openrouter', { now: NOW })
      expect(usage?.balanceNote).toBe('unavailable')
      expect(usage?.amounts?.[0]).toEqual({ kind: 'limit_remaining', amount: 100, currency: 'USD' })
    })

    it('a transient balance failure leaves the balance out — never blames the management key', async () => {
      const cases: RawResponse[] = [
        { status: 503, body: '' },
        { readError: { code: 'NETWORK_ERROR', message: 'reset' } },
        { readError: { code: 'TIMEOUT', message: 'slow' } },
      ]
      for (const response of cases) {
        const { transport } = scriptedHost({ [`GET ${OR}/key`]: KEY_DOC, [`GET ${OR}/credits`]: response })
        const usage = await fetchProviderUsage(transport, 'openrouter', { now: NOW })
        expect(usage?.balanceNote).toBeUndefined()
        expect(usage?.amounts?.map(a => a.kind)).toEqual(['limit_remaining', 'spent'])
      }
    })

    it('the key document failing still rejects — the balance is no substitute', async () => {
      const { transport } = scriptedHost({ [`GET ${OR}/key`]: { status: 401, body: '' } })
      await expect(fetchProviderUsage(transport, 'openrouter', { now: NOW })).rejects.toThrow('HTTP 401')
    })
  })

  it('usage: the provider parser over its own document — Kimi with its chat codec auth', async () => {
    const { transport, opens } = scriptedHost({
      [`GET ${VC}/credits`]: json({ balance: '1.00', total_used: '0' }),
      'GET https://api.kimi.com/coding/v1/usages': json({ usage: { limit: '100', remaining: '75' } }),
    })
    expect(await fetchProviderUsage(transport, 'vercel-ai-gateway', { now: NOW }))
      .toMatchObject({ amounts: [{ kind: 'balance', amount: 1 }, { kind: 'spent', amount: 0 }] })
    expect(await fetchProviderUsage(transport, 'kimi', { now: NOW }))
      .toEqual({ windows: [{ kind: 'weekly', usedPercent: 25 }] })
    expect(opens[1]).toMatchObject({ providerId: 'kimi', headers: { authorization: 'Bearer {{secret:api_key}}' } })
    expect(await fetchProviderUsage(transport, 'glm')).toBeUndefined()
  })
})

// ── The user's picks ──────────────────────────────────────────────────────
function recordingHost(cache: Record<string, string> = {}) {
  const writes: Array<{ id: string; config: NexusProviderConfig }> = []
  const host: RuntimeProvidersHost = {
    writeProviderConfig: async (id, config) => {
      writes.push({ id, config })
    },
    readCache: async id => cache[id],
    writeCache: async (id, text) => {
      cache[id] = text
    },
  }
  configureRuntimeProviders(host)
  return { writes, cache }
}

const listed = openrouterModels.parse(OPENROUTER_LISTING, NOW)

describe('reconcileEntries', () => {
  it('drops entries the listing no longer offers — or that lost tools — and moves the default', () => {
    // A pre-entry `enabledModels` migrates: each id becomes its pinned version.
    expect(reconcileEntries('openrouter', {
      enabledModels: ['anthropic/claude-sonnet-5.5', 'gone/model', 'meta/llama-chat'],
      defaultModel: 'gone/model',
      model: 'gone/model',
    }, listed)).toEqual({
      next: {
        modelEntries: [{ family: 'anthropic/claude-sonnet-*', version: '5.5', id: 'anthropic/claude-sonnet-5.5' }],
        defaultModel: 'anthropic/claude-sonnet-*@5.5',
        model: 'anthropic/claude-sonnet-*@5.5',
      },
      removed: ['gone/model', 'meta/llama-chat'],
      removedIds: ['gone/model@latest', 'meta/llama-chat@latest'],
    })
  })

  it('a pinned version goes when its version does; Latest stays while the family has a stable one', () => {
    expect(reconcileEntries('openrouter', {
      modelEntries: [
        { family: 'anthropic/claude-sonnet-*', version: '5.0', id: 'anthropic/claude-sonnet-5.0' },
        { family: 'anthropic/claude-sonnet-*', version: 'latest' },
      ],
      defaultModel: 'anthropic/claude-sonnet-*@5.0',
    }, listed)).toEqual({
      next: {
        modelEntries: [{ family: 'anthropic/claude-sonnet-*', version: 'latest' }],
        defaultModel: 'anthropic/claude-sonnet-*@latest',
      },
      removed: ['Claude Sonnet 5.0'],
      removedIds: ['anthropic/claude-sonnet-*@5.0'],
    })
  })

  it('a listing with no tool-capable model reconciles nothing', () => {
    const toolless = listed.map(m => ({ ...m, supportsTools: false }))
    expect(reconcileEntries('openrouter', {
      modelEntries: [{ family: 'anthropic/claude-sonnet-*', version: 'latest' }],
    }, toolless)).toBeUndefined()
    expect(reconcileEntries('openrouter', {}, toolless, { pickDefaults: true })).toBeUndefined()
  })

  it('nothing to change is undefined; an emptied list stays empty unless it is a first connection', () => {
    expect(reconcileEntries('openrouter', { enabledModels: ['z-ai/glm-5'] }, listed)).toBeUndefined()
    expect(reconcileEntries('openrouter', { modelEntries: [] }, listed)).toBeUndefined()
    expect(reconcileEntries('openrouter', { modelEntries: [] }, listed, { pickDefaults: true })).toBeUndefined()
    expect(reconcileEntries('openrouter', { enabledModels: [] }, listed, { pickDefaults: true })).toBeUndefined()
    // First connection: Latest of the catalog's starter-model families the
    // listing has (no Opus listed here), the first one the default.
    expect(reconcileEntries('openrouter', {}, listed, { pickDefaults: true })).toEqual({
      next: {
        modelEntries: [
          { family: 'anthropic/claude-haiku-*', version: 'latest', id: 'anthropic/claude-haiku-4.5' },
          { family: 'anthropic/claude-sonnet-*', version: 'latest', id: 'anthropic/claude-sonnet-5.5' },
        ],
        defaultModel: 'anthropic/claude-haiku-*@latest',
        model: 'anthropic/claude-haiku-*@latest',
      },
      removed: [],
      removedIds: [],
    })
  })
})

describe('runtime provider listing, entries and catalog rows', () => {
  it('rows hold the ENTRIES only — with the listing figures, or bare when unlisted', async () => {
    recordingHost()
    const { transport } = scriptedHost({ [`GET ${OR}/models`]: json(OPENROUTER_LISTING) })
    setRuntimeProviderConfigs({})
    expect(runtimeProviderCatalogRows().map(r => [r.id, r.enabled, r.models.length]))
      .toEqual([['openrouter', false, 0], ['vercel-ai-gateway', false, 0]])
    // Each row shows its provider's own mark, not the generic one.
    expect(runtimeProviderCatalogRows().map(r => r.iconSvg)).toEqual([
      getProviderDefinition('openrouter')!.iconSvg,
      getProviderDefinition('vercel-ai-gateway')!.iconSvg,
    ])

    setRuntimeProviderConfigs({
      openrouter: { hasApiKey: true, enabledModels: ['anthropic/claude-sonnet-5.5', 'z-ai/glm-5'], defaultModel: 'z-ai/glm-5' },
    })
    // Before any listing an entry is still offered, by the id it was added
    // with and without figures.
    expect(runtimeProviderCatalogRows()[0]!.models).toEqual([
      expect.objectContaining({
        id: 'anthropic/claude-sonnet-*@5.5',
        label: 'Claude Sonnet 5.5',
        entry: expect.objectContaining({ kind: 'pinned', resolvedId: 'anthropic/claude-sonnet-5.5' }),
      }),
      expect.objectContaining({ id: 'z-ai/glm-*@5' }),
    ])
    await refreshRuntimeProviderModels(transport, 'openrouter', { now: NOW })
    const row = runtimeProviderCatalogRows()[0]!
    // The legacy concrete default maps onto its entry.
    expect(row).toMatchObject({ enabled: true, defaultModelId: 'z-ai/glm-*@5' })
    expect(row.models[0]).toMatchObject({
      label: 'Claude Sonnet 5.5',
      contextWindow: 1_000_000,
      availableThinkingTiers: ['low', 'medium', 'high', 'extra-high', 'max'],
      defaultThinkingTier: 'high',
    })
    // The listing is also recorded as the middle layer of family rows
    // (config/nexusModelConfig/familyRows.ts) — tool-less rows included,
    // figures only.
    expect(listedFigures('openrouter', 'anthropic/claude-sonnet-5.5')).toEqual({
      name: 'Claude Sonnet 5.5',
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      availableThinkingTiers: ['low', 'medium', 'high', 'extra-high', 'max'],
      defaultThinkingTier: 'high',
      supportsImageInput: true,
    })
    expect(listedFigures('openrouter', 'no/such-model')).toBeUndefined()
    const spliced = appendRuntimeProvidersToCatalog({ providers: [{ id: 'openai', label: 'OpenAI', iconSvg: '', enabled: true, models: [] }] })!
    expect(spliced.providers.map(p => p.id)).toEqual(['openai', 'openrouter', 'vercel-ai-gateway'])
  })

  it('the Add models families carry each version id and price: look-alike variants differ there', async () => {
    recordingHost()
    const luna = (id: string, name: string, prompt: string, completion: string) => ({
      id, name, context_length: 1_050_000, supported_parameters: ['tools'], pricing: { prompt, completion },
    })
    const { transport } = scriptedHost({
      [`GET ${OR}/models`]: json({
        data: [
          luna('openai/gpt-6-luna', 'OpenAI: GPT-6 Luna', '0.0000001', '0.0000005'),
          luna('openai/gpt-6-luna-pro', 'OpenAI: GPT-6 Luna Pro', '0.0000012', '0.000006'),
          // Batch-API-only: never offered (a chat request to it is a 404).
          luna('openai/gpt-6-luna:batch', 'OpenAI: GPT-6 Luna (batch)', '0.00000005', '0.00000025'),
        ],
      }),
    })
    const result = await providerModelFamilies(transport, 'openrouter')
    expect(result.ok).toBe(true)
    expect(result.families.map(f => [f.family, f.versions.map(v => [v.id, v.price])])).toEqual([
      ['openai/gpt-*-luna', [['openai/gpt-6-luna', { input: 0.1, output: 0.5 }]]],
      ['openai/gpt-*-luna-pro', [['openai/gpt-6-luna-pro', { input: 1.2, output: 6 }]]],
    ])
  })

  it('writes the listing into the catalog, so query-time lookups resolve it', async () => {
    recordingHost()
    const { transport } = scriptedHost({ [`GET ${VC}/models`]: json(VERCEL_LISTING) })
    expect(contextWindowOf('anthropic/claude-sonnet-5.5', 'vercel-ai-gateway')).toBe(200_000)
    await refreshRuntimeProviderModels(transport, 'vercel-ai-gateway', { now: NOW })
    expect(contextWindowOf('anthropic/claude-sonnet-5.5', 'vercel-ai-gateway')).toBe(1_000_000)
    expect(outputBudgetOf('anthropic/claude-sonnet-5.5', 'vercel-ai-gateway')).toBe(128_000)
    expect(getDefaultMaxOutputTokensForModel('anthropic/claude-sonnet-5.5', 'vercel-ai-gateway')).toBe(32_768)
    expect(getAvailableThinkingTiersForModel('google/gemini-3-pro', 'vercel-ai-gateway')).toEqual(['low', 'high'])
    expect(contextWindowOf('anthropic/claude-sonnet-5.5-fast', 'vercel-ai-gateway')).toBe(200_000)
    expect(
      resolveModelRequestFields({ model: 'google/gemini-3-pro', providerId: 'vercel-ai-gateway', thinkingTier: 'medium' })
        .providerBodyExtension,
    ).toBeUndefined()
    expect(
      resolveModelRequestFields({ model: 'google/gemini-3-pro', providerId: 'vercel-ai-gateway', thinkingTier: 'high' })
        .providerBodyExtension,
    ).toEqual({ reasoning: { effort: 'high' } })
  })

  it('a delisted entry is removed from settings on an authoritative listing, and noted', async () => {
    const { writes, cache } = recordingHost()
    setRuntimeProviderConfigs({
      openrouter: {
        apiKey: 'NEXUSENC1:sealed',
        baseUrl: '',
        enabledModels: ['gone/model', 'anthropic/claude-sonnet-5.5'],
        defaultModel: 'gone/model',
      },
    })
    const { transport } = scriptedHost({ [`GET ${OR}/models`]: json(OPENROUTER_LISTING) })
    expect(await refreshRuntimeProviderModels(transport, 'openrouter', { now: NOW }))
      .toMatchObject({ ok: true, removed: ['gone/model'] })
    // Written through the providers path WITHOUT the key (absent = keep it),
    // as entries (the pre-entry list migrated).
    expect(writes).toEqual([{
      id: 'openrouter',
      config: {
        baseUrl: '',
        modelEntries: [{ family: 'anthropic/claude-sonnet-*', version: '5.5', id: 'anthropic/claude-sonnet-5.5' }],
        defaultModel: 'anthropic/claude-sonnet-*@5.5',
      },
    }])
    expect(JSON.parse(cache.openrouter!)).toMatchObject({ fetchedAt: NOW, removed: { ids: ['gone/model'], at: NOW } })
    expect(await listRuntimeProviderModels(transport, 'openrouter')).toMatchObject({
      ok: true,
      removed: { ids: ['gone/model'] },
    })
    // The removal records the entry ids: a stale write naming one is dropped
    // (`staleEntryIds`) while the listing still cannot resolve it.
    expect(JSON.parse(cache.openrouter!).removed.entryIds).toEqual(['gone/model@latest'])
    expect(staleEntryIds('openrouter')).toEqual(['gone/model@latest'])
    dismissRemovedNotice('openrouter')
    expect(await listRuntimeProviderModels(transport, 'openrouter')).not.toHaveProperty('removed')
  })

  it('a failed or empty listing never touches the entries', async () => {
    const { writes } = recordingHost()
    setRuntimeProviderConfigs({ openrouter: { hasApiKey: true, enabledModels: ['gone/model'] } })
    const failing = scriptedHost({ [`GET ${OR}/models`]: { status: 500, body: '' } })
    expect(await refreshRuntimeProviderModels(failing.transport, 'openrouter', { now: NOW }))
      .toMatchObject({ ok: false })
    const empty = scriptedHost({ [`GET ${OR}/models`]: json({ data: [] }) })
    expect(await refreshRuntimeProviderModels(empty.transport, 'openrouter', { now: NOW, force: true }))
      .toEqual({ ok: false, error: 'the provider listed no models' })
    const toolless = scriptedHost({ [`GET ${OR}/models`]: json({ data: [{ id: 'some/model', name: 'Some' }] }) })
    expect(await refreshRuntimeProviderModels(toolless.transport, 'openrouter', { now: NOW, force: true }))
      .toEqual({ ok: false, error: 'the provider listed no tool-capable models' })
    expect(writes).toEqual([])
    expect(runtimeProviderCatalogRows()[0]!.models.map(m => [m.id, m.entry?.resolvedId]))
      .toEqual([['gone/model@latest', 'gone/model']])
  })

  it('a failed listing is not re-fetched by every catalog read — only after the retry delay, or forced', async () => {
    recordingHost()
    setRuntimeProviderConfigs({ openrouter: { hasApiKey: true, enabledModels: ['gone/model'] } })
    const { transport, opens } = scriptedHost({ [`GET ${OR}/models`]: { status: 500, body: '' } })
    expect(await refreshRuntimeProviderModels(transport, 'openrouter', { now: NOW })).toMatchObject({ ok: false })
    expect(await refreshRuntimeProviderModels(transport, 'openrouter', { now: NOW + 1_000 }))
      .toMatchObject({ ok: false, error: expect.stringContaining('HTTP 500') })
    expect(opens).toHaveLength(1)
    await refreshRuntimeProviderModels(transport, 'openrouter', { now: NOW + 1_000, force: true })
    expect(opens).toHaveLength(2)
    await refreshRuntimeProviderModels(transport, 'openrouter', { now: NOW + 2_000 + LISTING_RETRY_MS })
    expect(opens).toHaveLength(3)
  })

  it('a stale cached listing serves the catalog: the refresh is not waited for', async () => {
    recordingHost({ openrouter: JSON.stringify({ models: listed, fetchedAt: 0 }) })
    setRuntimeProviderConfigs({ openrouter: { hasApiKey: true, enabledModels: ['anthropic/claude-sonnet-5.5'] } })
    // A provider whose /models never answers.
    const hung = { request: () => new Promise(() => {}) } as unknown as BrowserBridgeTransport
    const settled = await Promise.race([
      refreshConfiguredRuntimeProviderModels(hung, { waitMs: 60_000 }).then(() => 'returned'),
      new Promise(resolve => setTimeout(() => resolve('waited'), 200)),
    ])
    expect(settled).toBe('returned')
  })

  it('verify joining a keyless listing fetch still picks the first entries', async () => {
    const { writes } = recordingHost()
    setRuntimeProviderConfigs({ openrouter: { apiKey: 'NEXUSENC1:sealed' } })
    const scripted = scriptedHost({
      [`GET ${OR}/key`]: json({ data: {} }),
      [`GET ${OR}/models`]: json(OPENROUTER_LISTING),
    })
    // The settings page's listing fetch is still running when verify lands.
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let held = false
    const transport = {
      async request(req: any) {
        if (!held && req.route.action === 'rawStreamOpen' && String(req.payload.url).endsWith('/models')) {
          held = true
          await gate
        }
        return scripted.transport.request(req)
      },
    } as unknown as BrowserBridgeTransport
    const pageFetch = refreshRuntimeProviderModels(transport, 'openrouter', { now: NOW })
    const verify = verifyRuntimeProvider(transport, 'openrouter', { now: NOW })
    await Promise.resolve()
    release()
    await pageFetch
    expect(await verify).toEqual({ ok: true, verifiedAtMs: NOW })
    expect(writes.at(-1)?.config.modelEntries?.length).toBeGreaterThan(0)
  })

  it('a cold start reads the cached listing — figures with no fetch while it is fresh', async () => {
    recordingHost({ openrouter: JSON.stringify({ models: listed, fetchedAt: Date.now() }) })
    setRuntimeProviderConfigs({ openrouter: { hasApiKey: true, enabledModels: ['anthropic/claude-sonnet-5.5'] } })
    const { transport, opens } = scriptedHost({})
    await refreshConfiguredRuntimeProviderModels(transport)
    expect(opens).toHaveLength(0)
    expect(contextWindowOf('anthropic/claude-sonnet-5.5', 'openrouter')).toBe(1_000_000)
    expect(runtimeProviderCatalogRows()[0]!.models[0]).toMatchObject({ label: 'Claude Sonnet 5.5' })
    // The rows recorded their resolution: an entry id reads its model's figures.
    expect(contextWindowOf('anthropic/claude-sonnet-*@5.5', 'openrouter')).toBe(1_000_000)
  })

  it('only providers with a key AND entries are polled', async () => {
    recordingHost()
    const { transport, opens } = scriptedHost({
      [`GET ${OR}/models`]: json(OPENROUTER_LISTING),
      [`GET ${VC}/models`]: json(VERCEL_LISTING),
    })
    setRuntimeProviderConfigs({ openrouter: { hasApiKey: true }, 'vercel-ai-gateway': { enabledModels: ['x'] } })
    await refreshConfiguredRuntimeProviderModels(transport)
    expect(opens).toHaveLength(0)
    setRuntimeProviderConfigs({ 'vercel-ai-gateway': { apiKey: 'NEXUSENC1:x', enabledModels: ['anthropic/claude-sonnet-5.5'] } })
    await refreshConfiguredRuntimeProviderModels(transport)
    expect(opens.map(o => o.url)).toEqual([`${VC}/models`])
  })

  it('a verified key is stamped FIRST, then the first entries are added — two writes in that order', async () => {
    const { writes } = recordingHost()
    setRuntimeProviderConfigs({ openrouter: { apiKey: 'NEXUSENC1:sealed' } })
    const { transport } = scriptedHost({
      [`GET ${OR}/key`]: json({ data: {} }),
      [`GET ${OR}/models`]: json(OPENROUTER_LISTING),
    })
    expect(await verifyRuntimeProvider(transport, 'openrouter', { now: NOW })).toEqual({ ok: true, verifiedAtMs: NOW })
    expect(writes).toEqual([
      { id: 'openrouter', config: { lastVerification: { providerId: 'openrouter', verifiedAtMs: NOW } } },
      {
        id: 'openrouter',
        config: {
          lastVerification: { providerId: 'openrouter', verifiedAtMs: NOW },
          modelEntries: [
            { family: 'anthropic/claude-haiku-*', version: 'latest', id: 'anthropic/claude-haiku-4.5' },
            { family: 'anthropic/claude-sonnet-*', version: 'latest', id: 'anthropic/claude-sonnet-5.5' },
          ],
          defaultModel: 'anthropic/claude-haiku-*@latest',
          model: 'anthropic/claude-haiku-*@latest',
        },
      },
    ])
    const refused = scriptedHost({ [`GET ${OR}/key`]: { status: 401, body: '' } })
    writes.length = 0
    expect(await verifyRuntimeProvider(refused.transport, 'openrouter')).toMatchObject({ ok: false, code: 'auth_unauthorized' })
    expect(writes).toEqual([])
  })

  it("a built-in's key is probed on its own listing with the STORED key, stamped, and its entries left alone", async () => {
    const { writes } = recordingHost()
    const entries = [{ family: 'claude-opus-*', version: 'latest' }]
    setRuntimeProviderConfigs({ anthropic: { apiKey: 'NEXUSENC1:sealed', modelEntries: entries } })
    const LIST = 'GET https://api.anthropic.com/v1/models?limit=1000'
    const { transport, opens } = scriptedHost({ [LIST]: json({ data: [{ id: 'claude-opus-5-5' }] }) })
    expect(await verifyRuntimeProvider(transport, 'anthropic', { now: NOW })).toEqual({ ok: true, verifiedAtMs: NOW })
    // One write — the stamp. A built-in's entries resolve against its curated
    // rows, so the listing reconciles nothing and picks nothing.
    expect(writes).toEqual([
      { id: 'anthropic', config: { modelEntries: entries, lastVerification: { providerId: 'anthropic', verifiedAtMs: NOW } } },
    ])
    expect(opens[0]).toMatchObject({ method: 'GET', headers: expect.objectContaining({ 'x-api-key': '{{secret:api_key}}' }) })
    const refused = scriptedHost({ [LIST]: { status: 401, body: '{"error":{"message":"invalid x-api-key"}}' } })
    writes.length = 0
    expect(await verifyRuntimeProvider(refused.transport, 'anthropic')).toMatchObject({
      ok: false,
      code: 'auth_unauthorized',
      message: 'invalid x-api-key',
    })
    expect(writes).toEqual([])
    // A provider still on its host class is not probed here.
    expect(await verifyRuntimeProvider(transport, 'google')).toMatchObject({ ok: false, code: 'system_unexpected' })
  })

  it("the host's discovery in the runtime: a built-in row gains its listed models, curated rows stay", async () => {
    recordingHost()
    const { transport, opens } = scriptedHost({
      'GET https://api.openai.com/v1/models': json({ data: [{ id: 'gpt-6-astra' }, { id: 'gpt-6-nova' }] }),
    })
    const row = (id: string, enabled: boolean, models: string[]) => ({
      id, label: id, iconSvg: '', enabled,
      models: models.map(m => ({ id: m, label: m.toUpperCase(), enabled, supportsStreaming: true })),
    })
    const catalog = {
      providers: [row('openai', true, ['gpt-6-astra']), row('anthropic', false, ['claude-opus-5-5']), row('google', true, ['g'])],
    } as any
    // No listing yet: the rows are the host's, and a refresh starts in the
    // background — for the set-up provider only (anthropic has no enabled row).
    const first = await overlayBuiltInListings(transport, catalog)
    expect(first!.providers[0]!.models.map(m => m.id)).toEqual(['gpt-6-astra'])
    await refreshRuntimeProviderModels(transport, 'openai') // joins it
    expect(opens.map(o => o.url)).toEqual(['https://api.openai.com/v1/models'])
    const second = await overlayBuiltInListings(transport, catalog)
    expect(second!.providers[0]!.models).toEqual([
      { id: 'gpt-6-astra', label: 'GPT-6-ASTRA', enabled: true, supportsStreaming: true },
      { id: 'gpt-6-nova', label: 'gpt-6-nova', enabled: true, supportsStreaming: true, supportsTools: true },
    ])
    expect(second!.providers[1]).toBe(catalog.providers[1])
    expect(second!.providers[2]).toBe(catalog.providers[2])
    expect(opens).toHaveLength(1) // within the TTL: no second fetch
  })

  it("a catalog read picks up a base URL the host got outside the guest's write path", async () => {
    // `updateProviderConfig` (chrome.send) pointed openai at a
    // relay; the runtime's copy of the broker base URLs was only refreshed at
    // boot and on guest-side writes, so openai's ModelProvider kept sending
    // to the catalog default.
    __resetEndpointTrustForTest()
    expect(resolveDriverBaseUrl('openai')).toBe('https://api.openai.com/v1')
    const transport = {
      async request(req: any) {
        const action = `${req.route.capability}.${req.route.action}`
        if (action === 'model.catalog') return { id: req.id, route: req.route, ok: true, result: { providers: [] } }
        if (action === 'providerAuth.list') {
          return { id: req.id, route: req.route, ok: true, result: { providers: [{ id: 'openai', baseUrl: 'http://127.0.0.1:4100/v1' }] } }
        }
        return { id: req.id, route: req.route, ok: false, error: { code: 'UNEXPECTED', message: action } }
      },
    } as unknown as BrowserBridgeTransport
    try {
      await new BrowserHostBridge({ transport }).getModelCatalog()
      expect(resolveDriverBaseUrl('openai')).toBe('http://127.0.0.1:4100/v1')
    } finally {
      __resetEndpointTrustForTest()
    }
  })

  it('names the default base URL of each runtime-only provider, and only theirs', () => {
    expect(runtimeProviderDefaultBaseUrl('openrouter')).toBe(OR)
    expect(runtimeProviderDefaultBaseUrl('vercel-ai-gateway')).toBe('https://ai-gateway.vercel.sh/v1')
    expect(runtimeProviderDefaultBaseUrl('openai')).toBeUndefined()
  })

  it('injects the default base URL into the published copy only when unset', () => {
    const published = withRuntimeProviderBaseUrls({
      openrouter: { apiKey: 'NEXUSENC1:x' },
      'vercel-ai-gateway': { baseUrl: 'https://ai-gateway.vercel.sh/v2' },
      openai: {},
    })
    expect(published.openrouter).toEqual({ apiKey: 'NEXUSENC1:x', baseUrl: OR })
    expect(published['vercel-ai-gateway']!.baseUrl).toBe('https://ai-gateway.vercel.sh/v2')
    expect(published.openai).toEqual({})
  })
})

// ── Fresh listings for the settings home page's counts ────────────────────
describe('fetchFreshModelIds', () => {
  it('a gateway re-fetches its listing (forced) and answers the usable ids', async () => {
    recordingHost()
    const { transport, opens } = scriptedHost({ [`GET ${OR}/models`]: json(OPENROUTER_LISTING) })
    expect(await fetchFreshModelIds(transport, 'openrouter')).toEqual({
      ok: true,
      ids: ['anthropic/claude-sonnet-5.5', 'anthropic/claude-haiku-4.5', 'openai/gpt-6-astra', 'z-ai/glm-5'],
    })
    await fetchFreshModelIds(transport, 'openrouter')
    expect(opens).toHaveLength(2) // never the cached copy
    const down = scriptedHost({ [`GET ${OR}/models`]: { status: 500, body: '' } })
    expect(await fetchFreshModelIds(down.transport, 'openrouter')).toMatchObject({ ok: false })
  })

  it('a provider with no runtime listing asks the host to re-run its discovery', async () => {
    const requests: Array<{ action: string; payload: unknown }> = []
    const answer = (result: unknown): BrowserBridgeTransport => ({
      async request(req: any) {
        requests.push({ action: `${req.route.capability}.${req.route.action}`, payload: req.payload })
        return result as any
      },
    })
    expect(await fetchFreshModelIds(
      answer({ ok: true, result: { success: true, models: [{ id: 'gemini-x' }, { id: '' }] } }),
      'google',
    )).toEqual({ ok: true, ids: ['gemini-x'] })
    expect(requests[0]).toEqual({ action: 'providerAuth.refresh', payload: { providerId: 'google' } })
    expect(await fetchFreshModelIds(answer({ ok: true, result: { success: false, error: 'no key' } }), 'deepseek'))
      .toEqual({ ok: false, error: 'no key' })
    expect(await fetchFreshModelIds(answer({ ok: false, error: { code: 'LLM_ERROR', message: 'x' } }), 'deepseek'))
      .toEqual({ ok: false, error: 'LLM_ERROR: x' })
    const throwing: BrowserBridgeTransport = { request: async () => { throw new Error('port closed') } }
    expect(await fetchFreshModelIds(throwing, 'deepseek')).toEqual({ ok: false, error: 'port closed' })
  })

  it('openai, anthropic and kimi re-fetch their own listing in the runtime, never the host', async () => {
    const { transport, opens, hostCalls } = scriptedHost({
      'GET https://api.openai.com/v1/models': json({ data: [{ id: 'gpt-6-astra' }, { id: 'text-embedding-9' }] }),
      'GET https://api.anthropic.com/v1/models?limit=1000': json({ data: [{ id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5' }] }),
      'GET https://api.kimi.com/coding/v1/models': json({ data: [{ id: 'k3' }] }),
    })
    expect(await fetchFreshModelIds(transport, 'openai')).toEqual({ ok: true, ids: ['gpt-6-astra', 'text-embedding-9'] })
    expect(await fetchFreshModelIds(transport, 'anthropic')).toEqual({ ok: true, ids: ['claude-opus-5-5'] })
    expect(await fetchFreshModelIds(transport, 'kimi')).toEqual({ ok: true, ids: ['k3'] })
    expect(hostCalls).toEqual([])
    // The key rides as each codec's own auth template.
    expect(opens.map(o => o.headers)).toEqual([
      expect.objectContaining({ authorization: 'Bearer {{secret:api_key}}' }),
      expect.objectContaining({ 'x-api-key': '{{secret:api_key}}' }),
      expect.objectContaining({ authorization: 'Bearer {{secret:api_key}}' }),
    ])
    // A built-in's listing never replaces its curated catalog rows.
    expect(NEXUS_MODEL_CONFIG.providers.find(p => p.providerId === 'openai')!.models.length).toBeGreaterThan(2)
  })

  it('providers.freshModelIds forwards, and without a host transport says so', async () => {
    const ctx = { homeDir: '/h', fs: {} as never }
    expect(await handleFreshModelIds({ id: 'openai' }, { ...ctx, freshModelIds: async () => ({ ok: true, ids: ['a'] }) }))
      .toEqual({ ok: true, ids: ['a'] })
    expect(await handleFreshModelIds({ id: 'openai' }, ctx)).toEqual({ ok: false, error: 'no host transport' })
  })
})

// ── Usage service ─────────────────────────────────────────────────────────
describe('withProviderSecretMirror — the broker publish', () => {
  // The broker merges `secrets` name by name and only `''` removes one, so a
  // removed management key would keep authenticating unless every publish
  // names each DECLARED secret.
  it('names every declared secret, empty when not stored; other providers untouched', () => {
    const configs = {
      openrouter: { apiKey: 'NEXUSENC1:k' },
      'openrouter-2': { apiKey: 'x' },
      openai: { apiKey: 'NEXUSENC1:o' },
    }
    const out = withProviderSecretMirror(configs)
    expect(out.openrouter).toEqual({ apiKey: 'NEXUSENC1:k', secrets: { management_key: '' } })
    expect(out.openai).toBe(configs.openai)
    expect(out['openrouter-2']).toBe(configs['openrouter-2'])
    expect(withProviderSecretMirror({ openrouter: { secrets: { management_key: 'NEXUSENC1:m', other: 'NEXUSENC1:z' } } }).openrouter)
      .toEqual({ secrets: { management_key: 'NEXUSENC1:m', other: 'NEXUSENC1:z' } })
  })
})

describe('provider usage service', () => {
  it('fetches, publishes the table, throttles to once a minute unless forced, keeps figures on failure', async () => {
    const published: unknown[] = []
    setProviderUsagePublisher(state => published.push(state))
    const responses: Record<string, RawResponse> = { [`GET ${VC}/credits`]: json({ balance: '9.00', total_used: '1' }) }
    const { transport, opens } = scriptedHost(responses)
    const first = await refreshProviderUsage(transport, 'vercel-ai-gateway', { now: NOW })
    expect(first).toMatchObject({ checkedAt: NOW, usage: { amounts: [{ kind: 'balance', amount: 9 }, { kind: 'spent' }] } })
    expect(published).toHaveLength(1)
    await refreshProviderUsage(transport, 'vercel-ai-gateway', { now: NOW + USAGE_MIN_INTERVAL_MS - 1 })
    expect(opens).toHaveLength(1)
    responses[`GET ${VC}/credits`] = { status: 502, body: '' }
    const failed = await refreshProviderUsage(transport, 'vercel-ai-gateway', { now: NOW + 1, force: true })
    expect(failed).toMatchObject({ error: 'HTTP 502: request failed', usage: { amounts: [{ amount: 9 }, { amount: 1 }] } })
    expect(providerUsageState()['vercel-ai-gateway']).toBe(failed)
    expect(await refreshProviderUsage(transport, 'glm')).toBeUndefined()
  })
})

// ── Settings actions ──────────────────────────────────────────────────────
describe('providers.* settings actions', () => {
  const ctx = { homeDir: '/h', fs: {} as never, now: () => 42 }

  it('verify: the runtime stamp time passes through; failures keep their code', async () => {
    expect(await handleVerify({ id: 'openrouter' }, { ...ctx, verifyRuntimeProvider: async () => ({ ok: true, verifiedAtMs: 7 }) }))
      .toEqual({ ok: true, verifiedAtMs: 7 })
    expect(await handleVerify({ id: 'openrouter' }, {
      ...ctx,
      verifyRuntimeProvider: async () => ({ ok: false, code: 'auth_unauthorized', message: 'bad', httpStatus: 401 }),
    })).toEqual({ ok: false, errorCode: 'auth_unauthorized', message: 'bad', httpStatus: 401 })
    expect(await handleVerify({ id: 'openrouter' }, ctx)).toMatchObject({ ok: false, errorCode: 'system_unexpected' })
    await expect(handleVerify({ id: '' }, ctx)).rejects.toThrow(/non-empty/)
  })

  it('modelFamilies forwards force; dismissRemoved forgets the notice', async () => {
    const families = vi.fn(async () => ({ ok: true as const, families: [] }))
    expect(await handleModelFamilies({ id: 'openrouter', force: true }, { ...ctx, modelFamilies: families }))
      .toEqual({ ok: true, families: [] })
    expect(families).toHaveBeenCalledWith('openrouter', true)
    expect(await handleModelFamilies({ id: 'openrouter' }, ctx)).toMatchObject({ ok: false, families: [] })
    const dismiss = vi.fn()
    expect(await handleDismissRemoved({ id: 'openrouter' }, { ...ctx, dismissRemovedNotice: dismiss })).toEqual({ ok: true })
    expect(dismiss).toHaveBeenCalledWith('openrouter')
  })
})

// ── The transport interceptor ─────────────────────────────────────────────
describe('withModelProviders — every model.* caller reaches the ModelProvider', () => {
  const sse = (...frames: unknown[]) => frames.map(f => `data: ${JSON.stringify(f)}\n\n`).join('') + 'data: [DONE]\n\n'

  it('serves streamStart/Read for a runtime provider locally, reasoning included; refuses an unserved one', async () => {
    const { transport, opens, hostCalls } = scriptedHost({
      [`POST ${OR}/chat/completions`]: {
        status: 200,
        body: sse(
          { choices: [{ index: 0, delta: { reasoning: 'think', reasoning_details: [{ type: 'reasoning.text', text: 'think', signature: 's', index: 0 }] } }] },
          { choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: 'stop' }] },
        ),
      },
    })
    const wrapped = withModelProviders(transport, { getEnv: () => undefined } as never)
    const start: any = await wrapped.request({
      id: '1',
      route: { namespace: 'nexus', capability: 'model', action: 'streamStart' } as any,
      payload: {
        providerId: 'openrouter',
        model: 'anthropic/claude-sonnet-5.5',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }],
        providerBodyExtension: { reasoning: { effort: 'high' } },
      } as any,
    })
    expect(start.ok).toBe(true)
    const chunks: any[] = []
    for (let i = 0; i < 20 && !chunks.some(c => c.type === 'message_stop'); i += 1) {
      const read: any = await wrapped.request({
        id: `r${i}`,
        route: { namespace: 'nexus', capability: 'model', action: 'streamRead' } as any,
        payload: { streamId: start.result.streamId } as any,
      })
      chunks.push(...read.result.chunks)
    }
    expect(chunks.filter(c => c.type === 'content_block_delta').map(c => c.delta.type))
      .toEqual(['thinking_delta', 'text_delta', 'signature_delta'])
    const body = JSON.parse(new TextDecoder().decode(opens[0]!.body))
    expect(body.reasoning).toEqual({ effort: 'high' })
    expect(hostCalls).toEqual([])
    // A provider no driver serves is refused here: the host has no model
    // request routes.
    const refused: any = await wrapped.request({
      id: '2',
      route: { namespace: 'nexus', capability: 'model', action: 'streamStart' } as any,
      payload: { providerId: 'no-such-provider', model: 'x', messages: [] } as any,
    })
    expect(refused).toMatchObject({ ok: false, error: { code: 'provider_error' } })
    const unknownRead: any = await wrapped.request({
      id: '3',
      route: { namespace: 'nexus', capability: 'model', action: 'streamRead' } as any,
      payload: { streamId: 'gone' } as any,
    })
    expect(unknownRead).toMatchObject({ ok: false, error: { code: 'STREAM_NOT_FOUND' } })
    expect(hostCalls).toEqual([])
  })

  it('a built-in on its ModelProvider streams AND answers the blocking route in the runtime', async () => {
    const { transport, opens, hostCalls } = scriptedHost({
      [`POST https://api.kimi.com/coding/v1/chat/completions`]: {
        status: 200,
        body: sse({ choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: 'stop' }] }),
      },
    })
    const wrapped = withModelProviders(transport)
    const start: any = await wrapped.request({
      id: '1',
      route: { namespace: 'nexus', capability: 'model', action: 'streamStart' } as any,
      payload: { providerId: 'kimi', model: 'k3', messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }] } as any,
    })
    expect(start.ok).toBe(true)
    expect(opens).toHaveLength(1)
    expect(hostCalls).toEqual([])
    // The degenerate-stream fallback (`model.call`): a fresh stream, read
    // whole, in the host's blocking-call shape — the host is not asked.
    const call: any = await wrapped.request({
      id: '2',
      route: { namespace: 'nexus', capability: 'model', action: 'call' } as any,
      payload: { providerId: 'kimi', model: 'k3', messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }] } as any,
    })
    expect(call).toMatchObject({
      ok: true,
      result: {
        status: 'ok',
        message: { role: 'assistant', model: 'k3', stop_reason: 'end_turn', content: [{ type: 'text', text: 'hi' }] },
      },
    })
    expect(opens).toHaveLength(2)
    expect(hostCalls).toEqual([])
  })

  it('a failed blocking call carries the provider error; an implicit model is refused', async () => {
    const { transport, hostCalls } = scriptedHost({})
    const wrapped = withModelProviders(transport)
    // No scripted endpoint: the transport refuses the open, the call fails
    // with that error (the blocking route used to refuse a gateway outright).
    const call: any = await wrapped.request({
      id: '1',
      route: { namespace: 'nexus', capability: 'model', action: 'call' } as any,
      payload: { providerId: 'vercel-ai-gateway', model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }] } as any,
    })
    expect(call).toMatchObject({ ok: false, error: { code: 'LLM_ERROR' } })
    expect(call.error.message).toContain('TARGET_NOT_ALLOWED')
    const start: any = await wrapped.request({
      id: '2',
      route: { namespace: 'nexus', capability: 'model', action: 'streamStart' } as any,
      payload: { providerId: 'openrouter', model: 'inherit', messages: [] } as any,
    })
    expect(start.ok).toBe(false)
    expect(hostCalls).toEqual([])
  })
})

// ── Gateway stream shapes ─────────────────────────────────────────────────
describe('openai-chat codec — gateway stream shapes', () => {
  const context = { providerId: 'openrouter', baseUrl: OR, model: 'anthropic/claude-sonnet-5.5' }
  const decode = (text: string): DriverStreamEvent[] => {
    const decoder = openaiChatDriver.createDecoder(context)
    return [...decoder.push(enc.encode(text)), ...decoder.end()]
  }

  it('ignores the keep-alive comments OpenRouter interleaves', () => {
    expect(decode(
      ': OPENROUTER PROCESSING\n\n'
      + 'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n'
      + ': OPENROUTER PROCESSING\n\ndata: [DONE]\n\n',
    ).map(e => e.type)).toEqual(['text_delta', 'finish'])
  })

  it('surfaces a mid-stream error chunk (not a silent stop); an HTTP-range code is the status', () => {
    expect(decode(
      'data: {"choices":[{"index":0,"delta":{"content":"par"}}]}\n\n'
      + 'data: {"error":{"code":502,"message":"Provider disconnected"},"choices":[{"index":0,"delta":{"content":""},"finish_reason":"error"}]}\n\n',
    )).toEqual([
      { type: 'text_delta', text: 'par' },
      { type: 'error', message: 'HTTP 502: Provider disconnected', httpStatus: 502 },
    ])
    expect(decode('data: {"error":{"code":"server_error","message":"boom"}}\n\n'))
      .toEqual([{ type: 'error', message: 'HTTP 200: boom', httpStatus: 200 }])
  })
})
