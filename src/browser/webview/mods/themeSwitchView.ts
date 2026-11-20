/**
 * The page's read of `theme/switch` (F-25): the theme switches the runtime
 * runs now and how each ended; one store per connection. A topic only.
 */
import * as React from 'react'

import type { RuntimeConnection } from '../../runtimeClient/RuntimeConnection'
import { THEME_SWITCH_TOPIC, readThemeSwitchState, type ThemeSwitchState } from '../../../mods/themeSwitch'

type Listener = (state: ThemeSwitchState) => void
type Store = { latest: ThemeSwitchState | null; listeners: Set<Listener>; unsubscribe: (() => void) | null }

const stores = new WeakMap<Pick<RuntimeConnection, 'subscribe'>, Store>()

export function holdThemeSwitches(connection: Pick<RuntimeConnection, 'subscribe'>, listener: Listener): () => void {
  let store = stores.get(connection)
  if (!store) {
    store = { latest: null, listeners: new Set(), unsubscribe: null }
    stores.set(connection, store)
  }
  const held = store
  held.listeners.add(listener)
  if (held.unsubscribe === null) {
    held.unsubscribe = connection.subscribe<unknown>(THEME_SWITCH_TOPIC, event => {
      const next = readThemeSwitchState(event.payload)
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

/** The runtime's theme switches; null until the topic answers or with no connection. */
export function useThemeSwitches(runtimeConnection: (() => Promise<RuntimeConnection>) | undefined): ThemeSwitchState | null {
  const [state, setState] = React.useState<ThemeSwitchState | null>(null)
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
        release = holdThemeSwitches(conn, next => {
          if (live) setState(next)
        })
      },
      () => {
        // No connection: no switch shows.
      },
    )
    return () => {
      live = false
      release?.()
    }
  }, [runtimeConnection])
  return state
}
