/**
 * The page's read of `plugins/updates` (F-14) and its way to ask
 * (`pluginUpdates.*`); one store per connection. The page never fetches or
 * installs a version itself (P-3). A refused ask rejects; the topic's last
 * state stands.
 */
import * as React from 'react'

import type { RuntimeConnection } from '../../runtimeClient/RuntimeConnection'
import type { RouteKey } from '../../runtimeProtocol'
import type { PluginUpdateStatus } from '../../../pluginHost/pluginUpdates'
import {
  PLUGIN_UPDATES_CAPABILITY,
  PLUGIN_UPDATES_TOPIC,
  type PluginUpdatesAction,
  type PluginUpdatesState,
} from '../../../pluginHost/pluginUpdatesProtocol'

type Listener = (state: PluginUpdatesState) => void
type Store = { latest: PluginUpdatesState | null; listeners: Set<Listener>; unsubscribe: (() => void) | null }

const stores = new WeakMap<Pick<RuntimeConnection, 'subscribe'>, Store>()

/** A payload from the topic that is the shape this page reads, or null. */
export function readPluginUpdatesState(value: unknown): PluginUpdatesState | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Partial<PluginUpdatesState>
  if (!Array.isArray(raw.plugins)) return null
  return {
    autoUpdate: raw.autoUpdate === true,
    checking: raw.checking === true,
    ...(typeof raw.lastCheckedAt === 'string' ? { lastCheckedAt: raw.lastCheckedAt } : {}),
    unreachable: Array.isArray(raw.unreachable)
      ? raw.unreachable.filter(entry => !!entry && typeof entry.marketplace === 'string')
      : [],
    plugins: raw.plugins.filter(
      (entry): entry is PluginUpdateStatus =>
        !!entry && typeof entry === 'object' && typeof entry.identifier === 'string' && typeof entry.state === 'string',
    ),
  }
}

export function holdPluginUpdates(connection: Pick<RuntimeConnection, 'subscribe'>, listener: Listener): () => void {
  let store = stores.get(connection)
  if (!store) {
    store = { latest: null, listeners: new Set(), unsubscribe: null }
    stores.set(connection, store)
  }
  const held = store
  held.listeners.add(listener)
  if (held.unsubscribe === null) {
    held.unsubscribe = connection.subscribe<unknown>(PLUGIN_UPDATES_TOPIC, event => {
      const next = readPluginUpdatesState(event.payload)
      if (!next) return
      held.latest = next
      for (const each of Array.from(held.listeners)) each(next)
    })
  } else if (held.latest) {
    listener(held.latest)
  }
  return () => {
    if (!held.listeners.delete(listener)) return
    if (held.listeners.size > 0) return
    held.unsubscribe?.()
    held.unsubscribe = null
    held.latest = null
  }
}

export type PluginUpdatesView = {
  /** Null until the topic answers. */
  state: PluginUpdatesState | null
  /** Status by plugin id (`<name>@<marketplace>`). */
  byPlugin: ReadonlyMap<string, PluginUpdateStatus>
  /** Ask the runtime. Resolves with the result; rejects when it refuses or fails. */
  ask: (action: PluginUpdatesAction, payload?: Record<string, unknown>) => Promise<unknown>
}

const NONE: ReadonlyMap<string, PluginUpdateStatus> = new Map()

export function usePluginUpdates(
  runtimeConnection: (() => Promise<RuntimeConnection>) | undefined,
  enabled = true,
): PluginUpdatesView {
  const [state, setState] = React.useState<PluginUpdatesState | null>(null)
  React.useEffect(() => {
    if (!runtimeConnection || !enabled) {
      setState(null)
      return
    }
    let live = true
    let release: (() => void) | null = null
    void runtimeConnection().then(
      conn => {
        if (!live) return
        release = holdPluginUpdates(conn, next => {
          if (live) setState(next)
        })
      },
      () => {
        // No connection: the page shows no update status.
      },
    )
    return () => {
      live = false
      release?.()
    }
  }, [runtimeConnection, enabled])
  const byPlugin = React.useMemo(
    () => (state ? new Map(state.plugins.map(entry => [entry.identifier, entry] as const)) : NONE),
    [state],
  )
  const ask = React.useCallback(
    async (action: PluginUpdatesAction, payload: Record<string, unknown> = {}): Promise<unknown> => {
      if (!runtimeConnection) throw new Error('no runtime connection')
      const conn = await runtimeConnection()
      return conn.request(`${PLUGIN_UPDATES_CAPABILITY}.${action}` as RouteKey, payload)
    },
    [runtimeConnection],
  )
  return { state, byPlugin, ask }
}
