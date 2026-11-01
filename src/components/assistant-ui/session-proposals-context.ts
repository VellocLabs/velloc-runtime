import { createContext, useContext } from 'react'

import type { ProposalView } from '../../sessions/childProposals'

/**
 * One session's child-session proposals as the page reads them (F-36):
 * the records published on `proposals/<sessionId>` and the actions a card
 * may take. An action is absent when the thread is read-only or the
 * connection may not answer proposals; the card then draws no buttons.
 */
export type SessionProposalsValue = {
  /** Null until the session's state has landed (or with no connection). */
  proposals: readonly ProposalView[] | null
  start?: (taskId: string) => Promise<void>
  dismiss?: (taskId: string) => Promise<void>
  choose?: (taskId: string, choice: 'new' | 'here') => Promise<void>
}

export const NO_SESSION_PROPOSALS: SessionProposalsValue = { proposals: null }

export const SessionProposalsContext = createContext<SessionProposalsValue>(NO_SESSION_PROPOSALS)

export function useSessionProposalsContext(): SessionProposalsValue {
  return useContext(SessionProposalsContext)
}
