/**
 * Factory that assembles the model catalog from the runtime's seams. Nothing
 * runs when it is called: no read, no request. Wiring it into a runtime (who
 * supplies `http` and `fetchAsset`, where the one instance lives) is a
 * separate decision; this is the single named entry point for it.
 */
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import { joinRuntimePath } from '../utils/runtimePaths'
import { userDataRoot } from '../utils/conversationStoragePaths'
import { createCatalogStore } from './catalogStore'
import { createSnapshotReader } from './catalogSnapshot'
import { createModelCatalog, type ModelCatalog } from './modelCatalog'
import type { CatalogHttp } from './catalogFetcher'
import type { CatalogTimers } from './catalogReader'

export function createModelCatalogService(deps: {
  fs: RuntimeFs
  /** The Velloc home parent (what `userDataRoot` takes). */
  homeDir: string
  http: CatalogHttp
  /** Loads a bundle asset by path, undefined when absent. */
  fetchAsset: (assetPath: string) => Promise<string | undefined>
  sourceUrl?: () => string | undefined | Promise<string | undefined>
  now?: () => number
  timers?: CatalogTimers
}): ModelCatalog {
  return createModelCatalog({
    store: createCatalogStore({
      fs: deps.fs,
      dir: joinRuntimePath(userDataRoot(deps.homeDir), 'catalog'),
      timers: deps.timers,
    }),
    snapshot: createSnapshotReader({ fetchAsset: deps.fetchAsset, timers: deps.timers }),
    http: deps.http,
    now: deps.now ?? Date.now,
    sourceUrl: deps.sourceUrl,
  })
}
