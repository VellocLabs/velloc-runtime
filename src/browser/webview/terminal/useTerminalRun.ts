/**
 * The `terminal-run/<runId>` topic as React state (F-31). One subscription per
 * connection and run, shared by every reader: the connection replays a
 * snapshot only to a topic's first subscriber. The last reader leaving
 * releases the topic; the next one gets a fresh snapshot.
 */
import { useSyncExternalStore } from 'react'

import type { RuntimeConnection } from '@/browser/runtimeClient/RuntimeConnection'
import { topic } from '@/browser/runtimeProtocol'
import type { TerminalRunState } from '@/terminal/protocol'

/** Whether `value` has the topic's shape. */
export function isTerminalRunState(value: unknown): value is TerminalRunState {
  if (typeof value !== 'object' || value === null) return false
  const run = value as Record<string, unknown>
  return (
    typeof run.terminalId === 'string' &&
    typeof run.command === 'string' &&
    (run.status === 'running' || run.status === 'done' || run.status === 'ended') &&
    typeof run.output === 'string' &&
    typeof run.truncated === 'boolean'
  )
}

type RunStore = {
  get(): TerminalRunState | null
  subscribe(listener: () => void): () => void
}

const stores = new WeakMap<RuntimeConnection, Map<string, RunStore>>()

function runStoreFor(conn: RuntimeConnection, runId: string): RunStore {
  let byRun = stores.get(conn)
  if (!byRun) {
    byRun = new Map()
    stores.set(conn, byRun)
  }
  const existing = byRun.get(runId)
  if (existing) return existing
  let state: TerminalRunState | null = null
  const listeners = new Set<() => void>()
  let unsubscribeTopic: (() => void) | undefined
  const runs = byRun
  const store: RunStore = {
    get: () => state,
    subscribe(listener) {
      listeners.add(listener)
      if (listeners.size === 1) {
        unsubscribeTopic = conn.subscribe(topic.terminalRun(runId), event => {
          if (!isTerminalRunState(event.payload)) return
          state = event.payload
          for (const notify of Array.from(listeners)) notify()
        })
      }
      return () => {
        listeners.delete(listener)
        if (listeners.size > 0) return
        unsubscribeTopic?.()
        unsubscribeTopic = undefined
        runs.delete(runId)
      }
    },
  }
  byRun.set(runId, store)
  return store
}

const noStore: RunStore = { get: () => null, subscribe: () => () => {} }

/** The run's state: null until its snapshot lands, and for good once the runtime no longer holds it. */
export function useTerminalRun(conn: RuntimeConnection | null, runId: string | null): TerminalRunState | null {
  const store = conn && runId ? runStoreFor(conn, runId) : noStore
  return useSyncExternalStore(store.subscribe, store.get, () => null)
}
