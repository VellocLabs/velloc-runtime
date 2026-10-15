/**
 * The runtime connection's state as the UI reads it (F-24): the state hook, the composer's
 * send gate, and the reason shown to the user. Inert on the desktop (a MessagePort
 * connection never reconnects).
 */
import { createContext, useContext, useEffect, useState } from 'react'

import {
  DESKTOP_OFFLINE_CLOSE_REASON,
  type ConnectionState,
  type RuntimeConnection,
} from '../runtimeClient/RuntimeConnection'

/**
 * Track one connection's state. Returns `null` until the connection resolves
 * — which reads as "nothing to report", the right answer for a surface with
 * no connection at all (tests, mock hosts).
 */
export function useRuntimeConnectionState(
  connection?: (() => Promise<RuntimeConnection>) | undefined,
): ConnectionState | null {
  const [state, setState] = useState<ConnectionState | null>(null)

  useEffect(() => {
    if (!connection) {
      setState(null)
      return
    }
    let live = true
    let unsubscribe: (() => void) | undefined
    void connection().then(
      conn => {
        if (!live) return
        setState(conn.state)
        unsubscribe = conn.watchLinkState(next => setState(next))
      },
      () => {
        // A connection that never comes up is the boot path's problem to
        // report, not this banner's.
      },
    )
    return () => {
      live = false
      unsubscribe?.()
    }
  }, [connection])

  return state
}

/**
 * May the user send right now? True when there is no connection to speak of
 * (desktop surfaces that never wire one, and every existing test) and when
 * the connection is `ready`. False only while it is visibly away — so the
 * composer is never disabled by something the user cannot see explained.
 */
export function isRuntimeReady(state: ConnectionState | null): boolean {
  return state === null || state.status === 'ready'
}

/**
 * Whether the composer may send. Defaults to `true`, so a tree with no
 * provider — the desktop, and every existing test — is untouched.
 */
export const RuntimeReadyContext = createContext<boolean>(true)

export function useRuntimeReady(): boolean {
  return useContext(RuntimeReadyContext)
}

/**
 * The relay is up and the desktop panel is closed — `RuntimeConnection`
 * publishes the close reason that opened the gap, and this is the one the UI
 * can name as an action the user can take. Anything else (a blipped wire, a
 * `bye`, 4004) is an ordinary reconnect.
 */
export function isDesktopOffline(state: ConnectionState | null): boolean {
  return (
    state?.status === 'reconnecting' && state.reason === DESKTOP_OFFLINE_CLOSE_REASON
  )
}
