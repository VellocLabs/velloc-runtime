import { afterEach, describe, expect, it } from 'vitest'
import type { Message, QueryTerminal } from '../runtime/RuntimeTypes'
import { SYSTEM_SUBTYPE_COMPACT_BOUNDARY } from '../runtime/VercelModelConstants'
import { runTurnLoop } from '../engine/turnInterpreter'
import { assembleTurnDependencies } from '../engine/turn/turnDependencies'
import { collectPostCompactPlanRows } from '../messages/contextAttachments'
import {
  DefaultRuntimeConfig,
  NoopPlatformCapabilities,
  createEmptyAppState,
  createNoopToolUseContext,
} from '../runtime/testing/noopAdapters'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import { CLOSE_TURN_TOOL_NAME, SET_PLAN_TOOL_NAME } from '../sessions/sessionTurnServer'
import { TurnBoard, turnBoard, type TurnStep } from '../sessions/turnBoard'
import { createPostCompactTurnBoardMessage } from '../sessions/turnBoardRecovery'

const SESSION = 'turn-board-compact'

afterEach(() => {
  turnBoard.forget(SESSION)
})

function context(options: { tools?: string[]; sessionId?: string; agentId?: string; teammateName?: string } = {}): ToolCallContext {
  const tools = (options.tools ?? [SET_PLAN_TOOL_NAME, CLOSE_TURN_TOOL_NAME]).map(name => ({ name }))
  const ctx = createNoopToolUseContext({
    tools: tools as never,
    platformCapabilities: new NoopPlatformCapabilities(),
    appState: createEmptyAppState(),
    setAppState: () => {},
    cwd: '/workspace',
    sessionId: options.sessionId ?? SESSION,
  })
  if (options.agentId) (ctx as { agentId?: string }).agentId = options.agentId
  if (options.teammateName) (ctx.options as { teammateName?: string }).teammateName = options.teammateName
  return ctx
}

const textOf = (row: Message | null): string => {
  const content = (row as { message?: { content?: unknown } } | null)?.message?.content
  return typeof content === 'string' ? content : ''
}

const steps: TurnStep[] = [
  { text: 'Read the parser', status: 'completed' },
  { text: 'Fix the\n  off-by-one', status: 'in_progress' },
  { text: 'Add a test', status: 'pending' },
]

describe('createPostCompactTurnBoardMessage', () => {
  it('lists the held steps, numbered, with their state and how to go on', () => {
    const board = new TurnBoard()
    board.setPlan(SESSION, steps)
    const row = createPostCompactTurnBoardMessage(context(), board)
    expect((row as { isMeta?: boolean }).isMeta).toBe(true)
    const text = textOf(row)
    expect(text).toContain('1. [done] Read the parser')
    expect(text).toContain('2. [in progress] Fix the off-by-one')
    expect(text).toContain('3. [not started] Add a test')
    expect(text).toContain(SET_PLAN_TOOL_NAME)
    expect(text).toContain(CLOSE_TURN_TOOL_NAME)
  })

  it('reads the list as the board holds it after updates', () => {
    const board = new TurnBoard()
    board.setPlan(SESSION, steps)
    board.update(SESSION, { next: true })
    const text = textOf(createPostCompactTurnBoardMessage(context(), board))
    expect(text).toContain('2. [done] Fix the off-by-one')
    expect(text).toContain('3. [in progress] Add a test')
  })

  it('says nothing with no list, a finished list, or a closing already sent', () => {
    const board = new TurnBoard()
    expect(createPostCompactTurnBoardMessage(context(), board)).toBeNull()
    board.setPlan(SESSION, steps.map(step => ({ ...step, status: 'completed' as const })))
    expect(createPostCompactTurnBoardMessage(context(), board)).toBeNull()
    board.setPlan(SESSION, steps)
    board.close(SESSION, { summary: 'Stopped here.', replies: [], waiting: false })
    expect(createPostCompactTurnBoardMessage(context(), board)).toBeNull()
  })

  it('a closing answered by the person leaves the unfinished list to be told again', () => {
    const board = new TurnBoard()
    board.setPlan(SESSION, steps)
    board.close(SESSION, { summary: 'Asked first.', question: 'Go on?', replies: ['Yes'], waiting: true })
    board.personWrote(SESSION)
    // The closing completed the step in progress; the pending one is left.
    expect(textOf(createPostCompactTurnBoardMessage(context(), board))).toContain('3. [not started] Add a test')
  })

  it('says nothing to a loop without set_plan, a nested caller, or no session', () => {
    const board = new TurnBoard()
    board.setPlan(SESSION, steps)
    board.setPlan('subagent-1', steps)
    expect(createPostCompactTurnBoardMessage(context({ tools: ['Read'] }), board)).toBeNull()
    expect(createPostCompactTurnBoardMessage(context({ agentId: 'a1' }), board)).toBeNull()
    expect(createPostCompactTurnBoardMessage(context({ teammateName: 'ann' }), board)).toBeNull()
    expect(createPostCompactTurnBoardMessage(context({ sessionId: 'subagent-1' }), board)).toBeNull()
    expect(createPostCompactTurnBoardMessage(context({ sessionId: '' }), board)).toBeNull()
    expect(createPostCompactTurnBoardMessage(undefined, board)).toBeNull()
  })
})

describe('after a compaction', () => {
  it('the post-compaction rows end with the step list', async () => {
    turnBoard.setPlan(SESSION, steps)
    const rows = await collectPostCompactPlanRows(context(), new DefaultRuntimeConfig())
    expect(rows).toHaveLength(1)
    expect(textOf(rows[0]!)).toContain('2. [in progress] Fix the off-by-one')
  })

  it('the request after an automatic compaction carries the step list after the summary', async () => {
    turnBoard.setPlan(SESSION, steps)
    let compacted = false
    const seen: string[][] = []
    const deps = assembleTurnDependencies(new DefaultRuntimeConfig(), {
      autocompact: async () => {
        if (compacted) return {}
        compacted = true
        return {
          compactionResult: {
            boundaryMarker: {
              type: 'system',
              subtype: SYSTEM_SUBTYPE_COMPACT_BOUNDARY,
              uuid: 'boundary-1',
              message: 'Conversation compacted',
              compactMetadata: { trigger: 'auto', preTokens: 4000 },
            } as Message,
            summaryMessages: [
              { type: 'user', uuid: 'summary-1', isMeta: true, message: { role: 'user', content: 'summary' } } as Message,
            ],
          },
        }
      },
      callModel: async function* (params) {
        seen.push(params.messages.map(message => textOf(message) || (message.uuid ?? '')))
        yield {
          type: 'assistant',
          uuid: 'assistant-done',
          message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
        } as Message
      },
    })
    const loop = runTurnLoop({
      messages: [{ type: 'user', uuid: 'user-1', message: { role: 'user', content: 'long task' } } as Message],
      baseInstructions: ['base prompt'],
      userAmbient: {},
      systemAmbient: {},
      decidePermission: async () => ({ behavior: 'allow' }),
      callContext: context(),
      turnCaller: 'test',
      deps,
    })
    let next: IteratorResult<unknown, QueryTerminal>
    do next = await loop.next()
    while (!next.done)

    expect(seen).toHaveLength(1)
    const sent = seen[0]!
    expect(sent.slice(0, 2)).toEqual(['boundary-1', 'summary'])
    expect(sent).toHaveLength(3)
    expect(sent[2]).toContain('3. [not started] Add a test')
  })
})
