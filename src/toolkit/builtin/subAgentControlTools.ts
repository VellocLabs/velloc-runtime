/**
 * Model-facing control tools for background sub-agents (TaskStop, TaskOutput,
 * AgentResume), keyed by the sub-agent's session id. They degrade with a clear
 * message when the manager hasn't registered the controller.
 */

import type { ToolContract, InputCheck } from '../toolContract'
import type { ToolCallContext } from '../toolCallContext'
import { declareTool } from '../toolContract'
import {
  getSubAgentController,
  type SubAgentSnapshot,
  type SubAgentListEntry,
} from '../../team/subAgentController'
import {
  getTeamMessenger,
  type TeammateRosterEntry,
} from '../../team/teamMessenger'

/**
 * Teammates are child sessions, not background tasks: the control tools only show
 * them, and `TaskOutput` answers a `teammate-…` id with its status, never a wait.
 */
const TEAMMATE_ID_PREFIX = 'teammate-'

function isTeammateId(id: string): boolean {
  return id.startsWith(TEAMMATE_ID_PREFIX)
}

function teammatesOf(headSessionId: string | undefined): TeammateRosterEntry[] {
  if (!headSessionId) return []
  return getTeamMessenger()?.listMembers?.(headSessionId) ?? []
}

const TEAMMATE_STATUS_TEXT: Record<TeammateRosterEntry['status'], string> = {
  active: 'working on its current turn',
  idle: 'idle — its last turn is finished and reported (or the report is on its way)',
  stopped: 'stopped',
  lost:
    'LOST — it was running when the browser restarted, and teammates do not survive a restart. ' +
    'This is not a provider failure. Its transcript is kept (read-only) and the tasks it held were released; ' +
    'spawn a new teammate to continue its work.',
}

/** How a teammate's report reaches the lead — the sentence every teammate
 *  row carries, because polling for it is the mistake this exists to stop. */
const TEAMMATE_REPORT_HINT =
  'A teammate reports at the end of each of its turns, and the report ' +
  'arrives as a NEW turn in this session — so end your turn to receive it; ' +
  'polling cannot bring it sooner. Brief it again with SendMessage, end it ' +
  'with Shutdown.'

function formatTeammateEntry(t: TeammateRosterEntry): string {
  return `  [${t.status}] ${t.sessionId} — teammate "${t.name}": ${TEAMMATE_STATUS_TEXT[t.status]}`
}

export const JOB_HALT_TOOL_ID = 'TaskStop'
export const JOB_READ_TOOL_ID = 'TaskOutput'
export const AGENT_RESUME_TOOL_NAME = 'AgentResume'
export const AGENT_LIST_TOOL_NAME = 'AgentList'

const SUB_AGENT_STATUSES = ['running', 'success', 'error', 'stopped'] as const
type SubAgentStatusFilter = (typeof SUB_AGENT_STATUSES)[number]

const CONTROLLER_NOT_READY =
  'Background sub-agent control unavailable: not running inside the background ' +
  'runtime (no active session manager). This happens in headless / test contexts.'

/** Default + upper bound for TaskOutput's blocking wait. */
const JOB_READ_WAIT_MS = 30_000
const JOB_READ_WAIT_CAP_MS = 600_000

function requireTaskId(
  task_id: string | undefined,
  errorCode: number,
): InputCheck {
  if (typeof task_id !== 'string' || task_id.trim().length === 0) {
    return { result: false, message: 'task_id is required.', errorCode }
  }
  return { result: true }
}

// ---------------------------------------------------------------------------
// TaskStop (G1) — stop a running background sub-agent by id
// ---------------------------------------------------------------------------

export type TaskStopInput = { task_id?: string }

export const JobHaltTool: ToolContract<TaskStopInput, string> = declareTool({
  name: JOB_HALT_TOOL_ID,
  discoveryHint: 'stop a running background sub-agent by its task id',
  argsSchema: {
    type: 'object',
    properties: {
      task_id: {
        type: 'string',
        description:
          'The id of the background sub-agent to stop (the "subagent-…" id returned when you launched it with Agent run_in_background).',
      },
    },
    required: ['task_id'],
  },
  description: async () => 'Stop a running background sub-agent by id',
  parallelSafe: () => true,
  readsOnly: () => false,
  async checkInput(input: TaskStopInput): Promise<InputCheck> {
    const idCheck = requireTaskId(input.task_id, 1)
    if (!idCheck.result) return idCheck
    // TaskStop is for a RUNNING sub-agent only — a finished one is READ via TaskOutput, not
    // stopped. Reject up-front so the model gets an error, not the prior
    // success-shaped advisory it could ignore (then answer from stale work
    // while the real result auto-delivers a turn later). Skip the gate when the
    // controller isn't registered (test / headless) — call() returns
    // CONTROLLER_NOT_READY there.
    const controller = getSubAgentController()
    if (controller) {
      const id = (input.task_id ?? '').trim()
      const snap = controller.getSnapshot(id)
      if (!snap) {
        return {
          result: false,
          message: `No background sub-agent found with id "${id}". It may have been evicted or the id is wrong.`,
          errorCode: 2,
        }
      }
      if (snap.status !== 'running') {
        return {
          result: false,
          message: `Sub-agent "${snap.description}" (${id}) is not running (status: ${snap.status}) — nothing to stop. Read its result with TaskOutput.`,
          errorCode: 3,
        }
      }
    }
    return { result: true }
  },
  async call(input: TaskStopInput) {
    const controller = getSubAgentController()
    if (!controller) return { data: CONTROLLER_NOT_READY }
    const id = (input.task_id ?? '').trim()
    const result = controller.stop(id)
    // Defense-in-depth for the validateInput→call race: a sub-agent that reached a terminal
    // state in that window is an error, not a success — thrown here so
    // toolExecution surfaces it as isError, the same as the validateInput gate.
    if (result.status === 'not_found') {
      throw new Error(
        `No background sub-agent found with id "${id}". It may have already finished (read it with TaskOutput) or the id is wrong.`,
      )
    }
    if (result.status === 'already_finished') {
      throw new Error(
        `Background sub-agent "${result.description ?? id}" (${id}) is not running — it already finished. Read its result with TaskOutput.`,
      )
    }
    return {
      data: `Stopped background sub-agent "${result.description ?? id}" (${id}). Its partial output is still readable with TaskOutput.`,
    }
  },
})

// ---------------------------------------------------------------------------
// TaskOutput (G3) — read status / output of a background sub-agent by id
// ---------------------------------------------------------------------------

export type TaskOutputInput = {
  task_id?: string
  block?: boolean
  timeout?: number
}

function formatSnapshot(snap: SubAgentSnapshot, blocked: boolean): string {
  const kind =
    snap.taskType === 'local_bash'
      ? 'Background shell'
      : snap.taskType === 'local_supershell'
        ? 'SuperShell script'
        : 'Background sub-agent'
  const label = `${kind} "${snap.description}"${
    snap.agentType ? ` (${snap.agentType})` : ''
  }`
  if (snap.status === 'running') {
    const partial = snap.output.trim()
      ? `\n\nPartial output so far:\n${snap.output}`
      : ''
    const waited = blocked ? ' (timed out waiting for completion)' : ''
    const progress = snap.updates ? ` (${snap.updates} updates so far)` : ''
    return `${label} [running] — still running${progress}${waited}.${partial}`
  }
  const verb =
    snap.status === 'stopped'
      ? 'was stopped'
      : snap.status === 'error'
        ? 'failed'
        : 'completed'
  return `${label} [${snap.status}] — ${verb}.\n\n${snap.output || '(no output)'}`
}

export const JobReadTool: ToolContract<TaskOutputInput, string> = declareTool({
  name: JOB_READ_TOOL_ID,
  // Kind-agnostic read; the old per-kind names are aliases. `BashOutput` (the
  // former separate hosted shell-read tool) now resolves here so any stray/back-compat call still works.
  aliases: ['BashOutput', 'BashOutputTool', 'AgentOutputTool'],
  discoveryHint: 'read status/output of a background task (sub-agent or shell) by its task id',
  argsSchema: {
    type: 'object',
    properties: {
      task_id: {
        type: 'string',
        description:
          'The id of the background task to read: a sub-agent id (the "subagent-…" id from the Agent launch ack) OR a background-shell id (from a Bash/PowerShell run_in_background launch).',
      },
      block: {
        type: 'boolean',
        description:
          'Wait for the task to finish before returning (default true). false = return the current status/partial output immediately.',
      },
      timeout: {
        type: 'number',
        description:
          'Max time to wait in ms when block is true (default 30000, max 600000). On timeout you get the current partial output.',
      },
    },
    required: ['task_id'],
  },
  description: async () =>
    'Read the status/output of a background task (sub-agent or shell) by id',
  parallelSafe: () => true,
  readsOnly: () => true,
  async checkInput(input: TaskOutputInput): Promise<InputCheck> {
    return requireTaskId(input.task_id, 1)
  },
  async call(input: TaskOutputInput, context: ToolCallContext) {
    const controller = getSubAgentController()
    if (!controller) return { data: CONTROLLER_NOT_READY }
    const id = (input.task_id ?? '').trim()
    // A teammate id: status only, never a wait (see TEAMMATE_ID_PREFIX).
    if (isTeammateId(id)) {
      const mate = teammatesOf(context.options.sessionId).find(
        (t) => t.sessionId === id,
      )
      if (!mate) {
        return {
          data: `No running teammate with session id "${id}" in this team. AgentList shows the teammates you have; a teammate you Shutdown is gone.`,
        }
      }
      return {
        data: `Teammate "${mate.name}" [${mate.status}] — ${TEAMMATE_STATUS_TEXT[mate.status]}. ${TEAMMATE_REPORT_HINT}`,
      }
    }
    const block = input.block !== false
    const timeout = Math.min(
      Math.max(typeof input.timeout === 'number' ? input.timeout : JOB_READ_WAIT_MS, 0),
      JOB_READ_WAIT_CAP_MS,
    )
    let snap = controller.getSnapshot(id)
    if (!snap) {
      return {
        data: `No background task found with id "${id}". Use the id from the Agent launch ack (e.g. "subagent-…") or from a Bash/PowerShell run_in_background launch.`,
      }
    }
    if (block && snap.status === 'running') {
      // Thread THIS turn's abort signal so a Stop while blocked here unblocks
      // immediately (and stops the awaited sub-agent) — without it, Stop can't
      // interrupt the wait and the turn stays "running" for the sub-agent's
      // full run or the (model-settable, up-to-10-min) timeout.
      const waited = await controller.waitForCompletion(
        id,
        timeout,
        context.cancelSource?.signal,
      )
      if (waited) snap = waited
    }
    // Reading the TERMINAL result here is the model's delivery of it — suppress
    // the duplicate auto-delivery turn the manager would otherwise inject. A
    // still-`running` snapshot is NOT acknowledged: the model
    // hasn't seen the answer yet, so the later delivery is its first sight.
    if (snap.status !== 'running') controller.acknowledgeResult?.(id)
    return { data: formatSnapshot(snap, block) }
  },
})

// ---------------------------------------------------------------------------
// AgentResume (G4) — continue a finished background sub-agent with a follow-up
// ---------------------------------------------------------------------------

export type AgentResumeInput = { task_id?: string; prompt?: string }

export const AgentResumeTool: ToolContract<AgentResumeInput, string> = declareTool({
  name: AGENT_RESUME_TOOL_NAME,
  discoveryHint: 'continue a finished background sub-agent with a follow-up prompt',
  argsSchema: {
    type: 'object',
    properties: {
      task_id: {
        type: 'string',
        description:
          'The id of the finished background sub-agent to continue (the "subagent-…" id from its launch ack).',
      },
      prompt: {
        type: 'string',
        description:
          'The follow-up directive. The sub-agent resumes with its full prior context (transcript) preserved, so this is a directive, not a re-briefing.',
      },
    },
    required: ['task_id', 'prompt'],
  },
  description: async () => 'Continue a finished background sub-agent with a follow-up',
  parallelSafe: () => false,
  readsOnly: () => false,
  async checkInput(input: AgentResumeInput): Promise<InputCheck> {
    const idCheck = requireTaskId(input.task_id, 1)
    if (!idCheck.result) return idCheck
    if (typeof input.prompt !== 'string' || input.prompt.trim().length === 0) {
      return { result: false, message: 'prompt is required.', errorCode: 2 }
    }
    return { result: true }
  },
  async call(input: AgentResumeInput, _context: ToolCallContext) {
    const controller = getSubAgentController()
    if (!controller) return { data: CONTROLLER_NOT_READY }
    const id = (input.task_id ?? '').trim()
    const result = controller.resume(id, (input.prompt ?? '').trim())
    if (result.ok) {
      return {
        data:
          `Resumed background sub-agent (task id ${result.sessionId}) with your follow-up. ` +
          `It runs in its own isolated context with its prior transcript preserved and will ` +
          `report its result to you in a later turn — you will NOT see it inline. Continue ` +
          `with other work or end your turn.`,
      }
    }
    if (result.reason === 'still_running') {
      return {
        data: `Sub-agent "${id}" is still running — read it with TaskOutput or stop it with TaskStop before resuming.`,
      }
    }
    if (result.reason === 'unavailable') {
      return { data: CONTROLLER_NOT_READY }
    }
    return {
      data: `No resumable background sub-agent found with id "${id}". Only finished sub-agents from this session can be resumed; the record may have been evicted or the id is wrong.`,
    }
  },
})

// ---------------------------------------------------------------------------
// AgentList (G2) — enumerate background sub-agents launched from this session
// ---------------------------------------------------------------------------

export type AgentListInput = { status?: SubAgentStatusFilter }

function formatListEntry(e: SubAgentListEntry): string {
  const label = `"${e.description}"${e.agentType ? ` (${e.agentType})` : ''}`
  const progress =
    e.status === 'running' && e.updates ? ` · ${e.updates} updates` : ''
  return `  [${e.status}] ${e.sessionId} — ${label}${progress}`
}

export const AgentListTool: ToolContract<AgentListInput, string> = declareTool({
  name: AGENT_LIST_TOOL_NAME,
  discoveryHint: 'list the background sub-agents launched from this session',
  argsSchema: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: SUB_AGENT_STATUSES as unknown as string[],
        description:
          'Optional filter: only sub-agents in this state (running | success | error | stopped).',
      },
    },
    required: [],
  },
  description: async () =>
    'List the background sub-agents launched from this session (with their task ids)',
  parallelSafe: () => true,
  readsOnly: () => true,
  async checkInput(input: AgentListInput): Promise<InputCheck> {
    if (
      input.status !== undefined &&
      !SUB_AGENT_STATUSES.includes(input.status)
    ) {
      return {
        result: false,
        message: `status must be one of: ${SUB_AGENT_STATUSES.join(', ')}.`,
        errorCode: 1,
      }
    }
    return { result: true }
  },
  async call(input: AgentListInput, context: ToolCallContext) {
    const controller = getSubAgentController()
    if (!controller) return { data: CONTROLLER_NOT_READY }
    const spawnerSessionId = context.options.sessionId
    if (!spawnerSessionId) {
      return {
        data:
          'No session context: background sub-agents are listed per launching session, and this turn has no session id.',
      }
    }
    let entries = controller.list(spawnerSessionId)
    if (input.status) entries = entries.filter((e) => e.status === input.status)
    // Teammates are listed regardless of the sub-agent status filter: its
    // vocabulary (running/success/error/stopped) is a task's, and a
    // teammate's `active`/`idle` is neither. Hiding the roster behind a
    // filter that cannot name it is how a lead concluded it had no teammate.
    const mates = teammatesOf(spawnerSessionId)
    const teammateBlock =
      mates.length > 0
        ? `Teammates of this session (${mates.length}, ${mates.filter((t) => t.status === 'active').length} active):\n` +
          mates.map(formatTeammateEntry).join('\n') +
          `\n${TEAMMATE_REPORT_HINT}`
        : ''
    if (entries.length === 0) {
      const none = input.status
        ? `No background sub-agents in state "${input.status}" for this session.`
        : 'No background sub-agents have been launched from this session.'
      return { data: teammateBlock ? `${none}\n\n${teammateBlock}` : none }
    }
    const running = entries.filter((e) => e.status === 'running').length
    const subAgentBlock =
      `Background sub-agents for this session (${entries.length}, ${running} running):\n` +
      entries.map(formatListEntry).join('\n')
    return {
      data: teammateBlock ? `${subAgentBlock}\n\n${teammateBlock}` : subAgentBlock,
    }
  },
})
