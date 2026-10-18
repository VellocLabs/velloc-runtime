/**
 * Hooks over the runtime's `terminals` topic and the viewer's terminal prefs
 * (F-31). Small and xterm-free, so the shell and the topbar can read whether
 * terminals are available without loading the emulator chunk.
 */
import { useEffect, useState, useSyncExternalStore } from 'react'

import type { RuntimeConnection } from '@/browser/runtimeClient/RuntimeConnection'
import { topic } from '@/browser/runtimeProtocol'
import { TERMINAL_CAPABILITY, type TerminalsState } from '@/terminal/protocol'

import { loadTerminalPrefs, subscribeTerminalPrefs, type TerminalPrefs } from './terminalPrefs'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

/** Whether `value` has the topic's shape; the rows' own shapes are trusted. */
export function isTerminalsState(value: unknown): value is TerminalsState {
  return (
    isRecord(value) &&
    typeof value.available === 'boolean' &&
    Array.isArray(value.shells) &&
    Array.isArray(value.terminals)
  )
}

/** The connection once its promise settles; null before, and when there is none. */
export function useResolvedConnection(
  runtimeConnection: (() => Promise<RuntimeConnection>) | undefined,
): RuntimeConnection | null {
  const [conn, setConn] = useState<RuntimeConnection | null>(null)
  useEffect(() => {
    if (!runtimeConnection) {
      setConn(null)
      return
    }
    let live = true
    void runtimeConnection().then(
      resolved => {
        if (live) setConn(resolved)
      },
      () => {
        if (live) setConn(null)
      },
    )
    return () => {
      live = false
    }
  }, [runtimeConnection])
  return conn
}

type TerminalsStore = {
  get(): TerminalsState | null
  subscribe(listener: () => void): () => void
}

const stores = new WeakMap<RuntimeConnection, TerminalsStore>()

/**
 * One topic subscription per connection, shared by every reader: the
 * connection replays a snapshot only to the first subscriber of a topic, so
 * a reader that mounts later (the pane, after the topbar) takes the state
 * from here. The grant is known only once the welcome has landed, so the
 * subscription waits for it through the link state. The last reader leaving
 * releases the topic; the next one gets a fresh snapshot.
 */
function terminalsStoreFor(conn: RuntimeConnection): TerminalsStore {
  const existing = stores.get(conn)
  if (existing) return existing
  let state: TerminalsState | null = null
  const listeners = new Set<() => void>()
  let unsubscribeTopic: (() => void) | undefined
  let unwatch: (() => void) | undefined
  const attach = (): void => {
    if (unsubscribeTopic || !conn.can(TERMINAL_CAPABILITY, 'create')) return
    unsubscribeTopic = conn.subscribe(topic.terminals(), event => {
      if (!isTerminalsState(event.payload)) return
      state = event.payload
      for (const listener of listeners) listener()
    })
  }
  const store: TerminalsStore = {
    get: () => state,
    subscribe(listener) {
      listeners.add(listener)
      if (listeners.size === 1) {
        attach()
        unwatch = conn.watchLinkState(attach)
      }
      return () => {
        listeners.delete(listener)
        if (listeners.size > 0) return
        unwatch?.()
        unwatch = undefined
        unsubscribeTopic?.()
        unsubscribeTopic = undefined
        state = null
      }
    },
  }
  stores.set(conn, store)
  return store
}

const noStore: TerminalsStore = { get: () => null, subscribe: () => () => {} }

/**
 * The `terminals` topic's state: null until its snapshot lands, and null for
 * good on a connection without the `terminal` grant (the topic is `full`).
 */
export function useTerminalsState(conn: RuntimeConnection | null): TerminalsState | null {
  const store = conn ? terminalsStoreFor(conn) : noStore
  return useSyncExternalStore(store.subscribe, store.get, () => null)
}

export function useTerminalPrefs(): TerminalPrefs {
  return useSyncExternalStore(subscribeTerminalPrefs, loadTerminalPrefs, loadTerminalPrefs)
}
