/**
 * The page's read of `chapters/<sessionId>` (F-37): the latest list of one session's chapter marks, and
 * the `chapters.*` actions bound to that session. One store per (connection, session), released by the
 * last listener, so every reader of a session shares one subscription.
 */
import * as React from 'react'

import type { RuntimeConnection } from '../runtimeClient/RuntimeConnection'
import { chapterMarksFromStorage, type ChapterMark } from '../../sessions/chapterMarks'
import { chaptersTopic, type ChaptersState } from '../../sessions/chapterProtocol'
import type { ChapterTarget } from './chapterAnchors'

type Listener = (marks: readonly ChapterMark[]) => void

type Store = {
  marks: readonly ChapterMark[] | null
  listeners: Set<Listener>
  unsubscribe: (() => void) | null
}

const stores = new WeakMap<Pick<RuntimeConnection, 'subscribe'>, Map<string, Store>>()

/** The published state's marks, or null for a payload of another shape. */
export function chaptersOfPayload(payload: unknown, sessionId: string): ChapterMark[] | null {
  if (typeof payload !== 'object' || payload === null) return null
  const state = payload as Partial<ChaptersState>
  if (state.sessionId !== sessionId || !Array.isArray(state.marks)) return null
  return chapterMarksFromStorage(state.marks)
}

function storeFor(connection: Pick<RuntimeConnection, 'subscribe'>, sessionId: string): Store {
  let bySession = stores.get(connection)
  if (!bySession) {
    bySession = new Map()
    stores.set(connection, bySession)
  }
  let store = bySession.get(sessionId)
  if (!store) {
    store = { marks: null, listeners: new Set(), unsubscribe: null }
    bySession.set(sessionId, store)
  }
  return store
}

export function holdChaptersView(
  connection: Pick<RuntimeConnection, 'subscribe'>,
  sessionId: string,
  listener: Listener,
): () => void {
  const store = storeFor(connection, sessionId)
  store.listeners.add(listener)
  if (store.unsubscribe === null) {
    store.unsubscribe = connection.subscribe<unknown>(chaptersTopic(sessionId), event => {
      const marks = chaptersOfPayload(event.payload, sessionId)
      if (marks === null) return
      store.marks = marks
      for (const each of Array.from(store.listeners)) each(marks)
    })
  } else if (store.marks !== null) {
    listener(store.marks)
  }
  return () => {
    store.listeners.delete(listener)
    if (store.listeners.size === 0 && store.unsubscribe) {
      store.unsubscribe()
      store.unsubscribe = null
      store.marks = null
    }
  }
}

export type SessionChaptersValue = {
  marks: readonly ChapterMark[]
  /** Absent when this thread may not change marks (read-only, or no `chapters.mark` grant). */
  mark?: (target: ChapterTarget) => Promise<void>
  unmark?: (markId: string) => Promise<void>
}

export const NO_SESSION_CHAPTERS: SessionChaptersValue = { marks: [] }

export function chaptersActions(
  connection: Pick<RuntimeConnection, 'request'>,
  sessionId: string,
): Required<Pick<SessionChaptersValue, 'mark' | 'unmark'>> {
  return {
    mark: async target => {
      await connection.request('chapters.mark', {
        sessionId,
        entryKey: target.entryKey,
        ...(target.segmentKey !== undefined ? { segmentKey: target.segmentKey } : {}),
      })
    },
    unmark: async markId => {
      await connection.request('chapters.unmark', { sessionId, markId })
    },
  }
}

/** One session's chapter marks for its thread; `canMark` false leaves out the actions. */
export function useSessionChapters(
  runtimeConnection: (() => Promise<RuntimeConnection>) | undefined,
  sessionId: string | undefined,
  canMark: boolean,
): SessionChaptersValue {
  const [held, setHeld] = React.useState<{
    sessionId: string
    marks: readonly ChapterMark[]
    actions: ReturnType<typeof chaptersActions>
  } | null>(null)
  React.useEffect(() => {
    if (!runtimeConnection || !sessionId) {
      setHeld(null)
      return
    }
    let live = true
    let release: (() => void) | null = null
    void runtimeConnection().then(
      conn => {
        if (!live) return
        const actions = chaptersActions(conn, sessionId)
        release = holdChaptersView(conn, sessionId, marks => {
          if (live) setHeld({ sessionId, marks, actions })
        })
      },
      () => {
        // No connection: no marks to read.
      },
    )
    return () => {
      live = false
      release?.()
    }
  }, [runtimeConnection, sessionId])
  return React.useMemo(() => {
    if (held === null || held.sessionId !== sessionId) return NO_SESSION_CHAPTERS
    return canMark ? { marks: held.marks, ...held.actions } : { marks: held.marks }
  }, [held, sessionId, canMark])
}
