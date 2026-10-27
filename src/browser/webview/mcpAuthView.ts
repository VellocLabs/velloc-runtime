/**
 * The page's read of `mcpAuth/status` and its ways to ask (`mcpAuth.signIn`,
 * `cancel`, `signOut`) (F-10). One store per connection (the snapshot goes to
 * the FIRST listener only); nothing is kept in client storage (P-3).
 */
import * as React from 'react'

import type { RuntimeConnection } from '../runtimeClient/RuntimeConnection'
import type { RouteKey } from '../runtimeProtocol'
import {
  MCP_AUTH_CAPABILITY,
  MCP_AUTH_STATUS_TOPIC,
  readMcpAuthState,
  type McpAuthServerState,
  type McpAuthSignInPayload,
  type McpAuthState,
} from '../../mcp/oauth/mcpAuthProtocol'
import { normalizeMcpServerUrl } from '../../mcp/oauth/oauthKeys'

type Listener = (state: McpAuthState) => void
type Store = { latest: McpAuthState | null; listeners: Set<Listener>; unsubscribe: (() => void) | null }

const stores = new WeakMap<Pick<RuntimeConnection, 'subscribe'>, Store>()

export function holdMcpAuthStatus(connection: Pick<RuntimeConnection, 'subscribe'>, listener: Listener): () => void {
  let store = stores.get(connection)
  if (!store) {
    store = { latest: null, listeners: new Set(), unsubscribe: null }
    stores.set(connection, store)
  }
  const held = store
  held.listeners.add(listener)
  if (held.unsubscribe === null) {
    held.unsubscribe = connection.subscribe<unknown>(MCP_AUTH_STATUS_TOPIC, event => {
      const next = readMcpAuthState(event.payload)
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

/**
 * The servers whose sign-in finished between `previous` and `next`: their
 * phase went from `signing-in` to `signed-in`. A server first seen signed in
 * (the page opened after the sign-in) is not one.
 */
export function newlySignedIn(previous: McpAuthState | null, next: McpAuthState | null): string[] {
  if (!previous || !next) return []
  const before = new Map(previous.servers.map(server => [server.url, server.phase]))
  return next.servers
    .filter(server => server.phase === 'signed-in' && before.get(server.url) === 'signing-in')
    .map(server => server.url)
}

/** What a page can see and ask about MCP server sign-ins. */
export type McpAuthControls = {
  /** Latest published state; null until the topic answers. */
  state: McpAuthState | null
  /** The state of the server at `url`, matched on the normalized URL. */
  serverState: (url: string | undefined) => McpAuthServerState | undefined
  /** Rejects when the runtime refuses. */
  signIn: (payload: McpAuthSignInPayload) => Promise<void>
  cancel: (url: string) => Promise<void>
  signOut: (url: string) => Promise<void>
}

export function useMcpAuth(runtimeConnection: (() => Promise<RuntimeConnection>) | undefined): McpAuthControls {
  const [state, setState] = React.useState<McpAuthState | null>(null)
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
        release = holdMcpAuthStatus(conn, next => {
          if (live) setState(next)
        })
      },
      () => {
        // No connection: no sign-in controls.
      },
    )
    return () => {
      live = false
      release?.()
    }
  }, [runtimeConnection])
  const ask = React.useCallback(
    async (action: 'signIn' | 'cancel' | 'signOut', payload: Record<string, unknown>): Promise<void> => {
      if (!runtimeConnection) throw new Error('no runtime connection')
      const conn = await runtimeConnection()
      await conn.request(`${MCP_AUTH_CAPABILITY}.${action}` as RouteKey, payload)
    },
    [runtimeConnection],
  )
  return React.useMemo<McpAuthControls>(
    () => ({
      state,
      serverState: url => {
        const target = url ? normalizeMcpServerUrl(url) : null
        return target ? state?.servers.find(server => server.url === target) : undefined
      },
      signIn: payload => ask('signIn', payload),
      cancel: url => ask('cancel', { url }),
      signOut: url => ask('signOut', { url }),
    }),
    [state, ask],
  )
}
