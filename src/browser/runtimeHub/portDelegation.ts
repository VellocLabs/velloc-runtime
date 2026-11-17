/**
 * A runtime port handed to code its creator does not trust (F-42): the creator
 * caps the scope and names the only topics it may subscribe to, before the
 * port leaves its hands. `ConnectionHub` enforces it; `hello` cannot widen it.
 */

import { SCOPE_MODES, type ScopeMode, type TopicId } from '../runtimeProtocol/frames'

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
