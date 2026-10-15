/**
 * The page's ONE `remote/state` subscription per runtime connection (F-24): a
 * snapshot reaches only the first listener, so this store holds the latest payload
 * for every late consumer. Dropped with the last holder.
 */
import * as React from 'react'

import type { RuntimeConnection } from '../../runtimeClient/RuntimeConnection'
import type { RemoteAccessState } from '../../runtimeHub/remoteAccessDriver'
import type { RemoteState } from '../../runtimeHub/remoteCapability'

/** What the page reads of `remote/state`. */
export type RemoteAccessView = {
  access: RemoteAccessState
  pairings: RemoteState['pairings']
  /** One row per connected device (F-24). `[]` from a runtime that does not
   *  publish them, which is what makes the count the safe fallback. */
  connections: NonNullable<RemoteState['connections']>
}

type Listener = (view: RemoteAccessView) => void

type Store = {
  latest: RemoteAccessView | null
  listeners: Set<Listener>
  unsubscribe: (() => void) | null
}

const stores = new WeakMap<Pick<RuntimeConnection, 'subscribe'>, Store>()

/**
 * Hold `connection`'s store with `listener`. The listener hears the latest
 * view at once when there is one, then every publish. Returns the release.
 * Exported for the unit test; components use `useRemoteAccessView`.
 */
export function holdRemoteAccessView(
  connection: Pick<RuntimeConnection, 'subscribe'>,
  listener: Listener,
): () => void {
  let store = stores.get(connection)
  if (!store) {
    store = { latest: null, listeners: new Set(), unsubscribe: null }
    stores.set(connection, store)
  }
  const held = store
  held.listeners.add(listener)
  if (held.unsubscribe === null) {
    held.unsubscribe = connection.subscribe<RemoteState>('remote/state', event => {
      const payload = event.payload as Partial<RemoteState> | null
      if (!payload || typeof payload !== 'object' || !payload.access) return
      held.latest = {
        access: payload.access,
        pairings: payload.pairings ?? [],
        connections: payload.connections ?? [],
      }
      for (const each of Array.from(held.listeners)) each(held.latest)
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

/**
 * The latest `remote/state` view for the page's connection (null until the
 * first snapshot, and with no connection), plus the resolved connection for
 * the `remote.*` actions. `enabled: false` holds nothing — for a caller whose
 * connection may not read the topic at all.
 */
export function useRemoteAccessView(
  runtimeConnection: (() => Promise<RuntimeConnection>) | undefined,
  enabled = true,
): { view: RemoteAccessView | null; connection: RuntimeConnection | null } {
  const [view, setView] = React.useState<RemoteAccessView | null>(null)
  const [connection, setConnection] = React.useState<RuntimeConnection | null>(null)
  React.useEffect(() => {
    if (!runtimeConnection || !enabled) {
      setView(null)
      return
    }
    let live = true
    let release: (() => void) | null = null
    void runtimeConnection().then(
      conn => {
        if (!live) return
        setConnection(conn)
        release = holdRemoteAccessView(conn, next => {
          if (live) setView(next)
        })
      },
      () => {
        // No connection → no view. Every gate reading it fails closed.
      },
    )
    return () => {
      live = false
      release?.()
    }
  }, [runtimeConnection, enabled])
  return { view, connection }
}
