// Family rows (config/nexusModelConfig/familyRows.ts): one catalog row speaks for every version of a family.
// Pinned: the id reading over the gateways' real listings; which versions a row covers (`familyRowCovers`); what a
// covered version reads (`resolveFamilyRow`: versions[<v>] > the listing > the row); and the shared lookup
// (`findConfiguredModelIn`), the catalog check (`familyRowProblems`) and the wire view.
import { afterEach, describe, expect, it } from 'vitest'
import { NEXUS_MODEL_CONFIG } from '../config/nexusModelConfig'
import {
  familyRowCovers,
  familyRowProblems,
  listedFigures,
  recordListedFigures,
  resetListedFigures,
  resolveFamilyRow,
  type ListedModelFigures,
} from '../config/nexusModelConfig/familyRows'
import { findConfiguredModelIn } from '../config/nexusModelConfig/findConfiguredModel'
import {
  groupFamilies,
  LATEST,
  resolveEntry,
  versionParser,
} from '../config/nexusModelConfig/modelEntries'
import {
  recordEntryResolution,
  resetEntryResolutions,
} from '../config/nexusModelConfig/modelEntryResolution'
import {
  createAnthropicModelPattern,
  createExactModelPattern,
  createOpenAiModelPattern,
  deriveCanonicalModelId,
} from '../config/nexusModelConfig/patterns'
import { compareVersionsDesc, parseModelVersion } from '../config/nexusModelConfig/providers/shared/modelVersions'
import type { NexusConfiguredModel, NexusModelConfig } from '../config/nexusModelConfig/types'
import { serializeNexusModelConfig } from '../config/nexusModelConfigWire'
import {
  getAvailableThinkingTiersForModel,
  contextWindowOf,
  getDefaultMaxOutputTokensForModel,
} from '../engine/contextWindow'
import gatewayIds from './fixtures/gateway-model-ids.json'

afterEach(() => {
  resetListedFigures()
  resetEntryResolutions()
})

// The ids OpenRouter's and the Vercel AI Gateway's public `/models` listed on
// the fixture's `fetched` date (chat models only for Vercel) — ids only.
const GATEWAYS: Record<string, string[]> = {
  openrouter: gatewayIds.openrouter,
  'vercel-ai-gateway': gatewayIds['vercel-ai-gateway'],
}
const ALL_GATEWAY_IDS = Object.entries(GATEWAYS).flatMap(([gateway, ids]) => ids.map(id => [gateway, id] as const))

/** A gateway id's vendor prefix (`anthropic/`), '' for a bare id. */
const prefixOf = (id: string): string => id.slice(0, id.lastIndexOf('/') + 1)
/** The family key without the vendor prefix, lower-cased — what a first-party
 *  family key is compared with. */
const bareFamily = (id: string): string => parseModelVersion(id).family.slice(prefixOf(id).length).toLowerCase()

describe('the id reading over real gateway listings', () => {
  it('the fixture is the two listings, not a stub', () => {
    expect(GATEWAYS.openrouter!.length).toBeGreaterThan(400)
    expect(GATEWAYS['vercel-ai-gateway']!.length).toBeGreaterThan(200)
  })

  it('every listed id reads: the family keeps its vendor prefix, the version is numeric', () => {
    for (const [gateway, id] of ALL_GATEWAY_IDS) {
      const info = parseModelVersion(id)
      expect(info.family.startsWith(prefixOf(id)), `${gateway} ${id} → ${info.family}`).toBe(true)
      expect(info.version.every(n => Number.isInteger(n) && n >= 0), `${gateway} ${id} version`).toBe(true)
      // A versioned id has exactly one `*`; a family of one is the id itself
      // (minus a dated snapshot).
      expect(info.family.split('*').length - 1, `${gateway} ${id} → ${info.family}`).toBe(info.version.length > 0 ? 1 : 0)
      expect(info.versionLabel === '', `${gateway} ${id} label`).toBe(info.version.length === 0)
    }
  })

  it('every listed version resolves back to an id of that family and version', () => {
    for (const [gateway, ids] of Object.entries(GATEWAYS)) {
      const families = groupFamilies(ids.map(id => ({ id })))
      for (const family of families.values()) {
        for (const version of family.versions) {
          const resolved = resolveEntry({ family: family.family, version: version.versionLabel || LATEST }, families)
          // A family of one whose only id is a preview has no `latest`.
          if (!resolved) {
            expect(version.versionLabel === '' && version.preview, `${gateway} ${family.family}`).toBe(true)
            continue
          }
          if (version.versionLabel === '') continue // resolved through `latest`
          expect(version.ids, `${gateway} ${family.family}@${version.versionLabel}`).toContain(resolved.id)
          const back = parseModelVersion(resolved.id)
          expect([back.family, back.versionLabel]).toEqual([family.family, version.versionLabel])
        }
      }
    }
  })

  it('`latest` is the newest stable version of its family — never a preview, never older than a stable sibling', () => {
    for (const [gateway, ids] of Object.entries(GATEWAYS)) {
      const families = groupFamilies(ids.map(id => ({ id })))
      for (const family of families.values()) {
        const latest = resolveEntry({ family: family.family, version: LATEST }, families)
        const stable = family.versions.filter(v => !v.preview)
        expect(!!latest, `${gateway} ${family.family}`).toBe(stable.length > 0)
        if (!latest) continue
        expect(latest.preview).toBe(false)
        const newest = parseModelVersion(latest.id).version
        for (const other of stable) {
          // compareVersionsDesc(a, b) <= 0 ⇔ a is at least as new as b.
          expect(
            compareVersionsDesc(newest, other.version),
            `${gateway} ${family.family}: ${latest.versionLabel} vs ${other.versionLabel}`,
          ).toBeLessThanOrEqual(0)
        }
      }
    }
  })

  // The cross-format fact family rows and the gateway tier ladder both rest
  // on: a vendor's own id and a gateway's id for the same model reduce to
  // the same family (minus the gateway's vendor prefix, case aside), though
  // the ids themselves never match (`5-1` vs `5.1`, `MiniMax-M3` vs
  // `minimax-m3`, a dated snapshot on one side only).
  it.each([
    ['claude-fable-5-1', 'openrouter', 'anthropic/claude-fable-5.1', '5.1'],
    ['claude-fable-5-1', 'vercel-ai-gateway', 'anthropic/claude-fable-5.1', '5.1'],
    ['claude-haiku-4-5-20251001', 'openrouter', 'anthropic/claude-haiku-4.5', '4.5'],
    ['claude-sonnet-5', 'vercel-ai-gateway', 'anthropic/claude-sonnet-5', '5'],
    ['gpt-6-sol', 'openrouter', 'openai/gpt-6-sol', '6'],
    ['gpt-6-luna', 'vercel-ai-gateway', 'openai/gpt-6-luna', '6'],
    ['gemini-3.6-flash', 'openrouter', 'google/gemini-3.6-flash', '3.6'],
    ['gemini-3.5-flash-lite', 'vercel-ai-gateway', 'google/gemini-3.5-flash-lite', '3.5'],
    ['glm-5.2', 'openrouter', 'z-ai/glm-5.2', '5.2'],
    ['glm-5.2', 'vercel-ai-gateway', 'zai/glm-5.2', '5.2'],
    ['MiniMax-M3', 'openrouter', 'minimax/minimax-m3', '3'],
    ['qwen3.8-max', 'openrouter', 'qwen/qwen3.8-max-0902', '3.8'],
    ['qwen3.8-max', 'vercel-ai-gateway', 'alibaba/qwen3.8-max', '3.8'],
    ['deepseek-v4-pro', 'openrouter', 'deepseek/deepseek-v4-pro', '4'],
  ])('%s and %s `%s` are one family, version %s', (firstParty, gateway, gatewayId, version) => {
    expect(GATEWAYS[gateway], 'the gateway lists it').toContain(gatewayId)
    expect(bareFamily(gatewayId)).toBe(parseModelVersion(firstParty).family.toLowerCase())
    expect(parseModelVersion(gatewayId).versionLabel).toBe(version)
    expect(parseModelVersion(firstParty).versionLabel).toBe(version)
  })

  it('a variant is a family of its own: it never reads as its base model', () => {
    const variants = ALL_GATEWAY_IDS.map(([, id]) => id).filter(id => /:(free|thinking|extended|nitro)$/.test(id))
    expect(variants.length).toBeGreaterThan(5)
    for (const id of variants) {
      const base = id.replace(/:[a-z]+$/, '')
      expect(parseModelVersion(id).family, id).toBe(`${parseModelVersion(base).family}${id.slice(base.length)}`)
      expect(parseModelVersion(id).family).not.toBe(parseModelVersion(base).family)
    }
    expect(parseModelVersion('anthropic/claude-opus-5.5-fast').family).toBe('anthropic/claude-opus-*-fast')
  })

  it('within one gateway a bare family lives under one vendor prefix for the first-party ladders', () => {
    // What "look under the user's own prefix" relies on: no ladder family is
    // ambiguous inside a gateway today. (A gateway that lists one family
    // under two prefixes is still handled — the lookup keeps the prefix —
    // this only records that none does yet.)
    for (const firstParty of ['claude-fable-5-1', 'claude-sonnet-5', 'claude-haiku-4-5', 'gpt-6-sol', 'gemini-3.6-flash']) {
      const family = parseModelVersion(firstParty).family.toLowerCase()
      for (const [gateway, ids] of Object.entries(GATEWAYS)) {
        const prefixes = new Set(ids.filter(id => bareFamily(id) === family).map(prefixOf))
        expect([...prefixes], `${gateway} ${family}`).toHaveLength(1)
      }
    }
  })
})

// ── A family row ───────────────────────────────────────────────────────────

const FABLE: NexusConfiguredModel = {
  family: 'claude-fable-*',
  model: createAnthropicModelPattern('claude-fable-5-1'),
  name: 'Fable 5.1',
  minVersion: '5',
  promptProfile: 'lean',
  todoTools: false,
  supportsStrictTools: true,
  defaultThinkingTier: 'extra-high',
  availableThinkingTiers: ['low', 'medium', 'high', 'extra-high', 'max'],
  contextWindow: 1_000_000,
  defaultMaxOutputTokens: 64_000,
  maxOutputTokens: 128_000,
  versions: {
    '5': { name: 'Fable 5', defaultThinkingTier: 'high', contextWindow: 500_000 },
  },
}

const info = (id: string) => parseModelVersion(id)

describe('familyRowCovers — which versions a row speaks for', () => {
  const row = (extra: Partial<NexusConfiguredModel> = {}): NexusConfiguredModel => ({
    family: 'claude-fable-*',
    model: 'claude-fable-5-1',
    ...extra,
  })
  it.each([
    // [row range, id, covered]
    [{}, 'claude-fable-5-1', true],
    [{}, 'claude-fable-9', true], // no ceiling: tomorrow's version
    [{}, 'claude-fable-4', true], // no floor
    [{}, 'claude-fable-5-2-20270101', true], // a dated snapshot is its version
    [{}, 'claude-fable-5-2-preview', true], // a preview is its version too
    [{}, 'claude-opus-5-1', false], // another family
    [{}, 'claude-fable-5-1-fast', false], // a variant is another family
    [{}, 'anthropic/claude-fable-5.1', false], // a gateway id is another provider's family
    [{ minVersion: '5' }, 'claude-fable-5', true],
    [{ minVersion: '5' }, 'claude-fable-4-9', false],
    [{ minVersion: '5.1' }, 'claude-fable-5', false],
    [{ minVersion: '4.8' }, 'claude-fable-4-10', true], // element-wise, not lexical
    [{ maxVersion: '5.1' }, 'claude-fable-5-1', true],
    [{ maxVersion: '5.1' }, 'claude-fable-5-2', false],
    [{ maxVersion: '5' }, 'claude-fable-5-1', false],
    [{ minVersion: '5', maxVersion: '5.9' }, 'claude-fable-6', false],
    [{ minVersion: '5', maxVersion: '5.9' }, 'claude-fable-5-4', true],
  ] as const)('%j covers %s → %s', (range, id, covered) => {
    expect(familyRowCovers(row(range), info(id))).toBe(covered)
  })

  it('compares the family case-insensitively (a gateway lower-cases what the vendor capitalises)', () => {
    const minimax = { family: 'MiniMax-M*', model: 'MiniMax-M3' }
    expect(familyRowCovers(minimax, info('minimax-m3.5'))).toBe(true)
  })

  it('a fixed row covers nothing as a family', () => {
    expect(familyRowCovers({ model: 'claude-fable-5-1' }, info('claude-fable-5-1'))).toBe(false)
  })
})

describe('resolveFamilyRow — versions[<v>] > the listing > the row', () => {
  const resolve = (id: string, listed?: ListedModelFigures, row = FABLE) =>
    resolveFamilyRow(row, info(id), parseModelVersion, listed)

  // The fields a listing can state: each of the 2×2 (override? listed?) takes
  // the highest layer that states it.
  const LISTED: ListedModelFigures = {
    contextWindow: 2_000_000,
    maxOutputTokens: 200_000,
    availableThinkingTiers: ['low', 'high'],
    supportsImageInput: false,
  }
  const OVERRIDE = {
    contextWindow: 300_000,
    maxOutputTokens: 30_000,
    availableThinkingTiers: ['medium'],
    supportsImageInput: true,
  }
  const ROW: NexusConfiguredModel = {
    family: 'claude-fable-*',
    model: 'claude-fable-5-1',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    availableThinkingTiers: ['low', 'medium', 'high'],
    supportsImageInput: true,
  }
  const FIELDS = ['contextWindow', 'maxOutputTokens', 'availableThinkingTiers', 'supportsImageInput'] as const
  it.each(
    FIELDS.flatMap(field => [
      [field, false, false, 'row'],
      [field, false, true, 'listing'],
      [field, true, false, 'override'],
      [field, true, true, 'override'],
    ] as const),
  )('%s: override=%s listed=%s → the %s', (field, hasOverride, hasListed, source) => {
    const row: NexusConfiguredModel = hasOverride ? { ...ROW, versions: { '5.2': { [field]: OVERRIDE[field] } } } : ROW
    const out = resolve('claude-fable-5-2', hasListed ? { [field]: LISTED[field] } : undefined, row)
    const expected = { row: ROW[field], listing: LISTED[field], override: OVERRIDE[field] }[source]
    expect(out[field]).toEqual(expected)
  })

  it('a field no layer states stays unstated — the consumer keeps its own default', () => {
    const out = resolve('claude-fable-5-2', undefined, { family: 'claude-fable-*', model: 'claude-fable-5-1' })
    for (const field of [...FIELDS, 'promptProfile', 'todoTools', 'supportsStrictTools', 'defaultThinkingTier'] as const) {
      expect(out[field], field).toBeUndefined()
    }
  })

  it('the opt-in flags are the catalog\'s alone: a new version keeps them, no listing can set them', () => {
    // THE regression this change exists for: 5.2 used to read a grafted row
    // that carried figures but not these three.
    const out = resolve('claude-fable-5-2', { contextWindow: 2_000_000 })
    expect(out).toMatchObject({ promptProfile: 'lean', todoTools: false, supportsStrictTools: true })
    // …and an override is the only thing that changes one.
    const off = resolve('claude-fable-5-2', undefined, { ...FABLE, versions: { '5.2': { supportsStrictTools: false, promptProfile: 'standard' } } })
    expect(off).toMatchObject({ promptProfile: 'standard', todoTools: false, supportsStrictTools: false })
    // A listing has no way to say any of them (the type has no such field).
    const listed: ListedModelFigures = { contextWindow: 1 }
    expect(Object.keys(listed)).not.toContain('supportsStrictTools')
  })

  it('an override states only its difference: the rest of the version is the row', () => {
    const out = resolve('claude-fable-5')
    expect(out).toMatchObject({
      name: 'Fable 5',
      defaultThinkingTier: 'high',
      contextWindow: 500_000,
      // untouched
      maxOutputTokens: 128_000,
      defaultMaxOutputTokens: 64_000,
      availableThinkingTiers: ['low', 'medium', 'high', 'extra-high', 'max'],
      promptProfile: 'lean',
      supportsStrictTools: true,
    })
  })

  it('an override written `undefined` takes the field away for that version', () => {
    const row: NexusConfiguredModel = {
      ...FABLE,
      versions: { '5.2': { todoTools: undefined, availableThinkingTiers: undefined, defaultThinkingTier: undefined } },
    }
    const out = resolve('claude-fable-5-2', undefined, row)
    for (const field of ['todoTools', 'availableThinkingTiers', 'defaultThinkingTier'] as const) {
      expect(field in out, field).toBe(false)
    }
    expect(out.supportsStrictTools).toBe(true) // left out: the row's
    // …even over what the listing states.
    expect('availableThinkingTiers' in resolve('claude-fable-5-2', { availableThinkingTiers: ['low'] }, row)).toBe(false)
  })

  it('an override is keyed by version label: a dated snapshot reads it, a preview has its own key', () => {
    expect(resolve('claude-fable-5-20260301').contextWindow).toBe(500_000)
    const row = { ...FABLE, versions: { '5.2-preview': { contextWindow: 7 } } }
    expect(resolve('claude-fable-5-2-preview', undefined, row).contextWindow).toBe(7)
    expect(resolve('claude-fable-5-2', undefined, row).contextWindow).toBe(1_000_000)
  })

  describe('the name is the verified version\'s, not the family\'s', () => {
    it.each([
      ['claude-fable-5-1', undefined, 'Fable 5.1'], // the verified version
      ['claude-fable-5-1-20260901', undefined, 'Fable 5.1'], // its snapshot
      ['claude-fable-5-2', undefined, undefined], // a newer one: no stale label
      ['claude-fable-5-2', 'Claude Fable 5.2', 'Claude Fable 5.2'], // the listing names it
      ['claude-fable-5-1', 'Claude Fable 5.1', 'Claude Fable 5.1'], // the listing wins over the row
      ['claude-fable-5', 'Claude Fable 5', 'Fable 5'], // the override wins over both
    ])('%s (listed %s) → %s', (id, listedName, expected) => {
      expect(resolve(id, listedName ? { name: listedName } : undefined).name).toBe(expected)
    })
  })

  describe('the default thinking tier follows the tiers it must be one of', () => {
    it.each([
      // [listed tiers, listed default, expected default]
      [undefined, undefined, 'extra-high'], // nothing listed: the row's
      [['low', 'medium', 'high', 'extra-high'], undefined, 'extra-high'], // the row's still holds
      [['low', 'medium', 'high'], undefined, 'medium'], // the row's is gone: the tiers' fallback
      [['low', 'high'], undefined, 'low'], // no medium: the first real tier
      [['none', 'high'], undefined, 'high'], // `none` is not a default
      [['low', 'medium', 'high'], 'high', 'high'], // the listing states one
      [['low', 'medium'], 'max', 'medium'], // …that it does not list: ignored
    ] as const)('listed tiers %j, listed default %s → %s', (tiers, stated, expected) => {
      const listed: ListedModelFigures | undefined = tiers
        ? { availableThinkingTiers: [...tiers], ...(stated ? { defaultThinkingTier: stated } : {}) }
        : undefined
      const out = resolve('claude-fable-5-2', listed)
      expect(out.defaultThinkingTier).toBe(expected)
      expect(out.availableThinkingTiers).toContain(out.defaultThinkingTier)
    })

    it('a listed default without listed tiers is not a default of anything: the row stands', () => {
      expect(resolve('claude-fable-5-2', { defaultThinkingTier: 'low' }).defaultThinkingTier).toBe('extra-high')
    })

    it('only `none` listed: no default at all', () => {
      const out = resolve('claude-fable-5-2', { availableThinkingTiers: ['none'] })
      expect(out.defaultThinkingTier).toBeUndefined()
    })
  })

  it('the first-request reservation never exceeds a listed cap', () => {
    expect(resolve('claude-fable-5-2', { maxOutputTokens: 16_000 })).toMatchObject({
      maxOutputTokens: 16_000,
      defaultMaxOutputTokens: 16_000,
    })
    expect(resolve('claude-fable-5-2', { maxOutputTokens: 256_000 })).toMatchObject({
      maxOutputTokens: 256_000,
      defaultMaxOutputTokens: 64_000,
    })
  })

  it('never hands back or mutates the catalog row', () => {
    const before = JSON.stringify({ ...FABLE, model: String(FABLE.model) })
    const out = resolve('claude-fable-5-2', { contextWindow: 5, availableThinkingTiers: ['low'] })
    expect(out).not.toBe(FABLE)
    expect(out.availableThinkingTiers).not.toBe(FABLE.availableThinkingTiers)
    expect('versions' in out).toBe(false)
    out.availableThinkingTiers!.push('x')
    expect(JSON.stringify({ ...FABLE, model: String(FABLE.model) })).toBe(before)
  })
})

// ── The lookup ─────────────────────────────────────────────────────────────

const CONFIG: NexusModelConfig = {
  providers: [
    {
      providerId: 'anthropic',
      models: [
        FABLE,
        // A fixed row of ANOTHER family, and one for a version below the
        // family row's floor.
        { model: createAnthropicModelPattern('claude-haiku-4-5'), name: 'Haiku 4.5', contextWindow: 200_000 },
        { model: createAnthropicModelPattern('claude-fable-4'), name: 'Fable 4', contextWindow: 150_000 },
      ],
    },
    {
      providerId: 'minimax',
      models: [{ family: 'MiniMax-M*', model: 'MiniMax-M3', contextWindow: 400_000, maxVersion: '3.5' }],
    },
    {
      // No family rows: read exactly as before.
      providerId: 'openai',
      models: [{ model: createOpenAiModelPattern('gpt-6-sol'), contextWindow: 800_000, supportsStrictTools: true }],
    },
  ],
}

describe('findConfiguredModelIn — a fixed row that names the model, else its family row', () => {
  const find = (providerId: string | undefined, id: string) => findConfiguredModelIn(CONFIG, providerId, id)

  it('a version newer than the verified one reads the whole family row', () => {
    expect(find('anthropic', 'claude-fable-5-2')).toMatchObject({
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      defaultMaxOutputTokens: 64_000,
      defaultThinkingTier: 'extra-high',
      availableThinkingTiers: ['low', 'medium', 'high', 'extra-high', 'max'],
      promptProfile: 'lean',
      todoTools: false,
      supportsStrictTools: true,
    })
    // …and so does a dated snapshot of it, and a major the catalog never saw.
    expect(find('anthropic', 'claude-fable-5-2-20270101')?.supportsStrictTools).toBe(true)
    expect(find('anthropic', 'claude-fable-6')?.promptProfile).toBe('lean')
  })

  it('the verified version and an overridden one', () => {
    expect(find('anthropic', 'claude-fable-5-1')).toMatchObject({ name: 'Fable 5.1', contextWindow: 1_000_000 })
    expect(find('anthropic', 'claude-fable-5')).toMatchObject({ name: 'Fable 5', contextWindow: 500_000, supportsStrictTools: true })
  })

  it('below the floor the family row says nothing: a fixed row answers, else nothing', () => {
    expect(find('anthropic', 'claude-fable-4')).toBe(CONFIG.providers[0]!.models[2])
    expect(find('anthropic', 'claude-fable-3')).toBeUndefined()
  })

  it('above the ceiling the family row says nothing, even for the id its own pattern would match', () => {
    expect(find('minimax', 'MiniMax-M3')?.contextWindow).toBe(400_000)
    expect(find('minimax', 'minimax-m3.5')?.contextWindow).toBe(400_000)
    expect(find('minimax', 'MiniMax-M4')).toBeUndefined()
    const capped: NexusModelConfig = {
      providers: [{ providerId: 'x', models: [{ family: 'm-*', model: 'm-3', maxVersion: '2' }] }],
    }
    expect(findConfiguredModelIn(capped, 'x', 'm-3')).toBeUndefined()
  })

  it('a fixed row inside a family\'s range is that family\'s exception: it answers first', () => {
    const config: NexusModelConfig = {
      providers: [{
        providerId: 'x',
        models: [
          { family: 'm-*', model: 'm-3', contextWindow: 1, supportsStrictTools: true },
          // Listed AFTER the family row, and a pattern no id flattens from.
          { model: /^m-4-preview(?:-[a-z]+)?$/, contextWindow: 2 },
        ],
      }],
    }
    expect(findConfiguredModelIn(config, 'x', 'm-4-preview-exp')).toBe(config.providers[0]!.models[1])
    expect(findConfiguredModelIn(config, 'x', 'm-4-preview')?.supportsStrictTools).toBeUndefined()
    // Every other version of the family still reads the family row.
    expect(findConfiguredModelIn(config, 'x', 'm-4')).toMatchObject({ contextWindow: 1, supportsStrictTools: true })
    expect(findConfiguredModelIn(config, 'x', 'm-5-preview')).toMatchObject({ contextWindow: 1 })
  })

  it('another family reads its own fixed row; an unknown model reads nothing', () => {
    expect(find('anthropic', 'claude-haiku-4-5-20251001')).toBe(CONFIG.providers[0]!.models[1])
    expect(find('anthropic', 'claude-opus-5-5')).toBeUndefined()
    expect(find('anthropic', 'claude-fable-5-1-fast')).toBeUndefined() // a variant is not the family
  })

  it('a provider without family rows is read exactly as before', () => {
    expect(find('openai', 'gpt-6-sol-2026-09-01')).toBe(CONFIG.providers[2]!.models[0])
    expect(find('openai', 'gpt-7-sol')).toBeUndefined() // no row, no family: nothing follows
  })

  it('the family is per provider: another provider\'s family row never answers', () => {
    expect(find('openai', 'claude-fable-5-2')).toBeUndefined()
    expect(find('nope', 'claude-fable-5-2')).toBeUndefined()
    // Without a provider every provider is searched, in catalog order.
    expect(find(undefined, 'claude-fable-5-2')?.supportsStrictTools).toBe(true)
    expect(find(undefined, 'gpt-6-sol')?.contextWindow).toBe(800_000)
  })

  it('`exclude` takes an id out of a family row too', () => {
    const config: NexusModelConfig = {
      providers: [{
        providerId: 'x',
        models: [
          { family: 'm-*', model: 'm-3', contextWindow: 1, exclude: [createExactModelPattern('m-3-20260101')] },
        ],
      }],
    }
    expect(findConfiguredModelIn(config, 'x', 'm-3')?.contextWindow).toBe(1)
    expect(findConfiguredModelIn(config, 'x', 'm-3-20260101')).toBeUndefined()
  })

  it('a model entry reads the version it resolves to today', () => {
    recordEntryResolution('anthropic', 'claude-fable-*@latest', { id: 'claude-fable-5-2', versionLabel: '5.2', preview: false })
    expect(find('anthropic', 'claude-fable-*@latest')).toMatchObject({ contextWindow: 1_000_000, supportsStrictTools: true })
    recordEntryResolution('anthropic', 'claude-fable-*@5', { id: 'claude-fable-5', versionLabel: '5', preview: false })
    expect(find('anthropic', 'claude-fable-*@5')?.contextWindow).toBe(500_000)
  })

  it('the listing is the middle layer, per provider and per id', () => {
    recordListedFigures('anthropic', [
      { id: 'claude-fable-5-2', name: 'Claude Fable 5.2', supportsTools: true, contextWindow: 2_000_000, thinkingTiers: ['low', 'medium', 'high'] },
      { id: 'claude-fable-5', supportsTools: true, contextWindow: 9 },
      { id: 'claude-haiku-4-5', supportsTools: true, contextWindow: 9 },
    ])
    expect(find('anthropic', 'claude-fable-5-2')).toMatchObject({
      name: 'Claude Fable 5.2',
      contextWindow: 2_000_000,
      availableThinkingTiers: ['low', 'medium', 'high'],
      defaultThinkingTier: 'medium',
      maxOutputTokens: 128_000, // not listed: the row's
      supportsStrictTools: true,
    })
    expect(find('anthropic', 'claude-fable-5')?.contextWindow).toBe(500_000) // the override still wins
    expect(find('anthropic', 'claude-fable-5-1')?.contextWindow).toBe(1_000_000) // not listed: the row's
    expect(find('anthropic', 'claude-haiku-4-5')?.contextWindow).toBe(200_000) // a FIXED row never reads the listing
    // Another provider's listing of the same id is not this provider's.
    recordListedFigures('minimax', [{ id: 'claude-fable-5-1', supportsTools: true, contextWindow: 3 }])
    expect(find('anthropic', 'claude-fable-5-1')?.contextWindow).toBe(1_000_000)
    // A listing replaces the provider's previous one whole.
    recordListedFigures('anthropic', [{ id: 'claude-fable-5-1', supportsTools: true, contextWindow: 4 }])
    expect(find('anthropic', 'claude-fable-5-2')?.contextWindow).toBe(1_000_000)
    expect(listedFigures('anthropic', 'claude-fable-5-1')).toEqual({ contextWindow: 4 })
    // A listing that states nothing about a model records nothing for it.
    recordListedFigures('anthropic', [{ id: 'claude-fable-5-1', supportsTools: true }])
    expect(listedFigures('anthropic', 'claude-fable-5-1')).toBeUndefined()
  })

  it('the figure helpers (engine/contextWindow.ts) go through the same lookup', () => {
    expect(contextWindowOf('claude-fable-5-2', 'anthropic', CONFIG)).toBe(1_000_000)
    expect(contextWindowOf('claude-fable-5', 'anthropic', CONFIG)).toBe(500_000)
    expect(getDefaultMaxOutputTokensForModel('claude-fable-6', 'anthropic', CONFIG)).toBe(64_000)
    expect(getAvailableThinkingTiersForModel('claude-fable-5-2', 'anthropic', CONFIG)).toEqual(['low', 'medium', 'high', 'extra-high', 'max'])
    expect(contextWindowOf('claude-fable-3', 'anthropic', CONFIG)).toBe(200_000) // the uncatalogued default
  })

  it('a family-row read is reference-stable until the listing changes', () => {
    const first = find('anthropic', 'claude-fable-5-2')
    expect(find('anthropic', 'claude-fable-5-2')).toBe(first)
    recordListedFigures('anthropic', [{ id: 'claude-fable-5-2', supportsTools: true, contextWindow: 7 }])
    const listed = find('anthropic', 'claude-fable-5-2')
    expect(listed).not.toBe(first)
    expect(listed?.contextWindow).toBe(7)
    expect(find('anthropic', 'claude-fable-5-2')).toBe(listed)
    resetListedFigures()
    expect(find('anthropic', 'claude-fable-5-2')?.contextWindow).toBe(first?.contextWindow)
  })
})

// ── The catalog check, and the host's view ─────────────────────────────────

describe('familyRowProblems — a row that cannot work fails here, not at request time', () => {
  const problems = (models: NexusConfiguredModel[]) =>
    familyRowProblems({ providers: [{ providerId: 'x', models }] }, () => parseModelVersion)

  it('the shipped catalog has none', () => {
    expect(familyRowProblems(NEXUS_MODEL_CONFIG, versionParser)).toEqual([])
  })

  it('a sound row has none', () => {
    expect(problems([FABLE])).toEqual([])
    expect(problems([{ family: 'm-*', model: 'm-3', versions: { '2': {}, '3.1-preview': {} } }])).toEqual([])
  })

  it.each([
    ['a regex-only `model`', [{ family: 'm-*', model: /^m-(3|4)$/ }], 'does not flatten'],
    ['a `model` of another family', [{ family: 'm-*', model: 'n-3' }], 'reads as family n-*'],
    ['a verified version below the floor', [{ family: 'm-*', model: 'm-3', minVersion: '4' }], 'verified version 3 is outside'],
    ['a verified version above the ceiling', [{ family: 'm-*', model: 'm-3', maxVersion: '2' }], 'verified version 3 is outside'],
    ['a `versions` key out of range', [{ family: 'm-*', model: 'm-3', minVersion: '3', versions: { '2': {} } }], "versions['2'] is outside"],
    ['a `versions` key that is not a version', [{ family: 'm-*', model: 'm-3', versions: { latest: {} } }], "versions['latest'] is outside"],
    ['two rows covering one version', [{ family: 'm-*', model: 'm-3' }, { family: 'm-*', model: 'm-4' }], 'an earlier row of the same family already covers 4'],
  ] as const)('%s', (_what, models, message) => {
    const found = problems(models as unknown as NexusConfiguredModel[])
    expect(found).toHaveLength(1)
    expect(found[0]).toContain(message)
  })

  it('two rows of one family with disjoint ranges are fine', () => {
    expect(problems([
      { family: 'm-*', model: 'm-3', maxVersion: '3.9' },
      { family: 'm-*', model: 'm-4', minVersion: '4' },
    ])).toEqual([])
  })
})

describe('the host sees a family row as its verified version', () => {
  // The host reads only `model` (+ `name`) of a catalog row and flattens the
  // pattern to a literal id; one it cannot flatten is dropped silently
  // (`DeriveTsModelId`, nexus_llm_host.cc). A family row therefore goes out
  // as its verified version's pattern — never as the `*` family key.
  it('serializes to a pattern that flattens to one concrete id', () => {
    const wire = serializeNexusModelConfig(CONFIG)
    const fable = wire.providers[0]!.models[0]!
    expect(fable.model).toBe(String.raw`^claude-fable-5-1(?:-\d{8})?$`)
    expect(deriveCanonicalModelId(new RegExp(fable.model))).toBe('claude-fable-5-1')
    expect(fable.model).not.toContain('*')
    expect(fable.name).toBe('Fable 5.1')
    expect(wire.providers[1]!.models[0]!.model).toBe('MiniMax-M3')
  })

  it('deriveCanonicalModelId: the id a pattern stands for', () => {
    expect(deriveCanonicalModelId('gpt-6-sol')).toBe('gpt-6-sol')
    expect(deriveCanonicalModelId(createAnthropicModelPattern('claude-fable-5-1'))).toBe('claude-fable-5-1')
    expect(deriveCanonicalModelId(createOpenAiModelPattern('gpt-5\\.6-sol'))).toBe('gpt-5.6-sol')
    expect(deriveCanonicalModelId(createExactModelPattern('k3'))).toBe('k3')
    expect(deriveCanonicalModelId(/^claude-(opus|fable)-5$/)).toBeUndefined()
  })
})
