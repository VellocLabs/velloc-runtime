import { describe, expect, it } from 'vitest'
import type { Message } from '../runtime/RuntimeTypes'
import { assembleTurnDependencies } from '../engine/turn/turnDependencies'
import {
  createRepeatedToolCallGuard,
  REPEATED_TOOL_CALL_LIMIT,
} from '../engine/turn/repeatedToolCallGuard'
import {
  DefaultRuntimeConfig,
  NoopPlatformCapabilities,
  createEmptyAppState,
  createNoopToolUseContext,
} from '../runtime/testing/noopAdapters'

/**
 * A model stuck re-emitting one read-only tool call (734 identical
 * `Grep` calls, 64000 output tokens, 8.5 minutes, nothing executed) is cut at
 * REPEATED_TOOL_CALL_LIMIT consecutive copies. Only an unbroken run of the
 * same read-only call counts; anything said in between resets it.
 */

const LIMIT = REPEATED_TOOL_CALL_LIMIT

const call = (id: string, args: unknown = { pattern: 'ad' }, toolName = 'Grep') =>
  ({ type: 'tool-call', toolCallId: id, toolName, args })

const readOnlyNames = new Set(['Grep', 'Read'])
const isReadOnlyCall = (name: string) => readOnlyNames.has(name)

function feed(blocks: Array<Record<string, unknown>>): number[] {
  const guard = createRepeatedToolCallGuard(isReadOnlyCall)
  const trips: number[] = []
  blocks.forEach((b, i) => {
    if (guard.observe(b)) trips.push(i)
  })
  return trips
}

describe('repeatedToolCallGuard', () => {
  it('trips on the LIMIT-th identical consecutive read-only call, once', () => {
    const blocks = Array.from({ length: LIMIT + 3 }, (_, i) => call(`t${i}`))
    expect(feed(blocks)).toEqual([LIMIT - 1])
  })

  it('does not trip one short of the limit', () => {
    expect(feed(Array.from({ length: LIMIT - 1 }, (_, i) => call(`t${i}`)))).toEqual([])
  })

  it('treats args with reordered keys as the same call', () => {
    const blocks = Array.from({ length: LIMIT }, (_, i) =>
      call(`t${i}`, i % 2 ? { a: 1, b: { c: 2, d: 3 } } : { b: { d: 3, c: 2 }, a: 1 }))
    expect(feed(blocks)).toEqual([LIMIT - 1])
  })

  it.each([
    ['a text block', { type: 'text', text: 'checking again' }],
    ['a thinking block', { type: 'thinking', thinking: '' }],
    ['a call with other args', call('x', { pattern: 'other' })],
    ['another read-only tool', call('x', { pattern: 'ad' }, 'Read')],
  ])('resets the run when %s sits between the copies', (_label, between) => {
    const half = Array.from({ length: LIMIT - 1 }, (_, i) => call(`a${i}`))
    const rest = Array.from({ length: LIMIT - 1 }, (_, i) => call(`b${i}`))
    expect(feed([...half, between as Record<string, unknown>, ...rest])).toEqual([])
  })

  it('never trips on a tool that is not read-only', () => {
    const blocks = Array.from({ length: LIMIT * 3 }, (_, i) => call(`t${i}`, { x: 1 }, 'Click'))
    expect(feed(blocks)).toEqual([])
  })

  it('treats a throwing isReadOnly as not read-only', () => {
    const guard = createRepeatedToolCallGuard(() => {
      throw new Error('bad input')
    })
    const tripped = Array.from({ length: LIMIT * 2 }, (_, i) => guard.observe(call(`t${i}`)))
    expect(tripped.some(Boolean)).toBe(false)
  })
})

// ── Through the stream consumer (engine/turn/streamReader.ts) ─────────────────────────────

const fakeTool = (name: string, readOnly: boolean) => ({
  name,
  readsOnly: () => readOnly,
  parallelSafe: () => readOnly,
  isEnabled: () => true,
  argsShape: { safeParse: (v: unknown) => ({ success: true, data: v }) },
  prompt: async () => name,
  description: async () => name,
  displayLabel: () => name,
})

function makeCallModelParams() {
  const toolUseContext = createNoopToolUseContext({
    tools: [fakeTool('Grep', true), fakeTool('Click', false)] as never,
    platformCapabilities: new NoopPlatformCapabilities(),
    appState: createEmptyAppState(),
    setAppState: () => {},
  })
  return {
    messages: [{
      type: 'user',
      uuid: 'user-1',
      message: { role: 'user', content: 'hello' },
    } as Message],
    baseInstructions: 'test',
    userContext: {},
    systemAmbient: {},
    callContext: toolUseContext,
    querySource: 'test',
    providerId: 'deepseek',
  }
}

const toolChunk = (index: number, toolName = 'Grep', args: unknown = { pattern: 'ad' }) => ({
  type: 'content_block_start',
  index,
  content_block: { type: 'tool-call', toolCallId: `toolu_${index}`, toolName, args },
})
const textChunk = (index: number, text: string) => [
  { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index, delta: { type: 'text_delta', text } },
]
const maxTokensDelta = {
  type: 'message_delta',
  delta: { stop_reason: 'max_tokens' },
  usage: { output_tokens: 64000 },
}

async function runStream(chunks: unknown[]) {
  const actions: string[] = []
  const transport = {
    servesModelRoutes: true,
    request: async (req: { route: { action: string } }) => {
      actions.push(req.route.action)
      switch (req.route.action) {
        case 'streamStart':
          return { ok: true as const, result: { streamId: 's1' } }
        case 'streamRead':
          return { ok: true as const, result: { done: true, chunks } }
        case 'streamCancel':
          return { ok: true as const, result: {} }
        default:
          return {
            ok: false as const,
            error: { code: 'UNEXPECTED', message: `unexpected ${req.route.action}` },
          }
      }
    },
  }
  const runtimeConfig = new DefaultRuntimeConfig()
  const deps = assembleTurnDependencies(runtimeConfig, {}, {
    bridgeTransport: transport as never,
    runtimeConfig,
  })
  const gen = deps.callModel(makeCallModelParams() as never) as AsyncGenerator<unknown>
  for await (const value of gen) {
    const msg = value as {
      type?: string
      apiError?: string
      repeatedToolCallCut?: Record<string, unknown>
      message?: { content?: Array<Record<string, unknown>>; stop_reason?: string }
    }
    if (msg.type === 'assistant') return { msg, actions }
  }
  throw new Error('no assistant message yielded')
}

describe('stream consumer cuts a repeated read-only tool call', () => {
  it('keeps one copy, ends as tool_use, cancels upstream, and records the cut', async () => {
    const chunks = [
      ...Array.from({ length: 40 }, (_, i) => toolChunk(i)),
      maxTokensDelta,
    ]
    const { msg, actions } = await runStream(chunks)

    expect(msg.message?.content).toEqual([
      { type: 'tool-call', toolCallId: 'toolu_0', toolName: 'Grep', args: { pattern: 'ad' } },
    ])
    expect(msg.message?.stop_reason).toBe('tool_use')
    // No truncation verdict: the query loop must not escalate and re-ask.
    expect(msg.apiError).toBeUndefined()
    expect(actions).toContain('streamCancel')
    expect(msg.repeatedToolCallCut).toMatchObject({
      toolName: 'Grep',
      repeatCount: LIMIT,
      providerId: 'deepseek',
      toolCount: expect.any(Number),
      transcriptLength: expect.any(Number),
      systemPromptHash: expect.stringMatching(/^[0-9a-f]{8}$/),
    })
  })

  it('keeps calls that came before the run', async () => {
    const chunks = [
      ...textChunk(0, 'Searching.'),
      toolChunk(1, 'Grep', { pattern: 'first' }),
      ...Array.from({ length: LIMIT + 2 }, (_, i) => toolChunk(i + 2)),
    ]
    const { msg } = await runStream(chunks)

    expect(msg.message?.content?.map(b => b.toolCallId ?? b.type)).toEqual([
      'text',
      'toolu_1',
      'toolu_2',
    ])
  })

  it('leaves the response alone when text separates the copies', async () => {
    const chunks: unknown[] = []
    for (let i = 0; i < LIMIT * 2; i++) {
      chunks.push(toolChunk(i * 2))
      chunks.push(...textChunk(i * 2 + 1, 'again'))
    }
    chunks.push(maxTokensDelta)
    const { msg, actions } = await runStream(chunks)

    expect(msg.message?.content?.filter(b => b.type === 'tool-call')).toHaveLength(LIMIT * 2)
    expect(msg.apiError).toBe('max_output_tokens')
    expect(msg.repeatedToolCallCut).toBeUndefined()
    expect(actions).not.toContain('streamCancel')
  })

  it('leaves a run one short of the limit alone', async () => {
    const chunks = [
      ...Array.from({ length: LIMIT - 1 }, (_, i) => toolChunk(i)),
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 50 } },
    ]
    const { msg } = await runStream(chunks)

    expect(msg.message?.content).toHaveLength(LIMIT - 1)
    expect(msg.repeatedToolCallCut).toBeUndefined()
  })

  it('never cuts a tool that is not read-only', async () => {
    const chunks = [
      ...Array.from({ length: LIMIT * 2 }, (_, i) => toolChunk(i, 'Click', { x: 1 })),
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 50 } },
    ]
    const { msg, actions } = await runStream(chunks)

    expect(msg.message?.content).toHaveLength(LIMIT * 2)
    expect(msg.repeatedToolCallCut).toBeUndefined()
    expect(actions).not.toContain('streamCancel')
  })
})
