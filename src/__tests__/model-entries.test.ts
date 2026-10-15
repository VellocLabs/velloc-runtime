// Model entries: a family's Latest or a pinned version instead of a raw model
// id — the id reading (modelVersions), grouping and resolution
// (modelEntries), the shared resolution registry every model-id consumer goes
// through, the catalog rows the runtime builds, the broker's concrete copy of
// a default, the transport's rewrite, and the worker's selection mapping.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  BrowserBridgeTransport,
  BrowserLlmCatalog,
  BrowserLlmProvider,
} from '../browser/bridge/browserBridgeProtocol'
import { toEntrySelection } from '../browser/worker/modelSelection'
import {
  editableEntries,
  entryForModelId,
  entryId,
  familyLabel,
  groupFamilies,
  parseEntryId,
  pinnedEntryFor,
  resolveEntry,
} from '../config/nexusModelConfig/modelEntries'
import {
  entryResolution,
  recordEntryResolution,
  resetEntryResolutions,
  resolveModelId,
} from '../config/nexusModelConfig/modelEntryResolution'
import {
  compareVersionsDesc,
  parseModelVersion,
  pickVersionId,
} from '../config/nexusModelConfig/providers/shared/modelVersions'
import { providerModelFamilies } from '../models/drivers/modelFamilies'
import { withModelProviders } from '../models/drivers/driverTransport'
import {
  resetRuntimeProviders,
  setRuntimeProviderConfigs,
} from '../models/drivers/runtimeProviders'
import { findConfiguredModel } from '../config/nexusModelConfig/findConfiguredModel'
import {
  applyModelEntries,
  buildEntryRows,
  builtInEntryRow,
  builtInFamilies,
  effectiveEntries,
  resetModelEntryCatalog,
  uncuratedModels,
  usesModelEntries,
  withConcreteDefaultModels,
} from '../models/drivers/modelEntryCatalog'
import { contextWindowOf } from '../engine/contextWindow'
import {
  FIRST_REQUEST_OUTPUT_RESERVATION,
  recordListedFigures,
  resetListedFigures,
} from '../config/nexusModelConfig/familyRows'
import { resolveModelRequestFields } from '../engine/turn/modelRequestFields'

afterEach(() => {
  resetEntryResolutions()
  resetModelEntryCatalog()
})

describe('parseModelVersion — family, version, snapshot', () => {
  it.each([
    ['anthropic/claude-opus-5.1-20250123', 'anthropic/claude-opus-*', '5.1', '20250123', false],
    ['claude-haiku-4-5-20251001', 'claude-haiku-*', '4.5', '20251001', false],
    ['claude-opus-5', 'claude-opus-*', '5', undefined, false],
    ['claude-opus-5.5-fast', 'claude-opus-*-fast', '5.5', undefined, false],
    ['gpt-6-astra', 'gpt-*-astra', '6', undefined, false],
    ['qwen3.8-max', 'qwen*-max', '3.8', undefined, false],
    ['gemini-2.5-flash-preview-05-20', 'gemini-*-flash', '2.5-preview', '05-20', true],
    ['claude-sonnet-5.5:batch', 'claude-sonnet-*:batch', '5.5', undefined, false],
    ['o3-2025-04-16', 'o*', '3', '2025-04-16', false],
    ['kimi-for-coding', 'kimi-for-coding', '', undefined, false],
  ])('%s', (id, family, versionLabel, snapshot, preview) => {
    const info = parseModelVersion(id)
    expect(info).toMatchObject({ family, versionLabel, preview })
    expect(info.snapshot).toBe(snapshot)
  })

  it('versions compare element-wise (4.10 > 4.9); an undated alias beats any snapshot', () => {
    expect([[4, 9], [4, 10], [5]].sort(compareVersionsDesc)).toEqual([[5], [4, 10], [4, 9]])
    expect(pickVersionId(['claude-opus-5-1-20250123', 'claude-opus-5-1-20250545'])).toBe('claude-opus-5-1-20250545')
    expect(pickVersionId(['claude-opus-5-1-20250545', 'claude-opus-5-1'])).toBe('claude-opus-5-1')
  })
})

const OPUS_LISTING = [
  { id: 'anthropic/claude-opus-5.0', label: 'Anthropic: Claude Opus 5.0' },
  { id: 'anthropic/claude-opus-5.1-20250123', label: 'Anthropic: Claude Opus 5.1' },
  { id: 'anthropic/claude-opus-5.2-preview', label: 'Anthropic: Claude Opus 5.2 (Preview)' },
  { id: 'anthropic/claude-haiku-4.5', label: 'Anthropic: Claude Haiku 4.5' },
]

describe('families and entry resolution', () => {
  it('groups by family — stable newest first, previews after — with a versionless label', () => {
    const families = groupFamilies(OPUS_LISTING)
    const opus = families.get('anthropic/claude-opus-*')!
    expect(opus.label).toBe('Anthropic: Claude Opus')
    expect(opus.versions.map(v => [v.versionLabel, v.preview])).toEqual([
      ['5.1', false],
      ['5.0', false],
      ['5.2-preview', true],
    ])
    expect(familyLabel('z-ai/glm-*', undefined, '')).toBe('Glm')
    // The version goes with its separator, wherever it sits in the name.
    expect(familyLabel('gpt-*-terra', 'GPT-5.6 Terra', '5.6')).toBe('GPT Terra')
    expect(familyLabel('claude-haiku-*', 'Claude Haiku 4.5', '4.5')).toBe('Claude Haiku')
  })

  it('Latest follows the newest STABLE version; a pinned one stays, following its snapshots', () => {
    const today = groupFamilies(OPUS_LISTING)
    const latest = { family: 'anthropic/claude-opus-*', version: 'latest' }
    const pinned = { family: 'anthropic/claude-opus-*', version: '5.0' }
    expect(resolveEntry(latest, today)).toEqual({ id: 'anthropic/claude-opus-5.1-20250123', versionLabel: '5.1', preview: false })
    expect(resolveEntry(pinned, today)?.id).toBe('anthropic/claude-opus-5.0')
    // A preview is never Latest, but pins like any version.
    expect(resolveEntry({ ...pinned, version: '5.2-preview' }, today)).toMatchObject({ preview: true })

    // Tomorrow: 5.3 ships and 5.1 gets a new snapshot.
    const tomorrow = groupFamilies([
      ...OPUS_LISTING.filter(m => !m.id.includes('5.1')),
      { id: 'anthropic/claude-opus-5.1-20250545' },
      { id: 'anthropic/claude-opus-5.3' },
    ])
    expect(resolveEntry(latest, tomorrow)?.id).toBe('anthropic/claude-opus-5.3')
    expect(resolveEntry({ ...pinned, version: '5.1' }, tomorrow)?.id).toBe('anthropic/claude-opus-5.1-20250545')
    // Delisted version, unknown family: nothing.
    expect(resolveEntry({ ...pinned, version: '4.8' }, tomorrow)).toBeUndefined()
    expect(resolveEntry({ family: 'x/y-*', version: 'latest' }, tomorrow)).toBeUndefined()
    // A family with only previews has no Latest.
    expect(resolveEntry(latest, groupFamilies([{ id: 'anthropic/claude-opus-6-preview' }]))).toBeUndefined()
  })

  it('entry ids, the entry a raw id belongs to, and the page-side entry list', () => {
    expect(entryId({ family: 'claude-opus-*', version: 'latest' })).toBe('claude-opus-*@latest')
    expect(parseEntryId('anthropic/claude-opus-*@5.0')).toEqual({ family: 'anthropic/claude-opus-*', version: '5.0' })
    expect(parseEntryId('claude-opus-5')).toBeUndefined()
    const entries = [
      { family: 'claude-opus-*', version: 'latest' },
      { family: 'claude-opus-*', version: '5' },
    ]
    // Its pinned version first, else its family's Latest.
    expect(entryForModelId('claude-opus-5-20260101', entries)).toEqual(entries[1])
    expect(entryForModelId('claude-opus-5-5', entries)).toEqual(entries[0])
    expect(entryForModelId('gpt-6', entries)).toBeUndefined()
    expect(pinnedEntryFor('claude-opus-4-8')).toEqual({ family: 'claude-opus-*', version: '4.8', id: 'claude-opus-4-8' })
    expect(pinnedEntryFor('kimi-for-coding')).toEqual({ family: 'kimi-for-coding', version: 'latest', id: 'kimi-for-coding' })

    // Stored entries win (even an empty list); else the rows' entries.
    const rows = [{ entry: { family: 'f-*', version: 'latest', resolvedId: 'f-2' } }, {}]
    expect(editableEntries(undefined, rows)).toEqual([{ family: 'f-*', version: 'latest', id: 'f-2' }])
    expect(editableEntries([], rows)).toEqual([])
  })
})

describe('the resolution registry', () => {
  it('a concrete id passes through; an entry id resolves for its provider, or across all', () => {
    expect(resolveModelId('anthropic', 'claude-opus-5')).toBe('claude-opus-5')
    expect(resolveModelId('anthropic', 'claude-opus-*@latest')).toBe('claude-opus-*@latest')
    recordEntryResolution('anthropic', 'claude-opus-*@latest', { id: 'claude-opus-5-5', versionLabel: '5.5', preview: false })
    expect(resolveModelId('anthropic', 'claude-opus-*@latest')).toBe('claude-opus-5-5')
    expect(resolveModelId(undefined, 'claude-opus-*@latest')).toBe('claude-opus-5-5')
    expect(resolveModelId('bedrock', 'claude-opus-*@latest')).toBe('claude-opus-*@latest')
    recordEntryResolution('anthropic', 'claude-opus-*@latest', undefined)
    expect(entryResolution('anthropic', 'claude-opus-*@latest')).toBeUndefined()
  })

  it('the transport sends the concrete model to a ModelProvider', async () => {
    recordEntryResolution('google', 'gemini-*@latest', { id: 'gemini-9-pro', versionLabel: '9', preview: false })
    recordEntryResolution('anthropic', 'claude-opus-*@latest', { id: 'claude-opus-5-5', versionLabel: '5.5', preview: false })
    const providerBodies: unknown[] = []
    const inner: BrowserBridgeTransport = {
      async request(req: any) {
        const ok = (result: unknown) => ({ id: req.id, route: req.route, ok: true, result }) as any
        if (req.route.action === 'rawStreamOpen') {
          providerBodies.push(JSON.parse(new TextDecoder().decode(req.payload.body)))
          return ok({ streamId: 'raw-1', status: 200, statusText: 'OK', finalUrl: req.payload.url, headers: {} })
        }
        if (req.route.action === 'rawStreamRead') return ok({ done: true, chunk: new Uint8Array() })
        return ok({})
      },
    }
    const wrapped = withModelProviders(inner, { getEnv: () => undefined } as never)
    // A provider on its ModelProvider (anthropic): the wire body carries it.
    await wrapped.request({
      id: '2',
      route: { capability: 'model', action: 'streamStart' },
      payload: { providerId: 'anthropic', model: 'claude-opus-*@latest', messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }] },
    } as any)
    await vi.waitFor(() => expect(providerBodies).toEqual([expect.objectContaining({ model: 'claude-opus-5-5' })]))
  })
})

const provider = (models: Array<{ id: string; label?: string; contextWindow?: number }>, extra: Partial<BrowserLlmProvider> = {}): BrowserLlmProvider => ({
  id: 'openrouter',
  label: 'OpenRouter',
  iconSvg: '',
  enabled: true,
  models: models.map(m => ({ label: m.id, enabled: true, supportsStreaming: true, ...m })),
  ...extra,
})

describe('entry rows', () => {
  it('one row per entry, labelled, resolved, with its figures; families list their versions', () => {
    const families = groupFamilies(OPUS_LISTING)
    const row = buildEntryRows(
      provider([], { defaultModelId: 'anthropic/claude-opus-5.0' }),
      [
        { family: 'anthropic/claude-opus-*', version: 'latest' },
        { family: 'anthropic/claude-opus-*', version: '5.0' },
        { family: 'gone/model', version: 'latest' },
      ],
      families,
      id => ({ contextWindow: id.includes('5.1') ? 1_000_000 : 200_000 }),
    )
    expect(row.models.map(m => [m.id, m.label, m.contextWindow, m.entry?.kind, m.entry?.resolvedVersion])).toEqual([
      ['anthropic/claude-opus-*@latest', 'Anthropic: Claude Opus', 1_000_000, 'latest', '5.1'],
      ['anthropic/claude-opus-*@5.0', 'Anthropic: Claude Opus 5.0', 200_000, 'pinned', '5.0'],
    ])
    // The legacy concrete default maps onto its pinned entry.
    expect(row.defaultModelId).toBe('anthropic/claude-opus-*@5.0')
    expect(row.entryFamilies).toEqual([{
      family: 'anthropic/claude-opus-*',
      familyLabel: 'Anthropic: Claude Opus',
      versions: [
        { versionLabel: '5.1', id: 'anthropic/claude-opus-5.1-20250123', preview: false, pinned: false },
        { versionLabel: '5.0', id: 'anthropic/claude-opus-5.0', preview: false, pinned: true },
        { versionLabel: '5.2-preview', id: 'anthropic/claude-opus-5.2-preview', preview: true, pinned: false },
      ],
    }])
    // A stored entry-id default beats the host's concrete one.
    expect(buildEntryRows(
      provider([], { defaultModelId: 'anthropic/claude-opus-5.1-20250123' }),
      [{ family: 'anthropic/claude-opus-*', version: '5.1' }, { family: 'anthropic/claude-opus-*', version: 'latest' }],
      families,
      () => ({}),
      'anthropic/claude-opus-*@latest',
    ).defaultModelId).toBe('anthropic/claude-opus-*@latest')
  })

  it('no entries = a disabled provider; custom providers keep their own models', () => {
    expect(buildEntryRows(provider([]), [], new Map(), () => ({})).enabled).toBe(false)
    expect(usesModelEntries('anthropic')).toBe(true)
    expect(usesModelEntries('custom-abc123')).toBe(false)
  })

  it('defaults: the stored list, else the pre-entry picks pinned, else the provider\'s default entries', () => {
    const defaults = [{ family: 'f-*', version: 'latest' }, { family: 'g-*', version: '2', id: 'g-2' }]
    expect(effectiveEntries('openrouter', { modelEntries: [] }, defaults)).toEqual([])
    expect(effectiveEntries('openrouter', { enabledModels: ['a/b-1', 'a/b-1'] }, defaults))
      .toEqual([{ family: 'a/b-*', version: '1', id: 'a/b-1' }])
    const own = effectiveEntries('openrouter', {}, defaults)
    expect(own).toEqual(defaults)
    expect(own[0]).not.toBe(defaults[0]) // copies: the caller may edit them
  })
})

describe('built-in providers', () => {
  const anthropic = (): BrowserLlmProvider => ({
    id: 'anthropic',
    label: 'Anthropic',
    iconSvg: '',
    enabled: true,
    defaultModelId: 'claude-opus-5-5',
    models: [
      { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', enabled: true, supportsStreaming: true, contextWindow: 1_000_000 },
      { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', enabled: true, supportsStreaming: true },
      { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', enabled: true, supportsStreaming: true },
      // Discovered, not yet curated: a newer Opus.
      { id: 'claude-opus-5-7', label: 'Claude Opus 5.7', enabled: true, supportsStreaming: true },
    ],
  })

  // Host models the curated catalog does not know: chat ones are offered (the
  // Add models dialog's Other models), non-chat ones never are.
  const withOthers = (): BrowserLlmProvider => ({
    ...anthropic(),
    models: [
      ...anthropic().models,
      { id: 'acme-chat-2', label: 'Acme Chat 2', enabled: true, supportsStreaming: true, contextWindow: 64_000 },
      { id: 'acme-embed-1', label: 'Acme Embed 1', enabled: true, supportsStreaming: true },
      { id: 'acme-notools-1', label: 'Acme No Tools', enabled: true, supportsTools: false },
    ],
  })

  it('lists the host models outside the curated catalog: chat models only', () => {
    expect(uncuratedModels(withOthers()).map(m => m.id)).toEqual(['acme-chat-2'])
    // A provider with no curated list already offers everything.
    expect(uncuratedModels({ ...withOthers(), id: 'custom-openai' })).toEqual([])
  })

  it('an added uncurated model resolves, reads conservative figures and is marked unverified', () => {
    const entry = { family: 'acme-chat-*', version: '2', id: 'acme-chat-2' }
    // Not added: no row and no family.
    expect(builtInFamilies(withOthers()).families.has('acme-chat-*')).toBe(false)
    for (let rebuild = 0; rebuild < 2; rebuild++) {
      const row = builtInEntryRow(withOthers(), { modelEntries: [entry] })
      const added = row.models.find(m => m.entry?.resolvedId === 'acme-chat-2')!
      expect(added.entry?.unverified).toBe(true)
      expect(added.supportsImageInput).toBe(false)
      expect(added.contextWindow).toBe(64_000)
      expect(added.availableThinkingTiers).toBeUndefined()
      // The figures survive a rebuild: the grafted rule is not read as curated.
      expect(uncuratedModels(withOthers()).map(m => m.id)).toEqual(['acme-chat-2'])
    }
    const curatedRow = builtInEntryRow(withOthers(), {
      modelEntries: [entry, { family: 'claude-opus-*', version: 'latest' }],
    })
    expect(curatedRow.models.find(m => m.id === 'claude-opus-*@latest')?.entry?.unverified).toBeUndefined()
  })

  it('an added uncurated model reads what the listing states — in the picker and at request time', () => {
    // Anthropic's listing states context, output cap, effort levels and image
    // input; a model no family row covers (an older Opus, say) reads them
    // instead of the 200K / 8192 / any-tier fallbacks.
    const entry = { family: 'acme-chat-*', version: '2', id: 'acme-chat-2' }
    recordListedFigures('anthropic', [{
      id: 'acme-chat-2',
      supportsTools: true,
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      thinkingTiers: ['low', 'medium', 'high', 'max'],
      supportsImageInput: true,
    }])
    try {
      const row = builtInEntryRow(withOthers(), { modelEntries: [entry] })
      const added = row.models.find(m => m.entry?.resolvedId === 'acme-chat-2')!
      expect(added.entry?.unverified).toBe(true)
      expect(added.contextWindow).toBe(1_000_000)
      expect(added.maxOutputTokens).toBe(128_000)
      expect(added.availableThinkingTiers).toEqual(['low', 'medium', 'high', 'max'])
      expect(added.defaultThinkingTier).toBe('medium')
      expect(added.supportsImageInput).toBe(true)

      expect(contextWindowOf('acme-chat-2', 'anthropic')).toBe(1_000_000)
      const fields = resolveModelRequestFields({ model: 'acme-chat-2', providerId: 'anthropic', thinkingTier: 'max' })
      expect(fields.maxOutputTokens).toBe(FIRST_REQUEST_OUTPUT_RESERVATION)
      expect(fields.thinkingTier).toBe('max')
      // A level the listing does not state is dropped, not sent.
      expect(resolveModelRequestFields({ model: 'acme-chat-2', providerId: 'anthropic', thinkingTier: 'extra-high' })
        .thinkingTier).toBeUndefined()
    } finally {
      resetListedFigures()
    }
  })

  it('the Add models families carry the uncurated models apart, not among the curated ones', async () => {
    const transport = {
      request: async () => ({ ok: true, result: { providers: [withOthers()] } }),
    } as unknown as BrowserBridgeTransport
    const families = await providerModelFamilies(transport, 'anthropic')
    expect(families.ok).toBe(true)
    if (!families.ok) return
    expect(families.families.some(f => f.versions.some(v => v.id === 'acme-chat-2'))).toBe(false)
    expect(families.others?.flatMap(f => f.versions.map(v => v.id))).toEqual(['acme-chat-2'])
  })

  it('opening Add models keeps the grafted rule of an added uncurated model', async () => {
    const entry = { family: 'acme-chat-*', version: '2', id: 'acme-chat-2' }
    builtInEntryRow(withOthers(), { modelEntries: [entry] })
    expect(findConfiguredModel('anthropic', 'acme-chat-2')?.supportsImageInput).toBe(false)
    setRuntimeProviderConfigs({ anthropic: { modelEntries: [entry] } })
    const transport = {
      request: async () => ({ ok: true, result: { providers: [withOthers()] } }),
    } as unknown as BrowserBridgeTransport
    try {
      await providerModelFamilies(transport, 'anthropic')
      expect(findConfiguredModel('anthropic', 'acme-chat-2')?.supportsImageInput).toBe(false)
    } finally {
      setRuntimeProviderConfigs({})
    }
  })

  it('Add models, refreshed: a built-in re-runs its RUNTIME listing (never the host discovery) and offers what it lists', async () => {
    const calls: string[] = []
    const listing = new TextEncoder().encode(JSON.stringify({
      data: [{ id: 'claude-opus-5-9', display_name: 'Claude Opus 5.9' }, { id: 'acme-chat-2', display_name: 'Acme Chat 2' }],
    }))
    const transport = {
      async request(req: any) {
        const action = `${req.route.capability}.${req.route.action}`
        calls.push(action)
        if (action === 'model.catalog') return { ok: true, result: { providers: [anthropic()] } }
        if (action === 'model.rawStreamOpen') {
          return { ok: true, result: { streamId: 'r', status: 200, statusText: 'OK', finalUrl: req.payload.url, headers: {} } }
        }
        if (action === 'model.rawStreamRead') return { ok: true, result: { done: true, chunk: listing } }
        return { ok: false, error: { code: 'UNEXPECTED', message: action } }
      },
    } as unknown as BrowserBridgeTransport
    try {
      const families = await providerModelFamilies(transport, 'anthropic', { force: true })
      expect(calls).not.toContain('providerAuth.refresh')
      expect(calls[0]).toBe('model.rawStreamOpen')
      expect(families.ok).toBe(true)
      if (!families.ok) return
      // A listed version of a curated family joins it; another chat model is an "Other model".
      expect(families.families.find(f => f.family === 'claude-opus-*')?.versions[0]?.id).toBe('claude-opus-5-9')
      expect(families.others?.flatMap(f => f.versions.map(v => v.id))).toEqual(['acme-chat-2'])
    } finally {
      resetRuntimeProviders()
    }
  })

  it('a discovered newer version of a family is Latest, and reads the family row', () => {
    const { families, defaults } = builtInFamilies(anthropic())
    const opus = families.get('claude-opus-*')!
    // The family's verified version (5.5) and the versions its row names by
    // id (5 down to 4.6 — offered whether or not the host lists them, Opus 5
    // here is not listed) plus the discovered 5.7.
    expect(opus.versions.map(v => v.versionLabel)).toEqual(['5.7', '5.5', '5', '4.8', '4.7', '4.6'])
    expect(defaults).toContainEqual({ family: 'claude-opus-*', version: 'latest' })
    expect(contextWindowOf('claude-opus-5-7', 'anthropic')).toBe(contextWindowOf('claude-opus-5-5', 'anthropic'))
  })

  it('the catalog carries entries; the host default maps onto the entry sending it', () => {
    // No stored default: the host's concrete default becomes the entry that
    // sends exactly it.
    const fresh = applyModelEntries(
      { providers: [anthropic()], defaultSelection: { providerId: 'anthropic', modelId: 'claude-opus-5-7' } } as BrowserLlmCatalog,
      {},
    )
    expect(fresh.defaultSelection).toEqual({ providerId: 'anthropic', modelId: 'claude-opus-*@latest' })
  })

  it('the catalog carries entries, and the default selection moves to the default entry', () => {
    const catalog: BrowserLlmCatalog = {
      providers: [anthropic()],
      defaultSelection: { providerId: 'anthropic', modelId: 'claude-opus-5-5' },
    } as BrowserLlmCatalog
    const out = applyModelEntries(catalog, {
      anthropic: {
        modelEntries: [
          { family: 'claude-opus-*', version: 'latest' },
          { family: 'claude-opus-*', version: '5.5' },
        ],
        defaultModel: 'claude-opus-*@5.5',
      },
    })
    const row = out.providers[0]!
    const entryRows = row.models.filter(m => m.entry)
    expect(entryRows.map(m => [m.id, m.entry?.resolvedId, m.entry?.resolvedLabel])).toEqual([
      ['claude-opus-*@latest', 'claude-opus-5-7', 'Claude Opus 5.7'],
      ['claude-opus-*@5.5', 'claude-opus-5-5', 'Opus 5.5'],
    ])
    expect(out.defaultSelection).toEqual({ providerId: 'anthropic', modelId: 'claude-opus-*@5.5' })
    // Every id consumer resolves the entry.
    expect(resolveModelId('anthropic', 'claude-opus-*@latest')).toBe('claude-opus-5-7')

    // Every candidate stays selectable as a HIDDEN row — the tier dictionary
    // and session-model pins name exact models (an older Opus here) — aliased
    // to the entry sending the same model, else to its pinned version's id.
    const hidden = new Map(row.models.filter(m => !m.entry).map(m => [m.id, m.pickerAliasId]))
    expect(hidden.get('claude-opus-4-8')).toBe('claude-opus-*@4.8')
    expect(hidden.get('claude-opus-5-7')).toBe('claude-opus-*@latest')
    expect(hidden.get('claude-opus-5-5')).toBe('claude-opus-*@5.5')
    expect([...hidden.values()].every(Boolean)).toBe(true)
    // A concrete id the catalog offers runs exactly; one it does not moves to
    // the entry holding its version.
    expect(toEntrySelection(out, { providerId: 'anthropic', modelId: 'claude-opus-4-8' }))
      .toEqual({ providerId: 'anthropic', modelId: 'claude-opus-4-8' })
    expect(toEntrySelection(out, { providerId: 'anthropic', modelId: 'claude-opus-5-5-20270101' }))
      .toEqual({ providerId: 'anthropic', modelId: 'claude-opus-*@5.5' })
    expect(toEntrySelection(out, { providerId: 'anthropic', modelId: 'claude-opus-5-9' }))
      .toEqual({ providerId: 'anthropic', modelId: 'claude-opus-*@latest' })
    expect(toEntrySelection(out, { providerId: 'anthropic', modelId: 'claude-opus-*@5.5' }))
      .toEqual({ providerId: 'anthropic', modelId: 'claude-opus-*@5.5' })
  })

  it('the broker gets a concrete default — resolved now, else the entry\'s own id, else none', () => {
    recordEntryResolution('anthropic', 'claude-opus-*@latest', { id: 'claude-opus-5-7', versionLabel: '5.7', preview: false })
    const out = withConcreteDefaultModels({
      anthropic: { defaultModel: 'claude-opus-*@latest', model: 'claude-opus-*@latest' },
      openrouter: {
        defaultModel: 'a/b-*@1',
        modelEntries: [{ family: 'a/b-*', version: '1', id: 'a/b-1' }],
      },
      moonshot: { defaultModel: 'kimi-*@latest' },
      openai: { defaultModel: 'gpt-6' },
    })
    expect(out).toEqual({
      anthropic: { defaultModel: 'claude-opus-5-7', model: 'claude-opus-5-7' },
      openrouter: { defaultModel: 'a/b-1', modelEntries: [{ family: 'a/b-*', version: '1', id: 'a/b-1' }] },
      moonshot: {},
      openai: { defaultModel: 'gpt-6' },
    })
  })

  it('a custom provider\'s concrete id with an \'@\' in it is not an entry: sent as is', () => {
    const custom = { defaultModel: 'claude-sonnet-4@20250514', model: 'claude-sonnet-4@20250514' }
    expect(withConcreteDefaultModels({ 'custom-vertex': custom })).toEqual({ 'custom-vertex': custom })
  })
})
