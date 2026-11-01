/**
 * Security: child-session proposals on the runtime protocol (F-36). A client
 * reads one session's cards on topic `proposals/<sessionId>` (`observe`, and
 * only for a session the connection may see) and answers them through the
 * `proposals.*` actions, all `control`: each acts on one session's
 * conversation the way sending it a message does, and a start runs only what
 * that session's own model proposed, under the same checks as the model's own
 * start. The topic carries each card's state and title, never its brief.
 */
import type { ScopeMode, TopicId } from '../browser/runtimeProtocol'
import { isProposalTaskId, type ProposalState, type ProposalView } from './childProposals'

export const PROPOSALS_CAPABILITY = 'proposals'
/** The `type` of the snapshot and of every delta. */
export const PROPOSALS_EVENT = 'state'

const TOPIC_PREFIX = 'proposals/'

export function proposalsTopic(sessionId: string): TopicId {
  if (!sessionId || sessionId.includes('/')) {
    throw new RangeError(`[protocol] proposals topic needs a session id without '/': ${JSON.stringify(sessionId)}`)
  }
  return `${TOPIC_PREFIX}${sessionId}` as TopicId
}

/** The session a proposals topic is about, or null for any other id. */
export function sessionOfProposalsTopic(id: string): string | null {
  if (!id.startsWith(TOPIC_PREFIX)) return null
  const sessionId = id.slice(TOPIC_PREFIX.length)
  return sessionId.length > 0 && !sessionId.includes('/') ? sessionId : null
}

export const PROPOSALS_TOPIC_SCOPE: ScopeMode = 'observe'

export const PROPOSALS_ACTION_SCOPES = {
  start: 'control',
  dismiss: 'control',
  choose: 'control',
} as const satisfies Record<string, ScopeMode>
export type ProposalsAction = keyof typeof PROPOSALS_ACTION_SCOPES

/** The whole state of one session's cards, published on every change. */
export type ProposalsState = {
  sessionId: string
  proposals: ProposalView[]
}

export type ProposalsTargetPayload = { sessionId: string; taskId: string }
export type ProposalsChoosePayload = ProposalsTargetPayload & { choice: 'new' | 'here' }

/** Every action answers with the card's state after it, or refuses with the
 *  real one (`conflict`). */
export type ProposalsActionResult = { state: ProposalState }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isSessionId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 300 && !value.includes('/')

function hasOnly(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key))
}

export function isProposalsTargetPayload(value: unknown): value is ProposalsTargetPayload {
  return (
    isRecord(value) &&
    hasOnly(value, ['sessionId', 'taskId']) &&
    isSessionId(value.sessionId) &&
    isProposalTaskId(value.taskId)
  )
}

export function isProposalsChoosePayload(value: unknown): value is ProposalsChoosePayload {
  return (
    isRecord(value) &&
    hasOnly(value, ['sessionId', 'taskId', 'choice']) &&
    isSessionId(value.sessionId) &&
    isProposalTaskId(value.taskId) &&
    (value.choice === 'new' || value.choice === 'here')
  )
}

export function sessionOfProposalsPayload(value: unknown): string | undefined {
  return isRecord(value) && isSessionId(value.sessionId) ? value.sessionId : undefined
}
