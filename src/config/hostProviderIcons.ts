/**
 * The brand marks the HOST ships per provider (its catalog rows' `iconSvg`),
 * for readers that have no catalog of their own. Published, not fetched:
 * plain host-owned data, replaced wholesale and read synchronously. Empty =
 * "not known yet", never "no mark".
 */
import type { BrowserLlmCatalog } from '../browser/bridge/protocol/nexus_llm'

let marks = new Map<string, string>()

/** Adopt a host catalog's marks. A null or empty catalog is ignored (the broker was not ready). */
export function publishHostProviderIcons(catalog: BrowserLlmCatalog | null | undefined): void {
  if (!catalog || catalog.providers.length === 0) return
  const next = new Map<string, string>()
  for (const provider of catalog.providers) {
    if (typeof provider.iconSvg === 'string' && provider.iconSvg !== '') next.set(provider.id, provider.iconSvg)
  }
  marks = next
}

/** The SVG text the host's catalog row of `providerId` carries; undefined when none is known. */
export function hostProviderIconSvg(providerId: string): string | undefined {
  return marks.get(providerId)
}

/** Test seam: drop everything published so far. */
export function resetHostProviderIcons(): void {
  marks = new Map()
}
