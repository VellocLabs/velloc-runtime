/**
 * Contract: a reminder when the step list (F-41) has gone stale mid-turn. After
 * `STEP_LIST_NUDGE.STEPS_SINCE_UPDATE` model steps with no `set_plan` call,
 * while the list still has a step not done and no closing is standing, the
 * main conversation gets one meta row naming the step shown in progress and
 * how to advance it. Repeats at most every `STEPS_BETWEEN_NUDGES` steps and
 * `MAX_PER_TURN` times in one turn (since the person's last message).
 * Nothing for a loop that cannot call `set_plan` or a nested caller.
 */
import type { Message, UserRow } from '../runtime/RuntimeTypes'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import { createGeneratedUserMessage } from '../messages/messageFactories'
import { callsTool, countModelSteps, type ScanPart } from '../messages/modelStepScan'
import { SET_PLAN_TOOL_NAME, isNestedCaller } from './sessionTurnServer'
import { turnBoard, type TurnBoard, type TurnStep } from './turnBoard'

export const STEP_LIST_NUDGE = {
  STEPS_SINCE_UPDATE: 10,
  STEPS_BETWEEN_NUDGES: 10,
  MAX_PER_TURN: 3,
} as const

const NUDGE_OPENING = 'The step list on screen has not changed for a while.'

function isNudge(message: Message): boolean {
  if (message.type !== 'user' || !(message as { isMeta?: boolean }).isMeta) return false
  const content = (message as { message?: { content?: unknown } }).message?.content
  return typeof content === 'string' && content.includes(NUDGE_OPENING)
}

/** A message the person wrote: not meta, not a tool result. */
function isPersonMessage(message: Message): boolean {
  if (message.type !== 'user' || (message as { isMeta?: boolean }).isMeta) return false
  const content = (message as { message?: { content?: unknown } }).message?.content
  if (typeof content === 'string') return true
  if (!Array.isArray(content)) return false
  return !(content as ScanPart[]).some(part => part?.type === 'tool-result' || part?.type === 'tool_result')
}

/** Nudges sent since the person's last message. */
export function nudgesThisTurn(messages: readonly Message[]): number {
  let count = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (!message) continue
    if (isNudge(message)) count++
    else if (isPersonMessage(message)) break
  }
  return count
}

/** Model steps (reasoning-only replies left out) newer than the last `set_plan` call and the last nudge. */
export function stepsSinceStepListActivity(messages: readonly Message[]): { sinceUpdate: number; sinceNudge: number } {
  const { sinceCall, sinceMarker } = countModelSteps(messages, {
    calls: parts => callsTool(parts, SET_PLAN_TOOL_NAME),
    isMarker: isNudge,
  })
  return { sinceUpdate: sinceCall, sinceNudge: sinceMarker }
}

function currentStepLine(steps: readonly TurnStep[]): string {
  const index = steps.findIndex(step => step.status === 'in_progress')
  if (index < 0) {
    const done = steps.filter(step => step.status === 'completed').length
    return `No step is shown in progress (${done} of ${steps.length} done).`
  }
  return `It still shows step ${index + 1} of ${steps.length} in progress: "${steps[index]!.text.replace(/\s+/g, ' ')}".`
}

export function createStepListNudge(
  context: ToolCallContext | undefined,
  messages: readonly Message[],
  board: TurnBoard = turnBoard,
): UserRow | null {
  if (!context || isNestedCaller(context)) return null
  const tools = Array.isArray(context.options?.tools) ? context.options.tools : []
  if (!tools.some(tool => tool?.name === SET_PLAN_TOOL_NAME)) return null
  const sessionId = context.options.sessionId
  if (!sessionId) return null
  const { steps, closing } = board.read(sessionId)
  if (closing !== null || steps.length === 0 || steps.every(step => step.status === 'completed')) return null
  const { sinceUpdate, sinceNudge } = stepsSinceStepListActivity(messages)
  if (sinceUpdate < STEP_LIST_NUDGE.STEPS_SINCE_UPDATE) return null
  if (sinceNudge < STEP_LIST_NUDGE.STEPS_BETWEEN_NUDGES) return null
  if (nudgesThisTurn(messages) >= STEP_LIST_NUDGE.MAX_PER_TURN) return null

  const text = [
    '<system-reminder>',
    `${NUDGE_OPENING} ${currentStepLine(steps)}`,
    `If you have moved past it, send ${SET_PLAN_TOOL_NAME} with {"next": true} (or {"done": [...], "start": n}) beside your next tool call; if the plan changed, send the whole new "steps" list. Do not mention this reminder to the person.`,
    '</system-reminder>',
  ].join('\n')
  return createGeneratedUserMessage(text, { isMeta: true })
}
