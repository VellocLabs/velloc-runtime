import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { BrowserLlmCatalog } from '../browser/bridge/browserBridgeProtocol'
import {
  NEXUS_MODEL_CONFIG,
  type NexusModelConfig,
  type NexusProviderModelConfig,
} from '../config/nexusModelConfig'
import {
  createConfiguredModelCatalog,
  extractOnlineModelIds,
  healReplacesGlobalDefault,
  isSelectionEnabled,
} from '../browser/webview/modelCatalog'
import {
  createConfiguredProvider,
  findConfiguredModelRule,
} from '../browser/webview/configuredModels'
import { findConfiguredModel } from '../config/nexusModelConfig/findConfiguredModel'
import { createAnthropicModelPattern } from '../config/nexusModelConfig/patterns'
import {
  getBalancedModel,
  topTierModel,
  contextWindowOf,
  getDefaultMaxOutputTokensForModel,
  getFastModel,
  getFastModelForProvider,
  outputBudgetOf,
  getModelForSessionType,
  getSessionModelPolicyFor,
  getSessionTypeTier,
  getSupportsImageInputForModel,
  getTierModelForProvider,
  type TierModelSessionType,
} from '../engine/contextWindow'
import { serializeNexusModelConfig } from '../config/nexusModelConfigWire'
import { resetEntryResolutions } from '../config/nexusModelConfig/modelEntryResolution'
import {
  resetSessionModelSettingsSnapshot,
  setSessionModelSettingsSnapshot,
} from '../models/tierSettingsSnapshot'
import { installBuiltinCatalogFigures } from './_helpers/builtinCatalogFigures'
import { resetCatalogFigures } from '../config/nexusModelConfig/catalogFigures'
import { resetCustomProviderRecords, setCustomProviderRecords } from '../config/customProviderRegistry'

// Built-in rows read the context window / output cap / image input they
// leave unset from the model catalog: install the runtime's figures, as
// after its first catalog read (catalog/builtinCatalogFill.ts).
beforeAll(installBuiltinCatalogFigures)
afterAll(resetCatalogFigures)

const TEST_CATALOG: BrowserLlmCatalog = {
  providers: [
    {
      id: 'openai',
      label: 'OpenAI',
      iconSvg: '<svg />',
      enabled: true,
      defaultModelId: 'gpt-4o',
      models: [
        {
          id: 'gpt-4o',
          label: 'GPT-4o',
          enabled: true,
        },
        {
          id: 'gpt-4.5-preview',
          label: 'GPT-4.5 Preview',
          enabled: true,
        },
      ],
    },
    {
      id: 'anthropic',
      label: 'Anthropic',
      iconSvg: '<svg />',
      enabled: true,
      defaultModelId: 'claude-3-7-sonnet',
      models: [
        {
          id: 'claude-3-7-sonnet',
          label: 'Claude 3.7 Sonnet',
          enabled: true,
        },
      ],
    },
  ],
  defaultSelection: {
    providerId: 'openai',
    modelId: 'gpt-4o',
  },
}

describe('nexus model config helpers', () => {
  it('filters provider models, renames them, and derives a visible default selection', () => {
    const config: NexusModelConfig = {
      providers: [
        {
          providerId: 'openai',
          models: [
            {
              model: 'gpt-4.5',
              name: 'GPT-4.5 Preview',
            },
          ],
        },
      ],
    }

    const configuredCatalog = createConfiguredModelCatalog(TEST_CATALOG, config)
    const openaiProvider = configuredCatalog?.providers.find(
      provider => provider.id === 'openai',
    )

    // Both the real-id match (`gpt-4.5-preview`) and a synthesized entry
    // for the curated canonical id (`gpt-4.5`) appear in the catalog so
    // popup picks of the curated id resolve through `isSelectionEnabled`.
    expect(openaiProvider?.models.map(model => ({
      id: model.id,
      label: model.label,
    }))).toEqual([
      {
        id: 'gpt-4.5-preview',
        label: 'GPT-4.5 Preview',
      },
      {
        id: 'gpt-4.5',
        label: 'GPT-4.5 Preview',
      },
    ])
    expect(configuredCatalog?.defaultSelection).toEqual({
      providerId: 'openai',
      modelId: 'gpt-4.5-preview',
    })
  })

  it('keeps providers without model rules unchanged', () => {
    const config: NexusModelConfig = {
      providers: [
        {
          providerId: 'openai',
          models: [
            {
              model: 'gpt-4.5',
              name: 'GPT-4.5 Preview',
            },
          ],
        },
      ],
    }

    const configuredCatalog = createConfiguredModelCatalog(TEST_CATALOG, config)
    const anthropicProvider = configuredCatalog?.providers.find(
      provider => provider.id === 'anthropic',
    )

    expect(anthropicProvider?.models.map(model => model.id)).toEqual([
      'claude-3-7-sonnet',
    ])
  })

  it('keeps passthrough providers visible while applying configured labels', () => {
    const config: NexusModelConfig = {
      providers: [
        {
          providerId: 'anthropic',
          filterMode: 'passthrough',
          models: [
            {
              model: 'claude-sonnet-4',
              name: 'Claude Sonnet 4',
            },
          ],
        } satisfies NexusProviderModelConfig,
      ],
    }

    const catalog: BrowserLlmCatalog = {
      providers: [
        {
          id: 'anthropic',
          label: 'Anthropic',
          iconSvg: '<svg />',
          enabled: true,
          defaultModelId: 'claude-sonnet-4-20250514',
          models: [
            {
              id: 'claude-sonnet-4-20250514',
              label: 'claude-sonnet-4-20250514',
              enabled: true,
            },
            {
              id: 'claude-3-5-haiku-20241022',
              label: 'claude-3-5-haiku-20241022',
              enabled: true,
            },
          ],
        },
      ],
    }

    const configuredCatalog = createConfiguredModelCatalog(catalog, config)
    expect(configuredCatalog?.providers[0]?.models.map(model => ({
      id: model.id,
      label: model.label,
    }))).toEqual([
      {
        id: 'claude-sonnet-4-20250514',
        label: 'Claude Sonnet 4',
      },
      {
        id: 'claude-3-5-haiku-20241022',
        label: 'claude-3-5-haiku-20241022',
      },
    ])
  })

  it('whitelists the configured OpenAI model families', () => {
    const catalog: BrowserLlmCatalog = {
      providers: [
        {
          id: 'openai',
          label: 'OpenAI',
          iconSvg: '<svg />',
          enabled: true,
          defaultModelId: 'gpt-4.5-preview',
          models: [
            {
              id: 'gpt-6-astra-2026-09-03',
              label: 'GPT-6 Astra Snapshot',
              enabled: true,
            },
            {
              id: 'gpt-6-sol',
              label: 'GPT-6 Sol',
              enabled: true,
            },
            {
              id: 'gpt-5.6-terra-2026-07-09',
              label: 'GPT-5.6 Terra Snapshot',
              enabled: true,
            },
            {
              id: 'gpt-5.5-pro-2026-04-10',
              label: 'GPT-5.5 Pro Snapshot',
              enabled: true,
            },
            // Everything below is off-lineup and must be filtered out —
            // including former curated rows (gpt-5.5, gpt-5.4-nano,
            // gpt-5-nano) dropped in the GPT-5.6 lineup change, and
            // gpt-5.4-mini, which left the OpenAI lineup and
            // the chatgpt-pro lineup. Its snapshot is kept in
            // this input on purpose: `/v1/models` still returns it for an
            // OpenAI key, so the filter has to drop it.
            {
              id: 'gpt-5.4-mini-2026-03-17',
              label: 'GPT-5.4 Mini Snapshot',
              enabled: true,
            },
            {
              id: 'gpt-5.5-2026-04-10',
              label: 'GPT-5.5 Snapshot',
              enabled: true,
            },
            {
              id: 'gpt-5.4-nano-2026-03-17',
              label: 'GPT-5.4 Nano Snapshot',
              enabled: true,
            },
            {
              id: 'gpt-5-nano-2024-05-31',
              label: 'GPT-5 nano Snapshot',
              enabled: true,
            },
            {
              id: 'gpt-5.2-2026-04-10',
              label: 'GPT-5.2 Latest',
              enabled: true,
            },
            {
              id: 'gpt-4.5-preview',
              label: 'GPT-4.5 Preview',
              enabled: true,
            },
            {
              id: 'gpt-5-codex',
              label: 'GPT-5 Codex',
              enabled: true,
            },
            {
              id: 'o4-mini',
              label: 'o4-mini',
              enabled: true,
            },
          ],
        },
      ],
      defaultSelection: {
        providerId: 'openai',
        modelId: 'gpt-4.5-preview',
      },
    }

    const configuredCatalog = createConfiguredModelCatalog(
      catalog,
      NEXUS_MODEL_CONFIG,
    )
    const openaiProvider = configuredCatalog?.providers.find(
      provider => provider.id === 'openai',
    )

    // Each curated rule yields the real-id snapshot and a synthesized canonical-id entry; curated order is picker
    // order. `gpt-6-luna` is absent from the input on purpose: its synthesized canonical row must surface anyway.
    expect(openaiProvider?.models.map(model => ({
      id: model.id,
      label: model.label,
    }))).toEqual([
      {
        id: 'gpt-6-astra-2026-09-03',
        label: 'GPT-6 Astra',
      },
      {
        id: 'gpt-6-astra',
        label: 'GPT-6 Astra',
      },
      {
        id: 'gpt-6.1-sol',
        label: 'GPT-6.1 Sol',
      },
      {
        id: 'gpt-6-sol',
        label: 'GPT-6 Sol',
      },
      {
        id: 'gpt-5.6-sol',
        label: 'GPT-5.6 Sol',
      },
      {
        id: 'gpt-6-luna',
        label: 'GPT-6 Luna',
      },
      {
        id: 'gpt-5.6-luna',
        label: 'GPT-5.6 Luna',
      },
      {
        id: 'gpt-5.6-terra-2026-07-09',
        label: 'GPT-5.6 Terra',
      },
      {
        id: 'gpt-5.6-terra',
        label: 'GPT-5.6 Terra',
      },
      {
        id: 'gpt-5.5-2026-04-10',
        label: 'GPT-5.5',
      },
      {
        id: 'gpt-5.5',
        label: 'GPT-5.5',
      },
      {
        id: 'gpt-5.4',
        label: 'GPT-5.4',
      },
      {
        id: 'gpt-5.4-mini-2026-03-17',
        label: 'GPT-5.4 mini',
      },
      {
        id: 'gpt-5.4-mini',
        label: 'GPT-5.4 mini',
      },
      {
        id: 'gpt-5.4-pro',
        label: 'GPT-5.4 Pro',
      },
      {
        id: 'gpt-5.5-pro-2026-04-10',
        label: 'GPT-5.5 Pro',
      },
      {
        id: 'gpt-5.5-pro',
        label: 'GPT-5.5 Pro',
      },
    ])
    // The host's default (`gpt-4.5-preview`) is uncurated, so the default
    // selection falls to the first curated row — now the GPT-6 Astra snapshot.
    expect(configuredCatalog?.defaultSelection).toEqual({
      providerId: 'openai',
      modelId: 'gpt-6-astra-2026-09-03',
    })
  })

  it('applies the built-in provider configs for anthropic and google', () => {
    const catalog: BrowserLlmCatalog = {
      providers: [
        {
          id: 'anthropic',
          label: 'Anthropic',
          iconSvg: '<svg />',
          enabled: true,
          defaultModelId: 'claude-sonnet-4-6',
          models: [
            {
              id: 'claude-sonnet-4-6',
              label: 'claude-sonnet-4-6',
              enabled: true,
            },
            {
              id: 'claude-haiku-4-5-20251001',
              label: 'claude-haiku-4-5-20251001',
              enabled: true,
            },
          ],
        },
        {
          id: 'google',
          label: 'Google',
          iconSvg: '<svg />',
          enabled: true,
          defaultModelId: 'gemini-3-pro-preview',
          models: [
            {
              id: 'gemini-3-pro-preview',
              label: 'gemini-3-pro-preview',
              enabled: true,
            },
            {
              id: 'gemini-3-flash-preview',
              label: 'gemini-3-flash-preview',
              enabled: true,
            },
            {
              id: 'gemini-3.1-flash-lite-preview',
              label: 'gemini-3.1-flash-lite-preview',
              enabled: true,
            },
            {
              id: 'gemini-2.5-pro',
              label: 'gemini-2.5-pro',
              enabled: true,
            },
            {
              id: 'gemini-2.5-flash',
              label: 'gemini-2.5-flash',
              enabled: true,
            },
            {
              id: 'gemini-2.5-flash-lite',
              label: 'gemini-2.5-flash-lite',
              enabled: true,
            },
          ],
        },
      ],
    }

    const configuredCatalog = createConfiguredModelCatalog(
      catalog,
      NEXUS_MODEL_CONFIG,
    )

    // Anthropic's `/v1/models` returns the date-suffixed snapshot id
    // (`claude-haiku-4-5-20251001`) but the popup picks by canonical id
    // (`claude-haiku-4-5`). When a curated rule (Fable 5.1, Fable 5,
    // Sonnet 5) has no real match at all the catalog still surfaces the
    // synthesized canonical entry, so the popup row remains a valid pick
    // target. Curated order = picker order: newest Fable first.
    expect(configuredCatalog?.providers.map(provider => ({
      id: provider.id,
      models: provider.models.map(model => ({
        id: model.id,
        label: model.label,
      })),
    }))).toEqual([
      {
        id: 'anthropic',
        models: [
          {
            id: 'claude-fable-5-1',
            label: 'Fable 5.1',
          },
          {
            id: 'claude-fable-5',
            label: 'Fable 5',
          },
          {
            id: 'claude-opus-5-5',
            label: 'Opus 5.5',
          },
          {
            id: 'claude-opus-5',
            label: 'Opus 5',
          },
          {
            id: 'claude-opus-4-8',
            label: 'Opus 4.8',
          },
          {
            id: 'claude-opus-4-7',
            label: 'Opus 4.7',
          },
          {
            id: 'claude-opus-4-6',
            label: 'Opus 4.6',
          },
          {
            id: 'claude-sonnet-5-5',
            label: 'Sonnet 5.5',
          },
          {
            id: 'claude-sonnet-5',
            label: 'Sonnet 5',
          },
          {
            id: 'claude-sonnet-4-6',
            label: 'Sonnet 4.6',
          },
          {
            id: 'claude-haiku-4-5-20251001',
            label: 'Haiku 4.5',
          },
          {
            id: 'claude-haiku-4-5',
            label: 'Haiku 4.5',
          },
        ],
      },
      {
        id: 'google',
        // Family by family — each row's verified version, then the versions
        // it names, newest first — and the fixed preview rows last.
        models: [
          {
            id: 'gemini-3.8-flash',
            label: 'Gemini 3.8 Flash',
          },
          {
            id: 'gemini-3.7-flash',
            label: 'Gemini 3.7 Flash',
          },
          {
            id: 'gemini-3.6-flash',
            label: 'Gemini 3.6 Flash',
          },
          {
            id: 'gemini-3.5-flash',
            label: 'Gemini 3.5 Flash',
          },
          {
            id: 'gemini-2.5-flash',
            label: 'Gemini 2.5 Flash',
          },
          {
            id: 'gemini-3.5-flash-lite',
            label: 'Gemini 3.5 Flash-Lite',
          },
          {
            id: 'gemini-2.5-flash-lite',
            label: 'Gemini 2.5 Flash-Lite',
          },
          {
            id: 'gemini-2.5-pro',
            label: 'Gemini 2.5 Pro',
          },
          {
            id: 'gemini-3-pro-preview',
            label: 'Gemini 3.1 Pro Preview',
          },
          {
            id: 'gemini-3-flash-preview',
            label: 'Gemini 3 Flash Preview',
          },
          {
            id: 'gemini-3.1-flash-lite-preview',
            label: 'Gemini 3.1 Flash-Lite Preview',
          },
        ],
      },
    ])
  })

  it('applies the built-in Ollama config labels for current families', () => {
    const catalog: BrowserLlmCatalog = {
      providers: [
        {
          id: 'ollama',
          label: 'Ollama',
          iconSvg: '<svg />',
          enabled: true,
          defaultModelId: 'gpt-oss:20b',
          models: [
            {
              id: 'gpt-oss:20b',
              label: 'gpt-oss',
              enabled: true,
            },
            {
              id: 'qwen3-coder:30b',
              label: 'qwen3-coder',
              enabled: true,
            },
            {
              id: 'gemma4:27b',
              label: 'gemma4',
              enabled: true,
            },
            {
              id: 'phi4:14b',
              label: 'phi4',
              enabled: true,
            },
          ],
        },
      ],
    }

    const configuredCatalog = createConfiguredModelCatalog(
      catalog,
      NEXUS_MODEL_CONFIG,
    )

    // The Ollama curated config carries 17 canonical patterns. For each
    // one we now publish a synthesized canonical entry (e.g. `gpt-oss`,
    // `qwen3-coder`) so popup picks resolve through `isSelectionEnabled`,
    // alongside the size-tagged real ids returned by `/api/tags`.
    expect(configuredCatalog?.providers[0]?.models.map(model => ({
      id: model.id,
      label: model.label,
    }))).toEqual([
      { id: 'gpt-oss:20b', label: 'GPT-OSS' },
      { id: 'gpt-oss', label: 'GPT-OSS' },
      { id: 'qwen3.5', label: 'Qwen 3.5' },
      { id: 'qwen3-coder:30b', label: 'Qwen 3 Coder' },
      { id: 'qwen3-coder', label: 'Qwen 3 Coder' },
      { id: 'qwen2.5-coder', label: 'Qwen 2.5 Coder' },
      { id: 'qwen2.5', label: 'Qwen 2.5' },
      { id: 'gemma4:27b', label: 'Gemma 4' },
      { id: 'gemma4', label: 'Gemma 4' },
      { id: 'llama3.3', label: 'Llama 3.3' },
      { id: 'mistral-small', label: 'Mistral Small' },
      { id: 'mistral-nemo', label: 'Mistral Nemo' },
      { id: 'deepseek-v3', label: 'DeepSeek V3' },
      { id: 'deepseek-coder-v2', label: 'DeepSeek Coder V2' },
      { id: 'llama3', label: 'Llama 3' },
      { id: 'mistral', label: 'Mistral' },
      { id: 'codellama', label: 'Code Llama' },
      { id: 'gemma2', label: 'Gemma 2' },
      { id: 'phi4:14b', label: 'Phi 4' },
      { id: 'phi4', label: 'Phi 4' },
      { id: 'phi3', label: 'Phi 3' },
    ])
  })

  it('prefers the first enabled raw model for a configured entry', () => {
    const config: NexusModelConfig = {
      providers: [
        {
          providerId: 'openai',
          models: [
            {
              model: 'gpt-5.5',
              name: 'GPT-5.5',
              exclude: ['mini', 'nano', 'codex', 'high', 'pro'],
            },
          ],
        },
      ],
    }

    const catalog: BrowserLlmCatalog = {
      providers: [
        {
          id: 'openai',
          label: 'OpenAI',
          iconSvg: '<svg />',
          enabled: true,
          defaultModelId: 'gpt-5.5-2026-03-01',
          models: [
            {
              id: 'gpt-5.5-2026-03-01',
              label: 'GPT-5.5 March',
              enabled: false,
            },
            {
              id: 'gpt-5.5-2026-04-01',
              label: 'GPT-5.5 April',
              enabled: true,
            },
          ],
        },
      ],
    }

    const configuredCatalog = createConfiguredModelCatalog(catalog, config)
    const openaiProvider = configuredCatalog?.providers[0]

    // The matched real-id wins as the catalog default, but we also splice
    // in the synthesized canonical id so the popup can pick by it.
    expect(openaiProvider?.models.map(model => model.id)).toEqual([
      'gpt-5.5-2026-04-01',
      'gpt-5.5',
    ])
    expect(configuredCatalog?.defaultSelection).toEqual({
      providerId: 'openai',
      modelId: 'gpt-5.5-2026-04-01',
    })
  })

  it('synthesizes the curated DeepSeek catalog entries and drops the retired V4 Flash id', () => {
    const catalog: BrowserLlmCatalog = {
      providers: [
        {
          id: 'deepseek',
          label: 'DeepSeek',
          iconSvg: '<svg />',
          enabled: true,
          defaultModelId: 'deepseek-v4-pro',
          models: [
            // `/models` kept listing the retired alias for a while after
            // its retirement (it is "temporarily routed" to V4.1 Flash); the
            // curated filter must not surface it.
            {
              id: 'deepseek-v4-flash',
              label: 'deepseek-v4-flash',
              enabled: true,
            },
            {
              id: 'deepseek-flash',
              label: 'deepseek-flash',
              enabled: true,
            },
            {
              id: 'deepseek-v4-pro',
              label: 'deepseek-v4-pro',
              enabled: true,
            },
          ],
        },
      ],
    }

    const configuredCatalog = createConfiguredModelCatalog(
      catalog,
      NEXUS_MODEL_CONFIG,
    )
    const deepseekProvider = configuredCatalog?.providers.find(
      provider => provider.id === 'deepseek',
    )

    // The two current ids returned by `/models` match the curated rules
    // directly and are relabeled. `deepseek-v4-flash` was retired
    // (its successor is `deepseek-flash`, DeepSeek-V4.1-Flash)
    // and `deepseek-chat` / `deepseek-reasoner`, so exactly
    // the two current rows surface.
    expect(deepseekProvider?.models.map(model => ({
      id: model.id,
      label: model.label,
    }))).toEqual([
      { id: 'deepseek-v4-pro', label: 'V4 Pro' },
      { id: 'deepseek-flash', label: 'V4.1 Flash' },
    ])
    // Tier ids moved with the row (Flash → Flash), and both rows expose the
    // three real DeepSeek effort levels plus the thinking-off pill.
    expect(NEXUS_MODEL_CONFIG.providers.find(p => p.providerId === 'deepseek'))
      .toMatchObject({
        fastModel: 'deepseek-flash',
        balancedModel: 'deepseek-flash',
        // The Pro line by family: best follows its latest (V4 Pro today).
        bestModel: 'deepseek-v*-pro',
      })
    expect(getTierModelForProvider('deepseek', 'best')).toBe('deepseek-v4-pro')
    for (const model of ['deepseek-v4-pro', 'deepseek-flash']) {
      expect(findConfiguredModel('deepseek', model))
        .toMatchObject({
          defaultThinkingTier: 'high',
          availableThinkingTiers: ['none', 'low', 'high', 'max'],
        })
    }
  })

  it('carries the M2.x line plus M3, and keeps the retired rows out', () => {
    // `MiniMax-Text-01` and `abab6.5s-chat` are gone from MiniMax's served
    // catalog (verified against the release-notes and models-intro
    // pages). `abab6.5s-chat` had been the designated `fastModel`; the tiers
    // now sit on the M2.7 line and M3, — a tier must always
    // match a catalog entry, see the tier-resolution invariant below.
    const minimax = NEXUS_MODEL_CONFIG.providers.find(
      provider => provider.providerId === 'minimax',
    )

    // Two FAMILY rows — the M line (verified at M3) and its `-highspeed`
    // twins (verified at M2.7) — each stating its older versions' differences.
    expect(minimax?.models.map(model => [model.family, model.model.toString(), Object.keys(model.versions ?? {})])).toEqual([
      ['MiniMax-M*', '/^MiniMax-M3$/i', ['2', '2.7', '2.5', '2.1']], // (an integer-like key sorts first)
      ['MiniMax-M*-highspeed', '/^MiniMax-M2\\.7-highspeed$/i', ['2.5', '2.1']],
    ])
    for (const id of ['MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2.7-highspeed', 'MiniMax-M2.5', 'MiniMax-M2.5-highspeed', 'MiniMax-M2.1', 'MiniMax-M2.1-highspeed', 'MiniMax-M2']) {
      expect(findConfiguredModel('minimax', id), id).toBeDefined()
    }
    expect(minimax).toMatchObject({
      fastModel: 'MiniMax-M2.7',
      balancedModel: 'MiniMax-M2.7',
      // Best names the M family and follows its latest (M3 today).
      bestModel: 'MiniMax-M*',
    })
    expect(getTierModelForProvider('minimax', 'best')).toBe('MiniMax-M3')
    // Only M3 takes image input — the M2.x line is text + tool calls.
    expect(
      minimax?.models.filter(model => model.supportsImageInput !== false)
        .map(model => model.name),
    ).toEqual(['MiniMax M3'])

    // `filterMode: 'curated'` is what actually keeps the retired ids off
    // screen: a stale `/models` response that still lists them must not put
    // them back in the picker or make them selectable.
    const catalog: BrowserLlmCatalog = {
      providers: [
        {
          id: 'minimax',
          label: 'MiniMax',
          iconSvg: '<svg />',
          enabled: true,
          defaultModelId: 'MiniMax-Text-01',
          models: [
            {
              id: 'MiniMax-M2',
              label: 'MiniMax-M2',
              enabled: true,
            },
            {
              id: 'MiniMax-Text-01',
              label: 'MiniMax-Text-01',
              enabled: true,
            },
            {
              id: 'abab6.5s-chat',
              label: 'abab6.5s-chat',
              enabled: true,
            },
          ],
        },
      ],
    }

    const configuredCatalog = createConfiguredModelCatalog(
      catalog,
      NEXUS_MODEL_CONFIG,
    )
    const minimaxProvider = configuredCatalog?.providers.find(
      provider => provider.id === 'minimax',
    )

    // Curated mode synthesizes a row for every curated rule with no live
    // match, so the picker shows the whole lineup in curated order — and the
    // retired ids the fake `/models` still returns are absent from it.
    expect(minimaxProvider?.models.map(model => ({
      id: model.id,
      label: model.label,
    }))).toEqual([
      // The M family (verified version, then the versions it names, newest
      // first), then its `-highspeed` twins.
      { id: 'MiniMax-M3', label: 'MiniMax M3' },
      { id: 'MiniMax-M2.7', label: 'MiniMax M2.7' },
      { id: 'MiniMax-M2.5', label: 'MiniMax M2.5' },
      { id: 'MiniMax-M2.1', label: 'MiniMax M2.1' },
      { id: 'MiniMax-M2', label: 'MiniMax M2' },
      { id: 'MiniMax-M2.7-highspeed', label: 'MiniMax M2.7 Highspeed' },
      { id: 'MiniMax-M2.5-highspeed', label: 'MiniMax M2.5 Highspeed' },
      { id: 'MiniMax-M2.1-highspeed', label: 'MiniMax M2.1 Highspeed' },
    ])
    for (const retired of ['MiniMax-Text-01', 'abab6.5s-chat']) {
      expect(isSelectionEnabled(configuredCatalog, {
        providerId: 'minimax',
        modelId: retired,
      }), `${retired} is retired and must not be selectable`).toBe(false)
    }
  })

  it('alias-hides the date-suffixed snapshot row next to its synthesized curated twin', () => {
    // Regression: Anthropic's /v1/models returns the dated snapshot id
    // (`claude-haiku-4-5-20251001`) while the curated rule synthesizes the
    // alias id (`claude-haiku-4-5`). Both rows carry the curated label, so
    // the picker showed "Claude Haiku 4.5" twice.
    const config: NexusModelConfig = {
      providers: [
        {
          providerId: 'anthropic',
          models: [
            {
              model: createAnthropicModelPattern('claude-haiku-4-5'),
              name: 'Claude Haiku 4.5',
            },
          ],
        },
      ],
    }

    const catalog: BrowserLlmCatalog = {
      providers: [
        {
          id: 'anthropic',
          label: 'Anthropic',
          iconSvg: '<svg />',
          enabled: true,
          defaultModelId: 'claude-haiku-4-5-20251001',
          models: [
            {
              id: 'claude-haiku-4-5-20251001',
              label: 'Claude Haiku 4.5 (2025-10-01)',
              enabled: true,
            },
          ],
        },
      ],
    }

    const configuredCatalog = createConfiguredModelCatalog(catalog, config)
    const anthropicProvider = configuredCatalog?.providers.find(
      provider => provider.id === 'anthropic',
    )

    // Both ids stay selectable — persisted per-thread `llmSelection` and the
    // browser default may hold either form.
    expect(isSelectionEnabled(configuredCatalog, {
      providerId: 'anthropic',
      modelId: 'claude-haiku-4-5-20251001',
    })).toBe(true)
    expect(isSelectionEnabled(configuredCatalog, {
      providerId: 'anthropic',
      modelId: 'claude-haiku-4-5',
    })).toBe(true)

    // ...but the snapshot row is marked as an alias of the curated row, so
    // pickers list exactly one "Claude Haiku 4.5".
    expect(anthropicProvider?.models.map(model => ({
      id: model.id,
      label: model.label,
      pickerAliasId: model.pickerAliasId,
    }))).toEqual([
      {
        id: 'claude-haiku-4-5-20251001',
        label: 'Claude Haiku 4.5',
        pickerAliasId: 'claude-haiku-4-5',
      },
      {
        id: 'claude-haiku-4-5',
        label: 'Claude Haiku 4.5',
        pickerAliasId: undefined,
      },
    ])
  })

  it('does NOT alias-hide a real id that equals the curated id exactly', () => {
    const config: NexusModelConfig = {
      providers: [
        {
          providerId: 'anthropic',
          models: [
            {
              model: createAnthropicModelPattern('claude-sonnet-5'),
              name: 'Claude Sonnet 5',
            },
          ],
        },
      ],
    }

    const catalog: BrowserLlmCatalog = {
      providers: [
        {
          id: 'anthropic',
          label: 'Anthropic',
          iconSvg: '<svg />',
          enabled: true,
          defaultModelId: 'claude-sonnet-5',
          models: [
            {
              id: 'claude-sonnet-5',
              label: 'Claude Sonnet 5',
              enabled: true,
            },
          ],
        },
      ],
    }

    const configuredCatalog = createConfiguredModelCatalog(catalog, config)
    const anthropicProvider = configuredCatalog?.providers.find(
      provider => provider.id === 'anthropic',
    )

    // The exact-id match dedups the synthetic entirely — one row, no alias.
    expect(anthropicProvider?.models.map(model => ({
      id: model.id,
      pickerAliasId: model.pickerAliasId,
    }))).toEqual([
      { id: 'claude-sonnet-5', pickerAliasId: undefined },
    ])
  })

  it('passes custom-endpoint discovered models through unchanged (passthrough)', () => {
    // The two generic custom endpoints are declared `passthrough` with no
    // curated rows, so whatever the endpoint's /v1/models discovery returned
    // surfaces verbatim — for both wire dialects.
    for (const providerId of ['custom-openai', 'custom-anthropic']) {
      const entry = NEXUS_MODEL_CONFIG.providers.find(
        provider => provider.providerId === providerId,
      )
      expect(entry?.filterMode).toBe('passthrough')

      const catalog: BrowserLlmCatalog = {
        providers: [
          {
            id: providerId,
            label:
              providerId === 'custom-anthropic'
                ? 'Custom (Anthropic-compatible)'
                : 'Custom (OpenAI-compatible)',
            iconSvg: '',
            enabled: true,
            defaultModelId: 'cursor-fast',
            models: [
              { id: 'cursor-fast', label: 'cursor-fast', enabled: true },
              { id: 'gpt-4o-ish', label: 'gpt-4o-ish', enabled: true },
            ],
          },
        ],
      }

      const configuredCatalog = createConfiguredModelCatalog(
        catalog,
        NEXUS_MODEL_CONFIG,
      )
      const provider = configuredCatalog?.providers.find(
        p => p.id === providerId,
      )
      expect(provider?.models.map(model => model.id)).toEqual([
        'cursor-fast',
        'gpt-4o-ish',
      ])
    }
  })
  it('curates the current Kimi Code model lineup and tier assignments', () => {
    const kimi = NEXUS_MODEL_CONFIG.providers.find(
      provider => provider.providerId === 'kimi',
    )

    // `k3-256k` joins, and `kimi-for-coding` became the K2.8
    // Preview at 1M context (it was K2.7 Code at 256K); only the highspeed
    // row is still the 256K K2.7.
    expect(kimi?.models.map(model => model.model.toString())).toEqual([
      '/^k3$/i',
      '/^k3-256k$/i',
      '/^kimi-for-coding$/i',
      '/^kimi-for-coding-highspeed$/i',
    ])
    // The windows are the catalog's (the rows leave them unset).
    expect(['k3', 'k3-256k', 'kimi-for-coding', 'kimi-for-coding-highspeed']
      .map(id => findConfiguredModel('kimi', id)?.contextWindow)).toEqual([
      1_048_576,
      262_144,
      1_048_576,
      262_144,
    ])
    expect(kimi).toMatchObject({
      // fast tier deliberately pins the STANDARD coding model, not
      // -highspeed: the highspeed variant burns ~3x quota for its 6x speed
      // (2287df5), which is the wrong trade for background fast-model calls
      // (title naming, forks).
      fastModel: 'kimi-for-coding',
      balancedModel: 'kimi-for-coding',
      // Best names the K family and follows its latest (K3 today).
      bestModel: 'k*',
    })
    expect(getTierModelForProvider('kimi', 'best')).toBe('k3')
    // Effort vocabulary per the model page (re-read): low/high/max
    // on every non-highspeed row, default `high` on the K3 rows and `max` on
    // the K2.8 row; highspeed is "Thinking: ON" only, so no pills there.
    expect(kimi?.models[0]).toMatchObject({
      defaultThinkingTier: 'high',
      availableThinkingTiers: ['none', 'low', 'high', 'max'],
    })
    expect(kimi?.models[1]).toMatchObject({
      defaultThinkingTier: 'high',
      availableThinkingTiers: ['none', 'low', 'high', 'max'],
    })
    expect(kimi?.models[2]).toMatchObject({
      defaultThinkingTier: 'max',
      availableThinkingTiers: ['none', 'low', 'high', 'max'],
    })
    expect(kimi?.models[3]?.availableThinkingTiers).toBeUndefined()
  })
  it('gates the qwen thinking tiers per model (3.8-max has NO `none` pill)', () => {
    // The DashScope / token-plan gateway RESTRICTS `enable_thinking` to
    // True for qwen3.8-max (sending
    // `enable_thinking: false` → HTTP 400 "The value of the
    // enable_thinking parameter is restricted to True."). A `none` pill
    // on that model 400ed every turn it was picked on, so the catalog
    // must NEVER offer `none` there.
    const qwen = NEXUS_MODEL_CONFIG.providers.find(
      provider => provider.providerId === 'qwen',
    )
    const max = qwen?.models.find(
      m => m.model.toString() === '/^qwen3\\.8-max$/i',
    )
    expect(max?.availableThinkingTiers).toEqual(['max'])
    expect(max?.availableThinkingTiers).not.toContain('none')
  })

  // The GLM line belongs to the GLM provider; the Qwen catalog carried a
  // stray glm-5.2 row.
  it('carries only Qwen models in the qwen catalog', () => {
    const qwen = NEXUS_MODEL_CONFIG.providers.find(
      provider => provider.providerId === 'qwen',
    )
    for (const m of qwen?.models ?? []) {
      expect(m.model.toString(), m.name).toMatch(/qwen/i)
    }
  })

  it('resolves every curated provider tier id against its own model list', () => {
    // Every curated provider's tier id (`fastModel` / `balancedModel` / `bestModel`) must match a `models[]` entry, or
    // it resolves to no config. Asserted through the public resolvers (`patternMatches` is module-private);
    // `passthrough` providers declare no tier ids.
    const TIER_FIELDS = ['fastModel', 'balancedModel', 'bestModel'] as const
    for (const provider of NEXUS_MODEL_CONFIG.providers) {
      if (provider.filterMode !== 'curated') continue
      for (const field of TIER_FIELDS) {
        if (provider[field] === undefined) continue
        // A tier field names a model id or a FAMILY (`claude-haiku-*`); the
        // id it means now is what must be catalogued.
        const tier = field === 'fastModel' ? 'fast' : field === 'balancedModel' ? 'balanced' : 'best'
        const modelId = getTierModelForProvider(provider.providerId, tier)
        expect(modelId, `${provider.providerId}.${field} = "${provider[field]}" resolves to no model id`).toBeDefined()
        if (modelId === undefined) continue
        expect(modelId, 'a concrete id, never a family key').not.toContain('*')
        const where =
          `${provider.providerId}.${field} = "${provider[field]}" (${modelId}) resolves to no ` +
          `catalog entry — it matches none of that provider's model ` +
          `patterns (${provider.models
            .map(entry => String(entry.model))
            .join(', ')})`
        expect(
          getDefaultMaxOutputTokensForModel(modelId, provider.providerId),
          where,
        ).toBeDefined()
        expect(
          outputBudgetOf(modelId, provider.providerId),
          where,
        ).toBeDefined()
      }
    }
  })

  it('never points a tier id at a `-highspeed` row', () => {
    // No tier id may name a `-highspeed` twin (a same-model variant that burns more quota): tier ids serve background
    // traffic. The twins stay pickable rows.
    const offenders: string[] = []
    const TIER_FIELDS = ['fastModel', 'balancedModel', 'bestModel'] as const
    for (const provider of NEXUS_MODEL_CONFIG.providers) {
      if (provider.filterMode !== 'curated') continue
      for (const field of TIER_FIELDS) {
        const modelId = provider[field]
        if (modelId === undefined) continue
        if (modelId.toLowerCase().endsWith('-highspeed')) {
          offenders.push(`${provider.providerId}.${field} = "${modelId}"`)
        }
      }
    }
    expect(
      offenders,
      'a `-highspeed` variant trades quota for latency; tier ids must ' +
        'name the standard row (see kimi.ts / minimax.ts)',
    ).toEqual([])
  })
})

describe('extractOnlineModelIds', () => {
  it('parses the OpenAI/Anthropic-style {data: [{id}]} shape', () => {
    const raw = JSON.stringify({
      object: 'list',
      data: [
        { id: 'gpt-5.5', object: 'model' },
        { id: 'gpt-5.6-codex', object: 'model' },
      ],
    })
    expect(extractOnlineModelIds(raw)).toEqual(['gpt-5.5', 'gpt-5.6-codex'])
  })

  it('parses the Google/Ollama-style {models: [{name}]} shape', () => {
    const raw = JSON.stringify({
      models: [
        { name: 'models/gemini-2.5-pro' },
        { name: 'models/gemini-2.5-flash' },
      ],
    })
    expect(extractOnlineModelIds(raw)).toEqual([
      'models/gemini-2.5-pro',
      'models/gemini-2.5-flash',
    ])
  })

  it('parses a bare top-level array and string entries', () => {
    expect(
      extractOnlineModelIds(JSON.stringify([{ id: 'a' }, 'b', { model: 'c' }])),
    ).toEqual(['a', 'b', 'c'])
  })

  it('prefers id over name over model on a single entry', () => {
    const raw = JSON.stringify({
      data: [{ id: 'the-id', name: 'the-name', model: 'the-model' }],
    })
    expect(extractOnlineModelIds(raw)).toEqual(['the-id'])
  })

  it('skips entries without a usable identifier but keeps the rest', () => {
    const raw = JSON.stringify({
      data: [{ id: 'kept' }, { object: 'model' }, 42, null, { id: '' }],
    })
    expect(extractOnlineModelIds(raw)).toEqual(['kept'])
  })

  it('returns undefined (not []) for malformed JSON and listless payloads', () => {
    expect(extractOnlineModelIds('not json {')).toBeUndefined()
    expect(extractOnlineModelIds(JSON.stringify({ error: 'nope' }))).toBeUndefined()
    expect(extractOnlineModelIds(JSON.stringify(null))).toBeUndefined()
  })

  it('returns [] for an empty online list so it stays distinct from "unavailable"', () => {
    expect(extractOnlineModelIds(JSON.stringify({ data: [] }))).toEqual([])
  })
})

// Shared sub-session tier helpers (engine/contextWindow.ts): the Agent tool's
// `model: 'fast'|'balanced'|'best'` param and queryFastModel's utility
// one-shots resolve through these. Priority: settings override (reserved
// stub, always undefined today) → per-provider config field → parent model.
describe('sub-session model tier helpers', () => {
  const TIER_CONFIG: NexusModelConfig = {
    providers: [
      {
        providerId: 'acme',
        models: [],
        fastModel: 'acme-mini',
        balancedModel: 'acme-mid',
        bestModel: 'acme-ultra',
      },
      // No tier fields declared → every tier falls back to the parent.
      { providerId: 'bare', models: [] },
    ],
  }

  it('resolves each tier from its provider config field, with the parent as the failure-fallback tail', () => {
    // Ordered first-to-last: the resolved tier model, then the parent —
    // callers retry the tail once when the head model fails at runtime.
    expect(getFastModel('acme', 'acme-parent', 'other', TIER_CONFIG)).toEqual([
      { providerId: 'acme', modelId: 'acme-mini' },
      { providerId: 'acme', modelId: 'acme-parent' },
    ])
    expect(getBalancedModel('acme', 'acme-parent', 'other', TIER_CONFIG)).toEqual([
      { providerId: 'acme', modelId: 'acme-mid' },
      { providerId: 'acme', modelId: 'acme-parent' },
    ])
    expect(topTierModel('acme', 'acme-parent', 'other', TIER_CONFIG)).toEqual([
      { providerId: 'acme', modelId: 'acme-ultra' },
      { providerId: 'acme', modelId: 'acme-parent' },
    ])
    // A tier resolving to the parent's own id short-circuits to a single
    // parent entry — no self-fallback tail.
    expect(getFastModel('acme', 'acme-mini', 'other', TIER_CONFIG)).toEqual([
      { providerId: 'acme', modelId: 'acme-mini' },
    ])
  })

  it('falls back to the parent model when the tier field is unset or the provider is unknown (never a third model)', () => {
    // EVERY tier falls back to the parent when its provider field is unset —
    // fast, balanced, and best alike ('bare' declares none of the three).
    expect(getFastModel('bare', 'bare-parent', 'other', TIER_CONFIG)).toEqual([
      { providerId: 'bare', modelId: 'bare-parent' },
    ])
    expect(getBalancedModel('bare', 'bare-parent', 'other', TIER_CONFIG)).toEqual([
      { providerId: 'bare', modelId: 'bare-parent' },
    ])
    expect(topTierModel('bare', 'bare-parent', 'agent_tool', TIER_CONFIG)).toEqual([
      { providerId: 'bare', modelId: 'bare-parent' },
    ])
    // A provider missing from the config entirely behaves the same.
    expect(getFastModel('nope', 'parent-m', 'other', TIER_CONFIG)).toEqual([
      { providerId: 'nope', modelId: 'parent-m' },
    ])
    // And a partially-marked provider falls back only for its UNSET tiers:
    // fast configured, best not.
    const PARTIAL: NexusModelConfig = {
      providers: [{ providerId: 'semi', models: [], fastModel: 'semi-mini' }],
    }
    expect(getFastModel('semi', 'semi-parent', 'other', PARTIAL)).toEqual([
      { providerId: 'semi', modelId: 'semi-mini' },
      { providerId: 'semi', modelId: 'semi-parent' },
    ])
    expect(topTierModel('semi', 'semi-parent', 'other', PARTIAL)).toEqual([
      { providerId: 'semi', modelId: 'semi-parent' },
    ])
  })

  it('sessionType is reserved plumbing for the raw tier helpers — identical result for every value', () => {
    const kinds: TierModelSessionType[] = [
      'agent_tool',
      'session_title',
      'memory_recall',
      'web_fetch',
      'prompt_hook',
      'memory_extract',
      'memory_consolidate',
      'skill_fork',
      'hook_agent',
      'other',
    ]
    for (const kind of kinds) {
      expect(getFastModel('acme', 'x', kind, TIER_CONFIG)).toEqual([
        { providerId: 'acme', modelId: 'acme-mini' },
        { providerId: 'acme', modelId: 'x' },
      ])
    }
  })

  // The per-session-type policy (getModelForSessionType): titles/WebFetch/
  // hooks = fast, memory recall = balanced, compaction = inherit (the
  // session's main-loop model).
  it('routes each session type to its tier', () => {
    // fast consumers → the provider's fastModel (+ the parent fallback tail).
    for (const st of ['session_title', 'web_fetch', 'prompt_hook', 'other'] as const) {
      expect(getSessionTypeTier(st)).toBe('fast')
      expect(getModelForSessionType(st, 'acme', 'acme-parent', TIER_CONFIG)).toEqual([
        { providerId: 'acme', modelId: 'acme-mini' },
        { providerId: 'acme', modelId: 'acme-parent' },
      ])
    }
    // memory recall → balanced.
    expect(getSessionTypeTier('memory_recall')).toBe('balanced')
    expect(
      getModelForSessionType('memory_recall', 'acme', 'acme-parent', TIER_CONFIG),
    ).toEqual([
      { providerId: 'acme', modelId: 'acme-mid' },
      { providerId: 'acme', modelId: 'acme-parent' },
    ])
    // compact + agent_tool + the fork-backed kinds default → inherit the
    // parent model untouched (single candidate, no fallback tail).
    for (const st of [
      'compact',
      'agent_tool',
      'memory_extract',
      'memory_consolidate',
      'skill_fork',
      'hook_agent',
    ] as const) {
      expect(getSessionTypeTier(st)).toBe('inherit')
      expect(getModelForSessionType(st, 'acme', 'acme-parent', TIER_CONFIG)).toEqual([
        { providerId: 'acme', modelId: 'acme-parent' },
      ])
    }
    // Unconfigured provider → parent fallback, same as the tier helpers.
    expect(
      getModelForSessionType('memory_recall', 'bare', 'bare-parent', TIER_CONFIG),
    ).toEqual([{ providerId: 'bare', modelId: 'bare-parent' }])
  })

  it('ships the tier ladder for the real anthropic provider + keeps the raw accessors fallback-free', () => {
    // The shipped config the Agent-tool tier tests and docs rely on.
    expect(getTierModelForProvider('anthropic', 'fast')).toBe('claude-haiku-4-5')
    expect(getTierModelForProvider('anthropic', 'balanced')).toBe('claude-sonnet-5-5')
    // `best` tracks the Fable line — 5.1 succeeded 5. Opus 5.5
    // is a row, not a tier target: Anthropic still names Fable
    // 5.1 for the most demanding work, and the balanced slot stays in the
    // Sonnet price class.
    expect(getTierModelForProvider('anthropic', 'best')).toBe('claude-fable-5-1')
    expect(findConfiguredModel('anthropic', 'claude-opus-5-5'))
      .toMatchObject({
        promptProfile: 'lean',
        todoTools: false,
        defaultThinkingTier: 'medium',
        availableThinkingTiers: ['low', 'medium', 'high', 'extra-high', 'max'],
        contextWindow: 1_000_000,
        maxOutputTokens: 128_000,
      })
    // OpenAI's three tiers moved to the GPT-6 family, each
    // within its class (Luna → Luna, Terra/Sol workhorse → Sol, Sol → Astra).
    expect(getTierModelForProvider('openai', 'fast')).toBe('gpt-6-luna')
    // The Sol family's verified version is 6.1, and the
    // balanced slot follows the family to it.
    expect(getTierModelForProvider('openai', 'balanced')).toBe('gpt-6.1-sol')
    expect(getTierModelForProvider('openai', 'best')).toBe('gpt-6-astra')
    // GPT-6.1 Sol rejects `none` like Astra; 6 Sol and 5.6 Sol keep it.
    expect(
      findConfiguredModel('openai', 'gpt-6.1-sol')
        ?.availableThinkingTiers,
    ).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    // Astra is the one GPT-6 row that rejects `none` (HTTP 400).
    expect(
      findConfiguredModel('openai', 'gpt-6-astra')
        ?.availableThinkingTiers,
    ).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(
      findConfiguredModel('openai', 'gpt-6-sol')
        ?.availableThinkingTiers,
    ).toEqual(['none', 'low', 'medium', 'high', 'xhigh', 'max'])
    // The Codex backend lists Astra + Sol but not Luna (live-read),
    // so chatgpt-pro's fast slot stays on 5.6 Luna and its
    // Astra row follows the catalog's own `default_reasoning_level` (low).
    expect(getTierModelForProvider('chatgpt-pro', 'fast')).toBe('gpt-5.6-luna')
    expect(getTierModelForProvider('chatgpt-pro', 'balanced')).toBe('gpt-6-sol')
    expect(getTierModelForProvider('chatgpt-pro', 'best')).toBe('gpt-6-astra')
    expect(findConfiguredModel('chatgpt-pro', 'gpt-6-astra'))
      .toMatchObject({ defaultThinkingTier: 'low', contextWindow: 272_000 })
    // No `gpt-6-luna` row is OFFERED: the Luna family's verified version is
    // 5.6, and a version joins only when the Codex catalog lists it. (The
    // family row does speak for the id — the day it is listed it needs no
    // edit, and the fast tier follows it.)
    expect(createConfiguredProvider({ id: 'chatgpt-pro', label: 'ChatGPT', iconSvg: '', enabled: true, models: [] })
      .models.map(model => model.id)).not.toContain('gpt-6-luna')
    expect(findConfiguredModel('chatgpt-pro', 'gpt-6-luna'))
      .toMatchObject({ contextWindow: 272_000, family: 'gpt-*-luna' })
    // Raw accessors keep their no-fallback contract (callers use them for
    // "is the tier configured at all?" warn decisions).
    expect(getFastModelForProvider('anthropic')).toBe('claude-haiku-4-5')
    expect(getFastModelForProvider(undefined)).toBeUndefined()
    expect(getTierModelForProvider('ollama', 'best')).toBeUndefined()
  })
})

// The USER settings layer over the tier helpers: the global cross-provider
// tier DICTIONARY (`modelTiers`) and the per-session-type ROUTER
// (`sessionModelPolicy`). Snapshot-injected (tierSettingsSnapshot.ts) so the
// pure helpers pick it up without threading settings through callers.
describe('sub-session model routing settings (dictionary + router)', () => {
  const TIER_CONFIG: NexusModelConfig = {
    providers: [
      {
        providerId: 'acme',
        models: [],
        fastModel: 'acme-mini',
        balancedModel: 'acme-mid',
        bestModel: 'acme-ultra',
      },
      { providerId: 'bare', models: [] },
    ],
  }

  afterEach(() => {
    resetSessionModelSettingsSnapshot()
  })

  it('a dictionary pin redefines the tier globally — cross-provider, any session type, any parent', () => {
    setSessionModelSettingsSnapshot({
      modelTiers: {
        fast: { providerId: 'deepseek', modelId: 'ds-flash' },
      },
    })
    // The pin beats the parent provider's own ladder (acme HAS fastModel)…
    expect(getFastModel('acme', 'acme-parent', 'other', TIER_CONFIG)).toEqual([
      { providerId: 'deepseek', modelId: 'ds-flash' },
      { providerId: 'acme', modelId: 'acme-parent' },
    ])
    // …applies to ladderless providers…
    expect(getFastModel('bare', 'bare-parent', 'other', TIER_CONFIG)).toEqual([
      { providerId: 'deepseek', modelId: 'ds-flash' },
      { providerId: 'bare', modelId: 'bare-parent' },
    ])
    // …and to every census consumer of the tier.
    expect(
      getModelForSessionType('session_title', 'acme', 'acme-parent', TIER_CONFIG),
    ).toEqual([
      { providerId: 'deepseek', modelId: 'ds-flash' },
      { providerId: 'acme', modelId: 'acme-parent' },
    ])
    // Unpinned tiers keep the ladder resolution.
    expect(topTierModel('acme', 'acme-parent', 'other', TIER_CONFIG)).toEqual([
      { providerId: 'acme', modelId: 'acme-ultra' },
      { providerId: 'acme', modelId: 'acme-parent' },
    ])
  })

  it('a pin carrying a thinkingTier surfaces it on the head candidate only', () => {
    setSessionModelSettingsSnapshot({
      modelTiers: {
        balanced: { providerId: 'acme', modelId: 'acme-mid', thinkingTier: 'high' },
      },
    })
    expect(
      getModelForSessionType('memory_recall', 'acme', 'acme-parent', TIER_CONFIG),
    ).toEqual([
      { providerId: 'acme', modelId: 'acme-mid', thinkingTier: 'high' },
      { providerId: 'acme', modelId: 'acme-parent' },
    ])
  })

  it('a pin equal to the parent short-circuits to a single parent entry', () => {
    setSessionModelSettingsSnapshot({
      modelTiers: { fast: { providerId: 'acme', modelId: 'acme-parent' } },
    })
    expect(getFastModel('acme', 'acme-parent', 'other', TIER_CONFIG)).toEqual([
      { providerId: 'acme', modelId: 'acme-parent' },
    ])
  })

  it('router same-as-parent is a hard pin to the parent — beats the census tier', () => {
    setSessionModelSettingsSnapshot({
      sessionModelPolicy: { session_title: { mode: 'same-as-parent' } },
    })
    expect(
      getModelForSessionType('session_title', 'acme', 'acme-parent', TIER_CONFIG),
    ).toEqual([{ providerId: 'acme', modelId: 'acme-parent' }])
  })

  it('router specific is a hard cross-provider pin with the parent fallback tail', () => {
    setSessionModelSettingsSnapshot({
      sessionModelPolicy: {
        compact: {
          mode: 'specific',
          providerId: 'openai',
          modelId: 'gpt-tiny',
          thinkingTier: 'low',
        },
      },
    })
    expect(
      getModelForSessionType('compact', 'acme', 'acme-parent', TIER_CONFIG),
    ).toEqual([
      { providerId: 'openai', modelId: 'gpt-tiny', thinkingTier: 'low' },
      { providerId: 'acme', modelId: 'acme-parent' },
    ])
    // A specific pin equal to the parent collapses to inherit.
    setSessionModelSettingsSnapshot({
      sessionModelPolicy: {
        compact: { mode: 'specific', providerId: 'acme', modelId: 'acme-parent' },
      },
    })
    expect(
      getModelForSessionType('compact', 'acme', 'acme-parent', TIER_CONFIG),
    ).toEqual([{ providerId: 'acme', modelId: 'acme-parent' }])
  })

  it('router tier re-routes a kind through the dictionary (census override)', () => {
    // compact defaults to inherit; route it to 'fast' → the ladder resolves.
    setSessionModelSettingsSnapshot({
      sessionModelPolicy: { compact: { mode: 'tier', tier: 'fast' } },
    })
    expect(
      getModelForSessionType('compact', 'acme', 'acme-parent', TIER_CONFIG),
    ).toEqual([
      { providerId: 'acme', modelId: 'acme-mini' },
      { providerId: 'acme', modelId: 'acme-parent' },
    ])
    // …and the routed tier still reads the dictionary pin when one exists.
    setSessionModelSettingsSnapshot({
      modelTiers: { fast: { providerId: 'deepseek', modelId: 'ds-flash' } },
      sessionModelPolicy: { memory_extract: { mode: 'tier', tier: 'fast' } },
    })
    expect(
      getModelForSessionType('memory_extract', 'acme', 'acme-parent', TIER_CONFIG),
    ).toEqual([
      { providerId: 'deepseek', modelId: 'ds-flash' },
      { providerId: 'acme', modelId: 'acme-parent' },
    ])
  })

  it('router default (explicit or absent) preserves the census behavior', () => {
    setSessionModelSettingsSnapshot({
      sessionModelPolicy: { session_title: { mode: 'default' } },
    })
    expect(
      getModelForSessionType('session_title', 'acme', 'acme-parent', TIER_CONFIG),
    ).toEqual([
      { providerId: 'acme', modelId: 'acme-mini' },
      { providerId: 'acme', modelId: 'acme-parent' },
    ])
    // The fork-backed kinds stay inherit under default.
    expect(
      getModelForSessionType('memory_consolidate', 'acme', 'acme-parent', TIER_CONFIG),
    ).toEqual([{ providerId: 'acme', modelId: 'acme-parent' }])
  })

  it('exposes hard-vs-soft policy through getSessionModelPolicyFor; "other" is never routable', () => {
    setSessionModelSettingsSnapshot({
      sessionModelPolicy: { agent_tool: { mode: 'same-as-parent' } },
    })
    expect(getSessionModelPolicyFor('agent_tool')).toEqual({
      mode: 'same-as-parent',
    })
    expect(getSessionModelPolicyFor('session_title')).toBeUndefined()
    expect(getSessionModelPolicyFor('other')).toBeUndefined()
  })
})

describe('supportsImageInput capability plumbing', () => {
  // Field-survival guard: a capability flag must ride through ALL THREE
  // hops — the decorated real catalog row, the synthesized curated-alias
  // row, and the wire serializer — or it is silently dropped somewhere
  // between the config table and its consumers.
  const config: NexusModelConfig = {
    providers: [
      {
        providerId: 'openai',
        models: [
          {
            model: 'gpt-4.5',
            name: 'GPT-4.5 Preview',
            supportsImageInput: false,
          },
        ],
      },
    ],
  }

  it('resolves the flag via getSupportsImageInputForModel (false only when annotated)', () => {
    expect(
      getSupportsImageInputForModel('gpt-4.5-preview', 'openai', config),
    ).toBe(false)
    // Unannotated rows and uncatalogued models both default to supported —
    // the gate only closes on explicitly-verified text-only rows.
    expect(getSupportsImageInputForModel('gpt-4o', 'openai', config)).toBe(true)
    expect(getSupportsImageInputForModel(undefined, 'openai', config)).toBe(true)
  })

  it('pins representative live-catalog annotations', () => {
    // Verified text-only rows (vendor-doc citations live on the config rows).
    expect(getSupportsImageInputForModel('deepseek-v4-pro', 'deepseek')).toBe(false)
    // V4.1 Flash is the one DeepSeek row that takes images (vision guide).
    expect(getSupportsImageInputForModel('deepseek-flash', 'deepseek')).toBe(true)
    expect(getSupportsImageInputForModel('MiniMax-M2', 'minimax')).toBe(false)
    expect(getSupportsImageInputForModel('glm-4.6', 'glm')).toBe(false)
    // Verified vision rows keep the default.
    expect(getSupportsImageInputForModel('glm-4v-plus', 'glm')).toBe(true)
    expect(getSupportsImageInputForModel('k3', 'kimi')).toBe(true)
  })

  it('copies the flag onto BOTH the decorated real row and the synthesized alias row', () => {
    const configuredCatalog = createConfiguredModelCatalog(TEST_CATALOG, config)
    const models = configuredCatalog?.providers.find(
      provider => provider.id === 'openai',
    )?.models
    expect(
      models?.map(model => ({
        id: model.id,
        supportsImageInput: model.supportsImageInput,
      })),
    ).toEqual([
      { id: 'gpt-4.5-preview', supportsImageInput: false },
      { id: 'gpt-4.5', supportsImageInput: false },
    ])
  })

  it('survives wire serialization, and stays absent when never set', () => {
    const wire = serializeNexusModelConfig(config)
    expect(wire.providers[0]?.models[0]?.supportsImageInput).toBe(false)

    const unannotated = serializeNexusModelConfig({
      providers: [{ providerId: 'x', models: [{ model: 'm' }] }],
    })
    expect(
      'supportsImageInput' in (unannotated.providers[0]?.models[0] ?? {}),
    ).toBe(false)
  })
})

// Default base URLs are guest-owned: the host compiles none in for API-key
// vendors and applies what the published catalog carries. A provider that
// lost its `defaultBaseUrl` would leave every profile without an override
// unable to reach it at all.
describe('provider defaultBaseUrl', () => {
  const API_KEY_VENDORS = [
    'anthropic',
    'deepseek',
    'glm',
    'google',
    'kimi',
    'minimax',
    'ollama',
    'openai',
    'qwen',
  ]

  it('is set for every API-key vendor and rides the catalog wire', () => {
    const wire = serializeNexusModelConfig(NEXUS_MODEL_CONFIG)
    for (const id of API_KEY_VENDORS) {
      const entry = wire.providers.find(p => p.providerId === id)
      expect(entry?.defaultBaseUrl, id).toMatch(/^https?:\/\/[^/]+/)
    }
  })

  // The Kimi catalog is the Kimi Code line (k3, kimi-for-coding), which only
  // the Coding endpoint serves — api.moonshot.cn does not.
  it('points Kimi at the Kimi Code endpoint', () => {
    const kimi = NEXUS_MODEL_CONFIG.providers.find(p => p.providerId === 'kimi')
    expect(kimi?.defaultBaseUrl).toBe('https://api.kimi.com/coding/v1')
  })

  it('stays off the wire for providers that declare none', () => {
    const wire = serializeNexusModelConfig({
      providers: [{ providerId: 'x', models: [{ model: 'm' }] }],
    })
    expect('defaultBaseUrl' in (wire.providers[0] ?? {})).toBe(false)
  })
})

// A runtime-only provider's rows come from its listing, which only the worker
// fetches; the webview realm sees the catalog alone. Its context ring and
// autocompact countdown read `getContextWindowForModel`, which used to fall
// back to 200K for every OpenRouter model there.
describe('runtime-only provider figures in a realm without the listing', () => {
  afterEach(() => resetEntryResolutions())

  const entryCatalog = (contextWindow: number): BrowserLlmCatalog => ({
    providers: [
      {
        id: 'openrouter',
        label: 'OpenRouter',
        iconSvg: '<svg />',
        enabled: true,
        models: [
          {
            id: 'anthropic/claude-sonnet-*@latest',
            label: 'Claude Sonnet',
            enabled: true,
            contextWindow,
            maxOutputTokens: 128_000,
            entry: {
              kind: 'latest',
              family: 'anthropic/claude-sonnet-*',
              familyLabel: 'Claude Sonnet',
              version: 'latest',
              resolvedId: 'anthropic/claude-sonnet-5.5',
              preview: false,
            },
          },
        ],
        entryFamilies: [],
      },
    ],
  })

  it('resolves the window the catalog states, not the 200K default', () => {
    const config: NexusModelConfig = {
      providers: [{ providerId: 'openrouter', filterMode: 'passthrough', models: [] }],
    }
    const entryId = 'anthropic/claude-sonnet-*@latest'
    expect(contextWindowOf(entryId, 'openrouter', config)).toBe(200_000)

    createConfiguredModelCatalog(entryCatalog(1_000_000), config)
    expect(contextWindowOf(entryId, 'openrouter', config)).toBe(1_000_000)
    expect(outputBudgetOf(entryId, 'openrouter', config)).toBe(128_000)
    expect(getDefaultMaxOutputTokensForModel(entryId, 'openrouter', config)).toBe(32_768)

    // A later catalog replaces the mirrored row instead of stacking on it.
    createConfiguredModelCatalog(entryCatalog(400_000), config)
    expect(contextWindowOf(entryId, 'openrouter', config)).toBe(400_000)
    expect(config.providers[0]!.models).toHaveLength(1)
  })

  it('leaves a realm that already has a rule for the model alone', () => {
    const listed = { model: /^anthropic\/claude-sonnet-5\.5$/, contextWindow: 1_000_000 }
    const config: NexusModelConfig = {
      providers: [{ providerId: 'openrouter', filterMode: 'passthrough', models: [listed] }],
    }
    createConfiguredModelCatalog(entryCatalog(123_456), config)
    expect(config.providers[0]!.models).toEqual([listed])
  })
})

// A provider mod is registered only where its module runs (the worker); the
// webview has no entry for it, so without a mirror its composer meter reads 200K. (F-27)
describe('mod provider figures in a realm without the mod registry', () => {
  const MOD = 'mod.nebius.token-factory'
  const MODEL = 'example-org/Wide-Model-2'

  afterEach(() => {
    resetEntryResolutions()
    resetCustomProviderRecords()
    NEXUS_MODEL_CONFIG.providers.splice(
      0,
      NEXUS_MODEL_CONFIG.providers.length,
      ...NEXUS_MODEL_CONFIG.providers.filter(entry => entry.providerId !== MOD),
    )
  })

  const modCatalog = (providerId: string, contextWindow: number): BrowserLlmCatalog => ({
    providers: [
      {
        id: providerId,
        label: 'Nebius Token Factory',
        iconSvg: '<svg />',
        enabled: true,
        models: [
          {
            id: `${MODEL}@latest`,
            label: 'Wide Model 2',
            enabled: true,
            contextWindow,
            maxOutputTokens: 32_768,
            entry: {
              kind: 'latest',
              family: MODEL,
              familyLabel: 'Wide Model 2',
              version: 'latest',
              resolvedId: MODEL,
              preview: false,
            },
          },
        ],
        entryFamilies: [],
      },
    ],
  })

  it('resolves the window the catalog states, not the 200K default', () => {
    const config: NexusModelConfig = { providers: [] }
    expect(contextWindowOf(`${MODEL}@latest`, MOD, config)).toBe(200_000)

    createConfiguredModelCatalog(modCatalog(MOD, 1_048_576), config)
    expect(contextWindowOf(`${MODEL}@latest`, MOD, config)).toBe(1_048_576)
    expect(contextWindowOf(MODEL, MOD, config)).toBe(1_048_576)
    expect(outputBudgetOf(MODEL, MOD, config)).toBe(32_768)

    // A later catalog updates the same entry.
    createConfiguredModelCatalog(modCatalog(MOD, 262_144), config)
    expect(contextWindowOf(MODEL, MOD, config)).toBe(262_144)
    expect(config.providers.filter(entry => entry.providerId === MOD)).toHaveLength(1)
  })

  it('keeps the entry when the provider list is rebuilt', () => {
    createConfiguredModelCatalog(modCatalog(MOD, 1_048_576))
    expect(contextWindowOf(MODEL, MOD)).toBe(1_048_576)

    setCustomProviderRecords({})
    expect(contextWindowOf(MODEL, MOD)).toBe(1_048_576)
  })

  it('makes no entry for a provider that is not a mod', () => {
    const config: NexusModelConfig = { providers: [] }
    createConfiguredModelCatalog(modCatalog('unknown-gateway', 1_048_576), config)
    expect(config.providers).toEqual([])
    expect(contextWindowOf(MODEL, 'unknown-gateway', config)).toBe(200_000)
  })
})

describe('findConfiguredModelRule reads family rows', () => {
  // AgentModelController fills a selection's missing effort from this rule.
  // A family row's pattern names only its verified version; every other
  // version it speaks for must still get the row (and its per-version
  // override), not undefined.
  it('a legacy version of a family reads its per-version default effort', () => {
    expect(findConfiguredModelRule('anthropic', { id: 'claude-opus-5', label: 'claude-opus-5' })
      ?.defaultThinkingTier).toBe('high')
    expect(findConfiguredModelRule('anthropic', { id: 'claude-opus-5-5', label: 'claude-opus-5-5' })
      ?.defaultThinkingTier).toBe('medium')
  })
})

describe('healReplacesGlobalDefault', () => {
  // An automatic per-session fallback (send gate / post-settings heal) must not
  // overwrite the user's working topbar default — only an unusable one.
  const catalog = {
    providers: [
      {
        id: 'provider-a',
        label: 'A',
        iconSvg: '',
        enabled: true,
        models: [{ id: 'model-a', label: 'Model A', enabled: true, supportsStreaming: true }],
      },
      {
        id: 'provider-b',
        label: 'B',
        iconSvg: '',
        enabled: false,
        models: [{ id: 'model-b', label: 'Model B', enabled: true, supportsStreaming: true }],
      },
    ],
  } as unknown as BrowserLlmCatalog

  it('keeps a usable global default', () => {
    expect(
      healReplacesGlobalDefault(catalog, { providerId: 'provider-a', modelId: 'model-a', thinkingTier: 'high' }),
    ).toBe(false)
  })

  it('replaces a global default that is no longer enabled', () => {
    expect(healReplacesGlobalDefault(catalog, { providerId: 'provider-b', modelId: 'model-b' })).toBe(true)
  })

  it('has nothing to replace when the user never picked one', () => {
    expect(healReplacesGlobalDefault(catalog, null)).toBe(false)
  })
})
