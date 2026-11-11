/**
 * The page's read of `mcpAuth/status` and its ways to ask (`mcpAuth.signIn`,
 * `cancel`, `signOut`) (F-10). One store per connection (the snapshot goes to
 * the FIRST listener only); nothing is kept in client storage (P-3).
 */
import * as React from 'react'

import type { RuntimeConnection } from '../runtimeClient/RuntimeConnection'
import type { TranslateFn } from './i18n/translate'
import type { RouteKey } from '../runtimeProtocol'
import {
  MCP_AUTH_CAPABILITY,
  MCP_AUTH_STATUS_TOPIC,
  readMcpAuthState,
  mcpSignInDue,
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

/** The state of the server at `url` in `state`, matched on the normalized URL. */
export function serverStateIn(state: McpAuthState | null, url: string | undefined): McpAuthServerState | undefined {
  const target = url ? normalizeMcpServerUrl(url) : null
  return target ? state?.servers.find(server => server.url === target) : undefined
}

/** Sends `mcpAuth.<action>`; rejects when there is no connection or the runtime refuses. */
export async function askMcpAuth(
  runtimeConnection: (() => Promise<RuntimeConnection>) | undefined,
  action: 'signIn' | 'cancel' | 'signOut',
  payload: Record<string, unknown>,
): Promise<void> {
  if (!runtimeConnection) throw new Error('no runtime connection')
  const conn = await runtimeConnection()
  await conn.request(`${MCP_AUTH_CAPABILITY}.${action}` as RouteKey, payload)
}

/**
 * Of `urls`, the ones to start a sign-in for: the runtime reads them as
 * needing one, and a sign-in needs neither a client id nor a key from the person.
 */
export function dueSignIns(
  urls: readonly string[] | undefined,
  serverState: (url: string) => McpAuthServerState | undefined,
): string[] {
  return (urls ?? []).filter(url => mcpSignInDue(serverState(url)))
}

/** What an app press's sign-in reads at the press: the connection and the page's language. */
export type AppSignInContext = {
  runtimeConnection: (() => Promise<RuntimeConnection>) | undefined
  t: TranslateFn
}

/**
 * An app press's sign-in starter: each due server of `urls` gets `mcpAuth.signIn`,
 * its window titled by the server's host. A server asked for and not yet
 * answered is not asked again, so a second press keeps the window open. A
 * refusal is logged.
 */
export function createAppSignIn(
  latest: { readonly current: McpAuthState | null },
  context: { readonly current: AppSignInContext },
): (urls: readonly string[]) => void {
  const asking = new Set<string>()
  return urls => {
    const state = latest.current
    for (const url of dueSignIns(urls, each => serverStateIn(state, each))) {
      void askAppSignIn(asking, context.current, url)?.catch(err => {
        console.warn('[mcp] app sign-in failed:', err instanceof Error ? err.message : err)
      })
    }
  }
}

/**
 * Sends `mcpAuth.signIn` for the server at `url`, its window titled by the
 * server's host, unless `asking` holds a request for it not yet answered
 * (null then): a second request would replace the open window.
 */
export function askAppSignIn(asking: Set<string>, context: AppSignInContext, url: string): Promise<void> | null {
  const key = normalizeMcpServerUrl(url)
  if (!key || asking.has(key)) return null
  asking.add(key)
  const windowTitle = context.t('mcpAuth.windowTitle', { server: new URL(key).host })
  return askMcpAuth(context.runtimeConnection, 'signIn', { url, windowTitle }).finally(() => asking.delete(key))
}

/**
 * The latest `mcpAuth/status`, held without re-rendering its host: for a
 * reader that looks at it only when it acts.
 */
export function useMcpAuthLatest(
  runtimeConnection: (() => Promise<RuntimeConnection>) | undefined,
): { readonly current: McpAuthState | null } {
  const latest = React.useRef<McpAuthState | null>(null)
  React.useEffect(() => {
    latest.current = null
    if (!runtimeConnection) return
    let live = true
    let release: (() => void) | null = null
    void runtimeConnection().then(
      conn => {
        if (!live) return
        release = holdMcpAuthStatus(conn, next => {
          if (live) latest.current = next
        })
      },
      () => {
        // No connection: nothing to read.
      },
    )
    return () => {
      live = false
      release?.()
    }
  }, [runtimeConnection])
  return latest
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
    (action: 'signIn' | 'cancel' | 'signOut', payload: Record<string, unknown>): Promise<void> =>
      askMcpAuth(runtimeConnection, action, payload),
    [runtimeConnection],
  )
  return React.useMemo<McpAuthControls>(
    () => ({
      state,
      serverState: url => serverStateIn(state, url),
      signIn: payload => ask('signIn', payload),
      cancel: url => ask('cancel', { url }),
      signOut: url => ask('signOut', { url }),
    }),
    [state, ask],
  )
}
