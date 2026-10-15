/**
 * The `(task id …)` ack an imported parent's Agent tool result carries
 * (`extractBackgroundTaskId` keys on `task id <id>`). Applied by the write path
 * only for a sub-agent whose bundle landed, parent written last, so no ack
 * points at a missing `task.json`. Constants only, no converter deps.
 */

import {
  MSG_TYPE_USER,
  PART_TOOL_RESULT_CANONICAL,
} from '../../../runtime/VercelModelConstants'

type RawRecord = Record<string, unknown>

function asRecord(value: unknown): RawRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as RawRecord)
    : null
}

/** The exact suffix appended to an Agent tool result for `taskId`. */
export function agentTaskAckSuffix(taskId: string): string {
  return `\n\n(task id ${taskId})`
}

/** Append `suffix` to a tool result's text — the last text block, or the string
 *  itself — so the Agent card's task-id regex finds it. Same shape the CLI's own
 *  result carries; returns a NEW value (does not mutate `content`). */
function appendToToolResult(content: unknown, suffix: string): unknown {
  if (typeof content === 'string') return `${content}${suffix}`
  if (!Array.isArray(content)) return [{ type: 'text', text: suffix.trim() }]
  const blocks = content.slice()
  for (let i = blocks.length - 1; i >= 0; i--) {
    const record = asRecord(blocks[i])
    if (record && record.type === 'text' && typeof record.text === 'string') {
      blocks[i] = { ...record, text: `${record.text}${suffix}` }
      return blocks
    }
  }
  blocks.push({ type: 'text', text: suffix.trim() })
  return blocks
}

/**
 * Stamp the `(task id <taskId>)` ack onto the parent's Agent tool-result entry
 * for `toolCallId`, in place; false when the toolCallId is absent.
 */
export function applyAgentTaskAck(
  entries: readonly unknown[],
  toolCallId: string,
  taskId: string,
): boolean {
  const suffix = agentTaskAckSuffix(taskId)
  for (const entry of entries) {
    const record = asRecord(entry)
    if (!record || record.type !== MSG_TYPE_USER) continue
    const content = asRecord(record.message)?.content
    if (!Array.isArray(content)) continue
    let matched = false
    for (let i = 0; i < content.length; i++) {
      const part = asRecord(content[i])
      if (
        part &&
        part.type === PART_TOOL_RESULT_CANONICAL &&
        part.toolCallId === toolCallId
      ) {
        content[i] = { ...part, result: appendToToolResult(part.result, suffix) }
        matched = true
      }
    }
    if (matched) {
      if (typeof record.toolUseResult === 'string') {
        record.toolUseResult = `${record.toolUseResult}${suffix}`
      }
      return true
    }
  }
  return false
}
