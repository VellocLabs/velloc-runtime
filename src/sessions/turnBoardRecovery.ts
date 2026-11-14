/**
 * Contract: the step list told to the model again after a compaction (F-41).
 * A summary keeps what the conversation was about but not, reliably, which
 * step of the list on screen is where, so the main conversation gets the
 * list back as the board holds it. Nothing is returned for a loop that
 * cannot call `set_plan`, a nested caller, an empty or finished list, or a
 * turn that has already sent its closing.
 */
import type { UserRow } from '../runtime/RuntimeTypes'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import { createGeneratedUserMessage } from '../messages/messageFactories'
import { CLOSE_TURN_TOOL_NAME, SET_PLAN_TOOL_NAME, isNestedCaller } from './sessionTurnServer'
import { turnBoard, type TurnBoard, type TurnStepStatus } from './turnBoard'

const STATUS_WORD: Record<TurnStepStatus, string> = {
  completed: 'done',
  in_progress: 'in progress',
  pending: 'not started',
}

function offersSetPlan(context: ToolCallContext): boolean {
  const tools = Array.isArray(context.options?.tools) ? context.options.tools : []
  return tools.some(tool => tool?.name === SET_PLAN_TOOL_NAME)
}

/** One line per step; whitespace folded so a step cannot open a new line. */
function stepLines(steps: readonly { text: string; status: TurnStepStatus }[]): string[] {
  return steps.map((step, index) => `${index + 1}. [${STATUS_WORD[step.status]}] ${step.text.replace(/\s+/g, ' ')}`)
}

export function createPostCompactTurnBoardMessage(
  context: ToolCallContext | undefined,
  board: TurnBoard = turnBoard,
): UserRow | null {
  if (!context || isNestedCaller(context) || !offersSetPlan(context)) return null
  const sessionId = context.options.sessionId
  if (!sessionId) return null
  const { steps, closing } = board.read(sessionId)
  if (closing !== null || steps.length === 0) return null
  if (steps.every(step => step.status === 'completed')) return null

  const lines = [
    '<system-reminder>',
    'The step list shown to the person still has work left. The summary above may not say where it stands; this is the list as it is on screen, numbered as you sent it:',
    '',
    ...stepLines(steps),
    '',
    `Carry on from here and keep it current with ${SET_PLAN_TOOL_NAME}: "next" when the step in progress is done and the following one starts, "done" / "start" with step numbers, or a new "steps" list if the plan has changed. When the work is done, call ${CLOSE_TURN_TOOL_NAME}.`,
    '</system-reminder>',
  ]
  return createGeneratedUserMessage(lines.join('\n'), { isMeta: true })
}
