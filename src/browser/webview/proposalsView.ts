/**
 * The page's read of `proposals/<sessionId>` (F-36): the latest whole state
 * of one session's proposal cards, and the `proposals.*` actions bound to
 * that session. One store per (connection, session), released by the last
 * listener, so every reader of a session shares one subscription.
 */
import * as React from 'react'

import type { RuntimeConnection } from '../runtimeClient/RuntimeConnection'
import { PROPOSAL_STATES, type ProposalView } from '../../sessions/childProposals'
import { proposalsTopic, type ProposalsState } from '../../sessions/proposalProtocol'
import {
  NO_SESSION_PROPOSALS,
  type SessionProposalsValue,
} from '../../components/assistant-ui/session-proposals-context'

type Listener = (proposals: readonly ProposalView[]) => void

type Store = {
  proposals: readonly ProposalView[] | null
  listeners: Set<Listener>
  unsubscribe: (() => void) | null
}

const stores = new WeakMap<Pick<RuntimeConnection, 'subscribe'>, Map<string, Store>>()

function isView(value: unknown): value is ProposalView {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Record<string, unknown>
  return (
    typeof row.taskId === 'string' &&
    (row.mode === 'suggest' || row.mode === 'offer') &&
    typeof row.state === 'string' &&
    (PROPOSAL_STATES as readonly string[]).includes(row.state) &&
    typeof row.title === 'string'
  )
}

/** The published state's rows, or null for a payload of another shape. */
export function proposalsOfPayload(payload: unknown, sessionId: string): ProposalView[] | null {
  if (typeof payload !== 'object' || payload === null) return null
  const state = payload as Partial<ProposalsState>
  if (state.sessionId !== sessionId || !Array.isArray(state.proposals)) return null
  return state.proposals.filter(isView)
}

function storeFor(connection: Pick<RuntimeConnection, 'subscribe'>, sessionId: string): Store {
  let bySession = stores.get(connection)
  if (!bySession) {
    bySession = new Map()
    stores.set(connection, bySession)
  }
  let store = bySession.get(sessionId)
  if (!store) {
    store = { proposals: null, listeners: new Set(), unsubscribe: null }
    bySession.set(sessionId, store)
  }
  return store
}

export function holdProposalsView(
  connection: Pick<RuntimeConnection, 'subscribe'>,
  sessionId: string,
  listener: Listener,
): () => void {
  const store = storeFor(connection, sessionId)
  store.listeners.add(listener)
  if (store.unsubscribe === null) {
    store.unsubscribe = connection.subscribe<unknown>(proposalsTopic(sessionId), event => {
      const proposals = proposalsOfPayload(event.payload, sessionId)
      if (proposals === null) return
      store.proposals = proposals
      for (const each of Array.from(store.listeners)) each(proposals)
    })
  } else if (store.proposals !== null) {
    listener(store.proposals)
  }
  return () => {
    store.listeners.delete(listener)
    if (store.listeners.size === 0 && store.unsubscribe) {
      store.unsubscribe()
      store.unsubscribe = null
      store.proposals = null
    }
  }
}

/** The card's actions for one session; each resolves once the runtime answered. */
export function proposalsActions(
  connection: Pick<RuntimeConnection, 'request'>,
  sessionId: string,
): Required<Pick<SessionProposalsValue, 'start' | 'dismiss' | 'choose'>> {
  return {
    start: async taskId => {
      await connection.request('proposals.start', { sessionId, taskId })
    },
    dismiss: async taskId => {
      await connection.request('proposals.dismiss', { sessionId, taskId })
    },
    choose: async (taskId, choice) => {
      await connection.request('proposals.choose', { sessionId, taskId, choice })
    },
  }
}

/**
 * One session's proposals for its thread. `canAnswer` false (a read-only
 * thread, or a connection without `proposals.start`) leaves out the actions.
 */
export function useSessionProposals(
  runtimeConnection: (() => Promise<RuntimeConnection>) | undefined,
  sessionId: string | undefined,
  canAnswer: boolean,
): SessionProposalsValue {
  const [held, setHeld] = React.useState<{
    sessionId: string
    proposals: readonly ProposalView[]
    actions: ReturnType<typeof proposalsActions>
  } | null>(null)
  React.useEffect(() => {
    if (!runtimeConnection || !sessionId) {
      setHeld(null)
      return
    }
    let live = true
    let release: (() => void) | null = null
    void runtimeConnection().then(
      conn => {
        if (!live) return
        const actions = proposalsActions(conn, sessionId)
        release = holdProposalsView(conn, sessionId, proposals => {
          if (live) setHeld({ sessionId, proposals, actions })
        })
      },
      () => {
        // No connection: no cards to read.
      },
    )
    return () => {
      live = false
      release?.()
    }
  }, [runtimeConnection, sessionId])
  return React.useMemo(() => {
    if (held === null || held.sessionId !== sessionId) return NO_SESSION_PROPOSALS
    return canAnswer ? { proposals: held.proposals, ...held.actions } : { proposals: held.proposals }
  }, [held, sessionId, canAnswer])
}
