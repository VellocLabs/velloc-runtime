/**
 * The page's read of `catalog/status` and its one way to ask (`catalog.refresh`).
 * One store per connection (the snapshot goes to the FIRST listener only). The page
 * never fetches model data and keeps nothing in client storage (P-3).
 */
import * as React from 'react'

import type { RuntimeConnection } from '../../runtimeClient/RuntimeConnection'
import type { RouteKey } from '../../runtimeProtocol'
import {
  CATALOG_CAPABILITY,
  CATALOG_STATUS_TOPIC,
  readCatalogStatusState,
  type CatalogStatusState,
} from '../../../catalog/catalogProtocol'

type Listener = (state: CatalogStatusState) => void
type Store = { latest: CatalogStatusState | null; listeners: Set<Listener>; unsubscribe: (() => void) | null }

const stores = new WeakMap<Pick<RuntimeConnection, 'subscribe'>, Store>()

export function holdCatalogStatus(connection: Pick<RuntimeConnection, 'subscribe'>, listener: Listener): () => void {
  let store = stores.get(connection)
  if (!store) {
    store = { latest: null, listeners: new Set(), unsubscribe: null }
    stores.set(connection, store)
  }
  const held = store
  held.listeners.add(listener)
  if (held.unsubscribe === null) {
    held.unsubscribe = connection.subscribe<unknown>(CATALOG_STATUS_TOPIC, event => {
      const next = readCatalogStatusState(event.payload)
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

export type CatalogStatusView = {
  /** Latest published state; null until the topic answers. */
  state: CatalogStatusState | null
  /** Ask the runtime to refresh now. Resolves with the new state; rejects when it refuses or fails. */
  refresh: () => Promise<CatalogStatusState>
}

export function useCatalogStatus(
  runtimeConnection: (() => Promise<RuntimeConnection>) | undefined,
  enabled = true,
): CatalogStatusView {
  const [state, setState] = React.useState<CatalogStatusState | null>(null)
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
        release = holdCatalogStatus(conn, next => {
          if (live) setState(next)
        })
      },
      () => {
        // No connection: the page shows no model data status.
      },
    )
    return () => {
      live = false
      release?.()
    }
  }, [runtimeConnection, enabled])
  const refresh = React.useCallback(async (): Promise<CatalogStatusState> => {
    if (!runtimeConnection) throw new Error('no runtime connection')
    const conn = await runtimeConnection()
    const result = await conn.request(`${CATALOG_CAPABILITY}.refresh` as RouteKey, {})
    return readCatalogStatusState(result) ?? { available: false }
  }, [runtimeConnection])
  return { state, refresh }
}
