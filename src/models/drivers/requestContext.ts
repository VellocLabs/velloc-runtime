/**
 * The request context every model request carries. `purposeOfQuerySource` maps a
 * caller tag to a coarse purpose (unlisted = `other`); `requestIdentityOf` gives
 * `{ sessionId, agentId }`, `sessionId` always the top-level session.
 */
import type {
  BridgeModelRequestContext,
  BridgeModelRequestPurpose,
} from '../../browser/bridge/browserBridgeProtocol'

/** The compaction summarizer's caller tag (auto and `/compact` alike). */
export const COMPACTION_QUERY_SOURCE = 'compact'

/**
 * Every caller tag the runtime sends, by purpose. A sub-agent's own loop
 * (`agent_tool`) is a turn — its `agentId` tells it apart from the root's;
 * `fork` is a side run forked from the conversation (a forked skill, an agent
 * hook, the memory writers).
 */
const PURPOSE_BY_QUERY_SOURCE: Readonly<Record<string, BridgeModelRequestPurpose>> = {
  sdk: 'turn',
  agent_tool: 'turn',
  [COMPACTION_QUERY_SOURCE]: 'compaction',
  rename_generate_name: 'title',
  mod_model_complete: 'mod',
  mod_model_fork: 'mod',
  skill_fork: 'fork',
  hook_agent: 'fork',
  extract_memories: 'fork',
  periodic_tidy: 'fork',
  memory_recall: 'other',
  web_fetch_apply: 'other',
  fast_model_call: 'other',
}

/** The caller tags `purposeOfQuerySource` knows (for its tests). */
export const KNOWN_QUERY_SOURCES: readonly string[] = Object.keys(PURPOSE_BY_QUERY_SOURCE)

export function purposeOfQuerySource(querySource: string): BridgeModelRequestPurpose {
  return Object.prototype.hasOwnProperty.call(PURPOSE_BY_QUERY_SOURCE, querySource)
    ? PURPOSE_BY_QUERY_SOURCE[querySource]!
    : 'other'
}

/** The ids a call context holds that say who is asking. */
export type RequestIdentitySource = {
  /** The session the loop runs in (a teammate's own session id). */
  sessionId?: string
  /** Set on a spawned child session (a teammate): its lead's session. */
  spawnerSessionId?: string
  /** Set on a loop under the session (a sub-agent, a fork): its id. */
  agentId?: string
}

/**
 * `sessionId` is the top-level session: a spawned child's lead, else the
 * session itself. `agentId` is the loop under it: a sub-agent's / fork's id,
 * else — for a spawned child — the child session's own id.
 */
export function requestIdentityOf(
  source: RequestIdentitySource,
): Pick<BridgeModelRequestContext, 'sessionId' | 'agentId'> {
  const own = source.sessionId || undefined
  const root = source.spawnerSessionId || undefined
  const agentId = source.agentId || (root ? own : undefined)
  const sessionId = root ?? own
  return {
    ...(sessionId ? { sessionId } : {}),
    ...(agentId ? { agentId } : {}),
  }
}

export function buildRequestContext(
  source: RequestIdentitySource,
  querySource: string,
): BridgeModelRequestContext {
  return {
    ...requestIdentityOf(source),
    purpose: purposeOfQuerySource(querySource),
    querySource,
  }
}
