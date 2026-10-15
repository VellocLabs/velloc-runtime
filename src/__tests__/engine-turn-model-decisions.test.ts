import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Message } from '../runtime/RuntimeTypes'
import { ProviderApiError } from '../utils/providerConnectivity'
import { buildModelRequest, effectiveModelOf } from '../engine/turn/modelTransport'
import {
  classifyModelFailure,
  decideRetry,
  isBackgroundCaller,
  waitRetry,
  type ModelFailure,
} from '../engine/turn/retryLadder'
import {
  assembleChunk,
  buildStreamedAssistants,
  openStreamAccumulator,
  isEmptyStream,
  type ChunkContext,
  type StreamChunk,
} from '../engine/turn/streamReader'
import { REPEATED_TOOL_CALL_LIMIT } from '../engine/turn/repeatedToolCallGuard'
import {
  NoopPlatformCapabilities,
  createEmptyAppState,
  createNoopToolUseContext,
} from '../runtime/testing/noopAdapters'

/**
 * The pure decisions of the model call: request construction, failure
 * classification, the retry decision and the chunk state machine. None of
 * these touch the bridge, so each is driven directly with plain inputs.
 */

const fakeTool = (name: string, readOnly: boolean) => ({
  name,
  readsOnly: () => readOnly,
  parallelSafe: () => readOnly,
  offeredNow: () => true,
  argsShape: { safeParse: (v: unknown) => ({ success: true, data: v }) },
  prompt: async () => name,
  description: async () => name,
  displayLabel: () => name,
})

const tools = [fakeTool('Grep', true), fakeTool('Click', false)]

function callParams(overrides: Record<string, unknown> = {}) {
  const toolUseContext = createNoopToolUseContext({
    tools: tools as never,
    platformCapabilities: new NoopPlatformCapabilities(),
    appState: createEmptyAppState(),
    setAppState: () => {},
  })
  return {
    messages: [
      { type: 'user', uuid: 'u1', message: { role: 'user', content: 'hello' } } as Message,
    ],
    baseInstructions: 'be brief',
    userContext: {},
    systemAmbient: {},
    callContext: toolUseContext,
    querySource: 'sdk',
    providerId: 'deepseek',
    ...overrides,
  } as never
}

// ── buildModelRequest ──────────────────────────────────────────────────────

describe('buildModelRequest', () => {
  it('assembles payload, facts and trace metadata from one call', () => {
    const defs = [{ name: 'Grep' }, { name: 'Click' }]
    const request = buildModelRequest(callParams(), defs)
    const payload = request.payload as Record<string, unknown>
    expect(payload.providerId).toBe('deepseek')
    expect(payload.systemPrompt).toBe('be brief')
    expect(payload.tools).toBe(defs)
    expect(Array.isArray(payload.messages)).toBe(true)
    expect((payload.messages as unknown[]).length).toBe(1)
    expect(payload.toolUseContext).toMatchObject({ querySource: 'sdk' })
    expect(payload.toolUseContext).not.toHaveProperty('sessionId')
    expect(request.facts).toMatchObject({ toolCount: 2, transcriptLength: 1 })
    expect(request.trace).toMatchObject({
      turnCaller: 'sdk',
      providerId: 'deepseek',
      toolCount: 2,
      transcriptLength: 1,
      inputMessageCount: 1,
    })
  })

  it('uses the model override when one is given', () => {
    const params = callParams({ modelOverride: 'small-model' })
    expect(effectiveModelOf(params)).toBe('small-model')
    expect(buildModelRequest(params, []).payload.model).toBe('small-model')
  })

  it('sends only the transcript after the latest compaction boundary', () => {
    const params = callParams({
      messages: [
        { type: 'user', uuid: 'old', message: { role: 'user', content: 'old question' } },
        {
          type: 'system',
          subtype: 'compact_boundary',
          uuid: 'b1',
          content: 'compacted',
          compactMetadata: { trigger: 'manual', preTokens: 1 },
        },
        { type: 'user', uuid: 'new', message: { role: 'user', content: 'new question' } },
      ],
    })
    const sent = JSON.stringify(buildModelRequest(params, []).payload.messages)
    expect(sent).toContain('new question')
    expect(sent).not.toContain('old question')
  })
})

// ── classifyModelFailure ───────────────────────────────────────────────────

describe('classifyModelFailure', () => {
  it('treats an AbortError (scope teardown or Stop) as cancellation', () => {
    const abort = new DOMException('Runtime scope was disposed.', 'AbortError')
    expect(classifyModelFailure(abort).kind).toBe('aborted')
  })

  it('recognises an over-long prompt', () => {
    const error = new Error('prompt is too long: 250000 tokens > 200000 maximum')
    expect(classifyModelFailure(error).kind).toBe('prompt_too_long')
  })

  it('reads a rate limit with its typed Retry-After', () => {
    const error = new ProviderApiError('rate_limit_error: slow down', {
      httpStatus: 429,
      retryAfterMs: 7000,
    })
    const failure = classifyModelFailure(error)
    expect(failure.kind).toBe('rate_limit')
    expect(failure).toMatchObject({ retryAfterMs: 7000 })
  })

  it('classifies a service outage as connectivity', () => {
    const failure = classifyModelFailure(new Error('server_error: internal_server_error'))
    expect(failure.kind).toBe('connectivity')
  })

  it('leaves an unrecognised error as other', () => {
    expect(classifyModelFailure(new Error('something odd')).kind).toBe('other')
  })
})

// ── decideRetry ────────────────────────────────────────────────────────────

describe('decideRetry', () => {
  afterEach(() => vi.restoreAllMocks())

  const rateLimit = (retryAfterMs?: number): ModelFailure =>
    classifyModelFailure(
      new ProviderApiError('rate_limit_error: slow down', {
        httpStatus: 429,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      }),
    )
  const outage = (): ModelFailure =>
    classifyModelFailure(new Error('server_error: internal_server_error'))
  const base = {
    attempt: 1,
    maxAttempts: 5,
    caller: 'sdk',
    attemptDurationMs: 100,
    cancelled: false,
  }

  it('retries a retryable verdict with a growing, quiet backoff', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    expect(decideRetry({ ...base, failure: outage() })).toEqual({
      retry: true,
      delayMs: 500,
      notify: false,
    })
    expect(decideRetry({ ...base, attempt: 2, failure: outage() })).toMatchObject({
      delayMs: 1000,
    })
  })

  it('honours the server Retry-After', () => {
    expect(decideRetry({ ...base, failure: rateLimit(3000) })).toMatchObject({
      retry: true,
      delayMs: 3000,
    })
  })

  it('notifies from the fourth attempt, after a slow attempt, or before a long wait', () => {
    expect(decideRetry({ ...base, attempt: 4, failure: outage() })).toMatchObject({ notify: true })
    expect(decideRetry({ ...base, attemptDurationMs: 10_000, failure: outage() }))
      .toMatchObject({ notify: true })
    expect(decideRetry({ ...base, failure: rateLimit(12_000) })).toMatchObject({ notify: true })
  })

  it('gives up for a background caller on the first rate limit', () => {
    expect(isBackgroundCaller('rename_generate_name')).toBe(true)
    expect(isBackgroundCaller('sdk')).toBe(false)
    expect(decideRetry({ ...base, caller: 'rename_generate_name', failure: rateLimit() }))
      .toEqual({ retry: false })
    expect(decideRetry({ ...base, caller: 'rename_generate_name', failure: outage() }).retry)
      .toBe(true)
  })

  it('stops when attempts are exhausted, the call is cancelled, or the failure is not retryable', () => {
    expect(decideRetry({ ...base, attempt: 5, failure: outage() })).toEqual({ retry: false })
    expect(decideRetry({ ...base, cancelled: true, failure: outage() })).toEqual({ retry: false })
    expect(decideRetry({ ...base, failure: classifyModelFailure(new Error('odd')) }))
      .toEqual({ retry: false })
    expect(decideRetry({
      ...base,
      failure: classifyModelFailure(new Error('prompt is too long: 9 tokens > 1 maximum')),
    })).toEqual({ retry: false })
  })
})

describe('waitRetry', () => {
  it('ends early and quietly when the signal fires', async () => {
    const controller = new AbortController()
    const waiting = waitRetry(60_000, controller.signal)
    controller.abort()
    await expect(waiting).resolves.toBeUndefined()
  })
})

// ── the chunk state machine ────────────────────────────────────────────────

const ctx = (): ChunkContext => ({
  tools: tools as never,
  providerId: 'deepseek',
  baseInstructions: 'be brief',
  facts: { effectiveModel: 'm1', toolCount: 2, transcriptLength: 3 },
  elapsedMs: 42,
})
const isReadOnly = (name: string) => name === 'Grep'
const chunk = (c: Record<string, unknown>) => c as unknown as StreamChunk
const ids = () => {
  let n = 0
  return { uuid: () => `id-${++n}`, timestamp: () => 'T' }
}

describe('assembleChunk', () => {
  it('records the model and passes start usage on as a stream event', () => {
    const acc = openStreamAccumulator(isReadOnly)
    const out = assembleChunk(
      acc,
      chunk({ type: 'message_start', message: { model: 'm2', usage: { input_tokens: 5 } } }),
      ctx(),
    )
    expect(acc.model).toBe('m2')
    expect(out.emit).toEqual({
      type: 'stream_event',
      event: { type: 'message_start', message: { usage: { input_tokens: 5 } } },
    })
  })

  it('accumulates text, thinking and signature deltas into their blocks', () => {
    const acc = openStreamAccumulator(isReadOnly)
    assembleChunk(acc, chunk({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }), ctx())
    assembleChunk(acc, chunk({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } }), ctx())
    assembleChunk(acc, chunk({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } }), ctx())
    expect(acc.blocks[0]).toMatchObject({ text: 'Hello' })
  })

  it('stamps the stop reason and merges delta usage', () => {
    const acc = openStreamAccumulator(isReadOnly)
    const out = assembleChunk(
      acc,
      chunk({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } }),
      ctx(),
    )
    expect(acc.stopReason).toBe('end_turn')
    expect(acc.usage).toEqual({ output_tokens: 9 })
    expect(out.emit).toBeDefined()
  })

  it('turns an error chunk into a typed provider error', () => {
    const acc = openStreamAccumulator(isReadOnly)
    const out = assembleChunk(
      acc,
      chunk({ type: 'error', error: { type: 'provider_error', message: 'boom', httpStatus: 503, retryAfterSeconds: 2 } }),
      ctx(),
    )
    expect(out.error).toBeInstanceOf(ProviderApiError)
    expect(out.error?.message).toBe('provider_error: boom')
    expect(out.error).toMatchObject({ httpStatus: 503, retryAfterMs: 2000 })
  })

  it('drops a second announcement of the same tool call', () => {
    const acc = openStreamAccumulator(isReadOnly)
    const start = chunk({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool-call', toolCallId: 't1', toolName: 'Click', args: {} },
    })
    assembleChunk(acc, start, ctx())
    const second = assembleChunk(acc, start, ctx())
    expect(acc.blocks).toHaveLength(1)
    expect(second.note?.event).toBe('dup-content-block-skip')
  })

  it('cuts a run of identical read-only calls, keeping the first', () => {
    const acc = openStreamAccumulator(isReadOnly)
    let cut
    for (let i = 0; i < REPEATED_TOOL_CALL_LIMIT && !cut; i += 1) {
      cut = assembleChunk(acc, chunk({
        type: 'content_block_start',
        index: i,
        content_block: { type: 'tool-call', toolCallId: `t${i}`, toolName: 'Grep', args: { p: 1 } },
      }), ctx()).cut
    }
    expect(cut).toMatchObject({
      toolName: 'Grep',
      repeatCount: REPEATED_TOOL_CALL_LIMIT,
      model: 'm1',
      toolCount: 2,
      transcriptLength: 3,
      elapsedMs: 42,
    })
    expect(acc.blocks).toHaveLength(1)
    expect(acc.stopReason).toBe('tool_use')
  })
})

describe('isEmptyStream', () => {
  it('flags a stream with no blocks and no stop reason or no output', () => {
    const acc = openStreamAccumulator(isReadOnly)
    expect(isEmptyStream(acc, false)).toBe(true)
    acc.stopReason = 'end_turn'
    acc.usage = { output_tokens: 0 }
    expect(isEmptyStream(acc, false)).toBe(true)
  })

  it('does not flag truncation, a safety stop, a cancelled read or real output', () => {
    const acc = openStreamAccumulator(isReadOnly)
    expect(isEmptyStream(acc, true)).toBe(false)
    acc.stopReason = 'max_tokens'
    expect(isEmptyStream(acc, false)).toBe(false)
    acc.stopReason = 'content_filter'
    expect(isEmptyStream(acc, false)).toBe(false)
    acc.stopReason = 'end_turn'
    acc.usage = { output_tokens: 3 }
    expect(isEmptyStream(acc, false)).toBe(false)
  })
})

describe('buildStreamedAssistants', () => {
  it('builds one assistant with an empty text part when nothing streamed', () => {
    const acc = openStreamAccumulator(isReadOnly)
    acc.stopReason = 'end_turn'
    const [only, ...rest] = buildStreamedAssistants(acc, 'm1', ids())
    expect(rest).toEqual([])
    expect(only).toMatchObject({
      type: 'assistant',
      uuid: 'id-1',
      message: { content: [{ type: 'text', text: '' }], model: 'm1', stop_reason: 'end_turn' },
    })
  })

  it('marks a truncated response', () => {
    const acc = openStreamAccumulator(isReadOnly)
    acc.blocks.push({ type: 'text', text: 'partial' })
    acc.stopReason = 'max_tokens'
    expect(buildStreamedAssistants(acc, 'm1', ids())[0]).toMatchObject({ apiError: 'max_output_tokens' })
  })

  it('splits a safety stop into the streamed part and an API-error message', () => {
    const acc = openStreamAccumulator(isReadOnly)
    acc.blocks.push({ type: 'text', text: 'before the stop' })
    acc.stopReason = 'content_filter'
    const out = buildStreamedAssistants(acc, 'm1', ids())
    expect(out).toHaveLength(2)
    expect(out[1]).toMatchObject({ uuid: 'id-2' })
    expect(out[1]).toMatchObject({ isApiErrorMessage: true, error: 'refusal' })
  })
})
