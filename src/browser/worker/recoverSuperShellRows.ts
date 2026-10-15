/**
 * Recovered `local_supershell` drawer rows after a restart, in two passes: the transcript (calls,
 * notifications, TaskOutput calls), then each call's sidecar, which says whether the run was handed to
 * the background; a detached run with no recorded outcome is `stopped`. Also lists each run's
 * `background: true` steps.
 */

import {
  isAssistantMessage,
  isTextPart,
  isToolResultPart,
  isToolUsePart,
  isUserMessage,
} from '../../runtime/VercelModelConstants'
import type { BrowserToolCallDetailRecord } from '../../utils/toolCallDetails'

export type RecoveredSuperShellRow = {
  /** The tool call id — the drawer's handle for a SuperShell run (live rows use
   *  it too) and its sidecar key. */
  callId: string
  /** The model's `description`, from the transcript's slim preview. Absent → the
   *  publisher uses the generic Super Shell label. */
  description?: string
  /** From the transcript, a result part → success / error (`isError`) and no
   *  result → stopped (interrupted with its turn); for a run that continued in
   *  the background, its own outcome (resolveRecoveredSuperShellRows). Never
   *  'running' — a loaded transcript holds no live run. */
  status: 'success' | 'error' | 'stopped'
  startedAt?: number
  finishedAt?: number
  /** The public task id (`h…`) of a run that continued in the background. */
  taskId?: string
  /** A detached run's result from its `<task-notification>` — what the drawer
   *  detail shows in place of the hand-off. */
  resultText?: string
  /** A detached run's result is in this TaskOutput call's sidecar instead. */
  resultDetailId?: string
}

/** A detached run's outcome as a notification or a TaskOutput read gave it. */
export type SuperShellOutcome = {
  status: 'success' | 'error' | 'stopped'
  resultText: string
  finishedAt?: number
}

export type RecoveredSuperShellScan = {
  rows: RecoveredSuperShellRow[]
  /** `local_supershell` `<task-notification>` outcomes by public task id. */
  notifications: Map<string, SuperShellOutcome>
  /** Every TaskOutput call, in transcript order. Which task it read, and what it
   *  got, are only in its sidecar. `order` compares with `callOrder`. */
  taskOutputCalls: Array<{ callId: string; order: number; finishedAt?: number }>
  /** The transcript position of each row's call. */
  callOrder: Map<string, number>
}

/** The part of a tool-detail sidecar record the sidecar pass reads. */
export type ToolDetailSidecar = Pick<
  BrowserToolCallDetailRecord,
  'toolName' | 'args' | 'result' | 'isError'
>

/** Mirrors MAX_FINISHED_SUPER_SHELLS (SuperShellTaskCoordinator) — the same
 *  "recent tail" the live registry keeps. */
export const MAX_RECOVERED_SUPER_SHELL_ROWS = 40

/** TaskOutput sidecars one recovery loads at most while looking for the call
 *  that read a detached run finished — the bound for a session that polled many
 *  other tasks. */
export const MAX_RECOVERY_TASK_OUTPUT_READS = 50
/**
 * Row sidecars are read this many at a time, ahead of the row being
 * processed. Each read is a bridge round trip, and forty serial ones were the
 * restart's longest wait; a small window overlaps them without a burst.
 */
export const RECOVERY_SIDECAR_READ_CONCURRENCY = 4

const SUPER_SHELL_TOOL_NAME = 'SuperShell'

/** TaskOutput and the older names it still answers to (subAgentControlTools.ts). */
const TASK_OUTPUT_TOOL_NAMES = new Set([
  'TaskOutput',
  'BashOutput',
  'BashOutputTool',
  'AgentOutputTool',
])

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null
}

/** Tool call id off a content part — both spellings of both part kinds. */
function partToolCallId(part: Record<string, unknown>): string | null {
  if (typeof part.id === 'string') return part.id
  if (typeof part.toolCallId === 'string') return part.toolCallId
  return typeof part.toolUseId === 'string' ? part.toolUseId : null
}

function partToolName(part: Record<string, unknown>): string | null {
  if (typeof part.name === 'string') return part.name
  return typeof part.toolName === 'string' ? part.toolName : null
}

function messageTimestamp(record: Record<string, unknown>): number | undefined {
  if (typeof record.timestamp !== 'string') return undefined
  const parsed = Date.parse(record.timestamp)
  return Number.isFinite(parsed) ? parsed : undefined
}

function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

const DETACHED_RE =
  /^SuperShell is still running after \d+s and continues in the background with ID: ([^\s.]+)\./

/** The task id a SuperShell call handed its run to the background with, or null
 *  when the result is the run's own (it ended inline). */
export function parseSuperShellDetachedTaskId(resultText: string): string | null {
  return DETACHED_RE.exec(resultText)?.[1] ?? null
}

const BACKGROUND_STEP_RE = /^▶ .*  background task (\S+)/gm

/** The task ids of the `background: true` steps a SuperShell result or progress
 *  lists ("▶ <command>  background task <id>"). */
export function parseSuperShellBackgroundStepTaskIds(text: string): string[] {
  const ids: string[] = []
  BACKGROUND_STEP_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = BACKGROUND_STEP_RE.exec(text)) !== null) ids.push(match[1])
  return ids
}

/** A notification summary is `SuperShell script "<description>" <status>`, then
 *  the run's result on the next line. */
const NOTIFICATION_HEAD_RE = /^SuperShell script "[\s\S]*?" (?:completed|failed)(?:\n|$)/

const TASK_OUTPUT_FINISHED_RE =
  /^SuperShell script "[\s\S]*?" \[(success|error|stopped)\] — (?:completed|failed|was stopped)\.\n\n/

/** What a TaskOutput result that read a SuperShell run FINISHED says: the run's
 *  status and result. Null for anything else — a run still running, another task
 *  kind, an id TaskOutput did not know. */
export function parseSuperShellTaskOutputResult(
  text: string,
): { status: SuperShellOutcome['status']; resultText: string } | null {
  const head = TASK_OUTPUT_FINISHED_RE.exec(text)
  if (!head) return null
  return {
    status: head[1] as SuperShellOutcome['status'],
    resultText: text.slice(head[0].length),
  }
}

const NOTIFICATION_RE = /<task-notification>([\s\S]*?)<\/task-notification>/g

/**
 * Scan a session transcript (persisted-message shapes, sanitized or not) for
 * SuperShell calls, `local_supershell` completions and TaskOutput calls. Rows
 * are newest last, capped to the most recent MAX_RECOVERED_SUPER_SHELL_ROWS.
 */
export function extractRecoveredSuperShellRows(
  messages: readonly unknown[],
): RecoveredSuperShellScan {
  const byCallId = new Map<string, RecoveredSuperShellRow>()
  const callOrder = new Map<string, number>()
  const notifications = new Map<string, SuperShellOutcome>()
  const taskOutputCalls: RecoveredSuperShellScan['taskOutputCalls'] = []
  const taskOutputByCallId = new Map<
    string,
    RecoveredSuperShellScan['taskOutputCalls'][number]
  >()

  const scanNotifications = (text: string, at: number | undefined): void => {
    if (!text.includes('<task-notification>')) return
    NOTIFICATION_RE.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = NOTIFICATION_RE.exec(text)) !== null) {
      const block = match[1]
      if (!/<task-type>local_supershell<\/task-type>/.test(block)) continue
      const rawId = block.match(/<task-id>([\s\S]*?)<\/task-id>/)?.[1]
      const id = rawId ? unescapeXml(rawId).trim() : ''
      if (!id) continue
      const summary = unescapeXml(
        block.match(/<summary>([\s\S]*?)<\/summary>/)?.[1] ?? '',
      )
      notifications.set(id, {
        // A stopped run is never delivered, so a notification is one of these.
        status: /<status>failed<\/status>/.test(block) ? 'error' : 'success',
        resultText: summary.replace(NOTIFICATION_HEAD_RE, ''),
        ...(at !== undefined ? { finishedAt: at } : {}),
      })
    }
  }

  messages.forEach((message, order) => {
    const record = asRecord(message)
    if (!record || typeof record.type !== 'string') return
    const at = messageTimestamp(record)
    // A completion delivered MID-TURN — a `queued_command` attachment carrying
    // the batch the idle turn would have (never the user's own `prompt`).
    if (record.type === 'attachment') {
      const attachment = asRecord(record.attachment)
      if (
        attachment?.type === 'queued_command' &&
        attachment.commandMode !== 'prompt' &&
        typeof attachment.prompt === 'string'
      ) {
        scanNotifications(attachment.prompt, at)
      }
      return
    }
    const content = asRecord(record.message)?.content

    if (isAssistantMessage(record as { type: string })) {
      if (!Array.isArray(content)) return
      for (const part of content) {
        const p = asRecord(part)
        if (!p || typeof p.type !== 'string') continue
        if (!isToolUsePart(p as { type: string })) continue
        const callId = partToolCallId(p)
        if (!callId) continue
        const name = partToolName(p)
        if (name === SUPER_SHELL_TOOL_NAME) {
          const args = asRecord(p.args) ?? asRecord(p.input)
          const description =
            typeof args?.description === 'string' && args.description.trim()
              ? args.description.trim()
              : undefined
          byCallId.set(callId, {
            callId,
            ...(description !== undefined ? { description } : {}),
            status: 'stopped',
            ...(at !== undefined ? { startedAt: at } : {}),
          })
          callOrder.set(callId, order)
        } else if (name !== null && TASK_OUTPUT_TOOL_NAMES.has(name)) {
          const call = { callId, order }
          taskOutputCalls.push(call)
          taskOutputByCallId.set(callId, call)
        }
      }
      return
    }

    if (!isUserMessage(record as { type: string })) return
    // A completion delivered at the idle boundary: that turn's prompt is a
    // plain string, persisted as the user message's whole content.
    if (typeof content === 'string') {
      scanNotifications(content, at)
      return
    }
    if (!Array.isArray(content)) return
    for (const part of content) {
      const p = asRecord(part)
      if (!p || typeof p.type !== 'string') continue
      if (isToolResultPart(p as { type: string })) {
        const callId = partToolCallId(p)
        if (!callId) continue
        const row = byCallId.get(callId)
        if (row) {
          row.status = p.isError === true ? 'error' : 'success'
          if (at !== undefined) row.finishedAt = at
          continue
        }
        const read = taskOutputByCallId.get(callId)
        if (read && at !== undefined) read.finishedAt = at
        continue
      }
      if (isTextPart(p as { type: string }) && typeof p.text === 'string') {
        scanNotifications(p.text, at)
      }
    }
  })

  const rows = Array.from(byCallId.values())
  return {
    rows:
      rows.length > MAX_RECOVERED_SUPER_SHELL_ROWS
        ? rows.slice(rows.length - MAX_RECOVERED_SUPER_SHELL_ROWS)
        : rows,
    notifications,
    taskOutputCalls,
    callOrder,
  }
}

/**
 * Complete a scan with each call's tool-detail sidecar (`loadDetail`, by tool
 * call id; best-effort — a missing sidecar keeps the row as the transcript left
 * it). Mutates and returns the scan's rows, plus the task ids of every
 * `background: true` step the runs' results list.
 */
export async function resolveRecoveredSuperShellRows(
  scan: RecoveredSuperShellScan,
  loadDetail: (toolCallId: string) => Promise<ToolDetailSidecar | null>,
): Promise<{
  rows: RecoveredSuperShellRow[]
  backgroundStepTaskIds: Set<string>
}> {
  const backgroundStepTaskIds = new Set<string>()
  const collectSteps = (text: string): void => {
    for (const id of parseSuperShellBackgroundStepTaskIds(text)) {
      backgroundStepTaskIds.add(id)
    }
  }
  const load = async (toolCallId: string): Promise<ToolDetailSidecar | null> => {
    try {
      return await loadDetail(toolCallId)
    } catch {
      return null
    }
  }
  // TaskOutput sidecars, each read at most once: several detached runs can look
  // through the same later calls.
  const reads = new Map<string, Promise<ToolDetailSidecar | null>>()
  /** The first TaskOutput call after `callId`'s that read `taskId` finished. */
  const findFinishedRead = async (callId: string, taskId: string) => {
    const after = scan.callOrder.get(callId) ?? -1
    for (const call of scan.taskOutputCalls) {
      if (call.order <= after) continue
      let pending = reads.get(call.callId)
      if (!pending) {
        if (reads.size >= MAX_RECOVERY_TASK_OUTPUT_READS) return null
        pending = load(call.callId)
        reads.set(call.callId, pending)
      }
      const read = await pending
      const args = asRecord(read?.args)
      if (typeof args?.task_id !== 'string' || args.task_id.trim() !== taskId) continue
      const outcome =
        typeof read?.result === 'string' ? parseSuperShellTaskOutputResult(read.result) : null
      if (outcome) return { call, outcome }
    }
    return null
  }
  const settle = (
    row: RecoveredSuperShellRow,
    status: RecoveredSuperShellRow['status'],
    finishedAt: number | undefined,
  ): void => {
    row.status = status
    if (finishedAt !== undefined) row.finishedAt = finishedAt
    else delete row.finishedAt
  }

  // Row sidecars are read ahead, RECOVERY_SIDECAR_READ_CONCURRENCY at a time.
  // Only the reads overlap: rows are still processed in scan order, one at a
  // time, so the outcome is exactly the serial one. (`load` never rejects, so
  // a read nobody has reached yet cannot become an unhandled rejection.)
  const rowReads: Array<Promise<ToolDetailSidecar | null>> = []
  const readRowsAhead = (index: number): void => {
    const end = Math.min(index + RECOVERY_SIDECAR_READ_CONCURRENCY, scan.rows.length)
    while (rowReads.length < end) rowReads.push(load(scan.rows[rowReads.length].callId))
  }

  for (let index = 0; index < scan.rows.length; index++) {
    const row = scan.rows[index]
    readRowsAhead(index)
    const detail = await rowReads[index]
    if (!detail || detail.toolName !== SUPER_SHELL_TOOL_NAME) continue
    const callResult = typeof detail.result === 'string' ? detail.result : ''
    collectSteps(callResult)
    const taskId = parseSuperShellDetachedTaskId(callResult)
    if (taskId === null) {
      // It ended inline: the transcript's outcome stands, but a result part may
      // not carry `isError` — the sidecar does.
      if (detail.isError === true) row.status = 'error'
      continue
    }
    // The call's own result is only the hand-off.
    row.taskId = taskId
    const notified = scan.notifications.get(taskId)
    if (notified) {
      settle(row, notified.status, notified.finishedAt)
      row.resultText = notified.resultText
      collectSteps(notified.resultText)
      continue
    }
    const read = await findFinishedRead(row.callId, taskId)
    if (read) {
      settle(row, read.outcome.status, read.call.finishedAt)
      row.resultDetailId = read.call.callId
      collectSteps(read.outcome.resultText)
      continue
    }
    // Neither: still running when the app closed, or stopped.
    settle(row, 'stopped', undefined)
  }
  return { rows: scan.rows, backgroundStepTaskIds }
}
