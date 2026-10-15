// Built-in providers read the figures their rows leave unset from the model catalog (F-28): row ?? catalog ??
// consumer default; lookup by exact then normalized id in the provider's own key order; one stable object per
// (row, model, figures); the runtime's read (`startBuiltinCatalogFill`) is passive at start, awaited by the
// catalog fetch within a bound, republished on `catalog.updated`; a page realm reads what the runtime published.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserLlmCatalog, BrowserLlmProvider } from '../../browser/bridge/browserBridgeProtocol'
import { createConfiguredModelCatalog } from '../../browser/webview/modelCatalog'
import {
  awaitCatalogFigures,
  catalogMappedProviders,
  resetBuiltinCatalogFill,
  startBuiltinCatalogFill,
} from '../../catalog/builtinCatalogFill'
import type { CatalogUpdated } from '../../catalog/modelCatalog'
import { adaptReasoningEfforts } from '../../catalog/modelsDevAdapter'
import { SNAPSHOT_PROVIDER_KEYS } from '../../catalog/snapshotProviders'
import type { CatalogModel, CatalogProviderRecords } from '../../catalog/types'
import { NEXUS_MODEL_CONFIG } from '../../config/nexusModelConfig'
import {
  catalogFiguresFor,
  catalogFiguresOfRecord,
  recordPublishedFigures,
  resetCatalogFigures,
  setCatalogFigures,
  withCatalogFigures,
  type CatalogModelFigures,
} from '../../config/nexusModelConfig/catalogFigures'
import { knownModelRows, recordListedFigures, resetListedFigures } from '../../config/nexusModelConfig/familyRows'
import { versionParser } from '../../config/nexusModelConfig/modelEntries'
import { findConfiguredModel } from '../../config/nexusModelConfig/findConfiguredModel'
import { resetEntryResolutions } from '../../config/nexusModelConfig/modelEntryResolution'
import type { ProviderModelInfo } from '../../config/nexusModelConfig/providerDefinition'
import type { NexusModelConfig } from '../../config/nexusModelConfig/types'
import { contextWindowOf, getDefaultMaxOutputTokensForModel, outputBudgetOf } from '../../engine/contextWindow'
import { builtInFamilies, resetModelEntryCatalog } from '../../models/drivers/modelEntryCatalog'
import { resolveModelRequestFields } from '../../engine/turn/modelRequestFields'

afterEach(() => {
  resetCatalogFigures()
  resetListedFigures()
  resetBuiltinCatalogFill()
  resetEntryResolutions()
  resetModelEntryCatalog()
  vi.restoreAllMocks()
})

const layer = (entries: Record<string, CatalogModelFigures>) => new Map(Object.entries(entries))
const listed = (providerId: string, ...models: Array<Partial<ProviderModelInfo> & { id: string }>) =>
  recordListedFigures(providerId, models.map(m => ({ supportsTools: true, ...m })))

describe('which providers read the catalog, under which keys', () => {
  it('each built-in names its own keys; the providers without a catalog name none', () => {
    expect(Object.fromEntries(catalogMappedProviders())).toEqual({
      openai: ['openai'],
      anthropic: ['anthropic'],
      google: ['google'],
      deepseek: ['deepseek'],
      glm: ['zhipuai', 'zai', 'zhipuai-coding-plan', 'zai-coding-plan'],
      kimi: ['kimi-code-plan-global', 'kimi-code-plan-cn', 'moonshotai'],
      minimax: ['minimax', 'minimax-cn'],
      qwen: ['alibaba-cn', 'alibaba'],
      openrouter: ['openrouter'],
      'vercel-ai-gateway': ['vercel'],
    })
    for (const id of ['chatgpt-pro', 'ollama', 'github-copilot', 'qwen-code', 'custom-openai', 'custom-anthropic']) {
      expect(NEXUS_MODEL_CONFIG.providers.find(p => p.providerId === id)!.catalog, id).toBeUndefined()
    }
  })

  it('every key is one the bundle snapshot keeps', () => {
    for (const keys of catalogMappedProviders().values()) {
      for (const key of keys) expect(SNAPSHOT_PROVIDER_KEYS, key).toContain(key)
    }
  })

  it('a record gives only the three figures, image input from its input modalities', () => {
    const record = { name: 'X', contextWindow: 10, maxOutput: 5, inputModalities: ['text', 'image'], free: false } as CatalogModel
    expect(catalogFiguresOfRecord(record)).toEqual({ contextWindow: 10, maxOutputTokens: 5, supportsImageInput: true })
    expect(catalogFiguresOfRecord({ ...record, inputModalities: ['text'] }).supportsImageInput).toBe(false)
    // No modalities stated: image input is left unsaid, not "no".
    expect(catalogFiguresOfRecord({ ...record, inputModalities: [] }).supportsImageInput).toBeUndefined()
  })
})

describe('the catalog is the lowest layer', () => {
  it('fills what a row leaves unset, and nothing it sets', () => {
    expect(findConfiguredModel('openai', 'gpt-6-astra')!.contextWindow).toBeUndefined()
    setCatalogFigures('openai', [layer({ 'gpt-6-astra': { contextWindow: 111_000, maxOutputTokens: 22_000, supportsImageInput: false } })])
    const row = findConfiguredModel('openai', 'gpt-6-astra')!
    expect(row).toMatchObject({ contextWindow: 111_000, maxOutputTokens: 22_000, supportsImageInput: false })
    // Never a name or tiers: the row's own stay.
    expect(row.availableThinkingTiers).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    // A filled cap bounds the first-request reservation, as a listed one does.
    expect(row.defaultMaxOutputTokens).toBe(22_000)

    // A row's own figure wins: 3.7 Plus states its cap, V4 Pro no images.
    setCatalogFigures('qwen', [layer({ 'qwen3.7-plus': { contextWindow: 1_000_000, maxOutputTokens: 64_000 } })])
    expect(findConfiguredModel('qwen', 'qwen3.7-plus')).toMatchObject({ contextWindow: 1_000_000, maxOutputTokens: 131_072 })
    setCatalogFigures('deepseek', [layer({ 'deepseek-v4-pro': { supportsImageInput: true } })])
    expect(findConfiguredModel('deepseek', 'deepseek-v4-pro')!.supportsImageInput).toBe(false)
  })

  it('a version override wins over the catalog', () => {
    setCatalogFigures('glm', [layer({ 'glm-4.6': { contextWindow: 1_000_000 } })])
    expect(findConfiguredModel('glm', 'glm-4.6')!.contextWindow).toBe(200_000)
    setCatalogFigures('qwen', [layer({ 'qwen3.7-max': { maxOutputTokens: 65_536 }, 'qwen3.8-max': { maxOutputTokens: 1 } })])
    expect(findConfiguredModel('qwen', 'qwen3.7-max')!.maxOutputTokens).toBe(131_072)
  })

  it('a family version the catalog does not list reads the record of its verified version', () => {
    // The Sol row's verified version (6.1) is listed; 6.2 is not.
    setCatalogFigures('openai', [layer({ 'gpt-6.1-sol': { contextWindow: 1_050_000, maxOutputTokens: 128_000 } })])
    expect(findConfiguredModel('openai', 'gpt-6.2-sol')).toMatchObject({ contextWindow: 1_050_000, maxOutputTokens: 128_000 })
    // A version the catalog does list reads its own record.
    setCatalogFigures('openai', [layer({ 'gpt-6.1-sol': { contextWindow: 1_050_000 }, 'gpt-6.2-sol': { contextWindow: 2_000_000 } })])
    expect(findConfiguredModel('openai', 'gpt-6.2-sol')!.contextWindow).toBe(2_000_000)
    // Only the family's own verified version: a fixed row borrows nothing.
    setCatalogFigures('openai', [layer({ 'gpt-6.1-sol': { contextWindow: 1_050_000 } })])
    expect(findConfiguredModel('openai', 'gpt-5.4-pro')!.contextWindow).toBeUndefined()
    // A named version absent from the catalog: MiniMax M2.1 Highspeed reads
    // the verified M2.7 twin, in the lookup and in the host copy alike.
    setCatalogFigures('minimax', [layer({ 'MiniMax-M2.7-highspeed': { contextWindow: 204_800 } })])
    expect(findConfiguredModel('minimax', 'MiniMax-M2.1-highspeed')!.contextWindow).toBe(204_800)
    const host = knownModelRows(
      NEXUS_MODEL_CONFIG.providers.find(p => p.providerId === 'minimax')!.models,
      versionParser('minimax'),
      'minimax',
    )
    expect(host.find(row => row.name === 'MiniMax M2.1 Highspeed')!.contextWindow).toBe(204_800)
  })

  it('the provider\'s listing wins over the catalog; the catalog fills what it leaves', () => {
    setCatalogFigures('openai', [layer({ 'gpt-6-astra': { contextWindow: 111_000, maxOutputTokens: 22_000 } })])
    listed('openai', { id: 'gpt-6-astra', contextWindow: 333_000 })
    expect(findConfiguredModel('openai', 'gpt-6-astra')).toMatchObject({ contextWindow: 333_000, maxOutputTokens: 22_000 })
  })

  it('with nothing anywhere the consumer keeps its default, and a mapped built-in says so once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // Before any read: the default, quietly (the read has not happened).
    expect(contextWindowOf('gpt-6-astra', 'openai')).toBe(200_000)
    expect(warn).not.toHaveBeenCalled()
    setCatalogFigures('openai', [layer({})])
    expect(contextWindowOf('gpt-6-astra', 'openai')).toBe(200_000)
    expect(contextWindowOf('gpt-6-astra', 'openai')).toBe(200_000)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]![0])).toContain('openai/gpt-6-astra')
    expect(outputBudgetOf('gpt-6-astra', 'openai')).toBeUndefined()
  })

  it('consumers read the filled figures', () => {
    setCatalogFigures('anthropic', [layer({ 'claude-haiku-4-5': { contextWindow: 200_000, maxOutputTokens: 64_000 } })])
    expect(contextWindowOf('claude-haiku-4-5', 'anthropic')).toBe(200_000)
    expect(outputBudgetOf('claude-haiku-4-5', 'anthropic')).toBe(64_000)
    expect(getDefaultMaxOutputTokensForModel('claude-haiku-4-5', 'anthropic')).toBe(32_000)
  })
})

describe('lookups stay inside the provider\'s own keys', () => {
  it('exact id first, then the normalized id (a dated snapshot reads its model)', () => {
    setCatalogFigures('anthropic', [layer({
      'claude-opus-5': { contextWindow: 1_000_000 },
      'claude-sonnet-5-20260101': { contextWindow: 777_000 },
    })])
    expect(findConfiguredModel('anthropic', 'claude-opus-5-20260601')!.contextWindow).toBe(1_000_000)
    expect(findConfiguredModel('anthropic', 'claude-sonnet-5')!.contextWindow).toBe(777_000)
    // An OpenAI-style `-YYYY-MM-DD` snapshot reads its undated record.
    setCatalogFigures('openai', [layer({ 'gpt-6-astra': { contextWindow: 1_050_000 } })])
    expect(findConfiguredModel('openai', 'gpt-6-astra-2026-09-03')!.contextWindow).toBe(1_050_000)
  })

  it('keys are tried in order: the first that holds the model answers', () => {
    setCatalogFigures('glm', [
      layer({}),
      layer({ 'glm-5.3': { contextWindow: 1_000_000 } }),
      layer({ 'glm-5.3': { contextWindow: 5 } }),
    ])
    expect(findConfiguredModel('glm', 'glm-5.3')!.contextWindow).toBe(1_000_000)
    // A normalized hit under an earlier key beats an exact one under a later.
    setCatalogFigures('glm', [layer({ 'GLM-5.3': { contextWindow: 7 } }), layer({ 'glm-5.3': { contextWindow: 8 } })])
    expect(findConfiguredModel('glm', 'glm-5.3')!.contextWindow).toBe(7)
  })

  it('never borrows another provider\'s figures', () => {
    setCatalogFigures('anthropic', [layer({ 'gpt-6-astra': { contextWindow: 9 } })])
    expect(findConfiguredModel('openai', 'gpt-6-astra')!.contextWindow).toBeUndefined()
    // …and a provider without keys reads none, whatever the registry holds.
    setCatalogFigures('chatgpt-pro', [layer({ 'gpt-6-luna': { contextWindow: 9 } })])
    expect(findConfiguredModel('chatgpt-pro', 'gpt-6-luna')!.contextWindow).toBe(272_000)
  })
})

describe('a stable object', () => {
  it('the same row for the same figures; a new one when they change', () => {
    setCatalogFigures('openai', [layer({ 'gpt-6-astra': { contextWindow: 1_050_000 } })])
    const a = findConfiguredModel('openai', 'gpt-6-astra')
    expect(findConfiguredModel('openai', 'gpt-6-astra')).toBe(a)
    setCatalogFigures('openai', [layer({ 'gpt-6-astra': { contextWindow: 2_000_000 } })])
    const b = findConfiguredModel('openai', 'gpt-6-astra')
    expect(b).not.toBe(a)
    expect(b!.contextWindow).toBe(2_000_000)
    expect(findConfiguredModel('openai', 'gpt-6-astra')).toBe(b)
  })

  it('a row the catalog adds nothing to is the row itself', () => {
    const row = { model: /^m$/, contextWindow: 1, maxOutputTokens: 2, supportsImageInput: true }
    setCatalogFigures('p', [layer({ m: { contextWindow: 9, maxOutputTokens: 9, supportsImageInput: false } })])
    expect(withCatalogFigures('p', row, 'm')).toBe(row)
    expect(withCatalogFigures('q', row, 'm')).toBe(row)
  })
})

describe('a page realm reads what the runtime published', () => {
  const catalog = (contextWindow: number): BrowserLlmCatalog => ({
    providers: [{
      id: 'openai',
      label: 'OpenAI',
      iconSvg: '',
      enabled: true,
      models: [{
        id: 'gpt-*-astra@latest',
        label: 'GPT Astra',
        enabled: true,
        contextWindow,
        maxOutputTokens: 128_000,
        supportsImageInput: true,
        entry: { kind: 'latest', family: 'gpt-*-astra', familyLabel: 'GPT Astra', version: 'latest', resolvedId: 'gpt-6-astra', preview: false },
      }],
      entryFamilies: [],
    }],
  })

  it('a row the realm has fills from the published figures, which a new catalog replaces', () => {
    // This realm never read the catalog: the row alone has no window.
    expect(contextWindowOf('gpt-6-astra', 'openai')).toBe(200_000)
    const config = NEXUS_MODEL_CONFIG
    const before = config.providers.find(p => p.providerId === 'openai')!.models.length
    createConfiguredModelCatalog(catalog(1_050_000), config)
    expect(contextWindowOf('gpt-6-astra', 'openai')).toBe(1_050_000)
    expect(contextWindowOf('gpt-*-astra@latest', 'openai')).toBe(1_050_000)
    expect(outputBudgetOf('gpt-6-astra', 'openai')).toBe(128_000)
    // No row was added: the family row answers, with the figures beneath.
    expect(config.providers.find(p => p.providerId === 'openai')!.models).toHaveLength(before)
    createConfiguredModelCatalog(catalog(900_000), config)
    expect(contextWindowOf('gpt-6-astra', 'openai')).toBe(900_000)
  })

  it('the realm\'s own catalog read comes first; a republish of the same figures keeps the row', () => {
    recordPublishedFigures('openai', new Map([['gpt-6-astra', { contextWindow: 5, maxOutputTokens: 6 }]]))
    const first = findConfiguredModel('openai', 'gpt-6-astra')
    recordPublishedFigures('openai', new Map([['gpt-6-astra', { contextWindow: 5, maxOutputTokens: 6 }]]))
    expect(findConfiguredModel('openai', 'gpt-6-astra')).toBe(first)
    setCatalogFigures('openai', [layer({ 'gpt-6-astra': { contextWindow: 1_050_000 } })])
    expect(catalogFiguresFor('openai', 'gpt-6-astra')).toEqual({ contextWindow: 1_050_000, maxOutputTokens: 6 })
  })
})

// ── The runtime's read ────────────────────────────────────────────────────

type FakeCatalog = {
  provider: (key: string, opts?: { passive?: boolean }) => Promise<CatalogProviderRecords | undefined>
  onUpdated: (listener: (event: CatalogUpdated) => void) => () => void
  calls: Array<[string, { passive?: boolean } | undefined]>
  records: Record<string, CatalogProviderRecords>
  update: (keys: string[]) => void
  listeners: number
}

function record(contextWindow: number, image = true): CatalogModel {
  return { name: 'x', contextWindow, maxOutput: 64_000, inputModalities: image ? ['text', 'image'] : ['text'], free: false }
}

function fakeCatalog(records: Record<string, CatalogProviderRecords> = {}): FakeCatalog {
  const listeners = new Set<(event: CatalogUpdated) => void>()
  const fake: FakeCatalog = {
    calls: [],
    records,
    async provider(key, opts) {
      fake.calls.push([key, opts])
      return fake.records[key]
    },
    onUpdated(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    update(keys) {
      for (const l of listeners) l({ providerKeys: keys })
    },
    get listeners() {
      return listeners.size
    },
  }
  return fake
}

describe('the runtime reads the catalog for the built-ins', () => {
  it('reads every mapped key passively, then publishes the providers that got figures', async () => {
    const catalog = fakeCatalog({
      openai: { 'gpt-6-astra': record(1_050_000) },
      zai: { 'glm-5.3': record(1_000_000) },
    })
    const published: string[][] = []
    const fill = startBuiltinCatalogFill({ catalog, publish: async ids => void published.push(ids) })
    await fill.idle()
    // Every key, in each provider's order; none of them starts a refresh.
    expect(catalog.calls.map(([key]) => key)).toEqual([...catalogMappedProviders().values()].flat())
    expect(catalog.calls.every(([, opts]) => opts?.passive === true)).toBe(true)
    expect(published).toEqual([['openai', 'glm']])
    expect(findConfiguredModel('openai', 'gpt-6-astra')!.contextWindow).toBe(1_050_000)
    expect(findConfiguredModel('glm', 'glm-5.3')!.contextWindow).toBe(1_000_000)
    fill.dispose()
  })

  it('the catalog fetch waits for the first read, but only so long', async () => {
    // No read started: nothing to wait for.
    await awaitCatalogFigures(10_000)

    let release!: () => void
    const gate = new Promise<void>(r => (release = r))
    const catalog = fakeCatalog({ openai: { 'gpt-6-astra': record(1_050_000) } })
    const slow = { ...catalog, provider: async (key: string, opts?: { passive?: boolean }) => (await gate, catalog.provider(key, opts)) }
    const fill = startBuiltinCatalogFill({ catalog: slow, publish: async () => {} })
    const started = Date.now()
    await awaitCatalogFigures(30)
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(findConfiguredModel('openai', 'gpt-6-astra')!.contextWindow).toBeUndefined()

    release()
    await awaitCatalogFigures(10_000)
    expect(findConfiguredModel('openai', 'gpt-6-astra')!.contextWindow).toBe(1_050_000)
    fill.dispose()
  })

  it('catalog.updated swaps the affected providers\' figures and republishes them', async () => {
    const catalog = fakeCatalog({ openai: { 'gpt-6-astra': record(1_050_000) } })
    const published: string[][] = []
    const fill = startBuiltinCatalogFill({ catalog, publish: async ids => void published.push(ids) })
    await fill.idle()
    published.length = 0
    catalog.calls.length = 0

    // The model families a surface asks for read the new figure at once.
    const host: BrowserLlmProvider = {
      id: 'openai',
      label: 'OpenAI',
      iconSvg: '',
      enabled: true,
      models: [{ id: 'gpt-6-astra', label: 'gpt-6-astra', enabled: true, supportsStreaming: true }],
    }
    expect(builtInFamilies(host).byId.get('gpt-6-astra')!.contextWindow).toBe(1_050_000)

    catalog.records = { openai: { 'gpt-6-astra': record(2_000_000) } }
    catalog.update(['openai', 'some-reseller'])
    await fill.idle()
    expect(catalog.calls.map(([key]) => key)).toEqual(['openai'])
    expect(published).toEqual([['openai']])
    expect(findConfiguredModel('openai', 'gpt-6-astra')!.contextWindow).toBe(2_000_000)
    resetModelEntryCatalog()
    expect(builtInFamilies(host).byId.get('gpt-6-astra')!.contextWindow).toBe(2_000_000)

    // Same figures again: nothing to publish. A key no provider maps: no read.
    catalog.update(['openai'])
    catalog.update(['some-reseller'])
    await fill.idle()
    expect(published).toEqual([['openai']])
    expect(catalog.calls.map(([key]) => key)).toEqual(['openai', 'openai'])

    // A key shared by name with no other provider reads only its own: GLM.
    catalog.records = { ...catalog.records, 'zai-coding-plan': { 'glm-5.3': record(1_000_000, false) } }
    catalog.update(['zai-coding-plan'])
    await fill.idle()
    expect(published).toEqual([['openai'], ['glm']])
    expect(findConfiguredModel('glm', 'glm-5.3')).toMatchObject({ contextWindow: 1_000_000 })

    fill.dispose()
    expect(catalog.listeners).toBe(0)
  })

  it('catalog.updated that empties a provider republishes it, so the host drops the old figures', async () => {
    const catalog = fakeCatalog({ openai: { 'gpt-6-astra': record(1_050_000) } })
    const published: string[][] = []
    const fill = startBuiltinCatalogFill({ catalog, publish: async ids => void published.push(ids) })
    await fill.idle()
    expect(published).toEqual([['openai']])

    catalog.records = {}
    catalog.update(['openai'])
    await fill.idle()
    expect(published).toEqual([['openai'], ['openai']])
    expect(findConfiguredModel('openai', 'gpt-6-astra')!.contextWindow).toBeUndefined()

    // Still empty: nothing new to tell.
    catalog.update(['openai'])
    await fill.idle()
    expect(published).toEqual([['openai'], ['openai']])
    fill.dispose()
  })

  it('a publish that fails is reported, and the figures stay', async () => {
    const lines: string[] = []
    const catalog = fakeCatalog({ openai: { 'gpt-6-astra': record(1_050_000) } })
    const fill = startBuiltinCatalogFill({
      catalog,
      publish: async () => {
        throw new Error('host gone')
      },
      report: line => lines.push(line),
    })
    await fill.idle()
    expect(lines.join('\n')).toContain('host gone')
    expect(findConfiguredModel('openai', 'gpt-6-astra')!.contextWindow).toBe(1_050_000)
    fill.dispose()
  })

  it('reads only the config it is given', async () => {
    const config: NexusModelConfig = {
      providers: [{ providerId: 'p', filterMode: 'curated', catalog: { keys: ['k'] }, models: [{ model: /^m$/ }] }],
    }
    const catalog = fakeCatalog({ k: { m: record(5) } })
    const fill = startBuiltinCatalogFill({ catalog, publish: async () => {}, config })
    await fill.idle()
    expect(catalog.calls.map(([key]) => key)).toEqual(['k'])
    expect(catalogFiguresFor('p', 'm')).toMatchObject({ contextWindow: 5 })
    fill.dispose()
  })
})

describe('effort tiers from the catalog, for a provider that opts in', () => {
  const withEfforts = (efforts?: string[]): CatalogModel => ({
    ...record(1_000_000),
    ...(efforts ? { reasoningEfforts: efforts } : {}),
  })

  it('reads the source effort list; a budget or a toggle alone states no tiers', () => {
    expect(adaptReasoningEfforts([{ type: 'effort', values: ['minimal', 'low', 'medium', 'high'] }])).toEqual([
      'minimal',
      'low',
      'medium',
      'high',
    ])
    expect(adaptReasoningEfforts([{ type: 'budget_tokens', min: 128, max: 32768 }])).toBeUndefined()
    expect(adaptReasoningEfforts([{ type: 'toggle' }, { type: 'budget_tokens', min: 0, max: 24576 }])).toBeUndefined()
  })

  it("a record gives tiers only under a tier rule, in tier order, with the rule's default when offered", () => {
    const model = withEfforts(['high', 'xhigh', 'low'])
    expect(catalogFiguresOfRecord(model).availableThinkingTiers).toBeUndefined()
    expect(catalogFiguresOfRecord(model, { defaultThinkingTier: 'high' })).toMatchObject({
      availableThinkingTiers: ['low', 'high', 'extra-high'],
      defaultThinkingTier: 'high',
    })
    // The rule's default is not offered: `medium`, else the first non-`none`.
    expect(catalogFiguresOfRecord(withEfforts(['minimal', 'medium']), { defaultThinkingTier: 'high' }).defaultThinkingTier).toBe(
      'medium',
    )
    expect(catalogFiguresOfRecord(withEfforts(['minimal', 'low']), {}).defaultThinkingTier).toBe('minimal')
  })

  it("google: a 3.x record fills the row's tiers and the request sends its thinkingLevel; 2.5 stays without", async () => {
    const catalog = fakeCatalog({
      google: {
        'gemini-3.8-flash': withEfforts(['low', 'medium', 'high']),
        'gemini-3.6-flash': withEfforts(['minimal', 'low', 'medium', 'high']),
        'gemini-2.5-pro': withEfforts(),
      },
    })
    const fill = startBuiltinCatalogFill({ catalog, publish: async () => {} })
    await fill.idle()
    expect(findConfiguredModel('google', 'gemini-3.8-flash')).toMatchObject({
      availableThinkingTiers: ['low', 'medium', 'high'],
      defaultThinkingTier: 'high',
    })
    expect(findConfiguredModel('google', 'gemini-3.6-flash')!.availableThinkingTiers).toEqual(['minimal', 'low', 'medium', 'high'])
    expect(findConfiguredModel('google', 'gemini-2.5-pro')!.availableThinkingTiers).toBeUndefined()

    const fields = (model: string, thinkingTier: string) =>
      resolveModelRequestFields({ model, providerId: 'google', thinkingTier }).providerBodyExtension
    expect(fields('gemini-3.8-flash', 'low')).toEqual({ generationConfig: { thinkingConfig: { thinkingLevel: 'low' } } })
    // A tier the model does not offer is dropped, not sent.
    expect(fields('gemini-3.8-flash', 'minimal')).toBeUndefined()
    expect(fields('gemini-2.5-pro', 'high')).toBeUndefined()
    fill.dispose()
  })

  it("a provider that does not opt in takes no tiers; a row's own tiers and default always win", async () => {
    const own = { model: /^own$/, availableThinkingTiers: ['high'], defaultThinkingTier: 'high' }
    const config: NexusModelConfig = {
      providers: [
        { providerId: 'plain', filterMode: 'curated', catalog: { keys: ['k'] }, models: [{ model: /^m$/ }] },
        {
          providerId: 'tiered',
          filterMode: 'curated',
          catalog: { keys: ['k'], thinkingTiers: true },
          models: [{ model: /^m$/ }, own],
        },
      ],
    }
    const catalog = fakeCatalog({ k: { m: withEfforts(['low', 'high']), own: withEfforts(['low', 'medium']) } })
    const fill = startBuiltinCatalogFill({ catalog, publish: async () => {}, config })
    await fill.idle()
    expect(catalogFiguresFor('plain', 'm')!.availableThinkingTiers).toBeUndefined()
    expect(catalogFiguresFor('tiered', 'm')).toMatchObject({ availableThinkingTiers: ['low', 'high'], defaultThinkingTier: 'low' })
    expect(withCatalogFigures('tiered', own, 'own')).toMatchObject({ availableThinkingTiers: ['high'], defaultThinkingTier: 'high' })
    fill.dispose()
  })

  it('a change to the effort list alone is republished', async () => {
    const config: NexusModelConfig = {
      providers: [{ providerId: 'p', filterMode: 'curated', catalog: { keys: ['k'], thinkingTiers: true }, models: [{ model: /^m$/ }] }],
    }
    const catalog = fakeCatalog({ k: { m: withEfforts(['low', 'high']) } })
    const published: string[][] = []
    const fill = startBuiltinCatalogFill({ catalog, publish: async ids => void published.push(ids), config })
    await fill.idle()
    catalog.records.k = { m: withEfforts(['low', 'high']) }
    catalog.update(['k'])
    await fill.idle()
    catalog.records.k = { m: withEfforts(['low', 'medium', 'high']) }
    catalog.update(['k'])
    await fill.idle()
    expect(published).toEqual([['p'], ['p']])
    expect(catalogFiguresFor('p', 'm')!.availableThinkingTiers).toEqual(['low', 'medium', 'high'])
    fill.dispose()
  })

  it('published tiers reach only a provider that opts in', () => {
    const config: NexusModelConfig = {
      providers: [
        { providerId: 'plain', filterMode: 'curated', catalog: { keys: ['k'] }, models: [{ model: /^m$/ }] },
        { providerId: 'tiered', filterMode: 'curated', catalog: { keys: ['k'], thinkingTiers: true }, models: [{ model: /^m$/ }] },
      ],
    }
    const published = (id: string): BrowserLlmCatalog['providers'][number] => ({
      id,
      label: id,
      iconSvg: '',
      enabled: true,
      models: [{ id: 'm', label: 'm', enabled: true, contextWindow: 64_000, availableThinkingTiers: ['low', 'high'], defaultThinkingTier: 'high' }],
      entryFamilies: [],
    })
    createConfiguredModelCatalog({ providers: [published('plain'), published('tiered')] }, config)
    expect(catalogFiguresFor('plain', 'm')).toEqual({ contextWindow: 64_000 })
    expect(catalogFiguresFor('tiered', 'm')).toMatchObject({ availableThinkingTiers: ['low', 'high'], defaultThinkingTier: 'high' })
  })

  it('a page realm takes the published tiers with their default', () => {
    recordPublishedFigures('p', layer({ m: { availableThinkingTiers: ['low', 'high'], defaultThinkingTier: 'high' } }))
    expect(withCatalogFigures('p', { model: /^m$/ }, 'm')).toMatchObject({
      availableThinkingTiers: ['low', 'high'],
      defaultThinkingTier: 'high',
    })
  })
})
