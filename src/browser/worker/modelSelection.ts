/**
 * Pure model-selection resolution: catalog-based resolution, selection equality and tier merging.
 */
import type {
  BrowserLlmCatalog,
  BrowserLlmProvider,
  BrowserLlmSelection,
} from '../bridge/browserBridgeProtocol'
import {
  entryForModelId,
  entryId,
  isEntryId,
  versionParser,
} from '../../config/nexusModelConfig/modelEntries'
import { providerModelPool } from '../../config/nexusModelConfig/providerModelPool'
import { losslessEntryRow } from '../../models/drivers/modelEntryCatalog'

export function getFirstEnabledSelection(
  catalog: BrowserLlmCatalog | null,
): BrowserLlmSelection | null {
  if (!catalog) {
    return null
  }

  for (const provider of catalog.providers) {
    if (!provider.enabled) {
      continue
    }

    const defaultModel = provider.defaultModelId
      ? provider.models.find(
          model => model.id === provider.defaultModelId && model.enabled,
        )
      : undefined
    if (defaultModel) {
      return {
        providerId: provider.id,
        modelId: defaultModel.id,
      }
    }

    const firstEnabledModel = provider.models.find(model => model.enabled)
    if (firstEnabledModel) {
      return {
        providerId: provider.id,
        modelId: firstEnabledModel.id,
      }
    }
  }

  return null
}

export function getProviderById(
  catalog: BrowserLlmCatalog | null,
  providerId: string,
): BrowserLlmProvider | undefined {
  return catalog?.providers.find(provider => provider.id === providerId)
}

export function isSelectionEnabled(
  catalog: BrowserLlmCatalog | null,
  selection: BrowserLlmSelection | null | undefined,
): selection is BrowserLlmSelection {
  if (!catalog || !selection) {
    return false
  }

  const provider = getProviderById(catalog, selection.providerId)
  if (!provider?.enabled) {
    return false
  }

  return provider.models.some(
    model => model.id === selection.modelId && model.enabled,
  )
}

/**
 * A REQUESTED selection of a model its enabled provider can run but the catalog does not list (a
 * borrowed tier). Persisted selections are never admitted this way.
 */
function isPooledSelection(
  catalog: BrowserLlmCatalog | null,
  selection: BrowserLlmSelection | null | undefined,
): selection is BrowserLlmSelection {
  if (!catalog || !selection) return false
  if (!getProviderById(catalog, selection.providerId)?.enabled) return false
  return providerModelPool(selection.providerId).includes(selection.modelId)
}

/**
 * A selection naming a concrete model id: kept when the catalog offers it as a row, else mapped to the
 * entry resolving to that id, its version's pinned entry, or its family's `latest`; otherwise as is.
 */
export function toEntrySelection<T extends BrowserLlmSelection | null | undefined>(
  catalog: BrowserLlmCatalog | null,
  selection: T,
): T {
  if (!catalog || !selection || isEntryId(selection.modelId)) return selection
  const provider = getProviderById(catalog, selection.providerId)
  if (provider?.models.some(model => model.id === selection.modelId)) return selection
  const entries = (provider?.models ?? [])
    .map(model => model.entry)
    .filter((entry): entry is NonNullable<typeof entry> => !!entry)
  if (!provider || entries.length === 0) return selection
  const exact = losslessEntryRow(provider.models, selection.modelId)
  if (exact) return { ...selection, modelId: exact.id }
  const match = entryForModelId(selection.modelId, entries, versionParser(provider.id))
  return match ? { ...selection, modelId: entryId(match) } : selection
}

export function resolveSelectionByModelId(
  catalog: BrowserLlmCatalog | null,
  modelId: string | undefined,
): BrowserLlmSelection | null {
  if (!catalog || !modelId) {
    return null
  }

  for (const provider of catalog.providers) {
    if (!provider.enabled) {
      continue
    }

    const model = provider.models.find(
      entry => entry.id === modelId && entry.enabled,
    )
    if (model) {
      return {
        providerId: provider.id,
        modelId: model.id,
      }
    }
  }

  return null
}

export function resolveSelection(
  catalog: BrowserLlmCatalog | null,
  options: {
    requestedSelection?: BrowserLlmSelection | null
    requestedModelId?: string
    persistedSelection?: BrowserLlmSelection | null
    /**
     * Sub-agent tier spawns: the parent's live selection
     * (`payload.modelFallbackSelection`). Checked AFTER the requested
     * selection/id and BEFORE `catalog.defaultSelection`, so a requested
     * model that isn't enabled in the catalog degrades to the PARENT's
     * model — never a third, unrelated default.
     */
    fallbackSelection?: BrowserLlmSelection | null
  },
): BrowserLlmSelection | null {
  const persisted = toEntrySelection(catalog, options.persistedSelection)
  if (isSelectionEnabled(catalog, persisted)) {
    return persisted
  }

  const requested = toEntrySelection(catalog, options.requestedSelection)
  if (isSelectionEnabled(catalog, requested) || isPooledSelection(catalog, requested)) {
    return requested
  }

  const byModelId = resolveSelectionByModelId(catalog, options.requestedModelId)
  if (byModelId) {
    return byModelId
  }

  const fallback = toEntrySelection(catalog, options.fallbackSelection)
  if (isSelectionEnabled(catalog, fallback)) {
    return fallback
  }

  if (isSelectionEnabled(catalog, catalog?.defaultSelection)) {
    return catalog.defaultSelection
  }

  return getFirstEnabledSelection(catalog)
}

/**
 * Model IDENTITY equality — same (provider, model) pair, tier ignored.
 * Use for "did resolution land on a different model" questions (reconcile,
 * fallback warnings). NOT for persistence gates: a tier-only change is a
 * real selection change the user expects to stick — use
 * `areSelectionsFullyEqual` there.
 */
export function areSelectionsEqual(
  left: BrowserLlmSelection | null | undefined,
  right: BrowserLlmSelection | null | undefined,
): boolean {
  return left?.providerId === right?.providerId
    && left?.modelId === right?.modelId
}

/**
 * FULL selection equality — identity plus `thinkingTier`. Matches the UI
 * feed's `modelEquals` comparator (SessionFeedPublisher), so the persisted
 * metadata and the topbar agree on what counts as a change.
 */
export function areSelectionsFullyEqual(
  left: BrowserLlmSelection | null | undefined,
  right: BrowserLlmSelection | null | undefined,
): boolean {
  return (
    areSelectionsEqual(left, right) &&
    left?.thinkingTier === right?.thinkingTier
  )
}

/**
 * Splice the requested `thinkingTier` onto a resolved selection that has none. A tier the selection
 * already carries WINS: effort is per session (F-12).
 */
export function mergeRequestedTier(
  resolved: BrowserLlmSelection,
  requestedSelection: BrowserLlmSelection | null,
): BrowserLlmSelection {
  if (!requestedSelection?.thinkingTier || resolved.thinkingTier) {
    return resolved
  }
  if (
    resolved.providerId !== requestedSelection.providerId ||
    resolved.modelId !== requestedSelection.modelId
  ) {
    return resolved
  }
  return { ...resolved, thinkingTier: requestedSelection.thinkingTier }
}
