/**
 * `runtime.getRestartReadiness` — may the page reload into a new build without losing worker-only
 * state? Conservative: a source that could not be read (`null`) blocks; never ready by default.
 */
import type { ConnectionInfo } from './types'

export type RestartBlocker =
  /** A live session's turn is not idle (teammates and sub-agent sessions included). */
  | 'turn_running'
  /** A TaskRegistry task (shell, SuperShell, local_js, sub-agent, fork, …) is still live. */
  | 'task_running'
  /** A session is halted on an AskUserQuestion / permission ask. */
  | 'awaiting_answer'
  /** A teammate that is not `stopped` — idle teammates live only in worker memory. */
  | 'team_live'
  /** A headless routine run is in flight. */
  | 'routine_running'
  /** A runtime connection other than the caller's own window (remote, or another panel). */
  | 'other_clients'

export type RestartReadiness = { ready: boolean; reasons: RestartBlocker[] }

/** One live session as the manager sees it. `idle: null` = its phase could not be read. */
export type RestartSessionInput = {
  sessionId: string
  idle: boolean | null
  needsAnswer: boolean | null
}

/**
 * What the SharedWorker session manager reports (`SessionSurfaceHost.
 * getRestartReadinessInputs`). A `null` field = that source could not be read.
 */
export type RestartWorkInputs = {
  sessions: RestartSessionInput[] | null
  /** Live TaskRegistry entries of ANY type (no local_fork / local_fast carve-out). */
  liveTaskCount: number | null
  /** Status of every teammate on record. */
  teammateStatuses: ReadonlyArray<'active' | 'idle' | 'stopped'> | null
  /** RoutineCoordinator headless runs in flight. */
  headlessRunCount: number | null
}

export type RestartReadinessInputs = RestartWorkInputs & {
  /** The requesting connection. */
  caller: Pick<ConnectionInfo, 'connectionId' | 'panelId' | 'transport'>
  /** Every open runtime connection, the caller's included; `null` = unreadable. */
  connections: ReadonlyArray<Pick<ConnectionInfo, 'connectionId' | 'panelId' | 'transport'>> | null
}

/**
 * A connection that is not the caller's own window. The caller's window may
 * hold TWO connections — the guest page and the outer WebUI panel-host port —
 * both on this machine (`message-port`) with the same `panelId`; those are the
 * caller. A `websocket` connection is a remote-access client and always
 * counts. A caller without a `panelId` cannot prove any other connection is
 * its own, so every other connection counts.
 */
export function isOtherClient(
  caller: RestartReadinessInputs['caller'],
  conn: RestartReadinessInputs['caller'],
): boolean {
  if (conn.connectionId === caller.connectionId) return false
  if (conn.transport === 'websocket') return true
  if (caller.panelId === undefined || conn.panelId === undefined) return true
  return conn.panelId !== caller.panelId
}

export function computeRestartReadiness(inputs: RestartReadinessInputs): RestartReadiness {
  const reasons = new Set<RestartBlocker>()
  const { sessions } = inputs
  if (sessions === null) {
    reasons.add('turn_running')
    reasons.add('awaiting_answer')
  } else {
    for (const s of sessions) {
      if (s.idle !== true) reasons.add('turn_running')
      if (s.needsAnswer !== false) reasons.add('awaiting_answer')
    }
  }
  if (inputs.liveTaskCount === null || inputs.liveTaskCount > 0) reasons.add('task_running')
  if (inputs.teammateStatuses === null || inputs.teammateStatuses.some(s => s !== 'stopped')) {
    reasons.add('team_live')
  }
  if (inputs.headlessRunCount === null || inputs.headlessRunCount > 0) reasons.add('routine_running')
  if (inputs.connections === null || inputs.connections.some(c => isOtherClient(inputs.caller, c))) {
    reasons.add('other_clients')
  }
  const ORDER: RestartBlocker[] = [
    'turn_running', 'task_running', 'awaiting_answer', 'team_live', 'routine_running', 'other_clients',
  ]
  const list = ORDER.filter(r => reasons.has(r))
  return { ready: list.length === 0, reasons: list }
}

/** Every work source unreadable — what a host without the reader reports. */
export const UNREADABLE_WORK_INPUTS: RestartWorkInputs = {
  sessions: null,
  liveTaskCount: null,
  teammateStatuses: null,
  headlessRunCount: null,
}
