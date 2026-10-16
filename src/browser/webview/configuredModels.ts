import type {
  BrowserLlmModel,
  BrowserLlmProvider,
} from '../bridge/browserBridgeProtocol'
import {
  NEXUS_MODEL_CONFIG,
  type NexusConfiguredModel,
  type NexusModelConfig,
  type NexusModelPattern,
  type NexusProviderFilterMode,
  type NexusProviderModelConfig,
} from '../../config/nexusModelConfig'
import { recordEntryResolution } from '../../config/nexusModelConfig/modelEntryResolution'
import {
  FIRST_REQUEST_OUTPUT_RESERVATION,
  knownModelRows,
} from '../../config/nexusModelConfig/familyRows'
import {
  catalogTierRuleOf,
  recordPublishedFigures,
  withCatalogFigures,
  type CatalogModelFigures,
} from '../../config/nexusModelConfig/catalogFigures'
import { findConfiguredModelIn } from '../../config/nexusModelConfig/findConfiguredModel'
import { versionParser } from '../../config/nexusModelConfig/modelEntries'
import { deriveCanonicalModelId, escapeRegExp } from '../../config/nexusModelConfig/patterns'
import { markRealmMirrorEntry } from '../../config/customProviderRegistry'
import { isModProviderId } from '../../mods/provider/providerManifest'

type CatalogModelContext = {
  label: string
  modelId: string
  providerId: string
}

function createModelContext(
  providerId: string,
  model: Pick<BrowserLlmModel, 'id' | 'label'>,
): CatalogModelContext {
  return {
    providerId,
    modelId: model.id,
    label: model.label,
  }
}

function normalizeMatchValue(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function matchesStringPattern(
  values: readonly string[],
  pattern: string,
): boolean {
  const normalizedPattern = normalizeMatchValue(pattern)
  if (!normalizedPattern) {
    return false
  }

  return values.some(value =>
    normalizeMatchValue(value).includes(normalizedPattern),
  )
}

function modelIdMatches(
  values: readonly string[],
  pattern: NexusModelPattern,
): boolean {
  if (pattern instanceof RegExp) {
    return values.some(value => {
      pattern.lastIndex = 0
      return pattern.test(value)
    })
  }

  return matchesStringPattern(values, pattern)
}

function getMatchValues(context: CatalogModelContext): string[] {
  return [context.modelId, context.label]
}

function matchesConfiguredModel(
  context: CatalogModelContext,
  configuredModel: NexusConfiguredModel,
): boolean {
  const values = getMatchValues(context)
  if (!modelIdMatches(values, configuredModel.model)) {
    return false
  }

  return !configuredModel.exclude?.some(pattern =>
    modelIdMatches(values, pattern),
  )
}

function findProviderConfig(
  providerId: string,
  config: NexusModelConfig,
): NexusProviderModelConfig | undefined {
  return config.providers.find(entry => entry.providerId === providerId)
}

export function applyConfiguredModelRule(
  model: BrowserLlmModel,
  configuredModel: NexusConfiguredModel,
): BrowserLlmModel {
  const nextLabel = configuredModel.name ?? model.label
  const nextDefaultThinkingTier =
    configuredModel.defaultThinkingTier ?? model.defaultThinkingTier
  const nextAvailableThinkingTiers =
    configuredModel.availableThinkingTiers ?? model.availableThinkingTiers
  const nextContextWindow =
    configuredModel.contextWindow ?? model.contextWindow
  const nextMaxOutputTokens =
    configuredModel.maxOutputTokens ?? model.maxOutputTokens
  const nextSupportsImageInput =
    configuredModel.supportsImageInput ?? model.supportsImageInput

  if (
    nextLabel === model.label &&
    nextDefaultThinkingTier === model.defaultThinkingTier &&
    nextAvailableThinkingTiers === model.availableThinkingTiers &&
    nextContextWindow === model.contextWindow &&
    nextMaxOutputTokens === model.maxOutputTokens &&
    nextSupportsImageInput === model.supportsImageInput
  ) {
    return model
  }

  const result: BrowserLlmModel = {
    ...model,
    label: nextLabel,
  }
  if (nextDefaultThinkingTier !== undefined) {
    result.defaultThinkingTier = nextDefaultThinkingTier
  } else {
    delete result.defaultThinkingTier
  }
  if (nextAvailableThinkingTiers !== undefined) {
    result.availableThinkingTiers = nextAvailableThinkingTiers
  } else {
    delete result.availableThinkingTiers
  }
  if (nextContextWindow !== undefined) {
    result.contextWindow = nextContextWindow
  } else {
    delete result.contextWindow
  }
  if (nextMaxOutputTokens !== undefined) {
    result.maxOutputTokens = nextMaxOutputTokens
  } else {
    delete result.maxOutputTokens
  }
  if (nextSupportsImageInput !== undefined) {
    result.supportsImageInput = nextSupportsImageInput
  } else {
    delete result.supportsImageInput
  }
  return result
}

function synthesizeModelFromConfig(
  configuredModel: NexusConfiguredModel,
): BrowserLlmModel | undefined {
  const id = deriveCanonicalModelId(configuredModel.model)
  if (!id) {
    return undefined
  }

  const synthetic: BrowserLlmModel = {
    id,
    label: configuredModel.name ?? id,
    enabled: true,
    supportsStreaming: true,
    supportsTools: true,
  }
  if (configuredModel.defaultThinkingTier !== undefined) {
    synthetic.defaultThinkingTier = configuredModel.defaultThinkingTier
  }
  if (configuredModel.availableThinkingTiers !== undefined) {
    synthetic.availableThinkingTiers = configuredModel.availableThinkingTiers
  }
  if (configuredModel.contextWindow !== undefined) {
    synthetic.contextWindow = configuredModel.contextWindow
  }
  if (configuredModel.maxOutputTokens !== undefined) {
    synthetic.maxOutputTokens = configuredModel.maxOutputTokens
  }
  if (configuredModel.supportsImageInput !== undefined) {
    synthetic.supportsImageInput = configuredModel.supportsImageInput
  }
  return synthetic
}

function resolveProviderFilterMode(
  providerConfig: NexusProviderModelConfig,
): NexusProviderFilterMode {
  return providerConfig.filterMode ?? 'curated'
}

function findPreferredProviderModel(
  provider: BrowserLlmProvider,
  configuredModel: NexusConfiguredModel,
  usedModelIds: ReadonlySet<string>,
): BrowserLlmModel | undefined {
  const matches = provider.models.filter(model => {
    if (usedModelIds.has(model.id)) {
      return false
    }

    return matchesConfiguredModel(
      createModelContext(provider.id, model),
      configuredModel,
    )
  })

  return matches.find(model => model.enabled) ?? matches[0]
}

function createPassthroughProvider(
  provider: BrowserLlmProvider,
  providerConfig: NexusProviderModelConfig,
): BrowserLlmProvider {
  if (providerConfig.models.length === 0) {
    return provider
  }

  const models = provider.models.map(model => {
    const configuredModel = providerConfig.models.find(entry =>
      matchesConfiguredModel(
        createModelContext(provider.id, model),
        entry,
      ),
    )
    return configuredModel
      ? applyConfiguredModelRule(model, configuredModel)
      : model
  })

  const defaultModelId =
    models.some(model => model.id === provider.defaultModelId)
      ? provider.defaultModelId
      : models.find(model => model.enabled)?.id ?? models[0]?.id

  const result: BrowserLlmProvider = {
    ...provider,
    enabled: provider.enabled && models.some(model => model.enabled),
    models,
  }

  if (defaultModelId) {
    result.defaultModelId = defaultModelId
  } else {
    delete result.defaultModelId
  }

  return result
}

export function findConfiguredModelRule(
  providerId: string,
  model: Pick<BrowserLlmModel, 'id' | 'label'>,
  config: NexusModelConfig = NEXUS_MODEL_CONFIG,
): NexusConfiguredModel | undefined {
  // THE lookup (findConfiguredModelIn): a model entry reads the model it
  // resolves to, and a FAMILY row answers for every version it covers — a
  // pattern match would see only the row's verified version.
  return findConfiguredModelIn(config, providerId, model.id)
}

// Rows `mirrorEntryFigures` added, so each catalog replaces its own.
const mirroredRows = new WeakSet<NexusConfiguredModel>()

/**
 * Mirrors the catalog's figures for a runtime-only provider's models this realm has no rule for (the
 * webview never fetches listings). Adds nothing in the worker, where a rule always matches. A mod
 * provider has no entry in a realm without the mod registry; one is made for it here.
 */
function mirrorEntryFigures(
  provider: BrowserLlmProvider,
  config: NexusModelConfig,
): void {
  const providerConfig = findProviderConfig(provider.id, config) ?? mirrorEntryForMod(provider.id, config)
  if (!providerConfig) return
  const kept = providerConfig.models.filter(rule => !mirroredRows.has(rule))
  const added: NexusConfiguredModel[] = []
  const publishedFigures = new Map<string, CatalogModelFigures>()
  const carryTiers = catalogTierRuleOf(providerConfig) !== undefined
  for (const model of provider.models) {
    const concreteId = model.entry?.resolvedId ?? model.id
    // A row already answers for it — a fixed row by its pattern, a FAMILY
    // row by covering its version (the lookup itself, not a pattern match: a
    // mirrored exact-id row would otherwise shadow the family row and drop
    // its opt-in flags). Its published figures fill what the row leaves unset.
    if (findConfiguredModelIn({ providers: [{ ...providerConfig, models: [...kept, ...added] }] }, provider.id, concreteId)) {
      const figures = publishedFiguresOf(model, carryTiers)
      if (figures && !publishedFigures.has(concreteId)) publishedFigures.set(concreteId, figures)
      continue
    }
    if (model.contextWindow === undefined && model.maxOutputTokens === undefined) continue
    const row: NexusConfiguredModel = { model: new RegExp(`^${escapeRegExp(concreteId)}$`) }
    if (model.contextWindow !== undefined) row.contextWindow = model.contextWindow
    if (model.maxOutputTokens !== undefined) {
      row.maxOutputTokens = model.maxOutputTokens
      row.defaultMaxOutputTokens = Math.min(model.maxOutputTokens, FIRST_REQUEST_OUTPUT_RESERVATION)
    }
    if (model.availableThinkingTiers) row.availableThinkingTiers = [...model.availableThinkingTiers]
    if (model.defaultThinkingTier) row.defaultThinkingTier = model.defaultThinkingTier
    if (model.supportsImageInput === false) row.supportsImageInput = false
    mirroredRows.add(row)
    added.push(row)
  }
  recordPublishedFigures(provider.id, publishedFigures)
  if (added.length === 0 && kept.length === providerConfig.models.length) return
  providerConfig.models = [...kept, ...added]
}

/** A new, empty entry for a mod provider this realm has none for, added to `config`; undefined for any other id. */
function mirrorEntryForMod(providerId: string, config: NexusModelConfig): NexusProviderModelConfig | undefined {
  if (!isModProviderId(providerId)) return undefined
  const entry: NexusProviderModelConfig = { providerId, filterMode: 'passthrough', models: [] }
  markRealmMirrorEntry(entry)
  config.providers.push(entry)
  return entry
}

/** The catalog-layer figures a published row states, if any; the tier pair only when `carryTiers`
 *  (the provider takes catalog tiers), so a provider that does not opt in keeps its rows' own. */
function publishedFiguresOf(model: BrowserLlmModel, carryTiers: boolean): CatalogModelFigures | undefined {
  const figures: CatalogModelFigures = {}
  if (model.contextWindow !== undefined) figures.contextWindow = model.contextWindow
  if (model.maxOutputTokens !== undefined) figures.maxOutputTokens = model.maxOutputTokens
  if (model.supportsImageInput !== undefined) figures.supportsImageInput = model.supportsImageInput
  if (carryTiers && model.availableThinkingTiers !== undefined) {
    figures.availableThinkingTiers = [...model.availableThinkingTiers]
    if (model.defaultThinkingTier !== undefined) figures.defaultThinkingTier = model.defaultThinkingTier
  }
  return Object.keys(figures).length > 0 ? figures : undefined
}

export function createConfiguredProvider(
  provider: BrowserLlmProvider,
  config: NexusModelConfig = NEXUS_MODEL_CONFIG,
): BrowserLlmProvider {
  // Model-entry rows (the runtime already curated and decorated them —
  // models/drivers/modelEntryCatalog.ts) pass through; their
  // resolutions are recorded for this realm's metadata lookups.
  if (provider.entryFamilies) {
    for (const model of provider.models) {
      if (model.entry?.resolvedId) {
        recordEntryResolution(provider.id, model.id, {
          id: model.entry.resolvedId,
          versionLabel: model.entry.resolvedVersion ?? '',
          preview: model.entry.preview,
        })
      }
    }
    mirrorEntryFigures(provider, config)
    return provider
  }
  const providerConfig = findProviderConfig(provider.id, config)
  if (!providerConfig) {
    return provider
  }

  if (resolveProviderFilterMode(providerConfig) === 'passthrough') {
    return createPassthroughProvider(provider, providerConfig)
  }

  if (providerConfig.models.length === 0) {
    return provider
  }

  const usedModelIds = new Set<string>()
  const decorated: BrowserLlmModel[] = []

  // One rule per KNOWN model: a family row stands for its verified version
  // and the versions it names by id (config/nexusModelConfig/familyRows.ts).
  for (const configuredModel of knownModelRows(providerConfig.models, versionParser(provider.id))) {
    const matchedModel = findPreferredProviderModel(
      provider,
      configuredModel,
      usedModelIds,
    )
    // Each model reads the catalog's figures beneath the rule (the lowest
    // layer, ../../config/nexusModelConfig/catalogFigures.ts): by its own id.
    const curatedId = deriveCanonicalModelId(configuredModel.model)
    const synthetic = synthesizeModelFromConfig(
      curatedId ? withCatalogFigures(provider.id, configuredModel, curatedId) : configuredModel,
    )
    // Will the synthetic land as a row of its own? Only when its curated id
    // differs from the matched real id (and no earlier rule claimed it).
    const syntheticIsSeparateRow =
      !!synthetic &&
      synthetic.id !== matchedModel?.id &&
      !usedModelIds.has(synthetic.id)

    if (matchedModel) {
      usedModelIds.add(matchedModel.id)
      const decoratedMatch = applyConfiguredModelRule(
        matchedModel,
        withCatalogFigures(provider.id, configuredModel, matchedModel.id),
      )
      // When the curated alias lands as a separate row it carries the same
      // curated label as this real-id match (e.g. the `/v1/models` snapshot
      // `claude-haiku-4-5-20251001` next to the alias `claude-haiku-4-5`).
      // Keep the snapshot row so persisted selections of its id still
      // resolve, but point it at the alias so pickers render one entry.
      decorated.push(
        syntheticIsSeparateRow && synthetic
          ? { ...decoratedMatch, pickerAliasId: synthetic.id }
          : decoratedMatch,
      )
    }

    // Always synthesize the curated entry alongside any matched real id.
    // The model picker advertises models by their curated id
    // (e.g. `claude-haiku-4-5`), but `/v1/models` typically returns the
    // date-suffixed snapshot id (`claude-haiku-4-5-20251015`). Without a
    // synthetic curated row, `isSelectionEnabled` returns false the moment
    // the user picks from the picker — which surfaces as the "Set up a model
    // provider" dialog on submit. Mirrors the C++ `BuildCatalog` graft
    // (always-splice with id-dedup) on the worker-bridge catalog.
    if (synthetic && !usedModelIds.has(synthetic.id)) {
      usedModelIds.add(synthetic.id)
      decorated.push(synthetic)
    }
  }

  const defaultModelId =
    decorated.find(model => model.id === provider.defaultModelId)?.id ??
    decorated.find(model => model.enabled)?.id ??
    decorated[0]?.id

  const result: BrowserLlmProvider = {
    ...provider,
    enabled: provider.enabled && decorated.some(model => model.enabled),
    models: decorated,
  }

  if (defaultModelId) {
    result.defaultModelId = defaultModelId
  } else {
    delete result.defaultModelId
  }

  return result
}
