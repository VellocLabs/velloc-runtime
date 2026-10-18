/**
 * localStorage I/O for the layout blob (F-9): pane layouts per session, the
 * per-kind pane weights and the session card prefs, under one key. Writes are
 * read-modify-write of the whole blob, coalesced to one `setItem` per task;
 * `pagehide` flushes. Best-effort: storage may be missing, and every read is
 * sanitized.
 */
import {
  defaultLayoutStorage,
  sanitizeLayoutStorage,
  type NexusLayoutStorage,
} from './layoutSanitize'
import type { SessionCardPrefs } from './sessionCards'

export const LAYOUT_STORAGE_KEY = 'nexus.layout'
/** The key an earlier shape used; removed on the first read, its values are not carried. */
const RETIRED_LAYOUT_STORAGE_KEY = 'nexus.layout.v1'

let pending: NexusLayoutStorage | null = null
let flushQueued = false

function readStorage(): NexusLayoutStorage {
  try {
    const storage = globalThis.localStorage
    if (!storage) return defaultLayoutStorage()
    if (storage.getItem(RETIRED_LAYOUT_STORAGE_KEY) !== null) storage.removeItem(RETIRED_LAYOUT_STORAGE_KEY)
    const raw = storage.getItem(LAYOUT_STORAGE_KEY)
    if (raw == null) return defaultLayoutStorage()
    return sanitizeLayoutStorage(JSON.parse(raw))
  } catch {
    return defaultLayoutStorage()
  }
}

/** The blob as stored (a pending write counts), sanitized. */
export function loadLayoutStorage(): NexusLayoutStorage {
  return pending ?? readStorage()
}

/** Write the pending blob now; a no-op when nothing is pending. */
export function flushLayoutStorage(): void {
  const blob = pending
  pending = null
  flushQueued = false
  if (!blob) return
  try {
    globalThis.localStorage?.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(blob))
  } catch {
    // Storage may be unavailable or full; persistence is best-effort.
  }
}

/**
 * Apply `fn` to the blob. The first update in a task reads storage; later
 * ones in the same task build on the pending result, and one `setItem`
 * follows in a microtask. `fn` returning its input writes nothing.
 */
export function updateLayoutStorage(fn: (prev: NexusLayoutStorage) => NexusLayoutStorage): NexusLayoutStorage {
  const prev = pending ?? readStorage()
  const next = fn(prev)
  if (next === prev && pending === null) return prev
  pending = next
  if (!flushQueued) {
    flushQueued = true
    queueMicrotask(flushLayoutStorage)
  }
  return next
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('pagehide', flushLayoutStorage)
}

export function loadSessionCardPrefs(): SessionCardPrefs {
  return loadLayoutStorage().sessionCards
}

export function saveSessionCardPrefs(prefs: SessionCardPrefs): void {
  updateLayoutStorage(prev => (prev.sessionCards === prefs ? prev : { ...prev, sessionCards: prefs }))
}
