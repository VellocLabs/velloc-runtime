/**
 * The page's copy of an app session's surfaces (F-40), from `mods/app/<sessionId>`.
 * One store per (connection, session), released by its last listener: a
 * second subscriber on one connection would get no snapshot, so readers share.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'

import type { RuntimeConnection } from '../../runtimeClient/RuntimeConnection'
import {
  isAppSurfaceState,
  modsAppTopic,
  type AppSurfaceState,
  type ModsBuildAppResult,
} from '../../runtimeProtocol/modApps'
import { useModContributions } from '../mods/modContributionsView'

type Listener = (state: AppSurfaceState | null) => void
type Store = { state: AppSurfaceState | null; listeners: Set<Listener>; unsubscribe: (() => void) | null }
type Subscriber = Pick<RuntimeConnection, 'subscribe'>

const stores = new WeakMap<Subscriber, Map<string, Store>>()

/** Holds the board of `sessionId`; `listener` hears the current board at once, then each change. */
export function holdAppSurface(connection: Subscriber, sessionId: string, listener: Listener): () => void {
  let bySession = stores.get(connection)
  if (!bySession) {
    bySession = new Map()
    stores.set(connection, bySession)
  }
  let store = bySession.get(sessionId)
  if (!store) {
    store = { state: null, listeners: new Set(), unsubscribe: null }
    bySession.set(sessionId, store)
  }
  const held = store
  held.listeners.add(listener)
  if (held.unsubscribe === null) {
    held.unsubscribe = connection.subscribe<unknown>(modsAppTopic(sessionId), event => {
      held.state = isAppSurfaceState(event.payload) ? event.payload : null
      for (const each of [...held.listeners]) each(held.state)
    })
  } else {
    listener(held.state)
  }
  return () => {
    held.listeners.delete(listener)
    if (held.listeners.size > 0) return
    held.unsubscribe?.()
    held.unsubscribe = null
    held.state = null
    bySession.delete(sessionId)
  }
}

/** The board of an app session; null while there is none, or when `enabled` is false. */
export function useAppSurface(
  runtimeConnection: (() => Promise<RuntimeConnection>) | undefined,
  sessionId: string | undefined,
  enabled: boolean,
): AppSurfaceState | null {
  const [held, setHeld] = useState<{ sessionId: string; state: AppSurfaceState | null } | null>(null)
  useEffect(() => {
    if (!enabled || !runtimeConnection || !sessionId) return
    let live = true
    let release: (() => void) | null = null
    void runtimeConnection().then(
      conn => {
        if (!live) return
        release = holdAppSurface(conn, sessionId, state => {
          if (live) setHeld({ sessionId, state })
        })
      },
      () => {
        // No connection: no board.
      },
    )
    return () => {
      live = false
      release?.()
    }
  }, [runtimeConnection, sessionId, enabled])
  return enabled && held !== null && held.sessionId === sessionId ? held.state : null
}

/** An app session as the page sees it: its latest state and a way to build it again. */
export type AppBoard = {
  state: AppSurfaceState | null
  /** `mods.buildApp`; undefined when there is no connection. */
  reload(): Promise<ModsBuildAppResult | undefined>
}

/**
 * The app of `sessionId` when its type is an app a plugin offers (its state
 * null while none has arrived); undefined for a session that is not an app's.
 */
export function useAppBoard(
  runtimeConnection: (() => Promise<RuntimeConnection>) | undefined,
  sessionId: string | undefined,
  templateType: string | undefined,
): AppBoard | undefined {
  const { apps } = useModContributions()
  const isApp = templateType !== undefined && (apps ?? []).some(app => app.type === templateType)
  const state = useAppSurface(runtimeConnection, sessionId, isApp)
  const reload = useCallback(async (): Promise<ModsBuildAppResult | undefined> => {
    if (!runtimeConnection || !sessionId) return undefined
    const connection = await runtimeConnection()
    return connection.request<ModsBuildAppResult>('mods.buildApp', { sessionId })
  }, [runtimeConnection, sessionId])
  const board = useMemo(() => ({ state, reload }), [state, reload])
  return isApp ? board : undefined
}
