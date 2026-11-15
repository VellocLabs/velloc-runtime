import { describe, expect, it } from 'vitest'
import type { Message } from '../runtime/RuntimeTypes'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import { CLOSE_TURN_TOOL_NAME, SET_PLAN_TOOL_NAME } from '../sessions/sessionTurnServer'
import { TurnBoard, type TurnStep } from '../sessions/turnBoard'
import { STEP_LIST_NUDGE, createStepListNudge, nudgesThisTurn, stepsSinceStepListActivity } from '../sessions/turnBoardNudge'

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
const person = (text: string): Message =>
  ({ type: 'user', message: { role: 'user', content: text } }) as unknown as Message
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

  it('sends at most MAX_PER_TURN nudges in one turn, and counts again after the person writes', () => {
    const between = STEP_LIST_NUDGE.STEPS_BETWEEN_NUDGES
    let history: Message[] = [person('go'), call(SET_PLAN_TOOL_NAME), ...steps(quiet)]
    for (let sent = 0; sent < STEP_LIST_NUDGE.MAX_PER_TURN; sent++) {
      const row = createStepListNudge(context(), history, board())
      expect(row, `nudge ${sent + 1}`).not.toBeNull()
      history = [...history, row!, ...steps(between)]
    }
    expect(nudgesThisTurn(history)).toBe(STEP_LIST_NUDGE.MAX_PER_TURN)
    expect(createStepListNudge(context(), history, board())).toBeNull()
    history = [...history, person('carry on'), ...steps(between)]
    expect(createStepListNudge(context(), history, board())).not.toBeNull()
  })

  it('a tool result is not the person writing', () => {
    const toolResult = { type: 'user', message: { role: 'user', content: [{ type: 'tool-result', toolCallId: 'x' }] } } as unknown as Message
    const nudge = createStepListNudge(context(), [call(SET_PLAN_TOOL_NAME), ...steps(quiet)], board())!
    expect(nudgesThisTurn([person('go'), nudge, toolResult])).toBe(1)
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
