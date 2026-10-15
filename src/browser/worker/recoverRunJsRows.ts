/**
 * Recovered `local_js` ("Super Edit") drawer rows after a restart: one row per `SuperEdit` call from
 * the transcript, status from its tool result; source/result load lazily from the sidecar. Ids the
 * registry still knows are skipped.
 */

import {
  isAssistantMessage,
  isToolResultPart,
  isToolUsePart,
  isUserMessage,
} from '../../runtime/VercelModelConstants'

export type RecoveredRunJsRow = {
  /** The tool call id — also the `local_js` public task id (see
   *  SideTaskCoordinator.registerRunJs). */
  callId: string
  /** The model's `description` arg, when the transcript's slim preview kept
   *  it. Absent for a pre-preview historical session — the publisher falls
   *  back to the generic Super Edit display label. */
  description?: string
  /** Terminal status from the transcript: a matched tool-result maps to
   *  success/error (via `isError`); a call with no result was interrupted
   *  with its turn → 'stopped'. Never 'running' — a loaded transcript holds
   *  no live run. */
  status: 'success' | 'error' | 'stopped'
  startedAt?: number
  finishedAt?: number
}

/** Mirrors MAX_FINISHED_RUN_JS (SideTaskCoordinator) — the same "recent
 *  tail" the live registry keeps. */
export const MAX_RECOVERED_RUN_JS_ROWS = 40

const SUPER_EDIT_TOOL_NAME = 'SuperEdit'

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null
}

/** Tool call id off a content part — both spellings, like toolCallDetails. */
function partToolCallId(part: Record<string, unknown>): string | null {
  if (typeof part.id === 'string') return part.id
  return typeof part.toolCallId === 'string' ? part.toolCallId : null
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

/**
 * Scan a session transcript (persisted-message shapes, sanitized or not) for
 * `run_js` tool calls and project them to drawer rows, newest last. Capped to
 * the most recent MAX_RECOVERED_RUN_JS_ROWS.
 */
export function extractRecoveredRunJsRows(
  messages: readonly unknown[],
): RecoveredRunJsRow[] {
  const byCallId = new Map<string, RecoveredRunJsRow>()

  for (const message of messages) {
    const record = asRecord(message)
    if (!record || typeof record.type !== 'string') continue
    const inner = asRecord(record.message)
    const content = inner?.content
    if (!Array.isArray(content)) continue

    if (isAssistantMessage(record as { type: string })) {
      for (const part of content) {
        const p = asRecord(part)
        if (!p || typeof p.type !== 'string') continue
        if (!isToolUsePart(p as { type: string })) continue
        if (partToolName(p) !== SUPER_EDIT_TOOL_NAME) continue
        const callId = partToolCallId(p)
        if (!callId) continue
        const args = asRecord(p.args)
        const description =
          typeof args?.description === 'string' && args.description.trim()
            ? args.description.trim()
            : undefined
        byCallId.set(callId, {
          callId,
          ...(description !== undefined ? { description } : {}),
          status: 'stopped',
          ...(messageTimestamp(record) !== undefined
            ? { startedAt: messageTimestamp(record) }
            : {}),
        })
      }
    } else if (isUserMessage(record as { type: string })) {
      for (const part of content) {
        const p = asRecord(part)
        if (!p || typeof p.type !== 'string') continue
        if (!isToolResultPart(p as { type: string })) continue
        const callId = partToolCallId(p)
        if (!callId) continue
        const row = byCallId.get(callId)
        if (!row) continue
        row.status = p.isError === true ? 'error' : 'success'
        const finishedAt = messageTimestamp(record)
        if (finishedAt !== undefined) row.finishedAt = finishedAt
      }
    }
  }

  const rows = Array.from(byCallId.values())
  return rows.length > MAX_RECOVERED_RUN_JS_ROWS
    ? rows.slice(rows.length - MAX_RECOVERED_RUN_JS_ROWS)
    : rows
}
