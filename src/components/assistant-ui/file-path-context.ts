import { createContext, useContext } from 'react'

import { rememberBounded } from './boundedUiMemory'

/**
 * Existence probing for auto-detected transcript file paths: requests in one tick share
 * one `fs.statBatch`, and answers (negative too) are cached, bounded, for the page.
 * A probe answers `true` only for an existing FILE; directories resolve false.
 */

export type FilePathStat = { path: string; isFile: boolean }

export type FilePathProbe = {
  /** Cached answer, or undefined when this path hasn't been resolved yet. */
  peek(absolutePath: string): boolean | undefined
  /** Ask the host (batched + cached). */
  check(absolutePath: string): Promise<boolean>
}

/** Paths per bridge round-trip. */
export const FILE_PROBE_BATCH_MAX = 64
/** How long requests accumulate before a batch is sent. One frame-ish: long
 *  enough to collect a whole message's paths, short enough to feel immediate. */
export const FILE_PROBE_BATCH_MS = 40
/** Cached answers retained (page lifetime). */
export const FILE_PROBE_CACHE_MAX = 2048
/** After a BRIDGE failure (the whole call failing, not a "doesn't exist" answer), how
 *  long new probes short-circuit to `false` without asking the host. The failure is
 *  transient, so the paths are deliberately NOT negative-cached. */
export const FILE_PROBE_FAILURE_BACKOFF_MS = 30_000

export function createFilePathProbe(
  statPaths: (paths: string[]) => Promise<readonly FilePathStat[]>,
  options?: {
    batchMs?: number
    batchMax?: number
    cacheMax?: number
    failureBackoffMs?: number
  },
): FilePathProbe {
  const batchMs = options?.batchMs ?? FILE_PROBE_BATCH_MS
  const batchMax = options?.batchMax ?? FILE_PROBE_BATCH_MAX
  const cacheMax = options?.cacheMax ?? FILE_PROBE_CACHE_MAX
  const failureBackoffMs =
    options?.failureBackoffMs ?? FILE_PROBE_FAILURE_BACKOFF_MS
  /** While `Date.now()` is before this, checks resolve false WITHOUT caching
   *  or touching the bridge. */
  let failureBackoffUntil = 0

  const cache = new Map<string, boolean>()
  const inFlight = new Map<string, Promise<boolean>>()
  let queued: string[] = []
  let resolvers = new Map<string, (value: boolean) => void>()
  let timer: ReturnType<typeof setTimeout> | null = null

  const flush = (): void => {
    timer = null
    const paths = queued.slice(0, batchMax)
    const overflow = queued.slice(batchMax)
    queued = overflow
    const pending = resolvers
    resolvers = new Map()
    // Anything past the batch cap keeps its resolver and rides the next flush.
    const carried = new Map<string, (value: boolean) => void>()
    for (const path of overflow) {
      const resolve = pending.get(path)
      if (resolve) {
        carried.set(path, resolve)
        pending.delete(path)
      }
    }
    for (const [path, resolve] of carried) resolvers.set(path, resolve)
    if (overflow.length > 0) schedule()
    if (paths.length === 0) return

    const settle = (path: string, isFile: boolean, cacheable: boolean): void => {
      if (cacheable) rememberBounded(cache, path, isFile, cacheMax)
      inFlight.delete(path)
      pending.get(path)?.(isFile)
    }
    void statPaths(paths)
      .then((stats) => {
        const byPath = new Map(stats.map((s) => [s.path, s.isFile]))
        for (const path of paths) settle(path, byPath.get(path) === true, true)
      })
      .catch(() => {
        // Bridge FAILURE is not evidence of absence — resolve the waiters
        // false but leave them UNCACHED, so a later mention retries once the
        // backoff clears. The backoff (not the cache) is what keeps a broken
        // host from being re-probed in a loop.
        failureBackoffUntil = Date.now() + failureBackoffMs
        for (const path of paths) settle(path, false, false)
      })
  }

  const schedule = (): void => {
    if (timer !== null) return
    timer = setTimeout(flush, batchMs)
  }

  return {
    peek: (path) => cache.get(path),
    check: (path) => {
      const cached = cache.get(path)
      if (cached !== undefined) return Promise.resolve(cached)
      if (Date.now() < failureBackoffUntil) return Promise.resolve(false)
      const existing = inFlight.get(path)
      if (existing) return existing
      const promise = new Promise<boolean>((resolve) => {
        resolvers.set(path, resolve)
      })
      inFlight.set(path, promise)
      queued.push(path)
      schedule()
      return promise
    },
  }
}

export type FilePathContextValue = {
  /** Session project root — the ONE base a relative path is resolved against. */
  projectRoot?: string
  probe?: FilePathProbe
}

export const FilePathContext = createContext<FilePathContextValue>({})

export function useFilePathContext(): FilePathContextValue {
  return useContext(FilePathContext)
}
