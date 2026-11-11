import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BUILTIN_PROVIDER_DEFINITIONS,
  registerModProviderDefinition,
  resetModProviderDefinitions,
} from '../config/nexusModelConfig/providers'
import { reapplyProviderCatalog, resetCustomProviderRecords } from '../config/customProviderRegistry'
import { foldTriggerTokens } from '../context/compaction/triggerThreshold'
import { createConfiguredModelCatalog } from '../browser/webview/modelCatalog'
import {
  contextWindowOf,
  getAvailableThinkingTiersForModel,
  getBlockingLimitTokens,
  getSupportsImageInputForModel,
  outputBudgetOf,
} from '../engine/contextWindow'
import { FALLBACK_MAX_OUTPUT_TOKENS, resolveModelRequestFields } from '../engine/turn/modelRequestFields'
import { checkPluginDescriptor } from '../pluginHost/manifestValidator'
import { modProviderDefinition } from '../mods/provider/modProviderDefinition'
import { resolveProviders } from '../mods/provider/providerManifest'
import {
  configureRuntimeProviders,
  listRuntimeProviderModels,
  refreshRuntimeProviderModels,
  resetRuntimeProviders,
  runtimeProviderCatalogRows,
  setRuntimeProviderConfigs,
} from '../models/drivers/runtimeProviders'
import type { BrowserBridgeTransport } from '../browser/bridge/browserBridgeProtocol'
import type { ProviderModelInfo } from '../config/nexusModelConfig/providerDefinition'
import type { NexusModelConfig } from '../config/nexusModelConfig/types'
import type { NexusProviderConfig } from '../settings/settingsTypes'

/**
 * Which figures a provider mod's model runs on, in the worker's configuration:
 * the window compaction measures against and the output cap a first request
 * carries, read per layer (the listed row, the manifest's `modelFacts`, the
 * platform default).
 */

const ID = 'mod.acme.main'
const transport = { request: vi.fn() } as unknown as BrowserBridgeTransport

async function provider(
  models: ProviderModelInfo[],
  modelFacts?: Record<string, unknown>,
  entries?: NexusProviderConfig['modelEntries'],
): Promise<void> {
  const { manifest, errors } = checkPluginDescriptor({
    name: 'acme',
    version: '1.0.0',
    providers: {
      main: {
        providerApi: 1,
        displayName: { en: 'Acme' },
        defaultBaseUrl: 'https://api.acme.example/v1',
        domains: ['api.acme.example'],
        format: BUILTIN_PROVIDER_DEFINITIONS.find(d => d.config.wire)!.config.wire!.format,
        credentials: { methods: ['apiKey'] },
        module: './providers/main.js',
        ...(modelFacts ? { modelFacts } : {}),
      },
    },
  })
  expect(errors).toEqual([])
  const resolved = resolveProviders('acme', '/p/acme', manifest!.providers!)[0]!
  registerModProviderDefinition(
    modProviderDefinition({
      plugin: 'acme',
      pluginVersion: '1.0.0',
      provider: resolved,
      isLoaded: () => true,
      list: async () => models,
    }),
  )
  reapplyProviderCatalog()
  setRuntimeProviderConfigs({
    [ID]: {
      source: 'mod',
      modVersion: '1.0.0',
      apiKey: 'sealed',
      ...(entries ? { modelEntries: entries } : {}),
    },
  })
  await refreshRuntimeProviderModels(transport, ID)
}

const firstRequestOutput = (model: string): number =>
  resolveModelRequestFields({ model, providerId: ID }).maxOutputTokens

beforeEach(() => {
  resetModProviderDefinitions()
  resetCustomProviderRecords()
  resetRuntimeProviders()
  configureRuntimeProviders({
    writeProviderConfig: vi.fn(async () => {}),
    readCache: vi.fn(async () => undefined),
    writeCache: vi.fn(async () => {}),
  })
})

afterEach(() => {
  resetModProviderDefinitions()
  resetRuntimeProviders()
  configureRuntimeProviders(undefined)
})

describe('the figures a listed row states', () => {
  it('are the window compaction uses and the cap the first request is derived from', async () => {
    await provider([{ id: 'wide-1', supportsTools: true, contextWindow: 300_000, maxOutputTokens: 64_000 }])

    expect(contextWindowOf('wide-1', ID)).toBe(300_000)
    // 300,000 less the 20,000 summary reserve, less the 13,000 headroom.
    expect(foldTriggerTokens('wide-1', ID)).toBe(267_000)
    expect(getBlockingLimitTokens('wide-1', ID)).toBe(277_000)
    // Half the stated cap, held to the first-request floor: not the cap, not the fallback.
    expect(firstRequestOutput('wide-1')).toBe(32_768)
    expect(firstRequestOutput('wide-1')).not.toBe(FALLBACK_MAX_OUTPUT_TOKENS)
  })

  it('give way to the platform default only when the row states none', async () => {
    await provider([{ id: 'bare-1', supportsTools: true }])

    expect(contextWindowOf('bare-1', ID)).toBe(200_000)
    expect(firstRequestOutput('bare-1')).toBe(FALLBACK_MAX_OUTPUT_TOKENS)
  })
})

describe('modelFacts, beneath the listed row', () => {
  it('a row that states no figures takes them: window, compaction, request, tiers, image input', async () => {
    await provider([{ id: 'bare-1', supportsTools: true }], {
      'bare-1': {
        contextWindow: 300_000,
        maxOutputTokens: 64_000,
        thinkingTiers: ['high', 'low'],
        defaultThinkingTier: 'high',
        supportsImageInput: false,
      },
    })

    expect(contextWindowOf('bare-1', ID)).toBe(300_000)
    expect(foldTriggerTokens('bare-1', ID)).toBe(267_000)
    expect(outputBudgetOf('bare-1', ID)).toBe(64_000)
    expect(firstRequestOutput('bare-1')).toBe(32_768)
    expect(getAvailableThinkingTiersForModel('bare-1', ID)).toEqual(['low', 'high'])
    expect(resolveModelRequestFields({ model: 'bare-1', providerId: ID, thinkingTier: 'high' }).thinkingTier).toBe('high')
    expect(getSupportsImageInputForModel('bare-1', ID)).toBe(false)
  })

  it('each field comes from the row when it states one, else the facts, else the platform default', async () => {
    await provider(
      [
        { id: 'both-1', supportsTools: true, contextWindow: 400_000, thinkingTiers: ['medium'] },
        { id: 'none-1', supportsTools: true },
      ],
      {
        'both-1': {
          contextWindow: 300_000,
          maxOutputTokens: 64_000,
          thinkingTiers: ['low', 'high'],
          defaultThinkingTier: 'high',
        },
      },
    )

    // The row's window and tiers; the facts' output cap, which the row left out.
    expect(contextWindowOf('both-1', ID)).toBe(400_000)
    expect(outputBudgetOf('both-1', ID)).toBe(64_000)
    expect(getAvailableThinkingTiersForModel('both-1', ID)).toEqual(['medium'])
    // No row figure and no entry: the platform default.
    expect(contextWindowOf('none-1', ID)).toBe(200_000)
    expect(firstRequestOutput('none-1')).toBe(FALLBACK_MAX_OUTPUT_TOKENS)
  })

  it('an exact id answers before a prefix, and the longest prefix before a shorter one', async () => {
    await provider(
      ['wide-5.3', 'wide-5.3-air', 'wide-5.1', 'wide-4', 'other'].map(id => ({ id, supportsTools: true })),
      {
        'wide-*': { contextWindow: 100_000 },
        'wide-5.*': { contextWindow: 250_000 },
        'wide-5.3': { contextWindow: 300_000 },
      },
    )

    expect(contextWindowOf('wide-5.3', ID)).toBe(300_000)
    expect(contextWindowOf('wide-5.3-air', ID)).toBe(250_000)
    expect(contextWindowOf('wide-5.1', ID)).toBe(250_000)
    expect(contextWindowOf('wide-4', ID)).toBe(100_000)
    expect(contextWindowOf('other', ID)).toBe(200_000)
  })

  it('a filled output cap is held to the window the row states', async () => {
    await provider([{ id: 'small-1', supportsTools: true, contextWindow: 16_000 }], {
      'small-*': { maxOutputTokens: 64_000 },
    })

    expect(outputBudgetOf('small-1', ID)).toBe(16_000)
  })

  it('the picker and the catalog row show the same figures the request runs on', async () => {
    const MODEL = 'vendor/wide-9.1-flash'
    await provider(
      [{ id: MODEL, supportsTools: true }],
      { 'vendor/*': { contextWindow: 640_000, maxOutputTokens: 48_000 } },
      [{ family: 'vendor/wide-*-flash', version: 'latest', id: MODEL }],
    )

    const picker = await listRuntimeProviderModels(transport, ID)
    expect(picker.models[0]).toMatchObject({ id: MODEL, contextWindow: 640_000, maxOutputTokens: 48_000 })

    const rows = runtimeProviderCatalogRows().filter(row => row.id === ID)
    expect(rows[0]!.models[0]).toMatchObject({ contextWindow: 640_000, maxOutputTokens: 48_000 })
    expect(contextWindowOf(MODEL, ID)).toBe(640_000)

    // A realm with no mod registry mirrors the published row.
    const page: NexusModelConfig = { providers: [] }
    createConfiguredModelCatalog({ providers: rows }, page)
    expect(contextWindowOf(rows[0]!.models[0]!.id, ID, page)).toBe(640_000)
    expect(outputBudgetOf(MODEL, ID, page)).toBe(48_000)
  })
})

describe('defaultMaxOutputTokens: the output cap of the first request', () => {
  it('a row that states it sends it, at most its output cap', async () => {
    await provider([
      { id: 'full-1', supportsTools: true, contextWindow: 300_000, maxOutputTokens: 64_000, defaultMaxOutputTokens: 64_000 },
      { id: 'over-1', supportsTools: true, maxOutputTokens: 40_000, defaultMaxOutputTokens: 90_000 },
      { id: 'lone-1', supportsTools: true, defaultMaxOutputTokens: 12_000 },
    ])

    expect(firstRequestOutput('full-1')).toBe(64_000)
    expect(firstRequestOutput('over-1')).toBe(40_000)
    expect(firstRequestOutput('lone-1')).toBe(12_000)
  })

  it('modelFacts states it for a row that does not, and a row that does keeps its own', async () => {
    await provider(
      [
        { id: 'facts-1', supportsTools: true, maxOutputTokens: 64_000 },
        { id: 'facts-2', supportsTools: true, maxOutputTokens: 64_000, defaultMaxOutputTokens: 50_000 },
        { id: 'facts-3', supportsTools: true, maxOutputTokens: 20_000 },
      ],
      { 'facts-*': { defaultMaxOutputTokens: 60_000 } },
    )

    expect(firstRequestOutput('facts-1')).toBe(60_000)
    expect(firstRequestOutput('facts-2')).toBe(50_000)
    expect(firstRequestOutput('facts-3')).toBe(20_000)
  })
})
