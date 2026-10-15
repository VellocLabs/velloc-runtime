/**
 * The page's read of `plugins/providerUpdates` and its way to ask
 * (`providerUpdates.*`); one store per connection. The page never fetches, stages or
 * activates a version itself (P-3). A refused ask (no `full` grant) rejects; the
 * topic's last state stands.
 */
import * as React from 'react'

import type { RuntimeConnection } from '../../runtimeClient/RuntimeConnection'
import type { RouteKey } from '../../runtimeProtocol'
import type { ProviderModUpdateStatus } from '../../../pluginHost/providerModUpdates'
import {
  PROVIDER_UPDATES_CAPABILITY,
  PROVIDER_UPDATES_TOPIC,
  type ProviderUpdatesAction,
  type ProviderUpdatesState,
} from '../../../pluginHost/providerUpdatesProtocol'

type Listener = (state: ProviderUpdatesState) => void
type Store = { latest: ProviderUpdatesState | null; listeners: Set<Listener>; unsubscribe: (() => void) | null }

const stores = new WeakMap<Pick<RuntimeConnection, 'subscribe'>, Store>()

/** A payload from the topic that is the shape this page reads, or null. */
export function readProviderUpdatesState(value: unknown): ProviderUpdatesState | null {
  if (!value || typeof value !== 'object') return null
  const plugins = (value as { plugins?: unknown }).plugins
  if (!Array.isArray(plugins)) return null
  return {
    plugins: plugins.filter(
      (entry): entry is ProviderModUpdateStatus =>
        !!entry &&
        typeof entry === 'object' &&
        typeof (entry as ProviderModUpdateStatus).pluginId === 'string' &&
        typeof (entry as ProviderModUpdateStatus).state === 'string',
    ),
  }
}

export function holdProviderUpdates(connection: Pick<RuntimeConnection, 'subscribe'>, listener: Listener): () => void {
  let store = stores.get(connection)
  if (!store) {
    store = { latest: null, listeners: new Set(), unsubscribe: null }
    stores.set(connection, store)
  }
  const held = store
  held.listeners.add(listener)
  if (held.unsubscribe === null) {
    held.unsubscribe = connection.subscribe<unknown>(PROVIDER_UPDATES_TOPIC, event => {
      const next = readProviderUpdatesState(event.payload)
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

export type ProviderUpdatesView = {
  /** Status by plugin id (`<name>@<catalog>`); empty until the topic answers. */
  byPlugin: ReadonlyMap<string, ProviderModUpdateStatus>
  /** Ask the runtime. Resolves with the result; rejects when it refuses or fails. */
  ask: (action: ProviderUpdatesAction, payload?: Record<string, string>) => Promise<unknown>
}

const NONE: ReadonlyMap<string, ProviderModUpdateStatus> = new Map()

export function useProviderUpdates(
  runtimeConnection: (() => Promise<RuntimeConnection>) | undefined,
  enabled = true,
): ProviderUpdatesView {
  const [state, setState] = React.useState<ProviderUpdatesState | null>(null)
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
        release = holdProviderUpdates(conn, next => {
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
    () => (state ? new Map(state.plugins.map(entry => [entry.pluginId, entry] as const)) : NONE),
    [state],
  )
  const ask = React.useCallback(
    async (action: ProviderUpdatesAction, payload: Record<string, string> = {}): Promise<unknown> => {
      if (!runtimeConnection) throw new Error('no runtime connection')
      const conn = await runtimeConnection()
      return conn.request(`${PROVIDER_UPDATES_CAPABILITY}.${action}` as RouteKey, payload)
    },
    [runtimeConnection],
  )
  return { byPlugin, ask }
}
