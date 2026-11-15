import { describe, expect, it } from 'vitest'
import type { ContextRow, Message } from '../runtime/RuntimeTypes'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import { collectQueuedAttachmentMessages } from '../messages/contextAttachments'
import {
  DefaultRuntimeConfig,
  NoopPlatformCapabilities,
  createEmptyAppState,
  createNoopToolUseContext,
} from '../runtime/testing/noopAdapters'
import { CLOSE_TURN_TOOL_NAME, SET_PLAN_TOOL_NAME } from '../sessions/sessionTurnServer'
import { TurnBoard, turnBoard, type TurnStep } from '../sessions/turnBoard'
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

  it('over one long turn, reminds at steps 10, 20 and 30 only', () => {
    let history: Message[] = [person('go'), call(SET_PLAN_TOOL_NAME)]
    const remindedAt: number[] = []
    for (let step = 1; step <= 45; step++) {
      history = [...history, call('Bash')]
      const row = createStepListNudge(context(), history, board())
      if (row) {
        remindedAt.push(step)
        history = [...history, row]
      }
    }
    expect(STEP_LIST_NUDGE.STEPS_SINCE_UPDATE).toBe(10)
    expect(remindedAt).toEqual([10, 20, 30])
  })

  it('a set_plan update restarts the count', () => {
    let history: Message[] = [person('go'), call(SET_PLAN_TOOL_NAME)]
    const remindedAt: number[] = []
    for (let step = 1; step <= 25; step++) {
      history = [...history, call(step === 8 ? SET_PLAN_TOOL_NAME : 'Bash')]
      const row = createStepListNudge(context(), history, board())
      if (row) {
        remindedAt.push(step)
        history = [...history, row]
      }
    }
    // The update at step 8 is itself a step; ten quiet ones after it end at 18.
    expect(remindedAt).toEqual([18])
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

describe('after a waiting closing', () => {
  it('the steps it left open are reminded once the person answers', () => {
    const waited = board()
    waited.close(SESSION, { summary: 'S.', question: 'Ship it?', replies: ['Ship'], waiting: true })
    const history = [call(SET_PLAN_TOOL_NAME), ...steps(quiet), person('not yet'), ...steps(quiet)]
    expect(createStepListNudge(context(), history, waited)).toBeNull()
    waited.personWrote(SESSION)
    expect(textOf(createStepListNudge(context(), history, waited))).toContain('No step is shown in progress (1 of 2 done).')
  })
})

describe('the reminder in the drain', () => {
  const drain = async (
    history: Message[],
    extra: {
      querySource?: string
      drainInjectMessages?: () => Array<{ uuid: string; prompt: string; enqueuedAt: number }>
    } = {},
  ): Promise<Message[]> => {
    const toolUseContext = createNoopToolUseContext({
      tools: [{ name: SET_PLAN_TOOL_NAME }] as never,
      platformCapabilities: new NoopPlatformCapabilities(),
      appState: createEmptyAppState(),
      setAppState: () => undefined,
      sessionId: SESSION,
    })
    const rows: Message[] = []
    for await (const row of collectQueuedAttachmentMessages({
      messages: history,
      toolUseContext,
      runtimeConfig: new DefaultRuntimeConfig(),
      ...extra,
    })) {
      rows.push(row)
    }
    return rows
  }

  it('hands over the reminder after the rows ahead of it', async () => {
    turnBoard.setPlan(SESSION, plan)
    try {
      const rows = await drain([call(SET_PLAN_TOOL_NAME), ...steps(quiet)], {
        querySource: 'sdk',
        drainInjectMessages: () => [{ uuid: 'u1', prompt: 'typed', enqueuedAt: 1 }],
      })
      expect(rows).toHaveLength(2)
      expect((rows[0] as ContextRow).attachment).toMatchObject({ commandMode: 'prompt' })
      expect((rows[1] as { isMeta?: boolean }).isMeta).toBe(true)
      expect(textOf(rows[1]!)).toContain('step 1 of 2 in progress')
    } finally {
      turnBoard.forget(SESSION)
    }
  })

  it('hands over nothing when the board holds no list', async () => {
    expect(await drain([call(SET_PLAN_TOOL_NAME), ...steps(quiet)])).toEqual([])
  })
})
