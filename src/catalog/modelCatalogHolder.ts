/**
 * Seam supplying the realm's model catalog service to the runtime hub. No
 * source configured: `available: false` and `catalog.refresh` answers
 * `host_unavailable`.
 */
import type { ModelCatalog } from './modelCatalog'
import { createRealmHolder } from '../utils/realmHolder'

export type ModelCatalogGetter = () => ModelCatalog | undefined | Promise<ModelCatalog | undefined>

const holder = createRealmHolder<ModelCatalogGetter>('model-catalog')

/** Set (or, with `null`, clear) where the service comes from; listeners hear of the change. */
export function configureModelCatalogSource(next: ModelCatalogGetter | null): void {
  holder.set(next)
}

export async function acquireModelCatalog(): Promise<ModelCatalog | undefined> {
  const getter = holder.get()
  return getter ? await getter() : undefined
}

export function onModelCatalogSourceChanged(listener: () => void): () => void {
  return holder.onChanged(listener)
}
