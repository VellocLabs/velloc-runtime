/**
 * A session's turn board on the runtime protocol (F-41); shapes and scope in
 * `sessions/turnProtocol.ts`. A topic only: the board is written by the
 * session's own tools.
 */
import type { TopicId } from '../runtimeProtocol'
import {
  TURN_EVENT,
  TURN_TOPIC_SCOPE,
  sessionOfTurnTopic,
  turnTopic,
  turnTopicState,
} from '../../sessions/turnProtocol'
import { turnBoard, type TurnBoard } from '../../sessions/turnBoard'
import { scopeAllows } from './CapabilityRegistry'
import type { TopicBroker } from './TopicBroker'
import type { ConnectionInfo, SnapshotPage, TopicProvider } from './types'

/** Whether `conn` may see `sessionId`: the session-topic rule. */
const seesSession = (conn: ConnectionInfo, sessionId: string): boolean =>
  conn.scope.sessions === 'all' || conn.scope.sessions.includes(sessionId)

export function registerTurnTopic(
  broker: TopicBroker,
  board: TurnBoard = turnBoard,
): { publish(sessionId: string): void; dispose(): void } {
  const provider: TopicProvider = {
    matches: (id: TopicId) => sessionOfTurnTopic(id) !== null,
    authorize: (id, conn) => {
      const sessionId = sessionOfTurnTopic(id)
      return sessionId !== null && scopeAllows(conn.scope.mode, TURN_TOPIC_SCOPE) && seesSession(conn, sessionId)
    },
    async *snapshot(id: TopicId): AsyncIterable<SnapshotPage> {
      const sessionId = sessionOfTurnTopic(id)
      if (sessionId) yield { type: TURN_EVENT, payload: turnTopicState(sessionId, board.read(sessionId)) }
    },
  }
  broker.registerProvider(provider)

  const publish = (sessionId: string): void => {
    let id: TopicId
    try {
      id = turnTopic(sessionId)
    } catch {
      return
    }
    // Nobody is reading: a later subscriber's snapshot reads afresh.
    if (broker.subscribersOf(id).length === 0) return
    broker.publish(id, turnTopicState(sessionId, board.read(sessionId)), { type: TURN_EVENT })
  }
  return { publish, dispose: board.onChange(publish) }
}
