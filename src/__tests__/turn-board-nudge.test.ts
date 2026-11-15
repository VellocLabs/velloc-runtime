import { describe, expect, it } from 'vitest'
import type { Message } from '../runtime/RuntimeTypes'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import { CLOSE_TURN_TOOL_NAME, SET_PLAN_TOOL_NAME } from '../sessions/sessionTurnServer'
import { TurnBoard, type TurnStep } from '../sessions/turnBoard'
import { STEP_LIST_NUDGE, createStepListNudge, stepsSinceStepListActivity } from '../sessions/turnBoardNudge'

// The stale step-list reminder (F-41): when it fires, how often, and what it says.

const SESSION = 's1'

function context(options: { tools?: string[]; sessionId?: string; agentId?: string } = {}): ToolCallContext {
  return {
    ...(options.agentId ? { agentId: options.agentId } : {}),
    options: {
      sessionId: options.sessionId ?? SESSION,
      tools: (options.tools ?? [SET_PLAN_TOOL_NAME, CLOSE_TURN_TOOL_NAME]).map(name => ({ name })),
    },
  } as unknown as ToolCallContext
}

const call = (toolName: string): Message =>
  ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool-call', toolName }] } }) as unknown as Message
const thinking = (): Message =>
  ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'reasoning', text: 'hm' }] } }) as unknown as Message
const steps = (n: number): Message[] => Array.from({ length: n }, () => call('Bash'))
const textOf = (row: Message | null): string => {
  const content = (row as { message?: { content?: unknown } } | null)?.message?.content
  return typeof content === 'string' ? content : ''
}

const plan: TurnStep[] = [
  { text: 'Read the docs', status: 'in_progress' },
  { text: 'Claim the queue', status: 'pending' },
]
function board(list: TurnStep[] = plan): TurnBoard {
  const out = new TurnBoard()
  out.setPlan(SESSION, list)
  return out
}

const quiet = STEP_LIST_NUDGE.STEPS_SINCE_UPDATE

describe('stepsSinceStepListActivity', () => {
  it('counts model steps after the last set_plan call, reasoning-only replies left out', () => {
    const history = [call(SET_PLAN_TOOL_NAME), call('Bash'), thinking(), call('Read')]
    expect(stepsSinceStepListActivity(history).sinceUpdate).toBe(2)
  })
})

describe('createStepListNudge', () => {
  it('names the step still shown in progress and how to advance it', () => {
    const row = createStepListNudge(context(), [call(SET_PLAN_TOOL_NAME), ...steps(quiet)], board())
    expect((row as { isMeta?: boolean }).isMeta).toBe(true)
    const text = textOf(row)
    expect(text).toContain('step 1 of 2 in progress: "Read the docs"')
    expect(text).toContain('{"next": true}')
  })

  it('stays quiet until enough steps have passed without an update', () => {
    expect(createStepListNudge(context(), [call(SET_PLAN_TOOL_NAME), ...steps(quiet - 1)], board())).toBeNull()
  })

  it('does not repeat until as many steps again have passed', () => {
    const first = createStepListNudge(context(), [call(SET_PLAN_TOOL_NAME), ...steps(quiet)], board())!
    const history = [call(SET_PLAN_TOOL_NAME), ...steps(quiet), first]
    expect(createStepListNudge(context(), [...history, ...steps(STEP_LIST_NUDGE.STEPS_BETWEEN_NUDGES - 1)], board())).toBeNull()
    expect(createStepListNudge(context(), [...history, ...steps(STEP_LIST_NUDGE.STEPS_BETWEEN_NUDGES)], board())).not.toBeNull()
  })

  it('says nothing for a finished or empty list, a standing closing, a nested caller or a loop without set_plan', () => {
    const history = [call(SET_PLAN_TOOL_NAME), ...steps(quiet + 3)]
    expect(createStepListNudge(context(), history, new TurnBoard())).toBeNull()
    expect(createStepListNudge(context(), history, board(plan.map(step => ({ ...step, status: 'completed' as const }))))).toBeNull()
    const closed = board()
    closed.close(SESSION, { summary: 'S.', replies: [], waiting: false })
    expect(createStepListNudge(context(), history, closed)).toBeNull()
    expect(createStepListNudge(context({ agentId: 'a1' }), history, board())).toBeNull()
    expect(createStepListNudge(context({ tools: ['Bash'] }), history, board())).toBeNull()
  })
})
