/**
 * The in-memory per-session pane records (F-9), seeded from the layout blob
 * once at boot so a session switch reads nothing. Every change goes to the
 * blob through the coalesced writer; records past the cap are dropped least
 * recently used first, and a deleted session's record goes with it.
 */
import { useSyncExternalStore } from 'react'

import { loadLayoutStorage, updateLayoutStorage } from './layoutStorage'
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
}

export function createSessionLayoutsStore(now: () => number = Date.now): SessionLayoutsStore {
  const seed = loadLayoutStorage()
  let snapshot: SessionLayoutsSnapshot = {
    records: new Map(Object.entries(seed.sessions)),
    weights: seed.paneWeightByKind,
  }
  const listeners = new Set<() => void>()

  const commit = (next: SessionLayoutsSnapshot): void => {
    snapshot = next
    updateLayoutStorage(prev => ({
      ...prev,
      paneWeightByKind: next.weights,
      sessions: Object.fromEntries(next.records),
    }))
    for (const listener of [...listeners]) listener()
  }

  const withRecord = (sessionId: string, record: SessionPaneRecord): void => {
    const entries: [string, SessionPaneRecord][] = [...snapshot.records].filter(([id]) => id !== sessionId)
    entries.push([sessionId, record])
    commit({ ...snapshot, records: new Map(trimSessionRecords(entries, SESSION_RECORD_CAP)) })
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
      withRecord(sessionId, stamped)
    },
    touch: sessionId => {
      const prev = snapshot.records.get(sessionId)
      if (!prev) return
      withRecord(sessionId, { ...prev, usedAt: now() })
    },
    remove: sessionIds => {
      const doomed = new Set(sessionIds)
      if (![...doomed].some(id => snapshot.records.has(id))) return
      const records = new Map(snapshot.records)
      for (const id of doomed) records.delete(id)
      commit({ ...snapshot, records })
    },
    setWeight: (kind, weight) => {
      if (!Number.isFinite(weight) || weight <= 0) return
      const rounded = Math.round(weight * 10_000) / 10_000
      if (snapshot.weights[kind] === rounded) return
      commit({ ...snapshot, weights: { ...snapshot.weights, [kind]: rounded } })
    },
  }
}

/** The store's current snapshot, re-rendering on every commit. */
export function useSessionLayouts(store: SessionLayoutsStore): SessionLayoutsSnapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}
