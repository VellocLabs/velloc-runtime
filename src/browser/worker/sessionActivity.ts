/**
 * What a session is doing now and how its last turn ended, as the sessions
 * summary publishes them for the start card and the session link chip (F-36).
 * Pure; the feed reads the live phase and the cached terminal reason.
 */
import type {
  NexusSessionActivity,
  NexusTurnEnding,
} from '../bridge/protocol/ui'
import type { AgentSessionPhase } from './AgentTurnState'
import {
  TERMINAL_ABORTED,
  TERMINAL_AWAITING_USER,
  TERMINAL_COMPLETED,
  TERMINAL_MAX_TURNS,
  TERMINAL_NEXT_TURN,
  TERMINAL_STOP_HOOK_PREVENTED,
} from '../../runtime/VercelModelConstants'

/** The running session's activity: the top in-flight tool, a retry, or the reply streaming; none when idle. */
export function sessionActivityOf(phase: AgentSessionPhase): NexusSessionActivity | undefined {
  if (phase.kind !== 'running') return undefined
  const sub = phase.sub
  if (sub.type === 'tools') {
    const top = sub.tools[sub.tools.length - 1]
    return top ? { kind: 'tool', tool: top.name } : { kind: 'responding' }
  }
  if (sub.type === 'retry') return { kind: 'retrying' }
  return { kind: 'responding' }
}

/**
 * How the last turn ended, from the stored terminal reason. A halt on the
 * person is not an ending (the waiting flag says it); an unknown reason and a
 * hand-over to a next turn are none.
 */
export function turnEndingOf(reason: string | undefined): NexusTurnEnding | undefined {
  switch (reason) {
    case undefined:
    case '':
    case TERMINAL_AWAITING_USER:
    case TERMINAL_NEXT_TURN:
      return undefined
    case TERMINAL_COMPLETED:
    case TERMINAL_STOP_HOOK_PREVENTED:
    case TERMINAL_MAX_TURNS:
      return 'finished'
    case TERMINAL_ABORTED:
      return 'stopped'
    default:
      return 'failed'
  }
}

export function activitiesEqual(
  a: NexusSessionActivity | undefined,
  b: NexusSessionActivity | undefined,
): boolean {
  if (a === b) return true
  if (!a || !b || a.kind !== b.kind) return false
  return a.kind !== 'tool' || a.tool === (b as { tool: string }).tool
}
