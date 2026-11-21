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

/** The service, waiting up to `ms` for a source to be configured; undefined when none comes. */
export async function waitForModelCatalog(ms: number): Promise<ModelCatalog | undefined> {
  if (holder.get()) return acquireModelCatalog()
  await new Promise<void>(resolve => {
    const timer = setTimeout(done, ms)
    const off = holder.onChanged(done)
    function done(): void {
      clearTimeout(timer)
      off()
      resolve()
    }
  })
  return acquireModelCatalog()
}
