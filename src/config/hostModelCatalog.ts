/**
 * The model ids the HOST reports per provider (the picker's list), since the curated
 * catalog holds patterns. Published, not fetched: plain host-owned data, replaced
 * wholesale and read synchronously. Empty = "not known yet", never "no models".
 */
import type { BrowserLlmCatalog } from '../browser/bridge/protocol/nexus_llm'

let modelIdsByProvider: Record<string, string[]> = {}

/**
 * Adopt a host catalog from any seam it arrives through. A null or empty catalog is
 * IGNORED (the broker was not ready).
 */
export function publishHostModelCatalog(
  catalog: BrowserLlmCatalog | null | undefined,
): void {
  if (!catalog || catalog.providers.length === 0) return
  const next: Record<string, string[]> = {}
  for (const provider of catalog.providers) {
    // The picker's own visibility rule (`ModelQuickPicker`: skip a provider
    // that is not set up, skip a disabled model, skip an alias-hidden
    // snapshot row that duplicates its curated twin). Reporting a row the
    // user cannot pick would be a different list wearing the same name.
    if (!provider.enabled) continue
    const ids = (provider.models ?? [])
      .filter(model => model.enabled && !model.pickerAliasId)
      .map(model => model.id)
      .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    if (ids.length > 0) next[provider.id] = ids
  }
  modelIdsByProvider = next
}

/** The host-reported model ids for one provider; empty when none are known. */
export function hostModelIdsFor(providerId: string): string[] {
  return modelIdsByProvider[providerId] ?? []
}

/** Test seam — drop everything published so far. */
export function resetHostModelCatalog(): void {
  modelIdsByProvider = {}
}
