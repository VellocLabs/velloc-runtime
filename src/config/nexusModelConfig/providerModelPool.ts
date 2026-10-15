/**
 * Every model a provider can run an agent on, offered or not, for the tier ladder.
 * From a fetched LISTING (tool-capable only), else the model CATALOG. Published,
 * read synchronously; no pool = not known yet.
 */
import type { BrowserLlmCatalog } from '../../browser/bridge/protocol/nexus_llm'

type Pool = { ids: string[]; names: Map<string, string>; listed: boolean }

const pools = new Map<string, Pool>()

/** Adopt a provider's fetched listing (its tool-capable models). */
export function publishListedModelPool(
  providerId: string,
  models: ReadonlyArray<{ id: string; name?: string }>,
): void {
  const names = new Map<string, string>()
  for (const model of models) if (model.name) names.set(model.id, model.name)
  pools.set(providerId, { ids: models.map(model => model.id), names, listed: true })
}

/**
 * Adopt a catalog for every provider that has no fetched listing. An entry
 * row counts as the concrete model it resolves to. A null or empty catalog
 * is ignored (the broker was not ready), as `publishHostModelCatalog` does.
 */
export function publishCatalogModelPool(catalog: BrowserLlmCatalog | null | undefined): void {
  if (!catalog || catalog.providers.length === 0) return
  for (const provider of catalog.providers) {
    if (pools.get(provider.id)?.listed) continue
    const names = new Map<string, string>()
    const ids: string[] = []
    for (const model of provider.models ?? []) {
      if (!model.enabled || model.supportsTools === false) continue
      const id = model.entry ? model.entry.resolvedId : model.id
      if (!id || ids.includes(id)) continue
      ids.push(id)
      const name = model.entry ? model.entry.resolvedLabel : model.label
      if (name && name !== id) names.set(id, name)
    }
    if (ids.length > 0) pools.set(provider.id, { ids, names, listed: false })
    else pools.delete(provider.id)
  }
}

/** The models `providerId` can run; empty when none are known yet. */
export function providerModelPool(providerId: string): readonly string[] {
  return pools.get(providerId)?.ids ?? []
}

/** A pooled model's display name, when its source states one. */
export function providerModelName(providerId: string, modelId: string): string | undefined {
  return pools.get(providerId)?.names.get(modelId)
}

/** Test seam — drop everything published so far. */
export function resetProviderModelPool(): void {
  pools.clear()
}
