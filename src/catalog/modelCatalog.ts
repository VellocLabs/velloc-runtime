/**
 * The model catalog service (F-28). Reads go cache -> snapshot -> none (newer
 * wins). Nothing is fetched at start; data older than 24 h answers and starts
 * one background refresh. A failure never reaches a caller; it is kept for
 * `status().lastError` and backs off 1 h, 6 h, then 24 h.
 */
import type { CatalogReader } from './catalogReader'
import type { CatalogStore } from './catalogStore'
import {
  DEFAULT_SOURCE_URL,
  fetchSlimmed,
  hashText,
  type CatalogHttp,
} from './catalogFetcher'
import { buildIdIndex, findNormalized, normalizeModelId } from './catalogMatch'
import type {
  CatalogHit,
  CatalogIndex,
  CatalogModel,
  CatalogProviderRecords,
  CatalogStatus,
} from './types'

export const CATALOG_TTL_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000
export const CATALOG_BACKOFF_MS = [HOUR_MS, 6 * HOUR_MS, 24 * HOUR_MS] as const

/** Cap on provider files read to pick among unlisted candidates. */
const MAX_BORROW_READS = 6

export type ModelCatalog = {
  /**
   * exact, then normalized (same provider); borrowed from another provider
   * only when `alsoTry` is passed (listed providers in order, then any).
   */
  lookup(
    providerKey: string,
    modelId: string,
    opts?: { alsoTry?: string[] },
  ): Promise<CatalogHit | undefined>
  /**
   * One provider's records. `{ passive: true }` is a read that leaves no
   * trace: it starts no background refresh (a stale read otherwise does) and
   * keeps none of the files it read held afterwards. The built-in figures
   * read at start uses it: nothing is fetched at start, and a host port that
   * replaces the one it read through is the one the next read uses.
   */
  provider(providerKey: string, opts?: { passive?: boolean }): Promise<CatalogProviderRecords | undefined>
  status(): Promise<CatalogStatus>
  /** Manual refresh: ignores the 24 h age and the backoff. Never throws. */
  refresh(): Promise<CatalogStatus>
  /**
   * Hear `catalog.updated` (F-28 section 7): called after a refresh replaced
   * the cache and some provider's content hash differs from the cache's
   * (every provider, when the cache was empty). Never after a 304, an
   * identical document, or a failed refresh. A listener that throws is
   * ignored. Returns the unsubscribe.
   */
  onUpdated(listener: (event: CatalogUpdated) => void): () => void
}

/** `catalog.updated`: the providers whose records changed, sorted. */
export type CatalogUpdated = { providerKeys: string[] }

export type ModelCatalogDeps = {
  store: CatalogStore
  snapshot: CatalogReader
  http: CatalogHttp
  now: () => number
  /** The hidden `catalog.sourceUrl` setting; absent = the default. */
  sourceUrl?: () => string | undefined | Promise<string | undefined>
  /** Injectable for tests; defaults to JSON.parse. */
  parse?: (text: string) => unknown
}

type Pick = { reader: CatalogReader; index: CatalogIndex; kind: 'cache' | 'snapshot' }

export function createModelCatalog(deps: ModelCatalogDeps): ModelCatalog {
  let inFlight: Promise<void> | undefined
  let failures = 0
  let nextAttemptAt = 0
  let lastError: string | undefined
  /** Set when this service wrote the cache (fetch or 304). */
  let wroteThisRun = false
  const listeners = new Set<(event: CatalogUpdated) => void>()
  function publishUpdated(providerKeys: string[]): void {
    if (providerKeys.length === 0) return
    const event: CatalogUpdated = { providerKeys: [...providerKeys].sort() }
    for (const listener of [...listeners]) {
      try {
        listener({ providerKeys: [...event.providerKeys] })
      } catch {
        // A listener's failure is its own.
      }
    }
  }

  /** Readers in preference order: the newer generatedAt first; cache on a tie. */
  async function ordered(): Promise<{ picks: Pick[]; cacheIndex?: CatalogIndex }> {
    const [cacheIndex, snapIndex] = await Promise.all([
      deps.store.readIndex(),
      deps.snapshot.readIndex(),
    ])
    const picks: Pick[] = []
    if (cacheIndex) picks.push({ reader: deps.store, index: cacheIndex, kind: 'cache' })
    if (snapIndex) picks.push({ reader: deps.snapshot, index: snapIndex, kind: 'snapshot' })
    picks.sort((a, b) =>
      b.index.generatedAt - a.index.generatedAt || (a.kind === 'cache' ? -1 : 1),
    )
    return { picks, cacheIndex }
  }

  /**
   * When the best data was current: the cache's fetchedAt, the snapshot's
   * generatedAt. A partial source (the bundle snapshot) does not count for a
   * provider it does not hold: its age says nothing about that provider.
   */
  function freshAt(picks: Pick[], providerKey?: string): number | undefined {
    let at: number | undefined
    for (const p of picks) {
      if (p.index.partial && providerKey !== undefined && !(providerKey in p.index.providers)) {
        continue
      }
      const t = p.kind === 'cache' ? p.index.fetchedAt : p.index.generatedAt
      if (t !== undefined && (at === undefined || t > at)) at = t
    }
    return at
  }

  function maybeRefresh(picks: Pick[], providerKey?: string): void {
    if (inFlight) return
    const at = freshAt(picks, providerKey)
    const age = at === undefined ? Infinity : deps.now() - at
    if (age <= CATALOG_TTL_MS) return
    if (deps.now() < nextAttemptAt) return
    void startRefresh()
  }

  function startRefresh(): Promise<void> {
    if (inFlight) return inFlight
    const run = runRefresh()
      .catch(() => {})
      .finally(() => {
        inFlight = undefined
      })
    inFlight = run
    return run
  }

  /** Listed providers whose cache file is missing or unreadable. */
  async function unreadableProviders(index: CatalogIndex): Promise<Set<string>> {
    // Held copies would hide a file removed since it was read: read the disk.
    deps.store.release()
    const out = new Set<string>()
    for (const key of Object.keys(index.providers)) {
      if (!(await deps.store.readProvider(key))) out.add(key)
    }
    return out
  }

  async function runRefresh(): Promise<void> {
    let updated: string[] = []
    try {
      const cached = await deps.store.readIndex()
      const url = (await deps.sourceUrl?.()) || DEFAULT_SOURCE_URL
      const broken = cached ? await unreadableProviders(cached) : new Set<string>()
      const result = await fetchSlimmed({
        http: deps.http,
        url,
        // A cache with a damaged provider file cannot be confirmed by a 304:
        // ask for the whole document so the file can be written again.
        etag: broken.size > 0 ? undefined : cached?.etag,
        cachedModelCount: cached?.modelCount ?? 0,
        parse: deps.parse,
      })
      const now = deps.now()
      if (result.kind === 'not-modified') {
        if (!cached) throw new Error('catalog source answered 304 without a cache')
        await deps.store.writeIndex({ ...cached, fetchedAt: now })
      } else {
        const hashes: Record<string, string> = {}
        const changed: Record<string, CatalogProviderRecords> = {}
        for (const [key, records] of Object.entries(result.providers)) {
          const h = hashText(JSON.stringify(records))
          hashes[key] = h
          if (cached?.providers[key] !== h || broken.has(key)) changed[key] = records
        }
        const gone = Object.keys(cached?.providers ?? {}).filter(k => !(k in hashes))
        const index: CatalogIndex = {
          version: 1,
          ...(result.etag ? { etag: result.etag } : {}),
          fetchedAt: now,
          generatedAt: now,
          contentHash: hashText(
            Object.keys(hashes).sort().map(k => `${k}:${hashes[k]}`).join('|'),
          ),
          providers: hashes,
          modelCount: result.modelCount,
        }
        await deps.store.write(index, changed, buildIdIndex(result.providers), gone)
        updated = [...Object.keys(changed), ...gone]
      }
      wroteThisRun = true
      failures = 0
      nextAttemptAt = 0
      lastError = undefined
      publishUpdated(updated)
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e)
      nextAttemptAt =
        deps.now() + CATALOG_BACKOFF_MS[Math.min(failures, CATALOG_BACKOFF_MS.length - 1)]
      failures++
    }
  }

  async function provider(
    providerKey: string,
    opts?: { passive?: boolean },
  ): Promise<CatalogProviderRecords | undefined> {
    const passive = opts?.passive === true
    try {
      const { picks } = await ordered()
      if (!passive) maybeRefresh(picks, providerKey)
      for (const p of picks) {
        if (!(providerKey in p.index.providers)) continue
        const records = await p.reader.readProvider(providerKey)
        if (records) return records
      }
      return undefined
    } finally {
      if (passive) {
        deps.store.release()
        deps.snapshot.release()
      }
    }
  }

  return {
    provider,
    async lookup(providerKey, modelId, opts) {
      const records = await provider(providerKey)
      if (records) {
        if (Object.prototype.hasOwnProperty.call(records, modelId)) {
          return { ...records[modelId], match: 'exact' }
        }
        const same = findNormalized(records, normalizeModelId(modelId))
        if (same !== undefined) return { ...records[same], match: 'normalized' }
      }
      if (!opts?.alsoTry) return undefined
      return borrow(providerKey, modelId, opts.alsoTry)
    },
    status,
    onUpdated(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    async refresh() {
      await startRefresh()
      return status()
    },
  }

  async function borrow(
    providerKey: string,
    modelId: string,
    alsoTry: readonly string[],
  ): Promise<CatalogHit | undefined> {
    const norm = normalizeModelId(modelId)
    if (norm.length === 0) return undefined
    const { picks } = await ordered()
    for (const pick of picks) {
      const keys = ((await pick.reader.readIdIndex())?.ids ?? {})[norm]
      if (!Array.isArray(keys)) continue
      const candidates = keys.filter(
        k => k !== providerKey && k in pick.index.providers,
      )
      const first = alsoTry.filter(k => candidates.includes(k))
      const rest = candidates.filter(k => !first.includes(k))
      const order = [...first, ...rest]
      let best: { from: string; model: CatalogModel; fields: number } | undefined
      for (let i = 0; i < order.length && i < MAX_BORROW_READS; i++) {
        const from = order[i]
        const recs = await pick.reader.readProvider(from)
        const id = recs ? findNormalized(recs, norm) : undefined
        if (!recs || id === undefined) continue
        const model = recs[id]
        // An alsoTry provider wins by its place in the list: take it at once.
        if (first.includes(from)) {
          best = { from, model, fields: 0 }
          break
        }
        const fields = Object.keys(model).length
        if (!best || fields > best.fields) best = { from, model, fields }
      }
      if (best) {
        // Model facts only: price and status belong to the provider that sells it.
        const { cost: _c, free: _f, status: _s, ...facts } = best.model
        return { ...facts, match: 'borrowed', from: best.from }
      }
    }
    return undefined
  }

  async function status(): Promise<CatalogStatus> {
    const { picks } = await ordered()
    const top = picks[0]
    const st: CatalogStatus = {
      source: !top ? 'none' : top.kind === 'snapshot' ? 'snapshot' : wroteThisRun ? 'live' : 'cache',
      models: top?.index.modelCount ?? 0,
    }
    if (top) {
      st.generatedAt = top.index.generatedAt
      if (top.kind === 'cache' && top.index.fetchedAt !== undefined) {
        st.fetchedAt = top.index.fetchedAt
      }
    }
    if (lastError) st.lastError = lastError
    return st
  }
}
