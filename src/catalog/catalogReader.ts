/**
 * Lazy reader shared by the local cache and the bundle snapshot: both are an
 * `index.json` plus one `providers/<key>.json` per provider. A lookup loads
 * only the provider file it needs and keeps it for an idle time, then lets go.
 */
import type { CatalogIdIndex, CatalogIndex, CatalogProviderRecords } from './types'

export type CatalogTimers = {
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
}

export const systemTimers: CatalogTimers = {
  set(fn, ms) {
    const h = setTimeout(fn, ms) as unknown as { unref?: () => void }
    h.unref?.()
    return h
  },
  clear(h) {
    clearTimeout(h as ReturnType<typeof setTimeout>)
  },
}

export const IDLE_RELEASE_MS = 60_000

/** Provider keys become file names: refuse anything path-like. */
export function isSafeProviderKey(key: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(key) && !key.includes('..')
}

export function providerRelPath(key: string): string {
  return `providers/${key}.json`
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function parseIndex(text: string): CatalogIndex | undefined {
  try {
    const v: unknown = JSON.parse(text)
    if (!isObj(v) || v.version !== 1 || !isObj(v.providers)) return undefined
    if (typeof v.generatedAt !== 'number' || typeof v.contentHash !== 'string') return undefined
    if (typeof v.modelCount !== 'number') return undefined
    return v as unknown as CatalogIndex
  } catch {
    return undefined
  }
}

function parseIdIndex(text: string): CatalogIdIndex | undefined {
  try {
    const v: unknown = JSON.parse(text)
    if (!isObj(v) || v.version !== 1 || !isObj(v.ids)) return undefined
    return v as unknown as CatalogIdIndex
  } catch {
    return undefined
  }
}

function parseProvider(text: string): CatalogProviderRecords | undefined {
  try {
    const v: unknown = JSON.parse(text)
    if (!isObj(v)) return undefined
    for (const m of Object.values(v)) {
      if (!isObj(m) || typeof m.name !== 'string' || !Array.isArray(m.inputModalities)) {
        return undefined
      }
    }
    return v as CatalogProviderRecords
  } catch {
    return undefined
  }
}

export type CatalogReader = {
  /** Undefined when absent or corrupted. */
  readIndex(): Promise<CatalogIndex | undefined>
  /** Undefined when the provider is unknown, absent or corrupted. */
  readProvider(key: string): Promise<CatalogProviderRecords | undefined>
  /** The normalized-id index; undefined when absent or corrupted. */
  readIdIndex(): Promise<CatalogIdIndex | undefined>
  /** Drop everything held now (after the files changed). */
  release(): void
}

export function createCatalogReader(
  readText: (relPath: string) => Promise<string | undefined>,
  opts: { timers?: CatalogTimers; idleMs?: number } = {},
): CatalogReader {
  const timers = opts.timers ?? systemTimers
  const idleMs = opts.idleMs ?? IDLE_RELEASE_MS
  type Held = { value: Promise<unknown>; timer: unknown }
  const held = new Map<string, Held>()

  function drop(name: string): void {
    const h = held.get(name)
    if (!h) return
    timers.clear(h.timer)
    held.delete(name)
  }

  function load<T>(
    name: string,
    relPath: string,
    parse: (text: string) => T | undefined,
  ): Promise<T | undefined> {
    const existing = held.get(name)
    if (existing) {
      timers.clear(existing.timer)
      existing.timer = timers.set(() => drop(name), idleMs)
      return existing.value as Promise<T | undefined>
    }
    const value = readText(relPath)
      .then(text => (text === undefined ? undefined : parse(text)))
      .catch(() => undefined)
    const entry: Held = { value, timer: undefined }
    entry.timer = timers.set(() => drop(name), idleMs)
    held.set(name, entry)
    return value
  }

  return {
    readIndex: () => load('index', 'index.json', parseIndex),
    readIdIndex: () => load('ids', 'ids.json', parseIdIndex),
    readProvider(key) {
      if (!isSafeProviderKey(key)) return Promise.resolve(undefined)
      return load(`p:${key}`, providerRelPath(key), parseProvider)
    },
    release() {
      for (const name of [...held.keys()]) drop(name)
    },
  }
}
