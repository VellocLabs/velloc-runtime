/**
 * Reader for the snapshot shipped as a static asset of the web bundle:
 * `catalog/snapshot/index.json` and `catalog/snapshot/providers/<key>.json`.
 * The asset loader is injected (the generator is a separate work package).
 */
import {
  createCatalogReader,
  type CatalogReader,
  type CatalogTimers,
} from './catalogReader'

export const SNAPSHOT_ASSET_ROOT = 'catalog/snapshot'

export function createSnapshotReader(opts: {
  /** Resolves the asset text, or undefined when it is not there. */
  fetchAsset: (assetPath: string) => Promise<string | undefined>
  timers?: CatalogTimers
  idleMs?: number
}): CatalogReader {
  return createCatalogReader(
    rel => opts.fetchAsset(`${SNAPSHOT_ASSET_ROOT}/${rel}`).catch(() => undefined),
    { timers: opts.timers, idleMs: opts.idleMs },
  )
}
