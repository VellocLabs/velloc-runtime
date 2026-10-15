import { describe, expect, it } from 'vitest'
import type { Message, QueryTerminal } from '../runtime/RuntimeTypes'
import { runTurnLoop } from '../engine/turnInterpreter'
import { assembleTurnDependencies } from '../engine/turn/turnDependencies'
import {
  DefaultRuntimeConfig,
  NoopPlatformCapabilities,
  createEmptyAppState,
  createNoopToolUseContext,
} from '../runtime/testing/noopAdapters'
import {
  STOPPED_BY_USER_TEXT,
  STOPPED_DURING_TOOL_TEXT,
} from '../messages/messageFactories'
import {
  ATTACHMENT_MAX_TURNS_REACHED,
  MSG_TYPE_ATTACHMENT,
  MSG_TYPE_USER,
  PART_TOOL_RESULT_CANONICAL,
  ROLE_USER,
  TERMINAL_ABORTED,
} from '../runtime/VercelModelConstants'
import { declareTool } from '../toolkit/toolContract'

async function collectQuery<T>(
  generator: AsyncGenerator<T, QueryTerminal, unknown>,
): Promise<{ values: T[]; terminal: QueryTerminal }> {
  const values: T[] = []
  while (true) {
    const next = await generator.next()
    if (next.done) {
      return { values, terminal: next.value }
    }
    values.push(next.value)
  }
}

function getUserTextMessages(
  values: readonly unknown[],
): string[] {
  const texts: string[] = []
  for (const v of values) {
    if (!v || typeof v !== 'object') continue
    const msg = v as Record<string, unknown>
    if (msg.type !== MSG_TYPE_USER) continue
    const payload = msg.message as { role?: string; content?: unknown }
    if (payload?.role !== ROLE_USER) continue
    const content = payload.content
    if (typeof content === 'string') {
      texts.push(content)
      continue
    }
    if (Array.isArray(content)) {
      for (const block of content) {
        if (
          block &&
          typeof block === 'object' &&
          (block as { type?: string }).type === 'text' &&
          typeof (block as { text?: string }).text === 'string'
        ) {
          texts.push((block as { text: string }).text)
        }
      }
    }
  }
  return texts
}

function getToolResultIds(values: readonly unknown[]): string[] {
  const ids: string[] = []
  for (const v of values) {
    const content = (v as { type?: string; message?: { content?: unknown } })
    if (content?.type !== MSG_TYPE_USER) continue
    if (!Array.isArray(content.message?.content)) continue
    for (const block of content.message.content) {
      const b = block as { type?: string; toolCallId?: string }
      if (b?.type === PART_TOOL_RESULT_CANONICAL && typeof b.toolCallId === 'string') {
        ids.push(b.toolCallId)
      }
    }
  }
  return ids
}

/**
 * Stop pressed WHILE a tool runs (the `aborted_tools` exit in engine/turnLoop.ts). The
 * tool finishes (a Sleep tool returns "interrupted after Ns"), and the loop
 * must return right there — before this fix it went on to call the model
 * again on the aborted signal, sending a real provider request whose output
 * was thrown away.
 */
async function runAbortingToolTurn(opts: {
  abortReason?: string
  maxTurns?: number
}): Promise<{ values: unknown[]; terminal: QueryTerminal; modelCalls: number }> {
  const runtimeConfig = new DefaultRuntimeConfig()
  let modelCalls = 0
  // eslint-disable-next-line prefer-const
  let toolUseContext: ReturnType<typeof createNoopToolUseContext>
  const StopDuringTool = declareTool({
    name: 'StopDuringTool',
    argsSchema: { type: 'object' as const, properties: {} },
    description: async () => 'Aborts the turn while running.',
    call: async () => {
      toolUseContext.cancelSource.abort(opts.abortReason)
      return { data: 'interrupted after 1.5s' }
    },
    readsOnly: () => true,
  })
  toolUseContext = createNoopToolUseContext({
    tools: [StopDuringTool],
    platformCapabilities: new NoopPlatformCapabilities(),
    appState: createEmptyAppState(),
    setAppState: () => {},
  })
  const deps = assembleTurnDependencies(runtimeConfig, {
    callModel: async function* () {
      modelCalls += 1
      if (modelCalls === 1) {
        yield {
          type: 'assistant',
          uuid: 'assistant-tool',
          message: {
            role: 'assistant',
            content: [
              { type: 'tool-call', toolCallId: 'call-1', toolName: 'StopDuringTool', args: {} },
            ],
          },
        } as Message
        return
      }
      yield {
        type: 'assistant',
        uuid: 'assistant-after-stop',
        message: { role: 'assistant', content: [{ type: 'text', text: 'should never be requested' }] },
      } as Message
    },
  })
  const { values, terminal } = await collectQuery(
    runTurnLoop({
      messages: [
        { type: 'user', uuid: 'user-1', message: { role: 'user', content: 'sleep a while' } },
      ],
      baseInstructions: 'test',
      userAmbient: {},
      systemAmbient: {},
      decidePermission: async () => ({ behavior: 'allow' }),
      callContext: toolUseContext,
      turnCaller: 'test',
      deps,
      ...(opts.maxTurns !== undefined ? { stepLimit: opts.maxTurns } : {}),
    }),
  )
  return { values, terminal, modelCalls }
}

describe('query abort handling', () => {
  it('yields [Request interrupted by user] when aborted mid-stream without a pending submit-interrupt', async () => {
    const runtimeConfig = new DefaultRuntimeConfig()
    const toolUseContext = createNoopToolUseContext({
      tools: [],
      platformCapabilities: new NoopPlatformCapabilities(),
      appState: createEmptyAppState(),
      setAppState: () => {},
    })

    // Abort the controller during `callModel` so the abort check at the end
    // of the model streaming loop fires synchronously on this tick.
    const deps = assembleTurnDependencies(runtimeConfig, {
      callModel: async function* () {
        toolUseContext.cancelSource.abort()
        yield {
          type: 'assistant',
          uuid: 'assistant-partial',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'partial…' }],
          },
        } as Message
      },
    })

    const { values, terminal } = await collectQuery(
      runTurnLoop({
        messages: [
          {
            type: 'user',
            uuid: 'user-1',
            message: { role: 'user', content: 'slow task' },
          },
        ],
        baseInstructions: 'test',
        userAmbient: {},
        systemAmbient: {},
        decidePermission: async () => ({ behavior: 'allow' }),
        callContext: toolUseContext,
        turnCaller: 'test',
        deps,
      }),
    )

    expect(terminal.reason).toBe(TERMINAL_ABORTED)
    const userTexts = getUserTextMessages(values)
    expect(userTexts).toContain(STOPPED_BY_USER_TEXT)
    // No tool_use in the partial assistant message, so we use the plain
    // form — not the "for tool use" variant.
    expect(userTexts).not.toContain(STOPPED_DURING_TOOL_TEXT)
  })

  it('uses the "for tool use" variant when the partial assistant message has a tool_use', async () => {
    const runtimeConfig = new DefaultRuntimeConfig()
    const toolUseContext = createNoopToolUseContext({
      tools: [],
      platformCapabilities: new NoopPlatformCapabilities(),
      appState: createEmptyAppState(),
      setAppState: () => {},
    })

    const deps = assembleTurnDependencies(runtimeConfig, {
      callModel: async function* () {
        toolUseContext.cancelSource.abort()
        yield {
          type: 'assistant',
          uuid: 'assistant-tool',
          message: {
            role: 'assistant',
            content: [
              // Canonical tool-call shape — `getToolUseBlocks` matches on
              // `PART_TOOL_CALL = 'tool-call'`. The legacy `tool_use`
              // Anthropic-style blocks are translated upstream.
              {
                type: 'tool-call',
                toolCallId: 'call-1',
                toolName: 'no_such_tool',
                args: {},
              },
            ],
          },
        } as Message
      },
    })

    const { values, terminal } = await collectQuery(
      runTurnLoop({
        messages: [
          {
            type: 'user',
            uuid: 'user-1',
            message: { role: 'user', content: 'do something' },
          },
        ],
        baseInstructions: 'test',
        userAmbient: {},
        systemAmbient: {},
        decidePermission: async () => ({ behavior: 'allow' }),
        callContext: toolUseContext,
        turnCaller: 'test',
        deps,
      }),
    )

    expect(terminal.reason).toBe(TERMINAL_ABORTED)
    const userTexts = getUserTextMessages(values)
    expect(userTexts).toContain(STOPPED_DURING_TOOL_TEXT)
    // "Interrupted by user" synthetic tool_result goes under a
    // tool_result block, not a plain text message, so it should NOT
    // surface here.
  })

  it('aborts a SLOW external model call promptly (the sync in-context fork Stop path)', async () => {
    // A SYNC `Agent` sub-agent runs as an in-context fork: a nested query()
    // whose abortController is a CHILD of the parent's (chaining verified in
    // forked-agent.test.ts — parent abort → child fires). This asserts the OTHER
    // half end-to-end: a query() blocked in a slow, signal-honoring model call
    // (what the real transport does — its fetch is cancelled on the signal, so
    // the stream just ends) terminates the instant the signal fires, NOT after
    // the slow call would have finished. Composed, a slow sync fork stops in a
    // tick when the user clicks Stop.
    const runtimeConfig = new DefaultRuntimeConfig()
    const toolUseContext = createNoopToolUseContext({
      tools: [],
      platformCapabilities: new NoopPlatformCapabilities(),
      appState: createEmptyAppState(),
      setAppState: () => {},
    })

    let callStarted = false
    const deps = assembleTurnDependencies(runtimeConfig, {
      callModel: async function* () {
        callStarted = true
        // Hang until aborted — a slow streaming call whose fetch is cancelled on
        // the signal. WITHOUT honoring the signal this never returns and query()
        // would hang for the call's full duration (the bug class we're guarding).
        await new Promise<void>(resolve => {
          const sig = toolUseContext.cancelSource.signal
          if (sig.aborted) return resolve()
          sig.addEventListener('abort', () => resolve(), { once: true })
        })
        yield {
          type: 'assistant',
          uuid: 'assistant-partial',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'partial…' }],
          },
        } as Message
      },
    })

    const collected = collectQuery(
      runTurnLoop({
        messages: [
          {
            type: 'user',
            uuid: 'user-1',
            message: { role: 'user', content: 'slow fork task' },
          },
        ],
        baseInstructions: 'test',
        userAmbient: {},
        systemAmbient: {},
        decidePermission: async () => ({ behavior: 'allow' }),
        callContext: toolUseContext,
        turnCaller: 'test',
        deps,
      }),
    )

    // Let the loop reach the (hanging) model call, then the user clicks Stop.
    for (let i = 0; i < 200 && !callStarted; i += 1) {
      await new Promise(r => setTimeout(r, 5))
    }
    expect(callStarted).toBe(true)
    const start = Date.now()
    toolUseContext.cancelSource.abort()
    const { terminal } = await collected
    expect(Date.now() - start).toBeLessThan(1_000)
    expect(terminal.reason).toBe(TERMINAL_ABORTED)
  })

  it('skips the interrupt marker when the abort reason is "interrupt" (submit-interrupt path)', async () => {
    const runtimeConfig = new DefaultRuntimeConfig()
    const toolUseContext = createNoopToolUseContext({
      tools: [],
      platformCapabilities: new NoopPlatformCapabilities(),
      appState: createEmptyAppState(),
      setAppState: () => {},
    })

    const deps = assembleTurnDependencies(runtimeConfig, {
      callModel: async function* () {
        toolUseContext.cancelSource.abort('interrupt')
        yield {
          type: 'assistant',
          uuid: 'assistant-partial',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'partial…' }],
          },
        } as Message
      },
    })

    const { values, terminal } = await collectQuery(
      runTurnLoop({
        messages: [
          {
            type: 'user',
            uuid: 'user-1',
            message: { role: 'user', content: 'mid-turn submit' },
          },
        ],
        baseInstructions: 'test',
        userAmbient: {},
        systemAmbient: {},
        decidePermission: async () => ({ behavior: 'allow' }),
        callContext: toolUseContext,
        turnCaller: 'test',
        deps,
      }),
    )

    expect(terminal.reason).toBe(TERMINAL_ABORTED)
    const userTexts = getUserTextMessages(values)
    expect(userTexts).not.toContain(STOPPED_BY_USER_TEXT)
    expect(userTexts).not.toContain(STOPPED_DURING_TOOL_TEXT)
  })

  it('returns aborted right after tools when Stop lands during a tool call — no second model request (aborted_tools)', async () => {
    const { values, terminal, modelCalls } = await runAbortingToolTurn({})

    expect(modelCalls).toBe(1)
    expect(terminal.reason).toBe(TERMINAL_ABORTED)
    // The tool's own result is kept and NOT duplicated by a synthetic one.
    expect(getToolResultIds(values)).toEqual(['call-1'])
    expect(getUserTextMessages(values)).toContain(STOPPED_DURING_TOOL_TEXT)
  })

  it('skips the interrupt marker after tools on a submit-interrupt, and still makes no second request', async () => {
    const { values, terminal, modelCalls } = await runAbortingToolTurn({
      abortReason: 'interrupt',
    })

    expect(modelCalls).toBe(1)
    expect(terminal.reason).toBe(TERMINAL_ABORTED)
    const userTexts = getUserTextMessages(values)
    expect(userTexts).not.toContain(STOPPED_BY_USER_TEXT)
    expect(userTexts).not.toContain(STOPPED_DURING_TOOL_TEXT)
  })

  it('yields the max_turns attachment when the aborted tool round was the last allowed turn', async () => {
    const { values, terminal, modelCalls } = await runAbortingToolTurn({ maxTurns: 1 })

    expect(modelCalls).toBe(1)
    expect(terminal.reason).toBe(TERMINAL_ABORTED)
    const maxTurns = values.filter(
      v =>
        (v as { type?: string }).type === MSG_TYPE_ATTACHMENT &&
        (v as { attachment?: { type?: string } }).attachment?.type ===
          ATTACHMENT_MAX_TURNS_REACHED,
    )
    expect(maxTurns).toHaveLength(1)
  })
})
