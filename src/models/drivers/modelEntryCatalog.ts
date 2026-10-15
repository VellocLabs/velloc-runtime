/**
 * Catalog rows as MODEL ENTRIES (F-28): one row per family `latest` or pinned
 * version, the concrete model chosen at request time. A FAMILY row makes `latest`
 * follow discovered versions in its range; a FIXED row is one model. Custom
 * providers keep their hand-defined models.
 */
import type {
  BrowserLlmCatalog,
  BrowserLlmEntryFamily,
  BrowserLlmModel,
  BrowserLlmProvider,
} from '../../browser/bridge/browserBridgeProtocol'
import { applyConfiguredModelRule, createConfiguredProvider } from '../../browser/webview/configuredModels'
import { isCustomBackendId, CUSTOM_PROVIDER_ID_PREFIX } from '../../config/customProviderRegistry'
import {
  NEXUS_MODEL_CONFIG,
  type NexusConfiguredModel,
} from '../../config/nexusModelConfig'
import {
  entryForModelId,
  entryId,
  familyLabel as humanFamilyLabel,
  groupFamilies,
  LATEST,
  parseEntryId,
  pinnedEntryFor,
  resolveEntry,
  type ModelCandidate,
  type ModelEntry,
  type ModelFamily,
  versionParser,
} from '../../config/nexusModelConfig/modelEntries'
import { familyRowCovers, listedFigures, listedModelRow } from '../../config/nexusModelConfig/familyRows'
import { findConfiguredModelIn } from '../../config/nexusModelConfig/findConfiguredModel'
import { recordEntryResolution, resolveModelId } from '../../config/nexusModelConfig/modelEntryResolution'
import { deriveCanonicalModelId } from '../../config/nexusModelConfig/patterns'
import { pickVersionId } from '../../config/nexusModelConfig/providers/shared/modelVersions'
import type { NexusProviderConfig } from '../../settings/settingsTypes'

/** Whether a provider's rows become entries: every built-in, never a custom one. */
export function usesModelEntries(providerId: string): boolean {
  return !providerId.startsWith(CUSTOM_PROVIDER_ID_PREFIX) && !isCustomBackendId(providerId)
}

/**
 * The provider's entries: the stored ones, else the pinned versions of a
 * pre-entry `enabledModels` (what the user had picked), else its defaults
 * (`builtInFamilies`).
 */
export function effectiveEntries(
  providerId: string,
  config: NexusProviderConfig | undefined,
  defaults: readonly ModelEntry[],
): ModelEntry[] {
  if (Array.isArray(config?.modelEntries)) return config.modelEntries.map(e => ({ ...e }))
  const parse = versionParser(providerId)
  const picked = (config?.enabledModels ?? []).filter(Boolean)
  if (picked.length > 0) {
    const out: ModelEntry[] = []
    for (const id of picked) {
      const entry = pinnedEntryFor(id, parse)
      if (!out.some(e => e.family === entry.family && e.version === entry.version)) out.push(entry)
    }
    return out
  }
  return defaults.map(entry => ({ ...entry }))
}

/**
 * Entry rows for one provider. `metadataFor` supplies a concrete model's
 * figures (context window, tiers, …). An entry that resolves to nothing — no
 * listing yet and no stored id — has no row.
 */
export function buildEntryRows(
  provider: BrowserLlmProvider,
  entries: readonly ModelEntry[],
  families: ReadonlyMap<string, ModelFamily>,
  /** A concrete model's figures (context window, tiers, …) and name. */
  metadataFor: (concreteId: string) => Partial<BrowserLlmModel>,
  /** The stored default (`config.defaultModel`) — an entry id wins over the
   *  host's concrete `defaultModelId`, which the broker only ever holds
   *  resolved (`withConcreteDefaultModels`). */
  storedDefault?: string,
): BrowserLlmProvider {
  const parse = versionParser(provider.id)
  const models: BrowserLlmModel[] = []
  for (const entry of entries) {
    const id = entryId(entry)
    const resolution =
      resolveEntry(entry, families, parse)
      ?? (entry.id
        ? { id: entry.id, versionLabel: entry.version === LATEST ? '' : entry.version, preview: parse(entry.id).preview }
        : undefined)
    recordEntryResolution(provider.id, id, resolution)
    if (!resolution) continue
    const family = families.get(entry.family)
    const familyLabel = family?.label ?? humanFamilyLabel(entry.family, undefined, '')
    const pinned = entry.version !== LATEST
    const { label: resolvedLabel, ...meta } = metadataFor(resolution.id)
    models.push({
      ...meta,
      id,
      label: pinned ? `${familyLabel} ${entry.version}` : familyLabel,
      enabled: true,
      supportsStreaming: meta.supportsStreaming ?? true,
      entry: {
        kind: pinned ? 'pinned' : 'latest',
        family: entry.family,
        familyLabel,
        version: entry.version,
        ...(resolution.versionLabel ? { resolvedVersion: resolution.versionLabel } : {}),
        resolvedId: resolution.id,
        ...(resolvedLabel && resolvedLabel !== resolution.id ? { resolvedLabel } : {}),
        preview: resolution.preview,
      },
    })
  }
  const entryFamilies: BrowserLlmEntryFamily[] = []
  for (const key of new Set(entries.map(e => e.family))) {
    const family = families.get(key)
    if (!family) continue
    entryFamilies.push({
      family: key,
      familyLabel: family.label,
      versions: family.versions
        .filter(v => v.versionLabel)
        .map(v => ({
          versionLabel: v.versionLabel,
          id: pickVersionId(v.ids, parse) ?? v.ids[0]!,
          preview: v.preview,
          pinned: entries.some(e => e.family === key && e.version === v.versionLabel),
        })),
    })
  }
  const row: BrowserLlmProvider = { ...provider, models, entryFamilies }
  row.enabled = provider.enabled && models.length > 0
  // The provider's default model: its entry — the one the concrete default
  // resolves to exactly, else the entry holding its version.
  const hostDefault = parseEntryId(storedDefault) ? storedDefault : provider.defaultModelId
  const defaultId = hostDefault && parseEntryId(hostDefault)
    ? models.find(m => m.id === hostDefault)?.id
    : hostDefault
      ? losslessEntryRow(models, hostDefault)?.id
        ?? (() => {
          const entry = entryForModelId(hostDefault, entries, parse)
          return entry && models.some(m => m.id === entryId(entry)) ? entryId(entry) : undefined
        })()
      : undefined
  const chosen = defaultId ?? models[0]?.id
  if (chosen) row.defaultModelId = chosen
  else delete row.defaultModelId
  return row
}

/** The entry row that sends exactly `concreteId` today — a pinned one first. */
export function losslessEntryRow(
  models: readonly BrowserLlmModel[],
  concreteId: string,
): BrowserLlmModel | undefined {
  const matches = models.filter(m => m.entry?.resolvedId === concreteId)
  return matches.find(m => m.entry?.kind === 'pinned') ?? matches[0]
}

// ── Built-in providers ────────────────────────────────────────────────────

/** Rows added to a provider's catalog entry for the uncurated models the
 *  user added (so metadata lookups read conservative figures, never a
 *  guess), by provider — replaced on every rebuild. */
const inheritedRows = new Map<string, NexusConfiguredModel[]>()

function catalogEntry(providerId: string) {
  return NEXUS_MODEL_CONFIG.providers.find(p => p.providerId === providerId)
}

/**
 * The provider's curated view — `createConfiguredProvider` over the catalog's
 * OWN rules only. The rules this module adds for user-added models
 * (`inheritedRows`) are left out: they would otherwise read as curated on
 * the next rebuild and lose their unverified standing.
 */
/** The catalog's OWN rows for a provider — without the grafted ones. */
function ownRows(providerId: string): NexusConfiguredModel[] {
  const grafted = new Set(inheritedRows.get(providerId) ?? [])
  return (catalogEntry(providerId)?.models ?? []).filter(rule => !grafted.has(rule))
}

function curatedView(provider: BrowserLlmProvider): BrowserLlmProvider {
  const grafted = new Set(inheritedRows.get(provider.id) ?? [])
  if (grafted.size === 0) return createConfiguredProvider(provider)
  return createConfiguredProvider(provider, {
    ...NEXUS_MODEL_CONFIG,
    providers: NEXUS_MODEL_CONFIG.providers.map(p =>
      p.providerId === provider.id ? { ...p, models: p.models.filter(rule => !grafted.has(rule)) } : p,
    ),
  })
}


/** Metadata of a row as the picker shows it (its `label` becomes the
 *  entry's `resolvedLabel`). */
function rowMetadata(model: BrowserLlmModel): Partial<BrowserLlmModel> {
  const { id: _id, enabled: _enabled, pickerAliasId: _alias, entry: _entry, ...rest } = model
  return rest
}

/**
 * A built-in provider's families: its curated rows plus the discovered
 * versions its table speaks for (see the header; every row, for a provider
 * with no curated list), the figures of each candidate, and its default
 * entries — `latest` of each family row and each fixed row's own version,
 * in table order.
 */
export function builtInFamilies(
  provider: BrowserLlmProvider,
  /** The user's stored entries: one that names an uncurated family keeps that
   *  family's models among the candidates, so it still resolves. */
  storedEntries: readonly ModelEntry[] = [],
): {
  families: Map<string, ModelFamily>
  byId: Map<string, BrowserLlmModel>
  defaults: ModelEntry[]
  /** Candidate ids from outside the curated catalog (conservative figures). */
  uncurated: Set<string>
} {
  const parse = versionParser(provider.id)
  const curated = curatedView(provider)
  const curatedIds = new Set(curated.models.map(m => m.id))
  const byId = new Map<string, BrowserLlmModel>()
  for (const model of curated.models) byId.set(model.id, model)
  const hasCuration = (catalogEntry(provider.id)?.models.length ?? 0) > 0 && curated !== provider

  const curatedFamilies = new Set(curated.models.map(m => parse(m.id).family))
  const candidates: ModelCandidate[] = curated.models.map(m => ({ id: m.id, label: m.label }))
  const familyRows = ownRows(provider.id).filter(row => row.family)
  // Discovered versions the table speaks for and does not list.
  const inherited: NexusConfiguredModel[] = []
  if (hasCuration) {
    for (const raw of provider.models) {
      if (curatedIds.has(raw.id)) continue
      const info = parse(raw.id)
      if (!familyRows.some(row => familyRowCovers(row, info))) continue
      // It reads what the lookup gives it — its family's row, or a fixed
      // row that names it — here and at request time alike.
      const rule = findConfiguredModelIn(NEXUS_MODEL_CONFIG, provider.id, raw.id)
      byId.set(raw.id, rule ? applyConfiguredModelRule(raw, rule) : raw)
      candidates.push({ id: raw.id, label: raw.label })
    }
  }
  // Models outside the curated catalog, only those the user added (a stored
  // entry names their family): they get no curated figures, so they read
  // what the provider's listing states (Anthropic's states context, output
  // cap, effort levels and image input) and otherwise the conservative
  // figures — no thinking tiers, no image input — never a guess.
  const uncurated = new Set<string>()
  if (hasCuration) {
    const wanted = new Set(storedEntries.map(e => e.family))
    for (const raw of uncuratedModels(provider)) {
      if (!wanted.has(parse(raw.id).family)) continue
      candidates.push({ id: raw.id, label: raw.label })
      uncurated.add(raw.id)
      const figures = listedFigures(provider.id, raw.id)
      const { name: _name, ...rule } = listedModelRow(raw.id, figures)
      rule.supportsImageInput = figures?.supportsImageInput ?? false
      byId.set(raw.id, applyConfiguredModelRule({
        id: raw.id,
        label: raw.label,
        enabled: true,
        supportsStreaming: true,
        ...(raw.contextWindow ? { contextWindow: raw.contextWindow } : {}),
        ...(raw.maxOutputTokens ? { maxOutputTokens: raw.maxOutputTokens } : {}),
      }, rule))
      inherited.push(rule)
    }
  }
  const families = groupFamilies(candidates, parse)

  const entry = catalogEntry(provider.id)
  if (entry) {
    const previous = new Set(inheritedRows.get(provider.id) ?? [])
    entry.models = [...entry.models.filter(rule => !previous.has(rule)), ...inherited]
    inheritedRows.set(provider.id, inherited)
  }

  const stable = [...families.values()]
    .filter(f => f.versions.some(v => !v.preview))
    .map(f => f.family)
  let defaults: ModelEntry[]
  if (familyRows.length > 0) {
    // The table says what is offered: `latest` of a family row, the one
    // version of a fixed row. (A table of fixed rows only — Ollama's, whose
    // ids are local tags — offers `latest` of each family its rows form.)
    defaults = []
    const add = (entry: ModelEntry) => {
      if (!defaults.some(e => e.family === entry.family && e.version === entry.version)) defaults.push(entry)
    }
    for (const row of ownRows(provider.id)) {
      if (row.family) {
        const family = stable.find(f => f.toLowerCase() === row.family!.toLowerCase())
        if (family) add({ family, version: LATEST })
        continue
      }
      const id = deriveCanonicalModelId(row.model)
      if (id && byId.has(id)) add(pinnedEntryFor(id, parse))
    }
  } else {
    defaults = (hasCuration ? stable.filter(f => curatedFamilies.has(f)) : stable)
      .map(family => ({ family, version: LATEST }))
  }
  return {
    families,
    byId,
    defaults,
    uncurated,
  }
}

/** Ids no agent can chat with: embeddings, speech, image / video generation … */
const NON_CHAT_ID = /embed|rerank|moderat|whisper|transcri|tts|speech|audio|realtime|dall-e|imagen|image|video|veo|sora|\bwan\d/i

/**
 * The models the host lists that the curated catalog leaves out AND that do not
 * belong to a curated family (a new version of a curated family is already a
 * candidate). Chat models only: an id that names an embedding / speech / image
 * model, or a row that says it cannot call tools, is dropped. Empty for a
 * provider with no curated list — every model of it is already offered.
 */
export function uncuratedModels(provider: BrowserLlmProvider): BrowserLlmModel[] {
  const curatedRules = catalogEntry(provider.id)?.models.length ?? 0
  if (curatedRules === 0) return []
  const parse = versionParser(provider.id)
  const curated = curatedView(provider)
  if (curated === provider) return []
  const curatedIds = new Set(curated.models.map(m => m.id))
  const familyRows = ownRows(provider.id).filter(row => row.family)
  // Whatever no family row covers: an older version, a newer version of a
  // FIXED row's family, a model of no row at all.
  const spokenFor = (id: string): boolean => familyRows.some(row => familyRowCovers(row, parse(id)))
  return provider.models.filter(
    model =>
      model.enabled !== false &&
      model.supportsTools !== false &&
      !NON_CHAT_ID.test(model.id) &&
      !curatedIds.has(model.id) &&
      !spokenFor(model.id),
  )
}

export function builtInEntryRow(
  provider: BrowserLlmProvider,
  config: NexusProviderConfig | undefined,
): BrowserLlmProvider {
  const { families, byId, defaults, uncurated } = builtInFamilies(provider, config?.modelEntries ?? [])
  const entries = effectiveEntries(provider.id, config, defaults)
  const row = buildEntryRows(
    provider,
    entries,
    families,
    id => {
      const model = byId.get(id)
      return model ? rowMetadata(model) : {}
    },
    config?.defaultModel,
  )
  // Every family row's `latest` is recorded, whether or not the user keeps
  // that entry: the tier ladder names families (`fastModel: 'claude-haiku-*'`,
  // engine/contextWindow.ts) and must resolve without the picker's say.
  for (const rule of ownRows(provider.id)) {
    if (!rule.family) continue
    const key = [...families.keys()].find(f => f.toLowerCase() === rule.family!.toLowerCase())
    recordEntryResolution(
      provider.id,
      entryId({ family: rule.family, version: LATEST }),
      key ? resolveEntry({ family: key, version: LATEST }, families, versionParser(provider.id)) : undefined,
    )
  }
  // An entry that sends an uncurated model says so.
  for (const model of row.models) {
    if (model.entry?.resolvedId && uncurated.has(model.entry.resolvedId)) {
      model.entry = { ...model.entry, unverified: true }
    }
  }
  // Every candidate model â€” and every model the host lists â€” stays
  // SELECTABLE as a hidden row (the picker never lists a `pickerAliasId`
  // row): the tier dictionary, the session-model pins and the host's own
  // default name concrete models — a curated catalog may route `balanced` to
  // qwen3.7-max while `best` is qwen3.8-max, the same family — and those
  // must run exactly, not as their family's Latest. Its alias is the entry
  // sending the same model (the picker checks that row), else the id its
  // pinned version would have.
  const parse = versionParser(provider.id)
  const entryRows = row.models
  const hidden: BrowserLlmModel[] = []
  const seen = new Set(entryRows.map(m => m.id))
  for (const model of [...byId.values(), ...provider.models]) {
    if (!model.enabled || seen.has(model.id)) continue
    seen.add(model.id)
    const info = parse(model.id)
    hidden.push({
      ...model,
      pickerAliasId:
        losslessEntryRow(entryRows, model.id)?.id
        ?? entryId({ family: info.family, version: info.versionLabel || LATEST }),
    })
  }
  if (hidden.length > 0) row.models = [...entryRows, ...hidden]
  return row
}

/**
 * The runtime's catalog, every built-in provider's rows as entries. The
 * default selection moves to its entry too.
 */
export function applyModelEntries(
  catalog: BrowserLlmCatalog,
  configs: Record<string, NexusProviderConfig>,
  options: { skip?: (providerId: string) => boolean } = {},
): BrowserLlmCatalog {
  const providers = catalog.providers.map(provider =>
    usesModelEntries(provider.id) && !options.skip?.(provider.id) && !provider.entryFamilies
      ? builtInEntryRow(provider, configs[provider.id])
      : provider,
  )
  const out: BrowserLlmCatalog = { ...catalog, providers }
  const selection = catalog.defaultSelection
  if (selection && !parseEntryId(selection.modelId)) {
    const provider = providers.find(p => p.id === selection.providerId)
    const entries = (provider?.models ?? [])
      .map(m => m.entry)
      .filter((e): e is NonNullable<typeof e> => !!e)
    if (provider && entries.length > 0) {
      // The host's default is the broker's resolved copy of the provider's
      // stored default: a stored entry default takes it back. Otherwise the
      // entry that sends exactly that model, else the entry holding its
      // version, else the provider's default.
      const stored = configs[provider.id]?.defaultModel
      const rows = provider.models
      const hasRow = (id: string | undefined) => !!id && rows.some(m => m.id === id)
      let modelId: string | undefined
      if (parseEntryId(stored) && hasRow(stored)) modelId = stored
      else if (losslessEntryRow(rows, selection.modelId)) modelId = losslessEntryRow(rows, selection.modelId)!.id
      else if (hasRow(selection.modelId)) modelId = selection.modelId
      else {
        const match = entryForModelId(selection.modelId, entries, versionParser(provider.id))
        modelId = match && hasRow(entryId(match)) ? entryId(match) : provider.defaultModelId
      }
      if (modelId) out.defaultSelection = { ...selection, modelId }
    }
  }
  return out
}

/**
 * The provider configs as the HOST broker takes them: a default model that is
 * an entry id (`claude-opus-*@latest`) becomes the concrete id it resolves to
 * now — the host sends `default_model` upstream as-is for a request that names
 * no model — else the id the entry was added with; one that resolves to
 * nothing is dropped (the host then falls back to the provider's own default).
 * The settings file keeps the entry id.
 */
export function withConcreteDefaultModels(
  input: Record<string, NexusProviderConfig>,
): Record<string, NexusProviderConfig> {
  const out: Record<string, NexusProviderConfig> = { ...input }
  for (const [providerId, config] of Object.entries(input)) {
    // A custom provider never uses entries: an id of its with an '@' in it
    // (`publisher-model@version`) is a concrete model, sent as is.
    if (!usesModelEntries(providerId)) continue
    let next: NexusProviderConfig | undefined
    for (const key of ['defaultModel', 'model'] as const) {
      const value = config[key]
      const entry = parseEntryId(value)
      if (!value || !entry) continue
      next ??= { ...config }
      const resolved = resolveModelId(providerId, value)
      const concrete = resolved !== value
        ? resolved
        : config.modelEntries?.find(e => e.family === entry.family && e.version === entry.version)?.id
      if (concrete) next[key] = concrete
      else delete next[key]
    }
    if (next) out[providerId] = next
  }
  return out
}

/** Test hook. */
export function resetModelEntryCatalog(): void {
  for (const [providerId, rows] of inheritedRows) {
    const entry = catalogEntry(providerId)
    if (entry) entry.models = entry.models.filter(rule => !rows.includes(rule))
  }
  inheritedRows.clear()
}
