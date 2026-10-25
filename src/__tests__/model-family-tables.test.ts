// Every provider table as family rows: no shipped model's figures changed (against
// fixtures/model-rows-before-family-rows.json); a new vendor version reads its family's row; the entry catalog
// offers `latest` / a fixed row's version and takes the covered discovered versions as candidates (`maxVersion`
// caps `latest`); tier ladders resolve to concrete ids.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { BrowserLlmProvider } from '../browser/bridge/browserBridgeProtocol'
import { NEXUS_MODEL_CONFIG } from '../config/nexusModelConfig'
import { familyRowProblems, knownModelRows } from '../config/nexusModelConfig/familyRows'
import { findConfiguredModel } from '../config/nexusModelConfig/findConfiguredModel'
import { versionParser } from '../config/nexusModelConfig/modelEntries'
import { resetEntryResolutions, resolveModelId } from '../config/nexusModelConfig/modelEntryResolution'
import { deriveCanonicalModelId } from '../config/nexusModelConfig/patterns'
import { serializeNexusModelConfig } from '../config/nexusModelConfigWire'
import { resolvePromptProfile } from '../prompting/promptProfile'
import {
  builtInEntryRow,
  builtInFamilies,
  resetModelEntryCatalog,
  uncuratedModels,
} from '../models/drivers/modelEntryCatalog'
import {
  topTierModel,
  getFastModel,
  getFastModelForProvider,
  getTierModelForProvider,
} from '../engine/contextWindow'
import { resetSessionModelSettingsSnapshot } from '../models/tierSettingsSnapshot'
import { modelSupportsStrictTools } from '../utils/strictTools'
import { modelUsesTodoTools } from '../utils/todoTools'
import before from './fixtures/model-rows-before-family-rows.json'
import { installBuiltinCatalogFigures } from './_helpers/builtinCatalogFigures'
import { resetCatalogFigures } from '../config/nexusModelConfig/catalogFigures'

// Built-in rows read the context window / output cap / image input they
// leave unset from the model catalog: install the runtime's figures, as
// after its first catalog read (catalog/builtinCatalogFill.ts).
beforeAll(installBuiltinCatalogFigures)
afterAll(resetCatalogFigures)

afterEach(() => {
  resetEntryResolutions()
  resetModelEntryCatalog()
  resetSessionModelSettingsSnapshot()
})

const catalogRows = (providerId: string) => NEXUS_MODEL_CONFIG.providers.find(p => p.providerId === providerId)!.models

const FIVE_STEP_TIERS = ['low', 'medium', 'high', 'extra-high', 'max']
const GPT_TIERS = ['none', 'low', 'medium', 'high', 'xhigh', 'max']

type Frozen = {
  promptProfile?: 'lean' | 'standard'
  todoTools?: false
  defaultThinkingTier?: string
  availableThinkingTiers?: string[]
  contextWindow: number
  defaultMaxOutputTokens: number
  maxOutputTokens: number
  supportsStrictTools?: boolean
}
const FABLE: Frozen = { promptProfile: 'lean', todoTools: false, defaultThinkingTier: 'high', availableThinkingTiers: FIVE_STEP_TIERS, contextWindow: 1_000_000, defaultMaxOutputTokens: 64_000, maxOutputTokens: 128_000, supportsStrictTools: true }
const SONNET: Frozen = { promptProfile: 'standard', todoTools: false, defaultThinkingTier: 'high', availableThinkingTiers: FIVE_STEP_TIERS, contextWindow: 1_000_000, defaultMaxOutputTokens: 32_000, maxOutputTokens: 128_000, supportsStrictTools: true }
const HAIKU: Frozen = { promptProfile: 'standard', contextWindow: 200_000, defaultMaxOutputTokens: 32_000, maxOutputTokens: 64_000, supportsStrictTools: true }
const GPT: Frozen = { todoTools: false, defaultThinkingTier: 'medium', availableThinkingTiers: GPT_TIERS, contextWindow: 1_050_000, defaultMaxOutputTokens: 32_000, maxOutputTokens: 128_000, supportsStrictTools: true }
const { todoTools: _t, ...GPT_LUNA } = GPT

// What every curated model read from its OWN row before the tables became
// family rows — dumped from the pre-migration catalog (`findConfiguredModel`
// over each row's id, plus the ids only a pattern row matches and a few dated
// snapshots), every per-model field that was stated.
const BEFORE: Record<string, Record<string, Record<string, unknown>>> = before
const FROZEN_FIELDS = [
  'name', 'promptProfile', 'todoTools', 'defaultThinkingTier', 'availableThinkingTiers',
  'contextWindow', 'defaultMaxOutputTokens', 'maxOutputTokens', 'compactionTriggerCharCount',
  'supportsStrictTools', 'supportsImageInput', 'documentInput',
] as const
// Deliberate changes since the dump, laid over it — each one dated, so the
// dump itself stays the untouched record.
// Figures the vendor's own docs contradicted now read the
// vendor's value (sources: catalog/builtinCatalogFigures.test.ts, VENDOR).
const VENDOR_SINCE: Record<string, Record<string, Record<string, unknown>>> = {
  deepseek: {
    'deepseek-v4-pro': { maxOutputTokens: 393_216 },
    'deepseek-flash': { maxOutputTokens: 393_216 },
  },
  glm: {
    'glm-5.3': { maxOutputTokens: 131_072 },
    'glm-5.3-flash': { maxOutputTokens: 131_072 },
    'glm-5.2': { maxOutputTokens: 131_072 },
    'glm-4.6': { maxOutputTokens: 131_072 },
  },
  qwen: {
    'qwen3.8-max': { contextWindow: 1_000_000, maxOutputTokens: 131_072, supportsImageInput: true },
    'qwen3.8-flash': { contextWindow: 1_000_000, maxOutputTokens: 131_072, supportsImageInput: true },
    'qwen3.7-plus': { contextWindow: 1_000_000, maxOutputTokens: 131_072, supportsImageInput: true },
    'qwen3.7-max': { contextWindow: 1_000_000, maxOutputTokens: 131_072 },
    'qwen3.6-flash': { contextWindow: 1_000_000, maxOutputTokens: 65_536 },
  },
}
const CHANGED_SINCE = (providerId: string, id: string): Record<string, unknown> => ({
  // The Fable line defaults to the API's own effort, `high` (was `xhigh`).
  ...(providerId === 'anthropic' && id.startsWith('claude-fable-') ? { defaultThinkingTier: 'high' } : {}),
  ...VENDOR_SINCE[providerId]?.[id],
})
const SHIPPED = Object.entries(BEFORE).flatMap(([providerId, rows]) =>
  Object.entries(rows).map(([id, figures]) => [providerId, id, { ...figures, ...CHANGED_SINCE(providerId, id) }] as const))

// Versions no table names: each must read its family's row, whole.
const UNSHIPPED: ReadonlyArray<readonly [string, string, Frozen]> = [
  ['anthropic', 'claude-fable-5-2', FABLE],
  ['anthropic', 'claude-fable-6-20270301', FABLE],
  ['anthropic', 'claude-opus-5-7', { ...FABLE, defaultThinkingTier: 'medium' }],
  ['anthropic', 'claude-sonnet-5-6', SONNET],
  ['anthropic', 'claude-haiku-5', HAIKU],
  ['openai', 'gpt-6.2-sol', { ...GPT, availableThinkingTiers: ['low', 'medium', 'high', 'xhigh', 'max'] }],
  ['openai', 'gpt-7-astra', { ...GPT, availableThinkingTiers: ['low', 'medium', 'high', 'xhigh', 'max'] }],
  ['openai', 'gpt-6-terra', GPT],
  ['openai', 'gpt-6.5-luna-2027-01-01', GPT_LUNA],
  ['chatgpt-pro', 'gpt-6-luna', { defaultThinkingTier: 'medium', availableThinkingTiers: GPT_TIERS, contextWindow: 272_000, defaultMaxOutputTokens: 32_000, maxOutputTokens: 128_000, supportsStrictTools: true }],
  ['deepseek', 'deepseek-v5-pro', { todoTools: false, defaultThinkingTier: 'high', availableThinkingTiers: ['none', 'low', 'high', 'max'], contextWindow: 1_000_000, defaultMaxOutputTokens: 32_000, maxOutputTokens: 393_216 }], // The vendor's cap
  // The output caps below are the vendor's (131,072, was 128,000).
  ['glm', 'glm-5.4', { todoTools: false, contextWindow: 1_000_000, defaultMaxOutputTokens: 32_000, maxOutputTokens: 131_072, supportsStrictTools: true }],
  ['glm', 'glm-6-flash', { contextWindow: 1_000_000, defaultMaxOutputTokens: 32_000, maxOutputTokens: 131_072, supportsStrictTools: true }],
  ['google', 'gemini-3.9-flash', { todoTools: false, contextWindow: 1_048_576, defaultMaxOutputTokens: 32_000, maxOutputTokens: 65_536 }],
  ['google', 'gemini-3.5-pro', { contextWindow: 1_048_576, defaultMaxOutputTokens: 32_000, maxOutputTokens: 65_536 }],
  ['kimi', 'k4', { todoTools: false, defaultThinkingTier: 'high', availableThinkingTiers: ['none', 'low', 'high', 'max'], contextWindow: 1_048_576, defaultMaxOutputTokens: 64_000, maxOutputTokens: 131_072 }],
  ['kimi', 'k4-pro', { todoTools: false, defaultThinkingTier: 'high', availableThinkingTiers: ['low', 'high', 'max'], contextWindow: 1_048_576, defaultMaxOutputTokens: 64_000, maxOutputTokens: 131_072 }],
  ['kimi', 'k3.2-pro-highspeed', { todoTools: false, defaultThinkingTier: 'high', availableThinkingTiers: ['low', 'high', 'max'], contextWindow: 1_048_576, defaultMaxOutputTokens: 64_000, maxOutputTokens: 131_072 }],
  ['minimax', 'MiniMax-M3.5', { todoTools: false, contextWindow: 1_000_000, defaultMaxOutputTokens: 8_192, maxOutputTokens: 16_384 }],
  ['minimax', 'minimax-m4', { todoTools: false, contextWindow: 1_000_000, defaultMaxOutputTokens: 8_192, maxOutputTokens: 16_384 }],
  // The window and cap below are the vendor's (were 983,616 / 32,768).
  ['qwen', 'qwen3.9-max', { todoTools: false, defaultThinkingTier: 'max', availableThinkingTiers: ['max'], contextWindow: 1_000_000, defaultMaxOutputTokens: 16_384, maxOutputTokens: 131_072, supportsStrictTools: true }],
  ['qwen', 'qwen4-flash', { contextWindow: 1_000_000, defaultMaxOutputTokens: 16_384, maxOutputTokens: 131_072 }],
]

// Models added to the tables (this year's releases, each read
// from its vendor's model page that day) — what each reads, whole. The
// frozen copy above predates them.
const ADDED: ReadonlyArray<readonly [string, string, Frozen & { name: string }]> = [
  ['anthropic', 'claude-sonnet-5-5', { ...SONNET, name: 'Sonnet 5.5' }],
  ['anthropic', 'claude-sonnet-4-6', { ...SONNET, name: 'Sonnet 4.6', todoTools: undefined, availableThinkingTiers: ['low', 'medium', 'high', 'max'] }],
  ['anthropic', 'claude-opus-4-7', { ...FABLE, name: 'Opus 4.7', promptProfile: undefined, todoTools: undefined, defaultThinkingTier: 'high' }],
  ['anthropic', 'claude-opus-4-6', { ...FABLE, name: 'Opus 4.6', promptProfile: undefined, todoTools: undefined, defaultThinkingTier: 'high', availableThinkingTiers: ['low', 'medium', 'high', 'max'] }],
  ['openai', 'gpt-6.1-sol', { ...GPT, name: 'GPT-6.1 Sol', availableThinkingTiers: ['low', 'medium', 'high', 'xhigh', 'max'] }],
  ['openai', 'gpt-5.5', { ...GPT_LUNA, name: 'GPT-5.5', availableThinkingTiers: ['none', 'low', 'medium', 'high', 'xhigh'] }],
  ['openai', 'gpt-5.4', { ...GPT_LUNA, name: 'GPT-5.4', defaultThinkingTier: 'none', availableThinkingTiers: ['none', 'low', 'medium', 'high', 'xhigh'] }],
  ['openai', 'gpt-5.4-mini', { ...GPT_LUNA, name: 'GPT-5.4 mini', defaultThinkingTier: 'none', availableThinkingTiers: ['none', 'low', 'medium', 'high', 'xhigh'], contextWindow: 400_000 }],
  ['openai', 'gpt-5.4-pro', { ...GPT_LUNA, name: 'GPT-5.4 Pro', availableThinkingTiers: ['medium', 'high', 'xhigh'] }],
  ['kimi', 'k3.1-pro', { ...{ todoTools: false, defaultThinkingTier: 'high', availableThinkingTiers: ['low', 'high', 'max'], contextWindow: 1_048_576, defaultMaxOutputTokens: 64_000, maxOutputTokens: 131_072 }, name: 'K3.1 Pro' }],
  ['kimi', 'k3.1-pro-highspeed', { ...{ todoTools: false, defaultThinkingTier: 'high', availableThinkingTiers: ['low', 'high', 'max'], contextWindow: 1_048_576, defaultMaxOutputTokens: 64_000, maxOutputTokens: 131_072 }, name: 'K3.1 Pro Highspeed' }],
]
const ADDED_IDS: Record<string, string[]> = {}
for (const [providerId, id] of ADDED) (ADDED_IDS[providerId] ??= []).push(id)

// Models the tables do NOT speak for.
const UNCOVERED: ReadonlyArray<readonly [string, string, string]> = [
  ['anthropic', 'claude-opus-4-5-20251101', 'below minVersion 4.6 (extended thinking only)'],
  ['anthropic', 'claude-opus-4-1-20250805', 'below minVersion'],
  ['anthropic', 'claude-sonnet-4-5-20250929', 'below minVersion 4.6'],
  ['anthropic', 'claude-haiku-4', 'below minVersion'],
  ['anthropic', 'claude-opus-5-5-fast', 'a variant is another family'],
  ['openai', 'gpt-5.5-sol', 'below minVersion 5.6'],
  ['openai', 'gpt-5-astra', 'below minVersion 6'],
  ['openai', 'gpt-6-pro', 'GPT-5.5 / 5.4 Pro are FIXED rows: nothing follows them'],
  ['openai', 'gpt-5.2', 'below the base GPT row (minVersion 5.4)'],
  ['openai', 'gpt-5-mini', 'below the mini row (minVersion 5.4)'],
  ['openai', 'gpt-6-nova', 'no row'],
  ['chatgpt-pro', 'gpt-5.5-pro', 'not served on the Codex backend: no row'],
  ['deepseek', 'deepseek-v3-pro', 'below minVersion'],
  ['deepseek', 'deepseek-flash-lite', 'a FIXED row is one id'],
  ['glm', 'glm-3-turbo', 'no row'],
  ['glm', 'glm-5v-turbo', 'no row'],
  ['google', 'gemini-2-flash', 'below minVersion 2.5'],
  ['google', 'gemini-4-ultra', 'no row'],
  ['kimi', 'k2', 'below minVersion'],
  ['kimi', 'k3-pro', 'below the Pro row (minVersion 3.1)'],
  ['kimi', 'kimi-for-coding-pro', 'a FIXED row is one id'],
  ['minimax', 'MiniMax-M1', 'below minVersion'],
  ['qwen', 'qwen3.6-max', 'below minVersion 3.7'],
  ['qwen', 'qwen3.5-plus', 'below minVersion 3.7'],
]

const expectFrozen = (providerId: string, id: string, frozen: Frozen) => {
  const row = findConfiguredModel(providerId, id)
  expect(row, `${providerId}/${id} is covered`).toBeDefined()
  for (const field of ['promptProfile', 'todoTools', 'defaultThinkingTier', 'availableThinkingTiers', 'contextWindow', 'defaultMaxOutputTokens', 'maxOutputTokens'] as const) {
    expect(row![field], `${providerId}/${id}.${field}`).toEqual(frozen[field])
  }
  expect(row!.supportsStrictTools, `${providerId}/${id}.supportsStrictTools`).toBe(frozen.supportsStrictTools)
}

describe('every provider table as family rows', () => {
  it('the catalog check passes (rows and tier fields)', () => {
    expect(familyRowProblems(NEXUS_MODEL_CONFIG, versionParser)).toEqual([])
  })

  it('every curated table but Ollama\'s names its families', () => {
    for (const provider of NEXUS_MODEL_CONFIG.providers) {
      if (provider.filterMode !== 'curated') continue
      // Ollama's ids are local tags (`qwen3.5:14b`), matched by substring:
      // there is no vendor version line to follow.
      expect(provider.models.some(row => row.family), provider.providerId).toBe(provider.providerId !== 'ollama')
    }
    // A fixed row in a migrated table is deliberate — these, and no others.
    const fixed = NEXUS_MODEL_CONFIG.providers
      .filter(p => p.models.some(row => row.family))
      .flatMap(p => p.models.filter(row => !row.family).map(row => `${p.providerId}/${row.name}`))
    expect(fixed).toEqual([
      'openai/GPT-5.4 Pro',
      'openai/GPT-5.5 Pro',
      'glm/GLM-4V Plus',
      'deepseek/V4.1 Flash',
      'google/Gemini 3.1 Pro Preview',
      'google/Gemini 3 Flash Preview',
      'google/Gemini 3.1 Flash-Lite Preview',
      'kimi/K2.8 Preview',
      'kimi/K2.7 Code Highspeed',
    ])
  })

  it('the frozen copy covers every provider that has curated rows', () => {
    expect(Object.keys(BEFORE).sort()).toEqual(
      NEXUS_MODEL_CONFIG.providers
        .filter(p => p.filterMode === 'curated' && p.providerId !== 'ollama')
        .map(p => p.providerId)
        .sort(),
    )
    expect(SHIPPED.length).toBeGreaterThan(60)
  })

  it.each(SHIPPED)('%s/%s reads exactly what its own row said', (providerId, id, figures) => {
    const row = findConfiguredModel(providerId, id)
    expect(row, 'still covered').toBeDefined()
    for (const field of FROZEN_FIELDS) {
      if (field === 'supportsImageInput') {
        // The catalog now states image input where the row was
        // silent; an absent flag already read as "takes images", so what
        // the model does is unchanged.
        expect(row![field] ?? true, `${providerId}/${id}.${field}`).toBe(figures[field] ?? true)
        continue
      }
      expect(row![field], `${providerId}/${id}.${field}`).toEqual(figures[field])
    }
  })

  it.each(UNSHIPPED)('%s/%s — not shipped — reads its family\'s row, flags included', (providerId, id, frozen) => {
    expectFrozen(providerId, id, frozen)
    // No stale label: the name is the listing's to give.
    expect(findConfiguredModel(providerId, id)!.name).toBeUndefined()
    // The consumers of the opt-in flags agree (they share the lookup).
    expect(modelSupportsStrictTools(id, providerId)).toBe(frozen.supportsStrictTools === true)
    expect(resolvePromptProfile({ providerId, modelId: id })).toBe(frozen.promptProfile ?? 'standard')
    expect(modelUsesTodoTools(id, providerId)).toBe(frozen.todoTools !== false)
  })

  it.each(ADDED)('%s/%s — added 2026-10-07 — reads its vendor\'s figures', (providerId, id, frozen) => {
    expectFrozen(providerId, id, frozen)
    expect(findConfiguredModel(providerId, id)!.name).toBe(frozen.name)
    expect(resolvePromptProfile({ providerId, modelId: id })).toBe(frozen.promptProfile ?? 'standard')
    expect(modelUsesTodoTools(id, providerId)).toBe(frozen.todoTools !== false)
  })

  it.each(UNCOVERED)('%s/%s is not covered: %s', (providerId, id) => {
    expect(findConfiguredModel(providerId, id)).toBeUndefined()
    // …so it fails safe: no strict tools, the standard prompt, the todo tools.
    expect(modelSupportsStrictTools(id, providerId)).toBe(false)
    expect(resolvePromptProfile({ providerId, modelId: id })).toBe('standard')
    expect(modelUsesTodoTools(id, providerId)).toBe(true)
  })

  it('a family row is this provider\'s only: a gateway id of the same model reads nothing here', () => {
    expect(findConfiguredModel('anthropic', 'anthropic/claude-fable-5.1')).toBeUndefined()
    expect(findConfiguredModel('openai', 'claude-fable-5-1')).toBeUndefined()
  })
})

// ── Known versions ─────────────────────────────────────────────────────────

describe('a family row names the versions it knows (`versions[<v>].id`)', () => {
  const idsOf = (providerId: string) =>
    knownModelRows(catalogRows(providerId), versionParser(providerId)).map(row => deriveCanonicalModelId(row.model))

  it('one row per known model: the verified version, then the named ones, newest first', () => {
    expect(idsOf('anthropic')).toEqual([
      'claude-fable-5-1', 'claude-fable-5',
      'claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6',
      'claude-sonnet-5-5', 'claude-sonnet-5', 'claude-sonnet-4-6',
      'claude-haiku-4-5',
    ])
    expect(idsOf('minimax')).toEqual([
      'MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2.5', 'MiniMax-M2.1', 'MiniMax-M2',
      'MiniMax-M2.7-highspeed', 'MiniMax-M2.5-highspeed', 'MiniMax-M2.1-highspeed',
    ])
    // A fixed row is itself, where it stands — pattern rows included.
    expect(idsOf('google').slice(-3)).toEqual([undefined, undefined, undefined])
    expect(idsOf('deepseek')).toEqual(['deepseek-v4-pro', 'deepseek-flash'])
  })

  it('a known version\'s row carries what that version reads, in the verified row\'s pattern shape', () => {
    const rows = knownModelRows(catalogRows('anthropic'), versionParser('anthropic'))
    const opus5 = rows.find(row => deriveCanonicalModelId(row.model) === 'claude-opus-5')!
    expect(opus5).toMatchObject({ name: 'Opus 5', defaultThinkingTier: 'high', promptProfile: 'lean', supportsStrictTools: true })
    // Anthropic's optional date suffix comes along; the row is a FIXED one.
    expect(String(opus5.model)).toBe(String.raw`/^claude-opus-5(?:-\d{8})?$/i`)
    for (const key of ['family', 'minVersion', 'maxVersion', 'versions', 'id']) expect(key in opus5, key).toBe(false)
    // A string-pattern family keeps string patterns.
    // With the catalog's figures beneath (as the host is sent them): the
    // version's window is the catalog's, its image flag the row's own.
    const m27 = knownModelRows(catalogRows('minimax'), versionParser('minimax'), 'minimax')
      .find(row => deriveCanonicalModelId(row.model) === 'MiniMax-M2.7')!
    expect(m27).toMatchObject({ contextWindow: 204_800, supportsImageInput: false, todoTools: false })
  })

  it('the host is told of exactly the models it was told of before', () => {
    // The host flattens each published `model` to a literal id and splices
    // it into its own catalog; one it cannot flatten is dropped
    // (`DeriveTsModelId`, nexus_llm_host.cc). Same ids as the per-version
    // rows published — nothing more (no `*` family key), nothing less.
    const wire = serializeNexusModelConfig(NEXUS_MODEL_CONFIG)
    for (const [providerId, rows] of Object.entries(BEFORE)) {
      const published = wire.providers.find(p => p.providerId === providerId)!.models
      expect(published.some(model => model.model.includes('*') && !model.model.includes('(?:')), providerId).toBe(false)
      const ids = published
        .map(model => deriveCanonicalModelId(/[\\^$(]/.test(model.model) ? new RegExp(model.model) : model.model))
        .filter((id): id is string => !!id)
      // The fixture also holds dated snapshots and ids only a pattern row
      // matches — neither is a published row.
      const expected = [
        ...Object.keys(rows).filter(id => !/-\d{8}$|-\d{4}-\d{2}-\d{2}$|preview/.test(id)),
        ...(ADDED_IDS[providerId] ?? []),
      ]
      expect([...ids].sort(), providerId).toEqual([...expected].sort())
    }
  })

  it('a known version is offered with no listing at all: a tier pinned to one is a real row', () => {
    // MiniMax's fast and balanced tiers are the fixed id `MiniMax-M2.7`.
    const row = builtInEntryRow(host('minimax'), undefined)
    expect(row.models.some(model => model.id === 'MiniMax-M2.7' && model.enabled)).toBe(true)
    expect(row.entryFamilies!.find(f => f.family === 'MiniMax-M*')!.versions.map(v => v.versionLabel))
      .toEqual(['3', '2.7', '2.5', '2.1', '2'])
    expect(getTierModelForProvider('minimax', 'fast')).toBe('MiniMax-M2.7')
  })

  it('a version\'s id must be of that family and that version', () => {
    const problems = (versions: Record<string, { id: string }>) =>
      familyRowProblems({ providers: [{ providerId: 'x', models: [{ family: 'm-*', model: 'm-3', versions }] }] }, () => versionParser('x'))
    expect(problems({ '2': { id: 'm-2' }, '2.5': { id: 'm-2.5-20260101' } })).toEqual([])
    expect(problems({ '2': { id: 'm-2.5' } })).toEqual(["x / m-*: versions['2'].id m-2.5 reads as m-* 2.5"])
    expect(problems({ '2': { id: 'n-2' } })).toEqual(["x / m-*: versions['2'].id n-2 reads as n-* 2"])
  })
})

// ── The entry catalog ──────────────────────────────────────────────────────

const host = (id: string, ...modelIds: string[]): BrowserLlmProvider => ({
  id,
  label: id,
  iconSvg: '',
  enabled: true,
  models: modelIds.map(modelId => ({ id: modelId, label: `Listed ${modelId}`, enabled: true, supportsStreaming: true })),
})

describe('a migrated table in the entry catalog', () => {
  const openai = () => host(
    'openai',
    'gpt-6-astra', 'gpt-6-sol', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.5-pro',
    'gpt-6.2-sol', // discovered: a newer Sol
    'gpt-5.5-sol', // below the Sol row's floor
    'gpt-6-pro', // a newer version of the FIXED row's family
    'gpt-6-nova', // no row at all
  )

  it('offers what the table says: Latest of each family row, a fixed row\'s own version', () => {
    expect(builtInFamilies(openai()).defaults).toEqual([
      { family: 'gpt-*-astra', version: 'latest' },
      { family: 'gpt-*-sol', version: 'latest' },
      { family: 'gpt-*-luna', version: 'latest' },
      { family: 'gpt-*-terra', version: 'latest' },
      { family: 'gpt-*', version: 'latest' },
      { family: 'gpt-*-mini', version: 'latest' },
      { family: 'gpt-*-pro', version: '5.4', id: 'gpt-5.4-pro' },
      { family: 'gpt-*-pro', version: '5.5', id: 'gpt-5.5-pro' },
    ])
    const row = builtInEntryRow(openai(), undefined)
    const offered = row.models.filter(m => !m.pickerAliasId)
    expect(offered.map(m => [m.id, m.entry?.kind, m.entry?.resolvedId])).toEqual([
      ['gpt-*-astra@latest', 'latest', 'gpt-6-astra'],
      ['gpt-*-sol@latest', 'latest', 'gpt-6.2-sol'], // follows the discovered version
      ['gpt-*-luna@latest', 'latest', 'gpt-6-luna'], // unlisted: the verified version
      ['gpt-*-terra@latest', 'latest', 'gpt-5.6-terra'],
      ['gpt-*@latest', 'latest', 'gpt-5.5'],
      ['gpt-*-mini@latest', 'latest', 'gpt-5.4-mini'],
      ['gpt-*-pro@5.4', 'pinned', 'gpt-5.4-pro'],
      ['gpt-*-pro@5.5', 'pinned', 'gpt-5.5-pro'], // fixed: gpt-6-pro does not move it
    ])
  })

  it('takes as candidates exactly the discovered versions a family row covers', () => {
    const { families, byId, uncurated } = builtInFamilies(openai())
    expect(families.get('gpt-*-sol')!.versions.map(v => v.versionLabel)).toEqual(['6.2', '6.1', '6', '5.6'])
    expect(families.get('gpt-*-pro')!.versions.map(v => v.versionLabel)).toEqual(['5.5', '5.4'])
    expect(families.has('gpt-*-nova')).toBe(false)
    expect(uncurated.size).toBe(0)
    // What the table does not speak for is offered as an Other model.
    expect(uncuratedModels(openai()).map(m => m.id)).toEqual(['gpt-5.5-sol', 'gpt-6-pro', 'gpt-6-nova'])
    // A covered version carries its family row's figures; its label stays the listing's.
    // (The catalog does not list 6.2: it reads the verified version's record.)
    expect(byId.get('gpt-6.2-sol')).toMatchObject({
      label: 'Listed gpt-6.2-sol',
      contextWindow: 1_050_000,
      maxOutputTokens: 128_000,
      defaultThinkingTier: 'medium',
      availableThinkingTiers: ['low', 'medium', 'high', 'xhigh', 'max'],
    })
    // …and one with a `versions` name takes it.
    expect(byId.get('gpt-5.6-sol')!.label).toBe('GPT-5.6 Sol')
  })

  it('grafts nothing onto the catalog: the family row answers at request time', () => {
    const before = catalogRows('openai').length
    builtInEntryRow(openai(), undefined)
    builtInEntryRow(openai(), undefined)
    expect(catalogRows('openai')).toHaveLength(before)
    expect(findConfiguredModel('openai', 'gpt-*-sol@latest')).toMatchObject({ contextWindow: 1_050_000, supportsStrictTools: true, todoTools: false })
  })

  it('an added Other model still gets its conservative row, and only that', () => {
    const before = catalogRows('openai').length
    const row = builtInEntryRow(openai(), { modelEntries: [{ family: 'gpt-*-nova', version: '6', id: 'gpt-6-nova' }] })
    expect(row.models.find(m => m.entry?.resolvedId === 'gpt-6-nova')?.entry?.unverified).toBe(true)
    expect(catalogRows('openai')).toHaveLength(before + 1)
    expect(findConfiguredModel('openai', 'gpt-6-nova')?.supportsStrictTools).toBeUndefined()
    resetModelEntryCatalog()
    expect(catalogRows('openai')).toHaveLength(before)
  })

  it('`maxVersion` caps what Latest follows', () => {
    const sol = catalogRows('openai').find(row => row.family === 'gpt-*-sol')!
    sol.maxVersion = '6.1'
    try {
      const { families } = builtInFamilies(openai())
      expect(families.get('gpt-*-sol')!.versions.map(v => v.versionLabel)).toEqual(['6.1', '6', '5.6'])
      const row = builtInEntryRow(openai(), undefined)
      expect(row.models.find(m => m.id === 'gpt-*-sol@latest')!.entry!.resolvedId).toBe('gpt-6.1-sol')
      expect(findConfiguredModel('openai', 'gpt-6.2-sol')).toBeUndefined()
      expect(uncuratedModels(openai()).map(m => m.id)).toContain('gpt-6.2-sol')
    } finally {
      delete sol.maxVersion
    }
  })

  it('a family whose only listed versions are previews keeps Latest on the verified version', () => {
    const row = builtInEntryRow(host('anthropic', 'claude-fable-5-1', 'claude-fable-5-2-preview'), undefined)
    const fable = row.models.find(m => m.id === 'claude-fable-*@latest')!
    expect(fable.entry!.resolvedId).toBe('claude-fable-5-1')
    // The preview is a candidate (pinnable), reading the family row.
    expect(row.entryFamilies!.find(f => f.family === 'claude-fable-*')!.versions.map(v => v.versionLabel))
      .toEqual(['5.1', '5', '5.2-preview']) // 5: a known version, never listed here
    expect(findConfiguredModel('anthropic', 'claude-fable-5-2-preview')?.promptProfile).toBe('lean')
  })
})

describe('a table of fixed rows only (Ollama)', () => {
  it('offers Latest of each family its rows form, and nothing is grafted for a sibling', () => {
    const before = catalogRows('ollama').length
    // `qwen4` is of the `qwen*` family the `qwen3.5` row forms, but no row
    // names it: it is an Other model, not a candidate with borrowed figures.
    const provider = host('ollama', 'qwen3.5', 'qwen4', 'llama3.3')
    const { families, defaults } = builtInFamilies(provider)
    expect(defaults.every(entry => entry.version === 'latest')).toBe(true)
    expect(defaults).toContainEqual({ family: 'qwen*', version: 'latest' })
    expect(families.get('qwen*')!.versions.map(v => v.versionLabel)).not.toContain('4')
    expect(uncuratedModels(provider).map(m => m.id)).toEqual(['qwen4'])
    builtInEntryRow(provider, undefined)
    expect(catalogRows('ollama')).toHaveLength(before)
    expect(findConfiguredModel('ollama', 'qwen4')).toBeUndefined()
  })
})

describe('no table grafts a row for a discovered version', () => {
  const LISTED: Record<string, string[]> = {
    'chatgpt-pro': ['gpt-6-sol', 'gpt-6.1-sol', 'gpt-6-luna'],
    glm: ['glm-5.3', 'glm-5.4', 'glm-6-flash'],
    deepseek: ['deepseek-v4-pro', 'deepseek-v5-pro'],
    google: ['gemini-3.8-flash', 'gemini-3.9-flash', 'gemini-3.5-pro', 'gemini-3.1-pro-preview'],
    kimi: ['k3', 'k4', 'k3.1-pro', 'k4-pro'],
    minimax: ['MiniMax-M3', 'MiniMax-M3.5'],
    qwen: ['qwen3.8-max', 'qwen3.9-max'],
  }
  it.each(Object.entries(LISTED))('%s: the discovered versions are candidates read from the family row', (providerId, ids) => {
    const before = catalogRows(providerId).length
    const row = builtInEntryRow(host(providerId, ...ids), undefined)
    expect(catalogRows(providerId)).toHaveLength(before)
    const selectable = new Set(row.models.map(m => m.entry?.resolvedId ?? m.id))
    for (const id of ids) {
      expect(selectable.has(id), `${providerId}/${id} is selectable`).toBe(true)
      expect(findConfiguredModel(providerId, id), `${providerId}/${id} is covered`).toBeDefined()
    }
  })

  it('a stable Gemini 3.x Pro moves Latest and the best tier; a preview does not', () => {
    builtInEntryRow(host('google', 'gemini-2.5-pro', 'gemini-3.1-pro-preview'), undefined)
    expect(getTierModelForProvider('google', 'best')).toBe('gemini-2.5-pro')
    // The preview reads its own fixed row, not the Pro family's.
    expect(findConfiguredModel('google', 'gemini-3.1-pro-preview')).toMatchObject({ name: 'Gemini 3.1 Pro Preview', todoTools: false })
    builtInEntryRow(host('google', 'gemini-2.5-pro', 'gemini-3.1-pro-preview', 'gemini-3.5-pro'), undefined)
    expect(getTierModelForProvider('google', 'best')).toBe('gemini-3.5-pro')
  })
})

// ── The tier ladder ────────────────────────────────────────────────────────

describe('the tier ladder names families', () => {
  it('before any catalog is built a family tier is its verified version', () => {
    expect(getFastModelForProvider('anthropic')).toBe('claude-haiku-4-5')
    expect(getTierModelForProvider('anthropic', 'balanced')).toBe('claude-sonnet-5-5')
    expect(getTierModelForProvider('anthropic', 'best')).toBe('claude-fable-5-1')
    expect(getTierModelForProvider('openai', 'fast')).toBe('gpt-6-luna')
    expect(getTierModelForProvider('openai', 'balanced')).toBe('gpt-6.1-sol')
    expect(getTierModelForProvider('openai', 'best')).toBe('gpt-6-astra')
  })

  it('once the catalog is built it follows the family\'s Latest', () => {
    builtInEntryRow(host('anthropic', 'claude-haiku-4-5-20251001', 'claude-haiku-5', 'claude-fable-5-1', 'claude-fable-5-2', 'claude-sonnet-5'), undefined)
    expect(getTierModelForProvider('anthropic', 'fast')).toBe('claude-haiku-5')
    expect(getTierModelForProvider('anthropic', 'best')).toBe('claude-fable-5-2')
    // Sonnet 5.5 is a known version newer than the listed 5: Latest is it.
    expect(getTierModelForProvider('anthropic', 'balanced')).toBe('claude-sonnet-5-5')
    // A rebuild against a listing that dropped the version moves back.
    builtInEntryRow(host('anthropic', 'claude-haiku-4-5-20251001', 'claude-fable-5-1'), undefined)
    expect(getTierModelForProvider('anthropic', 'fast')).toBe('claude-haiku-4-5')
    expect(getTierModelForProvider('anthropic', 'best')).toBe('claude-fable-5-1')
  })

  it('…whether or not the user keeps that family in the picker', () => {
    // The user's list holds Fable only: Haiku is still the fast tier.
    const row = builtInEntryRow(
      host('anthropic', 'claude-haiku-5', 'claude-fable-5-1'),
      { modelEntries: [{ family: 'claude-fable-*', version: 'latest' }] },
    )
    expect(row.models.filter(m => !m.pickerAliasId).map(m => m.id)).toEqual(['claude-fable-*@latest'])
    expect(resolveModelId('anthropic', 'claude-haiku-*@latest')).toBe('claude-haiku-5')
    expect(getTierModelForProvider('anthropic', 'fast')).toBe('claude-haiku-5')
    // The tier's model is a selectable (hidden) row of the catalog.
    expect(row.models.some(m => m.id === 'claude-haiku-5' && m.enabled)).toBe(true)
  })

  it('a tier is one concrete id per provider: another provider\'s resolution is not read', () => {
    builtInEntryRow(host('anthropic', 'claude-haiku-5'), undefined)
    expect(getTierModelForProvider('openai', 'fast')).toBe('gpt-6-luna')
  })

  it('every ladder means, before any listing, exactly the ids it named before', () => {
    // [fast, balanced, best] as the tables had them written out — but for the
    // two balanced families whose verified version moved
    // (Sonnet 5 → 5.5, GPT-6 Sol → 6.1 Sol): a tier follows its family.
    const LADDERS: Record<string, [string, string, string]> = {
      openai: ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-astra'],
      'chatgpt-pro': ['gpt-5.6-luna', 'gpt-6-sol', 'gpt-6-astra'],
      anthropic: ['claude-haiku-4-5', 'claude-sonnet-5-5', 'claude-fable-5-1'],
      glm: ['glm-5.3-flash', 'glm-5.2', 'glm-5.3'],
      deepseek: ['deepseek-flash', 'deepseek-flash', 'deepseek-v4-pro'],
      google: ['gemini-3.5-flash-lite', 'gemini-3.6-flash', 'gemini-2.5-pro'],
      kimi: ['kimi-for-coding', 'k3', 'k3.1-pro'],
      minimax: ['MiniMax-M2.7', 'MiniMax-M2.7', 'MiniMax-M3'],
      qwen: ['qwen3.8-flash', 'qwen3.7-max', 'qwen3.8-max'],
    }
    for (const [providerId, [fast, balanced, best]] of Object.entries(LADDERS)) {
      expect([
        getTierModelForProvider(providerId, 'fast'),
        getTierModelForProvider(providerId, 'balanced'),
        getTierModelForProvider(providerId, 'best'),
      ], providerId).toEqual([fast, balanced, best])
    }
  })

  it('a tier pinned to a version of its own family stays there while the family moves', () => {
    // glm / qwen / minimax: balanced (and minimax fast) is a fixed id that is
    // a version of the best tier's family.
    builtInEntryRow(host('glm', 'glm-5.2', 'glm-5.3', 'glm-5.4', 'glm-5.3-flash', 'glm-6-flash'), undefined)
    expect(getTierModelForProvider('glm', 'best')).toBe('glm-5.4')
    expect(getTierModelForProvider('glm', 'balanced')).toBe('glm-5.2')
    expect(getTierModelForProvider('glm', 'fast')).toBe('glm-6-flash')
    builtInEntryRow(host('qwen', 'qwen3.7-max', 'qwen3.8-max', 'qwen3.9-max'), undefined)
    expect(getTierModelForProvider('qwen', 'best')).toBe('qwen3.9-max')
    expect(getTierModelForProvider('qwen', 'balanced')).toBe('qwen3.7-max')
    builtInEntryRow(host('minimax', 'MiniMax-M2.7', 'MiniMax-M3', 'MiniMax-M3.5'), undefined)
    expect(getTierModelForProvider('minimax', 'best')).toBe('MiniMax-M3.5')
    expect(getTierModelForProvider('minimax', 'fast')).toBe('MiniMax-M2.7')
  })

  it('a fixed tier id is that id, as before', () => {
    expect(getTierModelForProvider('kimi', 'fast')).toBe('kimi-for-coding')
    expect(getTierModelForProvider('qwen', 'balanced')).toBe('qwen3.7-max')
    expect(getTierModelForProvider('openrouter', 'fast')).toBeUndefined() // a gateway declares no ladder
    expect(getTierModelForProvider(undefined, 'fast')).toBeUndefined()
  })

  it('the candidates a child session gets are the resolved model, then the parent', () => {
    builtInEntryRow(host('anthropic', 'claude-haiku-5', 'claude-fable-5-2'), undefined)
    expect(getFastModel('anthropic', 'claude-sonnet-5', 'agent_tool')).toEqual([
      { providerId: 'anthropic', modelId: 'claude-haiku-5' },
      { providerId: 'anthropic', modelId: 'claude-sonnet-5' },
    ])
    // The parent already runs the tier's model: no second candidate.
    expect(topTierModel('anthropic', 'claude-fable-5-2', 'agent_tool')).toEqual([
      { providerId: 'anthropic', modelId: 'claude-fable-5-2' },
    ])
  })

  it('a family key no row declares is no tier, and fails the catalog check', () => {
    const config = {
      providers: [{
        providerId: 'x',
        fastModel: 'm-*-mini',
        bestModel: 'M-*', // case aside, this is the row below
        models: [{ family: 'm-*', model: 'm-3' }],
      }],
    }
    expect(getTierModelForProvider('x', 'fast', config)).toBeUndefined()
    expect(getTierModelForProvider('x', 'best', config)).toBe('m-3')
    expect(familyRowProblems(config, () => versionParser('x'))).toEqual(['x / fastModel: no family row is m-*-mini'])
  })
})
