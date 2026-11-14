/**
 * The page's read of `turn/<sessionId>` (F-41): the latest whole turn state
 * of one session. One store per (connection, session), released by the last
 * listener, so every reader of a session shares one subscription.
 */
import * as React from 'react'

import type { RuntimeConnection } from '../runtimeClient/RuntimeConnection'
import { turnStateOfPayload, turnTopic, type TurnTopicState } from '../../sessions/turnProtocol'
import { NO_TURN_BOARD, type TurnBoardValue } from '../../components/assistant-ui/turn-board-context'

type Listener = (state: TurnTopicState) => void

type Store = {
  state: TurnTopicState | null
  listeners: Set<Listener>
  unsubscribe: (() => void) | null
}

const stores = new WeakMap<Pick<RuntimeConnection, 'subscribe'>, Map<string, Store>>()

function storeFor(connection: Pick<RuntimeConnection, 'subscribe'>, sessionId: string): Store {
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
  return store
}

export function holdTurnBoardView(
  connection: Pick<RuntimeConnection, 'subscribe'>,
  sessionId: string,
  listener: Listener,
): () => void {
  const store = storeFor(connection, sessionId)
  store.listeners.add(listener)
  if (store.unsubscribe === null) {
    store.unsubscribe = connection.subscribe<unknown>(turnTopic(sessionId), event => {
      const state = turnStateOfPayload(event.payload, sessionId)
      if (state === null) return
      store.state = state
      for (const each of Array.from(store.listeners)) each(state)
    })
  } else if (store.state !== null) {
    listener(store.state)
  }
  return () => {
    store.listeners.delete(listener)
    if (store.listeners.size === 0 && store.unsubscribe) {
      store.unsubscribe()
      store.unsubscribe = null
      store.state = null
    }
  }
}

/** One session's turn board for its thread. */
export function useSessionTurnBoard(
  runtimeConnection: (() => Promise<RuntimeConnection>) | undefined,
  sessionId: string | undefined,
  canReply: boolean,
): TurnBoardValue {
  const [held, setHeld] = React.useState<TurnTopicState | null>(null)
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
        release = holdTurnBoardView(conn, sessionId, state => {
          if (live) setHeld(state)
        })
      },
      () => {
        // No connection: no board to read.
      },
    )
    return () => {
      live = false
      release?.()
    }
  }, [runtimeConnection, sessionId])
  return React.useMemo(() => {
    if (held === null || held.sessionId !== sessionId) return NO_TURN_BOARD
    return { state: held, canReply }
  }, [held, sessionId, canReply])
}
