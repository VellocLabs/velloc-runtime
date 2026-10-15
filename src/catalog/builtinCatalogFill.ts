/**
 * Built-in providers' catalog figures (context window, output cap, image input,
 * and effort tiers for a provider that opts in) recorded in the synchronous figures registry (F-28). Read passively at start
 * (no fetch; `getModelCatalog` waits up to `CATALOG_FIGURES_WAIT_MS`) and again
 * on `catalog.updated`; changed figures are re-published to the host and every
 * surface.
 */
import { NEXUS_MODEL_CONFIG } from '../config/nexusModelConfig'
import {
  catalogKeysOf,
  catalogFiguresRead,
  catalogTierRuleOf,
  figureLayerOf,
  sameFigures,
  setCatalogFigures,
  type CatalogModelFigures,
} from '../config/nexusModelConfig/catalogFigures'
import type { NexusModelConfig } from '../config/nexusModelConfig/types'
import type { ModelCatalog } from './modelCatalog'

/** How long the catalog fetch waits for the first read (it rarely needs any). */
export const CATALOG_FIGURES_WAIT_MS = 3_000

export type BuiltinCatalogFillDeps = {
  catalog: Pick<ModelCatalog, 'provider' | 'onUpdated'>
  /** Tell the host and the surfaces that these providers' figures changed. */
  publish: (providerIds: string[]) => Promise<void>
  config?: NexusModelConfig
  report?: (line: string) => void
}

export type BuiltinCatalogFill = {
  /** The read in progress (the first, or one after an update). */
  idle(): Promise<void>
  dispose(): void
}

let current: Promise<void> | undefined

/**
 * Wait for the realm's first catalog-figure read, at most `waitMs`. Resolves
 * at once when none was started (a realm without the catalog). Never rejects.
 */
export async function awaitCatalogFigures(waitMs: number = CATALOG_FIGURES_WAIT_MS): Promise<void> {
  const pending = current
  if (!pending) return
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    pending.catch(() => {}),
    new Promise<void>(resolve => {
      timer = setTimeout(resolve, waitMs)
    }),
  ])
  clearTimeout(timer)
}

/** Providers whose config names catalog keys, with those keys. */
export function catalogMappedProviders(config: NexusModelConfig = NEXUS_MODEL_CONFIG): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const provider of config.providers) {
    const keys = catalogKeysOf(config, provider.providerId)
    if (keys.length > 0) out.set(provider.providerId, keys)
  }
  return out
}

type Snapshot = ReadonlyMap<string, CatalogModelFigures>[]

function sameLayers(a: Snapshot | undefined, b: Snapshot): boolean {
  if (!a || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (x.size !== y.size) return false
    for (const [id, fx] of x) {
      const fy = y.get(id)
      if (!fy || !sameFigures(fx, fy)) return false
    }
  }
  return true
}

export function startBuiltinCatalogFill(deps: BuiltinCatalogFillDeps): BuiltinCatalogFill {
  const config = deps.config ?? NEXUS_MODEL_CONFIG
  const mapped = catalogMappedProviders(config)
  const held = new Map<string, Snapshot>()
  let disposed = false

  /** Read `providerIds`' keys; the providers whose figures changed. */
  const read = async (providerIds: readonly string[]): Promise<string[]> => {
    const changed: string[] = []
    for (const providerId of providerIds) {
      const keys = mapped.get(providerId)
      if (!keys) continue
      const tierRule = catalogTierRuleOf(config.providers.find(p => p.providerId === providerId))
      const layers: Snapshot = []
      for (const key of keys) {
        try {
          layers.push(figureLayerOf(await deps.catalog.provider(key, { passive: true }), tierRule))
        } catch (error) {
          // A catalog read never throws by contract; if one does, the key
          // answers nothing this time.
          deps.report?.(`[catalog] ${key}: ${error instanceof Error ? error.message : String(error)}`)
          layers.push(new Map())
        }
      }
      if (disposed) return changed
      const firstRead = !catalogFiguresRead(providerId)
      if (!firstRead && sameLayers(held.get(providerId), layers)) continue
      held.set(providerId, layers)
      setCatalogFigures(providerId, layers)
      // A first read with nothing to fill has nothing to tell; after that,
      // any change is told, figures gone included, or the host keeps the
      // old ones until the next publish.
      if (!firstRead || layers.some(layer => layer.size > 0)) changed.push(providerId)
    }
    return changed
  }

  // The figures are in place when a read settles; the publish that follows
  // is not waited for (it may itself make a surface fetch the catalog, which
  // waits for the read).
  let publishing: Promise<void> = Promise.resolve()
  const run = async (providerIds: readonly string[]): Promise<void> => {
    const changed = await read(providerIds)
    if (disposed || changed.length === 0) return
    publishing = publishing.then(async () => {
      try {
        await deps.publish(changed)
      } catch (error) {
        deps.report?.(`[catalog] the filled model figures could not be published: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
  }

  // Reads run one after another, so an update never races the first read.
  let chain: Promise<void> = Promise.resolve()
  const enqueue = (providerIds: readonly string[]): Promise<void> => {
    chain = chain.then(() => run(providerIds), () => run(providerIds))
    return chain
  }

  // The first read is what the catalog fetch waits for (`awaitCatalogFigures`).
  current = enqueue([...mapped.keys()])

  const unsubscribe = deps.catalog.onUpdated(event => {
    const keys = new Set(event.providerKeys)
    const affected = [...mapped].filter(([, ks]) => ks.some(k => keys.has(k))).map(([id]) => id)
    if (affected.length === 0) return
    current = enqueue(affected)
  })

  return {
    idle: async () => {
      await chain
      await publishing
    },
    dispose() {
      disposed = true
      unsubscribe()
    },
  }
}

/** Test seam. */
export function resetBuiltinCatalogFill(): void {
  current = undefined
}
