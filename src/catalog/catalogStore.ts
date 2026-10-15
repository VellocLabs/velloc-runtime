/**
 * Local cache under `<home>/catalog/`: `index.json` plus
 * `providers/<key>.json`. Reads go through the lazy reader; writes are
 * temp-file + rename, provider files first and the index last, so a reader
 * never sees an index that names files not yet written. A file that does not
 * parse counts as absent.
 */
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import {
  createCatalogReader,
  isSafeProviderKey,
  providerRelPath,
  type CatalogReader,
  type CatalogTimers,
} from './catalogReader'
import type { CatalogIdIndex, CatalogIndex, CatalogProviderRecords } from './types'

export type CatalogStore = CatalogReader & {
  /** Write the given providers, the id index, then the index; delete `removeKeys` files. */
  write(
    index: CatalogIndex,
    providers: Record<string, CatalogProviderRecords>,
    ids: CatalogIdIndex,
    removeKeys: readonly string[],
  ): Promise<void>
  /** Rewrite just the index (a 304). */
  writeIndex(index: CatalogIndex): Promise<void>
}

export function createCatalogStore(opts: {
  fs: RuntimeFs
  dir: string
  timers?: CatalogTimers
  idleMs?: number
}): CatalogStore {
  const { fs } = opts
  const root = opts.dir.replace(/[\\/]+$/, '')
  const path = (rel: string): string => `${root}/${rel}`

  const reader = createCatalogReader(
    async rel => {
      try {
        return await fs.readFile(path(rel), { encoding: 'utf8' })
      } catch {
        return undefined
      }
    },
    { timers: opts.timers, idleMs: opts.idleMs },
  )

  async function exists(p: string): Promise<boolean> {
    try {
      await fs.stat(p)
      return true
    } catch {
      return false
    }
  }

  async function atomicWrite(rel: string, text: string): Promise<void> {
    const target = path(rel)
    const tmp = `${target}.tmp`
    if (await exists(tmp)) await fs.unlink(tmp).catch(() => {})
    await fs.writeFile(tmp, text, { encoding: 'utf8' })
    if (!fs.rename) {
      // No atomic move on this host: write in place and drop the temp file.
      await fs.writeFile(target, text, { encoding: 'utf8' })
      await fs.unlink(tmp).catch(() => {})
      return
    }
    // rename never overwrites: clear the old file just before the move.
    // Between this unlink and the rename the target is briefly absent. That
    // window is accepted: a reader that lands in it gets "absent", which the
    // lazy reader already treats like a corrupted file — the catalog falls
    // back to the bundle snapshot (or answers nothing) for that one read and
    // the next read finds the new file. Provider files go first and the
    // index last, so the index never names a file that was never written.
    if (await exists(target)) await fs.unlink(target)
    await fs.rename(tmp, target)
  }

  return {
    readIndex: reader.readIndex,
    readProvider: reader.readProvider,
    readIdIndex: reader.readIdIndex,
    release: reader.release,
    async write(index, providers, ids, removeKeys) {
      await fs.mkdir(path('providers'), { mode: 0o700 }).catch(() => {})
      for (const [key, records] of Object.entries(providers)) {
        if (!isSafeProviderKey(key)) continue
        await atomicWrite(providerRelPath(key), JSON.stringify(records))
      }
      await atomicWrite('ids.json', JSON.stringify(ids))
      await atomicWrite('index.json', JSON.stringify(index))
      for (const key of removeKeys) {
        if (isSafeProviderKey(key) && !(key in providers)) {
          await fs.unlink(path(providerRelPath(key))).catch(() => {})
        }
      }
      reader.release()
    },
    async writeIndex(index) {
      await fs.mkdir(path(''), { mode: 0o700 }).catch(() => {})
      await atomicWrite('index.json', JSON.stringify(index))
      reader.release()
    },
  }
}
