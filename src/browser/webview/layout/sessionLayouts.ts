/**
 * The in-memory per-session pane records (F-9), seeded from the layout blob
 * once at boot so a session switch reads nothing. A change writes only the
 * record or weight it touched into the blob as stored, so two windows sharing
 * the storage keep each other's records; another window's write refreshes the
 * snapshot through the `storage` event. Records past the cap go least recently
 * used first; a deleted session's record goes with it.
 */
import { useSyncExternalStore } from 'react'

import { LAYOUT_STORAGE_KEY, loadLayoutStorage, updateLayoutStorage } from './layoutStorage'
import { SESSION_RECORD_CAP, trimSessionRecords } from './layoutSanitize'
import {
  defaultSessionPaneRecord,
  sessionPaneRecordEquals,
  type PaneWeightByKind,
  type SessionPaneRecord,
  type SidePaneKind,
} from './paneLayout'

export interface SessionLayoutsSnapshot {
  records: ReadonlyMap<string, SessionPaneRecord>
  weights: PaneWeightByKind
}

export interface SessionLayoutsStore {
  getSnapshot(): SessionLayoutsSnapshot
  subscribe(listener: () => void): () => void
  /** The session's record, or the default when it has none (nothing is written). */
  get(sessionId: string): SessionPaneRecord
  /** Replace the session's record; `usedAt` is stamped now. Same record → nothing. */
  put(sessionId: string, record: SessionPaneRecord): void
  /** Stamp the session as just shown. */
  touch(sessionId: string): void
  /** Forget deleted sessions. */
  remove(sessionIds: Iterable<string>): void
  setWeight(kind: SidePaneKind, weight: number): void
  /** Stop following the storage; for tests and teardown. */
  dispose(): void
}

export function createSessionLayoutsStore(now: () => number = Date.now): SessionLayoutsStore {
  const seed = loadLayoutStorage()
  let snapshot: SessionLayoutsSnapshot = {
    records: new Map(Object.entries(seed.sessions)),
    weights: seed.paneWeightByKind,
  }
  const listeners = new Set<() => void>()

  const publish = (next: SessionLayoutsSnapshot): void => {
    snapshot = next
    for (const listener of [...listeners]) listener()
  }

  /** Merge one record into the blob as it is now; the cap trims the merged map. */
  const writeRecord = (sessionId: string, record: SessionPaneRecord): void => {
    const stored = updateLayoutStorage(prev => {
      const entries: [string, SessionPaneRecord][] = Object.entries(prev.sessions).filter(
        ([id]) => id !== sessionId,
      )
      entries.push([sessionId, record])
      return { ...prev, sessions: Object.fromEntries(trimSessionRecords(entries, SESSION_RECORD_CAP)) }
    })
    publish({ ...snapshot, records: new Map(Object.entries(stored.sessions)) })
  }

  // Another window's write: take its blob as the snapshot.
  const onStorage = (event: StorageEvent): void => {
    if (event.key !== null && event.key !== LAYOUT_STORAGE_KEY) return
    const blob = loadLayoutStorage()
    publish({ records: new Map(Object.entries(blob.sessions)), weights: blob.paneWeightByKind })
  }
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('storage', onStorage)
  }

  return {
    getSnapshot: () => snapshot,
    subscribe: listener => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    get: sessionId => snapshot.records.get(sessionId) ?? defaultSessionPaneRecord(),
    put: (sessionId, record) => {
      const prev = snapshot.records.get(sessionId)
      const stamped = { ...record, usedAt: now() }
      if (prev && sessionPaneRecordEquals({ ...prev, usedAt: stamped.usedAt }, stamped)) return
      writeRecord(sessionId, stamped)
    },
    touch: sessionId => {
      const prev = snapshot.records.get(sessionId)
      if (!prev) return
      writeRecord(sessionId, { ...prev, usedAt: now() })
    },
    remove: sessionIds => {
      const doomed = new Set(sessionIds)
      if (doomed.size === 0) return
      let changed = [...doomed].some(id => snapshot.records.has(id))
      const stored = updateLayoutStorage(prev => {
        if (![...doomed].some(id => id in prev.sessions)) return prev
        changed = true
        const sessions = { ...prev.sessions }
        for (const id of doomed) delete sessions[id]
        return { ...prev, sessions }
      })
      if (changed) publish({ ...snapshot, records: new Map(Object.entries(stored.sessions)) })
    },
    setWeight: (kind, weight) => {
      if (!Number.isFinite(weight) || weight <= 0) return
      const rounded = Math.round(weight * 10_000) / 10_000
      if (snapshot.weights[kind] === rounded) return
      const stored = updateLayoutStorage(prev =>
        prev.paneWeightByKind[kind] === rounded
          ? prev
          : { ...prev, paneWeightByKind: { ...prev.paneWeightByKind, [kind]: rounded } },
      )
      publish({ ...snapshot, weights: stored.paneWeightByKind })
    },
    dispose: () => {
      if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
        window.removeEventListener('storage', onStorage)
      }
      listeners.clear()
    },
  }
}

/** The store's current snapshot, re-rendering on every commit. */
export function useSessionLayouts(store: SessionLayoutsStore): SessionLayoutsSnapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}
