import type {
  BrowserLlmCatalog,
  BrowserLlmSelection,
} from '../bridge/browserBridgeProtocol'
import {
  NEXUS_MODEL_CONFIG,
  type NexusModelConfig,
} from '../../config/nexusModelConfig'
import { createConfiguredProvider } from './configuredModels'

export function isSelectionEnabled(
  catalog: BrowserLlmCatalog | null | undefined,
  selection: BrowserLlmSelection | null | undefined,
): selection is BrowserLlmSelection {
  if (!catalog || !selection) {
    return false
  }

  const provider = catalog.providers.find(
    entry => entry.id === selection.providerId && entry.enabled,
  )
  if (!provider) {
    return false
  }

  return provider.models.some(
    model => model.id === selection.modelId && model.enabled,
  )
}

/**
 * Whether an AUTOMATIC fallback for one session — the send gate's
 * adopt-default, the post-settings heal — also replaces the global default new
 * sessions start on. Only when that default is itself unusable: set, but no
 * longer an enabled provider + model in `catalog`. A working default is the
 * user's own topbar pick, and one stale session must not overwrite it.
 */
export function healReplacesGlobalDefault(
  catalog: BrowserLlmCatalog | null | undefined,
  globalDefault: BrowserLlmSelection | null | undefined,
): boolean {
  return !!globalDefault && !isSelectionEnabled(catalog, globalDefault)
}

function getFirstEnabledSelection(
  catalog: BrowserLlmCatalog,
): BrowserLlmSelection | undefined {
  for (const provider of catalog.providers) {
    if (!provider.enabled) {
      continue
    }

    for (const model of provider.models) {
      if (!model.enabled) {
        continue
      }

      return {
        providerId: provider.id,
        modelId: model.id,
      }
    }
  }

  return undefined
}

/**
 * The model ids in a provider's raw online `/models` response (`catalog.rawCatalogs[providerId]`, the
 * only place the online list survives without config entries spliced in). Accepts `{data: [{id}]}`,
 * `{models: [{name|model|id}]}` or a bare array; `undefined` means "online list unavailable", not zero models.
 */
export function extractOnlineModelIds(rawJson: string): string[] | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawJson)
  } catch {
    return undefined
  }

  const candidates: unknown[] = [parsed]
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const record = parsed as Record<string, unknown>
    candidates.push(record.data, record.models)
  }
  const list = candidates.find(Array.isArray) as unknown[] | undefined
  if (!list) {
    return undefined
  }

  const ids: string[] = []
  for (const entry of list) {
    if (typeof entry === 'string') {
      if (entry) ids.push(entry)
      continue
    }
    if (entry && typeof entry === 'object') {
      const record = entry as Record<string, unknown>
      const id = record.id ?? record.name ?? record.model
      if (typeof id === 'string' && id) {
        ids.push(id)
      }
    }
  }
  return ids
}

export function createConfiguredModelCatalog(
  catalog: BrowserLlmCatalog | null | undefined,
  config: NexusModelConfig = NEXUS_MODEL_CONFIG,
): BrowserLlmCatalog | null | undefined {
  if (!catalog) {
    return catalog
  }

  const providers = catalog.providers.map(provider =>
    createConfiguredProvider(provider, config),
  )

  const configuredCatalog: BrowserLlmCatalog = {
    ...catalog,
    providers,
  }

  const defaultSelection =
    isSelectionEnabled(configuredCatalog, catalog.defaultSelection)
      ? catalog.defaultSelection
      : getFirstEnabledSelection(configuredCatalog)

  const result: BrowserLlmCatalog = {
    ...configuredCatalog,
  }
  if (defaultSelection) {
    result.defaultSelection = defaultSelection
  } else {
    delete result.defaultSelection
  }

  return result
}

/**
 * `items` in the user's provider order (settings.json `providers.order`): ids
 * the order names come first, in its sequence; everything else keeps its
 * original relative order after them. Stable, and a no-op for an empty order,
 * so an unset or partial order can never drop or shuffle a provider.
 */
export function orderByProviderIds<T extends { id: string }>(
  items: readonly T[],
  order: readonly string[],
): T[] {
  if (order.length === 0) return [...items]
  const rank = new Map(order.map((id, index) => [id, index] as const))
  return items
    .map((item, index) => ({ item, index, rank: rank.get(item.id) }))
    .sort((a, b) => {
      if (a.rank !== undefined && b.rank !== undefined) return a.rank - b.rank
      if (a.rank !== undefined) return -1
      if (b.rank !== undefined) return 1
      return a.index - b.index
    })
    .map(entry => entry.item)
}

/**
 * The catalog with its providers in the user's order — for DISPLAY (the quick
 * model picker). `defaultSelection` rides along untouched: it was resolved on
 * the catalog's own order, and the worker resolves its fallback the same way,
 * so reordering must not move the default out from under either of them.
 */
export function orderCatalogProviders(
  catalog: BrowserLlmCatalog | null | undefined,
  order: readonly string[],
): BrowserLlmCatalog | null | undefined {
  if (!catalog || order.length === 0) return catalog
  return { ...catalog, providers: orderByProviderIds(catalog.providers, order) }
}
