// The figures the built-in rows leave to the model catalog are guaranteed by
// the bundle snapshot (F-28). The checked-in fixture
// (fixtures/builtin-catalog-figures.json, written by
// scripts/gen_builtin_catalog_figures.ts from a snapshot) is what the
// snapshot stated for every such row; with it installed, every model reads
// exactly what its row stated before the figures were moved to the catalog.
import { afterEach, describe, expect, it } from 'vitest'
import { catalogCoverageProblems, catalogUnits, snapshotCoverageProblems } from '../../catalog/builtinCatalogCoverage'
import { buildSnapshotFiles } from '../../catalog/snapshotGenerator'
import type { CatalogProviderRecords } from '../../catalog/types'
import { resetCatalogFigures } from '../../config/nexusModelConfig/catalogFigures'
import { findConfiguredModel } from '../../config/nexusModelConfig/findConfiguredModel'
import {
  BUILTIN_CATALOG_FIGURES,
  builtinCatalogKey,
  builtinCatalogSourceDocument,
  installBuiltinCatalogFigures,
} from '../_helpers/builtinCatalogFigures'

afterEach(() => resetCatalogFigures())

/** The fixture as catalog records, each provider's models under its first key. */
function fixtureRecords(drop?: { providerId: string; modelId: string }): Map<string, CatalogProviderRecords> {
  const out = new Map<string, CatalogProviderRecords>()
  for (const [providerId, models] of Object.entries(BUILTIN_CATALOG_FIGURES)) {
    const records: CatalogProviderRecords = {}
    for (const [id, f] of Object.entries(models)) {
      if (drop && drop.providerId === providerId && drop.modelId === id) continue
      records[id] = {
        name: id,
        ...(f.contextWindow !== undefined ? { contextWindow: f.contextWindow } : {}),
        ...(f.maxOutputTokens !== undefined ? { maxOutput: f.maxOutputTokens } : {}),
        inputModalities: f.supportsImageInput === undefined ? [] : f.supportsImageInput ? ['text', 'image'] : ['text'],
        free: false,
      }
    }
    out.set(builtinCatalogKey(providerId), records)
  }
  return out
}

// What each model read from its row before the row left the figure to the
// catalog — the values deleted from the provider configs.
const ONE_M = 1_000_000
const BEFORE: Record<string, Record<string, { contextWindow?: number; maxOutputTokens?: number }>> = {
  openai: {
    'gpt-6-astra': { contextWindow: 1_050_000, maxOutputTokens: 128_000 },
    'gpt-6-sol': { contextWindow: 1_050_000, maxOutputTokens: 128_000 },
    'gpt-6.1-sol': { contextWindow: 1_050_000, maxOutputTokens: 128_000 },
    'gpt-5.6-sol': { contextWindow: 1_050_000, maxOutputTokens: 128_000 },
    'gpt-6-luna': { contextWindow: 1_050_000, maxOutputTokens: 128_000 },
    'gpt-5.6-luna': { contextWindow: 1_050_000, maxOutputTokens: 128_000 },
    'gpt-5.6-terra': { contextWindow: 1_050_000, maxOutputTokens: 128_000 },
    'gpt-5.5': { contextWindow: 1_050_000, maxOutputTokens: 128_000 },
    'gpt-5.4': { contextWindow: 1_050_000, maxOutputTokens: 128_000 },
    'gpt-5.4-mini': { contextWindow: 400_000, maxOutputTokens: 128_000 },
    'gpt-5.4-pro': { contextWindow: 1_050_000, maxOutputTokens: 128_000 },
    'gpt-5.5-pro': { contextWindow: 1_050_000, maxOutputTokens: 128_000 },
  },
  // Every Anthropic row but Haiku's: 1M / 128K; Haiku (and its dated id): 200K / 64K.
  anthropic: Object.fromEntries([
    ...['fable-5-1', 'fable-5', 'opus-5-5', 'opus-5', 'opus-4-8', 'opus-4-7', 'opus-4-6', 'sonnet-5-5', 'sonnet-5', 'sonnet-4-6']
      .map(v => [`claude-${v}`, { contextWindow: ONE_M, maxOutputTokens: 128_000 }]),
    ...['', '-20251001'].map(suffix => [`claude-haiku-4-5${suffix}`, { contextWindow: 200_000, maxOutputTokens: 64_000 }]),
  ]),
  google: Object.fromEntries([
    'gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash',
    'gemini-3.5-flash-lite', 'gemini-2.5-flash-lite', 'gemini-2.5-pro',
    'gemini-3.1-pro-preview', 'gemini-3.1-pro-preview-customtools', 'gemini-3-pro-preview',
    'gemini-3-flash-preview', 'gemini-3.1-flash-lite', 'gemini-3.1-flash-lite-preview', 'gemini-3-flash-lite-preview',
  ].map(id => [id, { contextWindow: 1_048_576, maxOutputTokens: 65_536 }])),
  deepseek: {
    'deepseek-v4-pro': { contextWindow: ONE_M },
    'deepseek-flash': { contextWindow: ONE_M },
  },
  glm: {
    'glm-5.3': { contextWindow: ONE_M },
    'glm-5.2': { contextWindow: ONE_M },
    'glm-5.3-flash': { contextWindow: ONE_M },
  },
  kimi: {
    k3: { contextWindow: 1_048_576, maxOutputTokens: 131_072 },
    'k3-256k': { contextWindow: 262_144, maxOutputTokens: 131_072 },
    'kimi-for-coding': { contextWindow: 1_048_576 },
    'kimi-for-coding-highspeed': { contextWindow: 262_144 },
  },
  minimax: {
    'MiniMax-M3': { contextWindow: ONE_M },
    'MiniMax-M2.7': { contextWindow: 204_800 },
    'MiniMax-M2.5': { contextWindow: 204_800 },
    'MiniMax-M2.1': { contextWindow: 204_800 },
    'MiniMax-M2': { contextWindow: 204_800 },
    'MiniMax-M2.7-highspeed': { contextWindow: 204_800 },
    'MiniMax-M2.5-highspeed': { contextWindow: 204_800 },
    'MiniMax-M2.1-highspeed': { contextWindow: 204_800 },
  },
}

// Figures checked against the vendor's own docs; each model reads the vendor's value (from the catalog, or from
// the row where the catalog's record is wrong). Sources: api-docs.deepseek.com create-chat-completion;
// docs.bigmodel.cn / docs.z.ai chat-completion (GLM-4.6 keeps the row's 200,000 window); alibabacloud.com
// model-studio qwen3 pages (3.7 Plus / 3.7 Max state 131,072; DashScope China's records say 64,000 / 65,536).
const VENDOR: Record<string, Record<string, { contextWindow?: number; maxOutputTokens?: number; supportsImageInput?: boolean }>> = {
  deepseek: {
    'deepseek-v4-pro': { contextWindow: ONE_M, maxOutputTokens: 393_216, supportsImageInput: false },
    'deepseek-flash': { contextWindow: ONE_M, maxOutputTokens: 393_216 },
  },
  glm: {
    'glm-5.3': { maxOutputTokens: 131_072 },
    'glm-5.2': { maxOutputTokens: 131_072 },
    'glm-4.6': { contextWindow: 200_000, maxOutputTokens: 131_072 },
    'glm-5.3-flash': { maxOutputTokens: 131_072 },
  },
  qwen: {
    'qwen3.8-max': { contextWindow: ONE_M, maxOutputTokens: 131_072, supportsImageInput: true },
    'qwen3.8-flash': { contextWindow: ONE_M, maxOutputTokens: 131_072, supportsImageInput: true },
    'qwen3.7-plus': { contextWindow: ONE_M, maxOutputTokens: 131_072, supportsImageInput: true },
    'qwen3.7-max': { contextWindow: ONE_M, maxOutputTokens: 131_072, supportsImageInput: false },
    'qwen3.6-flash': { contextWindow: ONE_M, maxOutputTokens: 65_536, supportsImageInput: true },
  },
}

describe('the snapshot guarantees what the built-in rows leave to the catalog', () => {
  it('the fixture covers every such row', () => {
    const records = fixtureRecords()
    expect(catalogCoverageProblems(key => records.get(key))).toEqual([])
  })

  it('a missing record is a named problem', () => {
    const records = fixtureRecords({ providerId: 'openai', modelId: 'gpt-5.4-mini' })
    expect(catalogCoverageProblems(key => records.get(key))).toEqual([
      'openai / gpt-5.4-mini: the row leaves contextWindow to the catalog, but no record under openai states it',
      'openai / gpt-5.4-mini: the row leaves maxOutputTokens to the catalog, but no record under openai states it',
    ])
  })

  it('the generator\'s gate reads generated snapshot files the same way', () => {
    // A source document in the catalog source's own shape, built from the fixture.
    const files = buildSnapshotFiles(JSON.stringify(builtinCatalogSourceDocument()), Date.now())
    expect(snapshotCoverageProblems(files)).toEqual([])
    // Without one provider's models the publish fails, naming its rows.
    const problems = snapshotCoverageProblems(
      buildSnapshotFiles(JSON.stringify(builtinCatalogSourceDocument('minimax')), Date.now()),
    )
    expect(problems.length).toBeGreaterThan(0)
    expect(problems.every(line => line.startsWith('minimax / '))).toBe(true)
  })

  it('every unit of a mapped provider is in the fixture or states all its figures', () => {
    for (const unit of catalogUnits()) {
      if (unit.row.contextWindow !== undefined && unit.row.maxOutputTokens !== undefined) continue
      const fixture = BUILTIN_CATALOG_FIGURES[unit.providerId] ?? {}
      // A named version the catalog lacks is covered by its verified version.
      if (!unit.modelId) continue
      const covered = unit.modelId in fixture || (!!unit.verifiedId && unit.verifiedId in fixture)
      expect(covered, `${unit.providerId}/${unit.modelId}`).toBe(true)
    }
  })
})

describe('moving the figures to the catalog changed no shipped model', () => {
  const cases = Object.entries(BEFORE).flatMap(([providerId, models]) =>
    Object.entries(models).map(([id, figures]) => [providerId, id, figures] as const))

  it.each(cases)('%s/%s reads what its row stated', (providerId, id, figures) => {
    installBuiltinCatalogFigures()
    const row = findConfiguredModel(providerId, id)
    expect(row, 'covered').toBeDefined()
    for (const [field, value] of Object.entries(figures)) {
      expect(row![field as keyof typeof figures], `${providerId}/${id}.${field}`).toBe(value)
    }
  })
})

describe('where the vendor contradicted a row, the model reads the vendor value', () => {
  const cases = Object.entries(VENDOR).flatMap(([providerId, models]) =>
    Object.entries(models).map(([id, figures]) => [providerId, id, figures] as const))

  it.each(cases)('%s/%s', (providerId, id, figures) => {
    installBuiltinCatalogFigures()
    const row = findConfiguredModel(providerId, id)
    expect(row, 'covered').toBeDefined()
    for (const [field, value] of Object.entries(figures)) {
      expect(row![field as keyof typeof figures] ?? (field === 'supportsImageInput' ? true : undefined), `${providerId}/${id}.${field}`).toBe(value)
    }
  })
})

describe('a family version the catalog does not list reads the verified version record', () => {
  it('a future version reads the figures its family row stands for, not the default', () => {
    installBuiltinCatalogFigures()
    // Unlisted versions of rows whose figures moved to the catalog.
    expect(findConfiguredModel('anthropic', 'claude-fable-5-2')).toMatchObject({ contextWindow: ONE_M, maxOutputTokens: 128_000 })
    expect(findConfiguredModel('openai', 'gpt-6.2-sol')).toMatchObject({ contextWindow: 1_050_000, maxOutputTokens: 128_000 })
    expect(findConfiguredModel('qwen', 'qwen3.9-max')).toMatchObject({ contextWindow: ONE_M, maxOutputTokens: 131_072 })
    // A named version the catalog does not list: the M2.1 Highspeed twin.
    expect(findConfiguredModel('minimax', 'MiniMax-M2.1-highspeed')!.contextWindow).toBe(204_800)
    // A version's own override still wins over the verified record.
    expect(findConfiguredModel('glm', 'glm-4.6')!.contextWindow).toBe(200_000)
    // A version the catalog DOES list reads its own record, not the verified one.
    expect(findConfiguredModel('qwen', 'qwen3.6-flash')!.maxOutputTokens).toBe(65_536)
  })
})
