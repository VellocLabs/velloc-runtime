import type {
  Message,
  TodoReminderAttachment,
} from '../runtime/RuntimeTypes'
import { resolveToolByName } from '../toolkit/toolContract'
import { type ToolCallContext } from '../toolkit/toolCallContext'
import { CHECKLIST_TOOL_ID } from '../toolkit/builtin/todoWrite'
import { isAttachmentMessage } from '../runtime/VercelModelConstants'
import { callsTool, countModelSteps } from './modelStepScan'

/** Turn thresholds for re-surfacing an untouched todo list. */
export const TODO_NUDGE_CADENCE = {
  TURNS_SINCE_WRITE: 10,
  TURNS_BETWEEN_REMINDERS: 10,
} as const

function isReminder(message: Message): boolean {
  return (
    isAttachmentMessage(message) &&
    (message as { attachment?: { type?: string } }).attachment?.type === 'todo_reminder'
  )
}

/**
 * Counts assistant turns (reasoning-only messages excluded) newer than the
 * latest TodoWrite call and newer than the latest todo reminder.
 */
export function turnsSinceTodoActivity(messages: readonly Message[]): {
  turnsSinceLastTodoWrite: number
  turnsSinceLastReminder: number
} {
  const { sinceCall, sinceMarker } = countModelSteps(messages, {
    calls: parts => callsTool(parts, CHECKLIST_TOOL_ID),
    isMarker: isReminder,
  })
  return { turnsSinceLastTodoWrite: sinceCall, turnsSinceLastReminder: sinceMarker }
}

/**
 * Yields one reminder holding the current todo list once both thresholds are
 * reached, provided TodoWrite is in the session's tool set.
 */
export function collectTodoReminderAttachments(
  messages: readonly Message[] | undefined,
  context: ToolCallContext,
): TodoReminderAttachment[] {
  const { options } = context
  if (!resolveToolByName(options.tools, CHECKLIST_TOOL_ID)) return []
  if (!messages?.length) return []
  const counts = turnsSinceTodoActivity(messages)
  if (counts.turnsSinceLastTodoWrite < TODO_NUDGE_CADENCE.TURNS_SINCE_WRITE) return []
  if (counts.turnsSinceLastReminder < TODO_NUDGE_CADENCE.TURNS_BETWEEN_REMINDERS) return []
  const key = context.agentId ?? options.sessionId ?? 'default'
  const todos = context.readAppState().todos?.[key] ?? []
  return [{ type: 'todo_reminder', content: todos, itemCount: todos.length }]
}
