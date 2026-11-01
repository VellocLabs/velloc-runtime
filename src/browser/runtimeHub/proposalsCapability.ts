/**
 * Child-session proposals on the runtime protocol (F-36); shapes and scopes in
 * `sessions/proposalProtocol.ts`. The runtime's proposal board does the work;
 * a client names a session and a task id and reads the result off the topic.
 */
import { wireError, type TopicId } from '../runtimeProtocol'
import {
  PROPOSALS_ACTION_SCOPES,
  PROPOSALS_CAPABILITY,
  PROPOSALS_EVENT,
  PROPOSALS_TOPIC_SCOPE,
  isProposalsChoosePayload,
  isProposalsTargetPayload,
  proposalsTopic,
  sessionOfProposalsPayload,
  sessionOfProposalsTopic,
  type ProposalsActionResult,
  type ProposalsChoosePayload,
  type ProposalsState,
  type ProposalsTargetPayload,
} from '../../sessions/proposalProtocol'
import {
  getProposalBoard,
  onProposalsChanged,
  type ProposalBoard,
} from '../../sessions/proposalBoard'
import { proposalStateWords, type ProposalState } from '../../sessions/childProposals'
import { scopeAllows, type CapabilityRegistry } from './CapabilityRegistry'
import type { TopicBroker } from './TopicBroker'
import type { ConnectionInfo, SnapshotPage, TopicProvider } from './types'

export type ProposalsCapabilityOptions = {
  /** Default: the realm's board (`setProposalBoard`). */
  board?: () => ProposalBoard | null
  /** Default: the board's change feed. */
  onChanged?: (listener: (sessionId: string) => void) => () => void
}

/** Whether `conn` may see `sessionId`: the session-topic rule. */
const seesSession = (conn: ConnectionInfo, sessionId: string): boolean =>
  conn.scope.sessions === 'all' || conn.scope.sessions.includes(sessionId)

export function registerProposalsCapability(
  registry: CapabilityRegistry,
  broker: TopicBroker,
  options: ProposalsCapabilityOptions = {},
): { publish(sessionId: string): Promise<void>; dispose(): void } {
  const boardOf = options.board ?? getProposalBoard

  const state = async (sessionId: string): Promise<ProposalsState> => {
    const board = boardOf()
    return { sessionId, proposals: board ? await board.views(sessionId) : [] }
  }
  const board = (): ProposalBoard => {
    const found = boardOf()
    if (!found) throw wireError('host_unavailable', 'proposals: the runtime has no session manager yet')
    return found
  }

  const provider: TopicProvider = {
    matches: (id: TopicId) => sessionOfProposalsTopic(id) !== null,
    authorize: (id, conn) => {
      const sessionId = sessionOfProposalsTopic(id)
      return sessionId !== null && scopeAllows(conn.scope.mode, PROPOSALS_TOPIC_SCOPE) && seesSession(conn, sessionId)
    },
    async *snapshot(id: TopicId): AsyncIterable<SnapshotPage> {
      const sessionId = sessionOfProposalsTopic(id)
      if (sessionId) yield { type: PROPOSALS_EVENT, payload: await state(sessionId) }
    },
  }
  broker.registerProvider(provider)

  /** The card's state after an action, or a `conflict` naming the real one. */
  const answer = (
    result: { ok: true; proposal: { state: ProposalState } } | { ok: false; state: ProposalState } | null,
    taskId: string,
  ): ProposalsActionResult => {
    if (!result) throw wireError('not_found', `proposals: no proposal ${taskId} in this session`)
    if (!result.ok) {
      throw wireError('conflict', `proposals: ${taskId} is ${proposalStateWords({ state: result.state })}`, {
        state: result.state,
      })
    }
    return { state: result.proposal.state }
  }

  registry.registerCapability({
    cap: PROPOSALS_CAPABILITY,
    actions: {
      start: { scope: PROPOSALS_ACTION_SCOPES.start, sessionOf: sessionOfProposalsPayload, guard: isProposalsTargetPayload },
      dismiss: { scope: PROPOSALS_ACTION_SCOPES.dismiss, sessionOf: sessionOfProposalsPayload, guard: isProposalsTargetPayload },
      choose: { scope: PROPOSALS_ACTION_SCOPES.choose, sessionOf: sessionOfProposalsPayload, guard: isProposalsChoosePayload },
    },
    handle: async request => {
      const act = request.route.act
      switch (act) {
        case 'start': {
          const { sessionId, taskId } = request.payload as ProposalsTargetPayload
          const result = await board().startByPerson(sessionId, taskId)
          if (result.ok) return { state: result.proposal.state } satisfies ProposalsActionResult
          // A start that could not run leaves the card where it was, with
          // the reason on it; a claim already taken answers the real state.
          if (result.state) return { state: result.state } satisfies ProposalsActionResult
          throw wireError('not_found', `proposals: ${result.reason}`)
        }
        case 'dismiss': {
          const { sessionId, taskId } = request.payload as ProposalsTargetPayload
          return answer(await board().dismiss(sessionId, taskId), taskId)
        }
        case 'choose': {
          const { sessionId, taskId, choice } = request.payload as ProposalsChoosePayload
          return answer(await board().choose(sessionId, taskId, choice), taskId)
        }
        default:
          throw wireError('unknown_route', `proposals has no action '${act}'`)
      }
    },
  })

  const publish = async (sessionId: string): Promise<void> => {
    let id: TopicId
    try {
      id = proposalsTopic(sessionId)
    } catch {
      return
    }
    // Nobody is reading: a later subscriber's snapshot reads afresh.
    if (broker.subscribersOf(id).length === 0) return
    broker.publish(id, await state(sessionId), { type: PROPOSALS_EVENT })
  }
  const unsubscribe = (options.onChanged ?? onProposalsChanged)(sessionId => {
    void publish(sessionId)
  })
  return { publish, dispose: unsubscribe }
}
