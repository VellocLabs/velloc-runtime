/**
 * The Agent tool's events (F-25): `agent.offer` (`{ isOffered: false }` hides a type
 * and refuses its dispatch; a failing hook passes it) and `agent.spawn` (resolves to
 * `{ model }`, or `{ deny }`). Pure shapes and answer checks.
 */

import type { Origin } from './modTypes'

export const ENGINE_PROVIDER: Origin = Object.freeze({ plugin: 'engine', tier: 'core' as const })

export type AgentOfferInput = {
  agent: string
  description: string
  source: string
  provider: Origin
}

export type AgentOfferResult = { isOffered: boolean }

export type AgentSpawnInput = {
  tool_use_id: string
  prompt: string
  description: string
  subagentType: string
  provider: Origin
  model?: string
  parentModel: string
  parentAgentId?: string
  permissionMode?: string
  background: boolean
  fork: boolean
  name?: string
  cwd?: string
  /** `'worktree'` when the call asked for its own checkout. Seen, not
   *  rewritten: the tool does not read it back. */
  isolation?: 'worktree'
}

/** What the tool reads back after the chain: the content a hook may have
 *  rewritten, and the model the chain settled on. */
export type AgentSpawnDecision = {
  prompt: string
  description: string
  subagentType: string
  model?: string
  background: boolean
  cwd?: string
}

export type AgentSpawnSettlement = AgentSpawnDecision | { deny: string }

/** The fields of `e` a hook may rewrite; the rest are pinned. */
const SPAWN_REWRITABLE = new Set(['prompt', 'description', 'subagentType', 'model', 'background', 'cwd'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isAgentOfferResult(value: unknown): boolean {
  return isRecord(value) && typeof value.isOffered === 'boolean'
}

export function isAgentSpawnResult(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (typeof value.deny === 'string') return value.deny !== ''
  return typeof value.model === 'string'
}

/**
 * Whether a rewritten `e` is one the spawn can run with: the pinned fields
 * unchanged (left out they are kept), the rewritable ones of the right kind.
 * Returns the reason it is not, or null.
 */
export function spawnInputProblem(original: AgentSpawnInput, e: unknown): string | null {
  if (!isRecord(e)) return 'the event argument is not an object'
  for (const key of Object.keys(e)) {
    if (SPAWN_REWRITABLE.has(key)) continue
    if (!(key in original)) return `${key} is not a field of agent.spawn`
    const own = original[key as keyof AgentSpawnInput]
    const given = e[key]
    if (key === 'provider') {
      if (JSON.stringify(given) !== JSON.stringify(own)) return 'provider is pinned'
      continue
    }
    if (given !== undefined && given !== own) return `${key} is pinned`
  }
  if (typeof e.prompt !== 'string' || e.prompt.trim() === '') return 'prompt is not a non-empty string'
  if (typeof e.description !== 'string') return 'description is not a string'
  if (typeof e.subagentType !== 'string' || e.subagentType === '') return 'subagentType is not a name'
  if (e.model !== undefined && typeof e.model !== 'string') return 'model is not a string'
  if (typeof e.background !== 'boolean') return 'background is not a boolean'
  if (e.cwd !== undefined && typeof e.cwd !== 'string') return 'cwd is not a string'
  if (original.fork && e.subagentType !== original.subagentType) return 'a fork dispatches no other agent'
  return null
}

/** The decision read back from the `e` the chain's core was handed. */
export function spawnDecisionOf(e: AgentSpawnInput): AgentSpawnDecision {
  return {
    prompt: e.prompt,
    description: e.description,
    subagentType: e.subagentType,
    ...(e.model !== undefined ? { model: e.model } : {}),
    background: e.background,
    ...(e.cwd !== undefined ? { cwd: e.cwd } : {}),
  }
}
