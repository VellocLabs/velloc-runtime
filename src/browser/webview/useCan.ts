/**
 * `useCan(cap, act)`: render by capability, never by "am I remote" (F-24). Reads the connection's
 * scope-filtered `welcome.server.capabilities`; an action it may not use is not rendered. Unknown means
 * allowed (the default is `ALLOW_ALL`; a desktop connection is `full`). Requests the page sends by itself
 * must also wait on `mayIssue()` while the grant is `PENDING_GRANT`.
 */
import { createContext, useContext, useEffect, useMemo, useState } from 'react'

import type { RuntimeConnection } from '../runtimeClient/RuntimeConnection'

/** What the UI asks. One method, the same shape `RuntimeConnection` exposes. */
export type CapabilityQuery = {
  can(cap: string, act?: string): boolean
  /**
   * `true` while a connection is wired but has not answered yet. `can()` then
   * says yes to everything (unknown means allowed), which is right for a
   * control but not for a request the page sends by itself: that one waits
   * (`mayIssue`). Absent means the answer is final, `ALLOW_ALL` included.
   */
  readonly pending?: boolean
  /**
   * Does the grant cover every session (`scope.sessions === 'all'`)? Only then
   * may the connection name a folder from the workspace index — one limited
   * to a list of sessions knows only those sessions' folders. Absent, or no
   * welcome yet, means yes (unknown means allowed).
   */
  allSessions?(): boolean
}

/** No connection wired: everything is allowed, so the tree renders as it always did. */
export const ALLOW_ALL: CapabilityQuery = { can: () => true }

/** A connection is wired and its welcome has not landed: controls render, requests wait. */
export const PENDING_GRANT: CapabilityQuery = { can: () => true, pending: true }

export const RuntimeCapabilitiesContext = createContext<CapabilityQuery>(ALLOW_ALL)

/**
 * May this connection perform `cap.act`?
 *
 * `act` omitted asks only whether the capability exists at all — use it for a
 * whole page whose every control needs the same capability, and name the
 * action when one control is narrower than its page.
 */
export function useCan(cap: string, act?: string): boolean {
  const query = useContext(RuntimeCapabilitiesContext)
  return query.can(cap, act)
}

/** The whole query, for a caller that tests several actions in a callback. */
export function useCapabilities(): CapabilityQuery {
  return useContext(RuntimeCapabilitiesContext)
}

/**
 * May the page send `cap.act` by itself, at mount or on a session switch,
 * rather than because the user clicked a control?
 *
 * The same answer as `can()`, except while the grant is unknown: then it is
 * `false`, so the request waits for the welcome instead of being refused.
 */
export function mayIssue(query: CapabilityQuery, cap: string, act?: string): boolean {
  return !query.pending && query.can(cap, act)
}

/**
 * Build a query from a live connection's `welcome`. Before the welcome lands
 * (and after the connection is gone) the answer is `true` — see "unknown means
 * allowed" above. A resumed or re-established connection re-reads the fresh
 * welcome, so a reconnect that comes back with a different grant re-renders
 * the tree rather than leaving stale entries on screen.
 */
export function capabilityQueryOf(connection: RuntimeConnection | null): CapabilityQuery {
  if (!connection) return ALLOW_ALL
  return {
    can(cap, act) {
      // No welcome yet: the grant is unknown, not empty.
      if (!connection.welcome) return true
      return connection.can(cap, act)
    },
    allSessions() {
      const welcome = connection.welcome
      return !welcome || welcome.scope.sessions === 'all'
    },
  }
}

/**
 * Track the page's runtime connection and answer `can()` from its live welcome: `PENDING_GRANT` until
 * it resolves, `ALLOW_ALL` without one. A reconnect re-derives the query, so a smaller grant re-renders.
 */
export function useCapabilityQuery(
  connection?: (() => Promise<RuntimeConnection>) | undefined,
): CapabilityQuery {
  const [resolved, setResolved] = useState<RuntimeConnection | null>(null)
  const [revision, setRevision] = useState(0)
  // The connection whose promise rejected. Its grant can never be learned, so the tree answers ALLOW_ALL.
  const [failed, setFailed] = useState<(() => Promise<RuntimeConnection>) | null>(null)

  useEffect(() => {
    if (!connection) {
      setResolved(null)
      return
    }
    let live = true
    let unsubscribe: (() => void) | undefined
    void connection().then(
      conn => {
        if (!live) return
        setResolved(conn)
        setRevision(n => n + 1)
        unsubscribe = conn.watchLinkState(() => setRevision(n => n + 1))
      },
      () => {
        // A connection that never comes up leaves the subtree on ALLOW_ALL.
        if (live) setFailed(() => connection)
      },
    )
    return () => {
      live = false
      unsubscribe?.()
    }
  }, [connection])

  return useMemo(
    () => {
      if (resolved) return capabilityQueryOf(resolved)
      return connection && failed !== connection ? PENDING_GRANT : ALLOW_ALL
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [resolved, revision, connection, failed],
  )
}
