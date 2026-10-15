/**
 * Seam supplying the realm's model catalog service to the runtime hub. No
 * source configured: `available: false` and `catalog.refresh` answers
 * `host_unavailable`.
 */
import type { ModelCatalog } from './modelCatalog'

export type ModelCatalogGetter = () => ModelCatalog | undefined | Promise<ModelCatalog | undefined>

let getter: ModelCatalogGetter | null = null
const listeners = new Set<() => void>()

/** Set (or, with `null`, clear) where the service comes from; listeners hear of the change. */
export function configureModelCatalogSource(next: ModelCatalogGetter | null): void {
  getter = next
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch (error) {
      console.warn('[model-catalog] a change listener failed:', error)
    }
  }
}

export async function acquireModelCatalog(): Promise<ModelCatalog | undefined> {
  return getter ? await getter() : undefined
}

export function onModelCatalogSourceChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
