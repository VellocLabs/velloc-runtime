import type {
  Message,
  TodoReminderAttachment,
} from '../runtime/RuntimeTypes'
import { resolveToolByName } from '../toolkit/toolContract'
import { type ToolCallContext } from '../toolkit/toolCallContext'
import { CHECKLIST_TOOL_ID } from '../toolkit/builtin/todoWrite'
import { isToolWithheldForModel } from '../utils/todoTools'
import {
  LEGACY_PART_TOOL_USE,
  PART_REASONING,
  PART_REDACTED_THINKING,
  PART_THINKING,
  PART_TOOL_CALL,
  isAssistantMessage,
  isAttachmentMessage,
} from '../runtime/VercelModelConstants'

/** Turn thresholds for re-surfacing an untouched todo list. */
export const TODO_NUDGE_CADENCE = {
  TURNS_SINCE_WRITE: 10,
  TURNS_BETWEEN_REMINDERS: 10,
} as const

type Part = { type?: string; toolName?: string; name?: string }

const REASONING_KINDS = new Set<string>([PART_THINKING, PART_REDACTED_THINKING, PART_REASONING])

function partsOf(message: Message): Part[] | null {
  const content = (message as { message?: { content?: unknown } }).message?.content
  return Array.isArray(content) ? (content as Part[]) : null
}

function onlyReasoning(parts: Part[] | null): boolean {
  return !!parts && parts.length > 0 && parts.every(p => REASONING_KINDS.has(p?.type ?? ''))
}

function writesTodos(parts: Part[] | null): boolean {
  return !!parts?.some(
    p =>
      (p?.type === PART_TOOL_CALL && p.toolName === CHECKLIST_TOOL_ID) ||
      (p?.type === LEGACY_PART_TOOL_USE && p.name === CHECKLIST_TOOL_ID),
  )
}

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
  let turns = 0
  let sinceWrite: number | null = null
  let sinceReminder: number | null = null
  for (let i = messages.length - 1; i >= 0; i--) {
    if (sinceWrite !== null && sinceReminder !== null) break
    const message = messages[i]
    if (!message) continue
    if (isReminder(message)) {
      sinceReminder ??= turns
      continue
    }
    if (!isAssistantMessage(message)) continue
    const parts = partsOf(message)
    if (onlyReasoning(parts)) continue
    if (writesTodos(parts)) sinceWrite ??= turns
    turns++
  }
  return {
    turnsSinceLastTodoWrite: sinceWrite ?? turns,
    turnsSinceLastReminder: sinceReminder ?? turns,
  }
}

/**
 * Yields one reminder holding the current todo list once both thresholds are
 * reached, provided TodoWrite is available to the active model.
 */
export function collectTodoReminderAttachments(
  messages: readonly Message[] | undefined,
  context: ToolCallContext,
): TodoReminderAttachment[] {
  const { options } = context
  if (!resolveToolByName(options.tools, CHECKLIST_TOOL_ID)) return []
  if (isToolWithheldForModel(CHECKLIST_TOOL_ID, options.mainLoopModel, options.mainLoopProviderId)) {
    return []
  }
  if (!messages?.length) return []
  const counts = turnsSinceTodoActivity(messages)
  if (counts.turnsSinceLastTodoWrite < TODO_NUDGE_CADENCE.TURNS_SINCE_WRITE) return []
  if (counts.turnsSinceLastReminder < TODO_NUDGE_CADENCE.TURNS_BETWEEN_REMINDERS) return []
  const key = context.agentId ?? options.sessionId ?? 'default'
  const todos = context.readAppState().todos?.[key] ?? []
  return [{ type: 'todo_reminder', content: todos, itemCount: todos.length }]
}
