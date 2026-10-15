/**
 * The page's read of `appUpdate/status` and its one way to ask
 * (`appUpdate.relaunch`) (F-30). One store per connection (the snapshot goes to
 * the FIRST listener only); nothing is kept in client storage (P-3).
 */
import * as React from 'react'

import type { RuntimeConnection } from '../runtimeClient/RuntimeConnection'
import type { RouteKey } from '../runtimeProtocol'
import {
  APP_UPDATE_CAPABILITY,
  APP_UPDATE_STATUS_TOPIC,
  readAppUpdateState,
  type AppUpdateState,
} from '../../appUpdate/appUpdateProtocol'

type Listener = (state: AppUpdateState) => void
type Store = { latest: AppUpdateState | null; listeners: Set<Listener>; unsubscribe: (() => void) | null }

const stores = new WeakMap<Pick<RuntimeConnection, 'subscribe'>, Store>()

export function holdAppUpdateStatus(connection: Pick<RuntimeConnection, 'subscribe'>, listener: Listener): () => void {
  let store = stores.get(connection)
  if (!store) {
    store = { latest: null, listeners: new Set(), unsubscribe: null }
    stores.set(connection, store)
  }
  const held = store
  held.listeners.add(listener)
  if (held.unsubscribe === null) {
    held.unsubscribe = connection.subscribe<unknown>(APP_UPDATE_STATUS_TOPIC, event => {
      const next = readAppUpdateState(event.payload)
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

export type AppUpdateStatusView = {
  /** Latest published state; null until the topic answers. */
  state: AppUpdateState | null
  /** Ask the runtime to restart into the installed update; rejects when it refuses. */
  relaunch: () => Promise<void>
}

export function useAppUpdateStatus(
  runtimeConnection: (() => Promise<RuntimeConnection>) | undefined,
): AppUpdateStatusView {
  const [state, setState] = React.useState<AppUpdateState | null>(null)
  React.useEffect(() => {
    if (!runtimeConnection) {
      setState(null)
      return
    }
    let live = true
    let release: (() => void) | null = null
    void runtimeConnection().then(
      conn => {
        if (!live) return
        release = holdAppUpdateStatus(conn, next => {
          if (live) setState(next)
        })
      },
      () => {
        // No connection: no update bar.
      },
    )
    return () => {
      live = false
      release?.()
    }
  }, [runtimeConnection])
  const relaunch = React.useCallback(async (): Promise<void> => {
    if (!runtimeConnection) throw new Error('no runtime connection')
    const conn = await runtimeConnection()
    await conn.request(`${APP_UPDATE_CAPABILITY}.relaunch` as RouteKey, {})
  }, [runtimeConnection])
  return { state, relaunch }
}
