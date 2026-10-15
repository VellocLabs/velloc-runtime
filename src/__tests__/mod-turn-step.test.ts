/**
 * `turn.step` (F-25): the model call cut into chunks (`modelChunks`), rebuilt into messages (`TurnStepAssembler`),
 * the step arriving at core (`arrivedTurnStep`), and the call raised through the chain
 * (`callModelThroughTurnStep`), failure paths included.
 */
import { describe, expect, it } from 'vitest'
import { ModDispatcher } from '../mods/ModDispatcher'
import type { ChainLink } from '../mods/ModDispatcher'
import type { ChainStream, StreamHookCall } from '../mods/streamChain'
import {
  TurnStepAssembler,
  TurnStepRefs,
  arrivedTurnStep,
  hookMadeAssistant,
  isTurnStepResult,
  modelChunks,
  turnStopReasonOf,
  type TurnStepChunk,
  type TurnStepInput,
  type TurnStepResult,
} from '../mods/turnStepEvent'
import { callModelThroughTurnStep, type TurnStepMods } from '../engine/turn/turnStepThroughMods'
import type { ModelReplyRow, Message } from '../runtime/RuntimeTypes'
import type { QueryModelCallParams } from '../runtime/interfaces/QueryRuntimeDeps'

const usageEvent = { type: 'stream_event', event: { type: 'message_start' } } as unknown as Message

function assistant(content: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}): ModelReplyRow {
  return {
    type: 'assistant',
    uuid: 'a-1',
    timestamp: '2026-10-04T00:00:00.000Z',
    message: {
      role: 'assistant',
      content,
      model: 'model-x',
      stop_reason: 'tool_use',
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 },
    },
    ...extra,
  } as unknown as ModelReplyRow
}

const thinking = { type: 'thinking', thinking: 'hmm', signature: 'sig-1' }
const args = { file_path: '/a.txt', limit: 3 }
const toolBlock = { type: 'tool-call', toolCallId: 'call-1', toolName: 'Read', args }
const response = () => assistant([thinking, { type: 'text', text: 'Reading.' }, toolBlock, { type: 'redacted_thinking', data: 'x' }])

async function* messages(...list: Message[]): AsyncGenerator<Message, void, unknown> {
  for (const message of list) yield message
}

async function collect<C, R>(gen: AsyncGenerator<C, R, undefined>): Promise<{ chunks: C[]; result: R }> {
  const chunks: C[] = []
  for (;;) {
    const step = await gen.next()
    if (step.done) return { chunks, result: step.value }
    chunks.push(step.value)
  }
}

function assemble(refs: TurnStepRefs, chunks: readonly unknown[]): Message[] {
  const assembler = new TurnStepAssembler(refs, () => hookMadeAssistant('made-1', 'now', 'model-x'))
  return [...chunks.flatMap(chunk => assembler.push(chunk)), ...assembler.finish()]
}

const E = { turnId: 't-1', index: 2 }

describe('turn.step — the engine response as chunks', () => {
  it('cuts each message: an envelope, its blocks, its stop; anything else is an engine chunk', async () => {
    const refs = new TurnStepRefs()
    const { chunks, result } = await collect(modelChunks(messages(usageEvent, response()), refs, E))
    expect(chunks.map(c => c.kind)).toEqual(['engine', 'engine', 'thinking', 'text', 'tool', 'input', 'engine', 'stop'])
    expect(chunks.filter(c => c.kind !== 'engine').map(({ ref: _ref, ...rest }) => rest)).toEqual([
      { kind: 'thinking', index: 0, text: 'hmm' },
      { kind: 'text', index: 1, text: 'Reading.' },
      { kind: 'tool', index: 2, id: 'call-1', name: 'Read' },
      { kind: 'input', index: 2, json: JSON.stringify(args) },
      {
        kind: 'stop',
        stopReason: 'tool_use',
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 1, model: 'model-x' },
      },
    ])
    expect(result).toEqual({
      turnId: 't-1',
      index: 2,
      answer: 'Reading.',
      toolUses: [{ name: 'Read', input: args }],
      stopReason: 'tool_use',
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 1, model: 'model-x' },
    })
    expect(isTurnStepResult(result)).toBe(true)
  })

  it('a step with no response has a null stop and usage', async () => {
    const { result } = await collect(modelChunks(messages(usageEvent), new TurnStepRefs(), E))
    expect(result).toMatchObject({ answer: '', toolUses: [], stopReason: null, usage: null })
  })

  it("names the engine's stop reasons as the event does: a safety stop is a refusal, an unknown one none", () => {
    expect(turnStopReasonOf('end_turn')).toBe('end_turn')
    expect(turnStopReasonOf('content_filter')).toBe('refusal')
    expect(turnStopReasonOf('length')).toBe(null)
    expect(turnStopReasonOf(undefined)).toBe(null)
  })
})

describe('turn.step — what leaves the chain, rebuilt', () => {
  it('passed through unchanged, the messages are the engine\'s own, in order', async () => {
    const refs = new TurnStepRefs()
    const original = response()
    const { chunks } = await collect(modelChunks(messages(usageEvent, original), refs, E))
    const out = assemble(refs, chunks)
    expect(out[0]).toBe(usageEvent)
    expect(out[1]).toEqual(original)
    const content = (out[1] as ModelReplyRow).message.content
    // The signed thinking block and the arguments object are the originals.
    expect(content[0]).toBe(thinking)
    expect(content[2]!.args).toBe(args)
  })

  it('rewritten text is both shown and recorded; pieces of one block concatenate', async () => {
    const refs = new TurnStepRefs()
    const { chunks } = await collect(modelChunks(messages(response()), refs, E))
    const rewritten = chunks.flatMap((c): unknown[] =>
      c.kind === 'text' ? [{ ...c, text: 'Read' }, { ...c, text: 'ing!' }] : [c],
    )
    const content = (assemble(refs, rewritten)[0] as ModelReplyRow).message.content
    expect(content[1]).toEqual({ type: 'text', text: 'Reading!' })
  })

  it('tool arguments are the pieces parsed at the block end; broken JSON leaves the raw text', async () => {
    const refs = new TurnStepRefs()
    const { chunks } = await collect(modelChunks(messages(response()), refs, E))
    const swap = (json: string[]) =>
      chunks.flatMap((c): unknown[] => (c.kind === 'input' ? json.map(piece => ({ kind: 'input', index: c.index, json: piece })) : [c]))
    const parsed = (assemble(refs, swap(['{"file_path":', '"/b.txt"}']))[0] as ModelReplyRow).message.content[2]
    expect(parsed).toEqual({ type: 'tool-call', toolCallId: 'call-1', toolName: 'Read', args: { file_path: '/b.txt' } })
    const broken = (assemble(refs, swap(['{"file_path":']))[0] as ModelReplyRow).message.content[2]
    expect(broken!.args).toBe('{"file_path":')
  })

  it("a block whose tool chunk never comes out is no tool call; thinking a hook made is not recorded", async () => {
    const refs = new TurnStepRefs()
    const { chunks } = await collect(modelChunks(messages(response()), refs, E))
    const edited: unknown[] = chunks
      .filter(c => c.kind !== 'tool' && c.kind !== 'thinking')
      .flatMap((c): unknown[] => (c.kind === 'text' ? [{ kind: 'thinking', index: 9, text: 'made up' }, c] : [c]))
    const content = (assemble(refs, edited)[0] as ModelReplyRow).message.content
    expect(content.map(b => b.type)).toEqual(['text', 'redacted_thinking'])
  })

  it('a stop a hook changed is the response\'s; a truncation is one only when it says so', async () => {
    const refs = new TurnStepRefs()
    const truncated = assistant([{ type: 'text', text: 'cut' }], { apiError: 'max_output_tokens' })
    ;(truncated.message as Record<string, unknown>).stop_reason = 'max_tokens'
    const { chunks } = await collect(modelChunks(messages(truncated), refs, E))
    const ended = chunks.map(c => (c.kind === 'stop' ? { ...c, stopReason: 'end_turn', usage: null } : c))
    const out = assemble(refs, ended)[0] as ModelReplyRow & { apiError?: string }
    expect(out.message.stop_reason).toBe('end_turn')
    expect(out.message.usage).toBeUndefined()
    expect(out.apiError).toBeUndefined()
  })

  it("a hook's own response gets an envelope from the engine, naming the step's model", () => {
    const out = assemble(new TurnStepRefs(), [
      { kind: 'text', index: 0, text: 'cached answer' },
      { kind: 'stop', stopReason: 'end_turn', usage: null },
    ])
    expect(out).toEqual([
      {
        type: 'assistant',
        uuid: 'made-1',
        timestamp: 'now',
        message: { role: 'assistant', content: [{ type: 'text', text: 'cached answer' }], model: 'model-x', stop_reason: 'end_turn' },
      },
    ])
  })

  it('ignores a ref the step does not hold, and what is not a chunk', () => {
    expect(assemble(new TurnStepRefs(), [{ kind: 'engine', ref: 42 }, null, 'x', { kind: 'nope' }])).toEqual([])
  })
})

describe('turn.step — the step as it arrives at core', () => {
  const sent: TurnStepInput = { turnId: 't', index: 1, model: 'big', effort: 'high', messageCount: 4, agentId: 'a1' }

  it('takes model and effort from a hook; keeps every pinned field as sent', () => {
    expect(
      arrivedTurnStep(sent, { turnId: 'x', index: 9, model: 'small', effort: 'low', messageCount: 0, agentId: 'zz' }),
    ).toEqual({ turnId: 't', index: 1, model: 'small', effort: 'low', messageCount: 4, agentId: 'a1' })
  })

  it("leaves the engine's model and effort where a hook's are not ones", () => {
    expect(arrivedTurnStep(sent, { model: '  ', effort: 'extreme' })).toEqual(sent)
    expect(arrivedTurnStep(sent, null)).toEqual(sent)
  })
})

// ── raised through a chain ──

function chainMods(hooks: Array<(call: StreamHookCall) => AsyncGenerator<unknown, unknown, undefined>>) {
  const reports: string[] = []
  const dispatcher = new ModDispatcher({ budgetMs: 5_000, catchMs: 1_000, onHookFailure: r => reports.push(`hook ${r.plugin}: ${r.outcome}`) })
  dispatcher.register(
    'm',
    hooks.map(
      (hook, i): ChainLink => ({
        id: `m/${i}`,
        plugin: `m${i}`,
        tier: 'user',
        pattern: 'turn.step',
        streams: true,
        run: () => Promise.reject(new Error('generator')),
        runStream: call => {
          const gen = hook(call)
          return { next: () => gen.next(), return: async () => void (await gen.return(undefined)) }
        },
      }),
    ),
  )
  const seen: TurnStepInput[] = []
  const mods: TurnStepMods = {
    hasTurnStepHooks: () => dispatcher.hasHooksFor('turn.step'),
    turnStep: (e, core, signal) => {
      seen.push(e)
      return dispatcher.dispatchStream<TurnStepChunk, TurnStepResult>(
        'turn.step',
        e,
        arrived => core(arrivedTurnStep(e, arrived)),
        { accepts: isTurnStepResult, ...(signal ? { signal } : {}) },
      )
    },
    report: line => reports.push(line),
  }
  return { mods, reports, seen }
}

async function* read(stream: ChainStream): AsyncGenerator<unknown, unknown, undefined> {
  for (;;) {
    const step = await stream.next()
    if (step.done) return step.value
    yield step.value
  }
}

function callParams(thinkingTier = 'high'): QueryModelCallParams {
  return {
    messages: [],
    callContext: { options: { mainLoopModel: 'big' }, cancelSource: new AbortController() },
    thinkingTier,
  } as unknown as QueryModelCallParams
}

const ids = { uuid: () => 'made-1', timestamp: () => 'now' }
const place = { turnId: 't-1', index: 0, transcriptLength: 3 }

async function run(
  mods: TurnStepMods | undefined,
  callModel: (p: QueryModelCallParams) => AsyncGenerator<Message, void, unknown>,
  thinkingTier?: string,
) {
  const out: Message[] = []
  for await (const message of callModelThroughTurnStep(callModel, callParams(thinkingTier), place, mods, ids)) out.push(message)
  return out
}

describe('turn.step — the model call raised through the chain', () => {
  it('with no hook selecting it, it is the model call itself', async () => {
    const original = response()
    const out = await run(chainMods([]).mods, async function* () {
      yield original
    })
    expect(out).toEqual([original])
    expect(out[0]).toBe(original)
  })

  it("hands the hooks the step; a hook's model and effort go out as the request's", async () => {
    const { mods, seen } = chainMods([
      async function* (call) {
        return yield* read(call.next({ ...(call.e as object), model: 'small', effort: 'low' }))
      },
    ])
    const requests: QueryModelCallParams[] = []
    await run(mods, async function* (p) {
      requests.push(p)
      yield response()
    })
    expect(seen).toEqual([{ turnId: 't-1', index: 0, model: 'big', effort: 'high', messageCount: 3 }])
    expect(requests).toHaveLength(1)
    expect(requests[0]!.modelOverride).toBe('small')
    expect(requests[0]!.thinkingTier).toBe('low')
  })

  it("the engine's extra-high tier is the event's xhigh, both ways", async () => {
    const { mods, seen } = chainMods([
      async function* (call) {
        return yield* read(call.next({ ...(call.e as object), effort: 'xhigh' }))
      },
    ])
    const requests: QueryModelCallParams[] = []
    const capture = async function* (p: QueryModelCallParams) {
      requests.push(p)
      yield response()
    }
    await run(mods, capture, 'extra-high')
    expect(seen[0]).toMatchObject({ effort: 'xhigh' })
    // Unchanged: the request keeps the engine's tier.
    expect(requests[0]!.thinkingTier).toBe('extra-high')
    await run(mods, capture, 'medium')
    expect(requests[1]!.thinkingTier).toBe('extra-high')
  })

  it("core's own error passes up exactly as without mods", async () => {
    const { mods, reports } = chainMods([
      async function* (call) {
        return yield* read(call.next(call.e))
      },
    ])
    const failure = new Error('transport down')
    await expect(
      run(mods, async function* () {
        yield usageEvent
        throw failure
      }),
    ).rejects.toBe(failure)
    expect(reports).toEqual([])
  })

  it('a chain that rejects before any request goes out: reported, and the request is sent without its hooks', async () => {
    const original = response()
    const mods: TurnStepMods = {
      hasTurnStepHooks: () => true,
      turnStep: () =>
        (async function* () {
          throw new Error('nothing left to stand')
        })() as never,
      report: line => reports.push(line),
    }
    const reports: string[] = []
    const out = await run(mods, async function* () {
      yield original
    })
    expect(out).toEqual([original])
    expect(reports).toEqual(['mods: turn.step failed: nothing left to stand; the request is sent without its hooks'])
  })
})
