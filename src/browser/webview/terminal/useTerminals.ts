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

/**
 * The `terminals` topic's state: null until its snapshot lands, and null for
 * good on a connection without the `terminal` grant (the topic is `full`).
 */
export function useTerminalsState(conn: RuntimeConnection | null): TerminalsState | null {
  const [state, setState] = useState<TerminalsState | null>(null)
  useEffect(() => {
    setState(null)
    if (!conn || !conn.can(TERMINAL_CAPABILITY, 'create')) return
    return conn.subscribe(topic.terminals(), event => {
      if (isTerminalsState(event.payload)) setState(event.payload)
    })
  }, [conn])
  return state
}

export function useTerminalPrefs(): TerminalPrefs {
  return useSyncExternalStore(subscribeTerminalPrefs, loadTerminalPrefs, loadTerminalPrefs)
}
