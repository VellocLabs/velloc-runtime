/**
 * The page's read of `mods/themes` (F-25) and its asks (`themeMods.*`); one
 * store per connection. The list is the runtime's to write (P-3): the page
 * reads it and changes only the backdrop's reach.
 */
import * as React from 'react'

import type { RuntimeConnection } from '../../runtimeClient/RuntimeConnection'
import type { RouteKey } from '../../runtimeProtocol'
import {
  THEME_MODS_CAPABILITY,
  THEME_MODS_TOPIC,
  readThemeModsState,
  type ThemeBackdropScope,
  type ThemeModsState,
  type ThemeModsTurnOffResult,
} from '../../../mods/themeMods'

type Listener = (state: ThemeModsState) => void
type Store = { latest: ThemeModsState | null; listeners: Set<Listener>; unsubscribe: (() => void) | null }

const stores = new WeakMap<Pick<RuntimeConnection, 'subscribe'>, Store>()

export function holdThemeMods(connection: Pick<RuntimeConnection, 'subscribe'>, listener: Listener): () => void {
  let store = stores.get(connection)
  if (!store) {
    store = { latest: null, listeners: new Set(), unsubscribe: null }
    stores.set(connection, store)
  }
  const held = store
  held.listeners.add(listener)
  if (held.unsubscribe === null) {
    held.unsubscribe = connection.subscribe<unknown>(THEME_MODS_TOPIC, event => {
      const next = readThemeModsState(event.payload)
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

export type ThemeModsView = {
  /** Null until the topic answers. */
  state: ThemeModsState | null
  /** Ask the runtime to read the list again; every reader gets the answer. */
  refresh: () => void
  /** Rejects when the runtime refuses; the topic's last state stands. */
  setBackdropScope: (scope: ThemeBackdropScope) => Promise<void>
  setSingle: (on: boolean) => Promise<void>
  /** Switches every theme plugin off; answers how many were on. */
  turnOffAll: () => Promise<number>
}

export function useThemeMods(runtimeConnection: (() => Promise<RuntimeConnection>) | undefined): ThemeModsView {
  const [state, setState] = React.useState<ThemeModsState | null>(null)
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
        release = holdThemeMods(conn, next => {
          if (live) setState(next)
        })
      },
      () => {
        // No connection: the window keeps the default reach and lists no mods.
      },
    )
    return () => {
      live = false
      release?.()
    }
  }, [runtimeConnection])
  const ask = React.useCallback(
    async (action: 'read' | 'setBackdropScope' | 'setSingle', payload: Record<string, unknown>): Promise<void> => {
      if (!runtimeConnection) throw new Error('no runtime connection')
      const conn = await runtimeConnection()
      await conn.request(`${THEME_MODS_CAPABILITY}.${action}` as RouteKey, payload)
    },
    [runtimeConnection],
  )
  const refresh = React.useCallback(() => {
    void ask('read', {}).catch(() => undefined)
  }, [ask])
  const setBackdropScope = React.useCallback((scope: ThemeBackdropScope) => ask('setBackdropScope', { scope }), [ask])
  const setSingle = React.useCallback((on: boolean) => ask('setSingle', { on }), [ask])
  const turnOffAll = React.useCallback(async (): Promise<number> => {
    if (!runtimeConnection) throw new Error('no runtime connection')
    const conn = await runtimeConnection()
    const answer = (await conn.request(`${THEME_MODS_CAPABILITY}.turnOffAll` as RouteKey, {})) as Partial<ThemeModsTurnOffResult>
    return typeof answer?.turnedOff === 'number' ? answer.turnedOff : 0
  }, [runtimeConnection])
  return React.useMemo(
    () => ({ state, refresh, setBackdropScope, setSingle, turnOffAll }),
    [state, refresh, setBackdropScope, setSingle, turnOffAll],
  )
}

/**
 * After a person turns `plugin` on: asks the runtime to run the command the
 * catalogue names for it (`theme.onEnable`) in `sessionId`. What shows after
 * is read from the session's published theme; a refusal changes nothing.
 */
export function askThemeOnEnable(
  runtimeConnection: () => Promise<RuntimeConnection>,
  sessionId: string,
  plugin: string,
): void {
  void runtimeConnection()
    .then(conn => conn.request('theme.onEnable' as RouteKey, { sessionId, plugin }))
    .catch(() => undefined)
}
