/**
 * A runtime port handed to code its creator does not trust (F-42): the creator
 * caps the scope and names the only topics it may subscribe to, before the
 * port leaves its hands. `ConnectionHub` enforces it; `hello` cannot widen it.
 */

import { SCOPE_MODES, type ScopeMode, type TopicId } from '../runtimeProtocol/frames'
import { parseTopic } from '../runtimeProtocol/topics'
import { sessionOfTurnTopic } from '../../sessions/turnProtocol'
import { SESSION_STATE_PATTERN, TURN_PATTERN } from '../../mods/app/appPageTopics'

export type PortDelegation = {
  readonly scope: ScopeMode
  readonly topics: readonly TopicId[]
}

/** Most topics one delegated port may name. */
export const PORT_DELEGATION_MAX_TOPICS = 32
const TOPIC_ID_MAX_LENGTH = 256

/**
 * Security: the attach message crosses from a page, so the cap is read, never
 * trusted as typed. Anything malformed is `null`, and the caller refuses the
 * attach rather than falling back to an uncapped port.
 */
export function parsePortDelegation(value: unknown): PortDelegation | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  // An unknown field may be a narrowing this build cannot enforce, so it refuses the cap.
  const keys = Object.keys(value)
  if (keys.length !== 2 || !keys.includes('scope') || !keys.includes('topics')) return null
  const { scope, topics } = value as { scope?: unknown; topics?: unknown }
  if (typeof scope !== 'string' || !(SCOPE_MODES as readonly string[]).includes(scope)) return null
  if (!Array.isArray(topics) || topics.length > PORT_DELEGATION_MAX_TOPICS) return null
  const ids: TopicId[] = []
  for (const topic of topics) {
    if (typeof topic !== 'string' || topic.length === 0 || topic.length > TOPIC_ID_MAX_LENGTH) return null
    if (!ids.includes(topic)) ids.push(topic)
  }
  return { scope: scope as ScopeMode, topics: ids }
}

/** The session a concrete session-detail topic is about, with the pattern it matches; null for any other id. */
function sessionDetailOf(topic: string): { pattern: string; sessionId: string } | null {
  const parsed = parseTopic(topic)
  if (parsed?.family === 'session' && parsed.kind === 'state') return { pattern: SESSION_STATE_PATTERN, sessionId: parsed.sessionId }
  const turn = sessionOfTurnTopic(topic)
  return turn !== null ? { pattern: TURN_PATTERN, sessionId: turn } : null
}

/**
 * Security: what a delegation lets `topic` through on. A topic it names
 * exactly: `{}`. A concrete `session/<id>/state` or `turn/<id>` whose pattern
 * it names: `{ sessionId }`, and the caller still checks the connection may
 * see that session. Anything else, a pattern itself included: null.
 */
export function delegatedTopicVerdict(delegation: PortDelegation, topic: string): { sessionId?: string } | null {
  if (topic.includes('*')) return null
  if (delegation.topics.includes(topic)) return {}
  const detail = sessionDetailOf(topic)
  if (!detail || detail.sessionId.includes('*') || !delegation.topics.includes(detail.pattern)) return null
  return { sessionId: detail.sessionId }
}
