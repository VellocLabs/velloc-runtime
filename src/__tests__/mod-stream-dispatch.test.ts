/**
 * The streaming hook chain (`turn.step`, `process.spawn`) with generator hooks: passing, transforming, answering,
 * mid-stream failures, the budget over the hook's own time, `.catch`, early close, and which hook form runs on
 * which event. Rules are the `claude-code` module's declarations unless a test says "Velloc".
 */
import { describe, expect, it } from 'vitest'
import {
  ModDispatcher,
  type ChainLink,
  type HookFailureReport,
} from '../mods/ModDispatcher'
import type { ChainStream, StreamCatchCall, StreamHookCall } from '../mods/streamChain'
import { MAX_DISPATCH_CALLS, type PluginTier, type TraceEntry } from '../mods/modTypes'

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** `next(e)` as a hook beside the chain reads it: an async generator whose
 *  return value is the result from beneath, closing the stream when left. */
async function* read(stream: ChainStream): AsyncGenerator<unknown, unknown, undefined> {
  let done = false
  try {
    for (;;) {
      const step = await stream.next()
      if (step.done) {
        done = true
        return step.value
      }
      yield step.value
    }
  } finally {
    if (!done) await stream.return()
  }
}

type Gen = AsyncGenerator<unknown, unknown, undefined>
type Next = (e: unknown) => Gen

function asStream(gen: Gen): ChainStream {
  return {
    next: () => gen.next(),
    return: async () => {
      await gen.return(undefined)
    },
  }
}

let linkSeq = 0
function streamLink(
  plugin: string,
  tier: PluginTier,
  pattern: string,
  hook: (call: StreamHookCall, next: Next) => Gen,
  extra: { onCatch?: (call: StreamCatchCall, next: Next) => Gen; matcher?: unknown } = {},
): ChainLink {
  const onCatch = extra.onCatch
  return {
    id: `${plugin}/${++linkSeq}`,
    plugin,
    tier,
    pattern,
    streams: true,
    ...(extra.matcher !== undefined ? { matcher: extra.matcher } : {}),
    run: () => Promise.reject(new Error('a generator hook is never run plainly')),
    runStream: call => asStream(hook(call, e => read(call.next(e)))),
    ...(onCatch ? { runCatchStream: (call: StreamCatchCall) => asStream(onCatch(call, e => read(call.next(e)))) } : {}),
  }
}

function setup(options: { budgetMs?: number; catchMs?: number } = {}) {
  const failures: HookFailureReport[] = []
  const dispatcher = new ModDispatcher({
    budgetMs: options.budgetMs ?? 5_000,
    catchMs: options.catchMs ?? 5_000,
    onHookFailure: report => failures.push(report),
  })
  return { dispatcher, failures }
}

/** Core: yields `chunks`, returns `result`; records what it saw. */
function core(chunks: readonly unknown[], result: unknown = 'core-result') {
  const seen: { e: unknown[]; closed: number; started: number } = { e: [], closed: 0, started: 0 }
  const fn = async function* (e: unknown): AsyncGenerator<unknown, unknown> {
    seen.started += 1
    seen.e.push(e)
    let finished = false
    try {
      for (const chunk of chunks) yield chunk
      finished = true
      return result
    } finally {
      if (!finished) seen.closed += 1
    }
  }
  return { fn, seen }
}

async function drain<C, R>(stream: AsyncGenerator<C, R | undefined, undefined>): Promise<{ chunks: C[]; result: R | undefined }> {
  const chunks: C[] = []
  for (;;) {
    const step = await stream.next()
    if (step.done) return { chunks, result: step.value }
    chunks.push(step.value)
  }
}

describe('ModDispatcher.dispatchStream — the call count', () => {
  it('a next opened again counts: a retry loop ends at the limit', async () => {
    const { dispatcher } = setup()
    const { fn, seen } = core([], 'R')
    let ended: string | undefined
    dispatcher.register('a', [
      streamLink('a', 'user', 'turn.step', async function* (call, next) {
        for (;;) {
          try {
            yield* next(call.e)
          } catch (error) {
            ended = String(error)
            return 'gave up'
          }
        }
      }),
    ])
    await expect(drain(dispatcher.dispatchStream('turn.step', {}, fn))).resolves.toEqual({ chunks: [], result: 'gave up' })
    expect(seen.started).toBe(MAX_DISPATCH_CALLS + 1)
    expect(ended).toMatch(/called next\(\) again past the dispatch's limit/)
  })
})

describe('ModDispatcher.dispatchStream — the chain', () => {
  it('with no hook on the event, dispatch IS core: its chunks and its result', async () => {
    const { dispatcher } = setup()
    const { fn } = core(['a', 'b'], 'R')
    const stream = dispatcher.dispatchStream('turn.step', {}, fn)
    await expect(drain(stream)).resolves.toEqual({ chunks: ['a', 'b'], result: 'R' })
    await expect(stream.result).resolves.toBe('R')
  })

  it('`return yield* next(e)` passes: every chunk and the result, untouched', async () => {
    const { dispatcher } = setup()
    dispatcher.register('a', [
      streamLink('a', 'user', 'turn.step', async function* (call, next) {
        return yield* next(call.e)
      }),
    ])
    const traces: (readonly TraceEntry[])[] = []
    const { fn } = core([1, 2, 3], 'R')
    const stream = dispatcher.dispatchStream('turn.step', { q: 1 }, fn, { trace: t => traces.push(t) })
    await expect(drain(stream)).resolves.toEqual({ chunks: [1, 2, 3], result: 'R' })
    // Trace entries gain `chunks`: how many each link yielded up.
    expect(traces[0]!.map(t => [t.plugin, t.outcome, t.chunks])).toEqual([
      ['a', 'returned', 3],
      ['engine', 'returned', 3],
    ])
  })

  it('transforms chunk by chunk, outermost hooks last', async () => {
    const { dispatcher } = setup()
    const upper = (plugin: string, tier: PluginTier, tag: string) =>
      streamLink(plugin, tier, 'turn.step', async function* (call, next) {
        const beneath = next(call.e)
        for (;;) {
          const step = await beneath.next()
          if (step.done) return `${tag}(${String(step.value)})`
          yield `${tag}(${String(step.value)})`
        }
      })
    dispatcher.register('outer', [upper('outer', 'prepend', 'o')])
    dispatcher.register('inner', [upper('inner', 'user', 'i')])
    const { fn } = core(['x', 'y'], 'R')
    await expect(drain(dispatcher.dispatchStream('turn.step', {}, fn))).resolves.toEqual({
      chunks: ['o(i(x))', 'o(i(y))'],
      result: 'o(i(R))',
    })
  })

  it('next({ ...e, x }) rewrites what beneath sees; the matcher reads e as it arrives', async () => {
    const { dispatcher } = setup()
    dispatcher.register('rewrite', [
      streamLink('rewrite', 'prepend', 'turn.step', async function* (call, next) {
        return yield* next({ ...(call.e as object), model: 'small' })
      }),
    ])
    const ran: string[] = []
    dispatcher.register('only-small', [
      streamLink(
        'only-small',
        'user',
        'turn.step',
        async function* (call, next) {
          ran.push('only-small')
          return yield* next(call.e)
        },
        { matcher: { model: 'small' } },
      ),
    ])
    const { fn, seen } = core(['c'])
    await drain(dispatcher.dispatchStream('turn.step', { model: 'big' }, fn))
    expect(ran).toEqual(['only-small'])
    expect(seen.e).toEqual([{ model: 'small' }])
  })

  it('a hook that yields without next answers alone: core never runs', async () => {
    const { dispatcher } = setup()
    dispatcher.register('cache', [
      streamLink('cache', 'user', 'turn.step', async function* () {
        yield 'cached'
        return 'cached-result'
      }),
    ])
    const { fn, seen } = core(['live'])
    await expect(drain(dispatcher.dispatchStream('turn.step', {}, fn))).resolves.toEqual({
      chunks: ['cached'],
      result: 'cached-result',
    })
    expect(seen.started).toBe(0)
  })

  it('is pull-driven: nothing beneath starts before the first read, and stops with the reader', async () => {
    const { dispatcher } = setup()
    dispatcher.register('a', [
      streamLink('a', 'user', 'turn.step', async function* (call, next) {
        return yield* next(call.e)
      }),
    ])
    const { fn, seen } = core([1, 2, 3])
    const stream = dispatcher.dispatchStream('turn.step', {}, fn)
    await sleep(5)
    expect(seen.started).toBe(0)
    expect(await stream.next()).toEqual({ done: false, value: 1 })
    // Closing the outermost stream closes every link, and core.
    await stream.return(undefined)
    expect(seen.closed).toBe(1)
    await expect(stream.result).rejects.toThrow(/closed before its end/)
  })

  it('returning a result while a stream beneath is still open closes it', async () => {
    const { dispatcher } = setup()
    dispatcher.register('first-only', [
      streamLink('first-only', 'user', 'turn.step', async function* (call, next) {
        const beneath = next(call.e)
        const first = await beneath.next()
        yield first.value
        return 'enough'
      }),
    ])
    const { fn, seen } = core([1, 2, 3])
    await expect(drain(dispatcher.dispatchStream('turn.step', {}, fn))).resolves.toEqual({
      chunks: [1],
      result: 'enough',
    })
    expect(seen.closed).toBe(1)
  })

  it("returning nothing lets its last next(e)'s result stand — read to its end, or the rest forwarded", async () => {
    const { dispatcher, failures } = setup()
    dispatcher.register('observer', [
      streamLink('observer', 'user', 'turn.step', async function* (call, next) {
        yield* next(call.e)
      }),
    ])
    dispatcher.register('peek', [
      streamLink('peek', 'builtin', 'turn.step', async function* (call, next) {
        const beneath = next(call.e)
        yield (await beneath.next()).value
        // Returns nothing with `beneath` still open: its rest goes on up.
      }),
    ])
    const traces: (readonly TraceEntry[])[] = []
    const { fn } = core([1, 2, 3], 'R')
    await expect(
      drain(dispatcher.dispatchStream('turn.step', {}, fn, { trace: t => traces.push(t) })),
    ).resolves.toEqual({ chunks: [1, 2, 3], result: 'R' })
    expect(failures).toEqual([])
    expect(traces[0]!.map(t => [t.plugin, t.outcome])).toEqual([
      ['observer', 'passed'],
      ['peek', 'passed'],
      ['engine', 'returned'],
    ])
  })

  it('returning nothing without ever calling next is a failure', async () => {
    const { dispatcher, failures } = setup()
    dispatcher.register('silent', [
      streamLink('silent', 'user', 'turn.step', async function* () {
        yield 'mine'
      }),
    ])
    const { fn } = core(['beneath'], 'R')
    // Its chunk stays; beneath runs in its place after it.
    await expect(drain(dispatcher.dispatchStream('turn.step', {}, fn))).resolves.toEqual({
      chunks: ['mine', 'beneath'],
      result: 'R',
    })
    expect(failures.map(f => [f.plugin, f.outcome, f.failure.message])).toEqual([
      ['silent', 'skipped', 'the hook returned nothing'],
    ])
  })
})

describe('ModDispatcher.dispatchStream — "a chunk yielded stays"', () => {
  it('a hook that fails mid-stream AFTER next is left: the rest from beneath it (kept)', async () => {
    const { dispatcher, failures } = setup()
    dispatcher.register('flaky', [
      streamLink('flaky', 'user', 'turn.step', async function* (call, next) {
        const beneath = next(call.e)
        const first = await beneath.next()
        yield `flaky:${String(first.value)}`
        throw new Error('boom')
      }),
    ])
    const traces: (readonly TraceEntry[])[] = []
    const { fn, seen } = core([1, 2, 3], 'R')
    await expect(
      drain(dispatcher.dispatchStream('turn.step', {}, fn, { trace: t => traces.push(t) })),
    ).resolves.toEqual({ chunks: ['flaky:1', 2, 3], result: 'R' })
    expect(seen.started).toBe(1)
    expect(failures.map(f => [f.plugin, f.outcome, f.failure.message])).toEqual([['flaky', 'kept', 'boom']])
    expect(traces[0]![0]).toMatchObject({ plugin: 'flaky', outcome: 'kept', chunks: 1 })
  })

  it('a hook that fails BEFORE next: beneath runs in its place on the e it was given (skipped)', async () => {
    const { dispatcher, failures } = setup()
    dispatcher.register('flaky', [
      streamLink('flaky', 'user', 'turn.step', async function* () {
        yield 'preamble'
        throw new Error('boom')
      }),
    ])
    const { fn, seen } = core([1], 'R')
    await expect(drain(dispatcher.dispatchStream('turn.step', { id: 7 }, fn))).resolves.toEqual({
      chunks: ['preamble', 1],
      result: 'R',
    })
    expect(seen.e).toEqual([{ id: 7 }])
    expect(failures.map(f => f.outcome)).toEqual(['skipped'])
  })

  it("Velloc: failing after closing the stream it opened rejects — there is no rest to stand", async () => {
    const { dispatcher, failures } = setup()
    dispatcher.register('quitter', [
      streamLink('quitter', 'user', 'turn.step', async function* (call, next) {
        for await (const chunk of next(call.e)) {
          yield chunk
          break
        }
        throw new Error('boom')
      }),
    ])
    const { fn } = core([1, 2])
    const stream = dispatcher.dispatchStream('turn.step', {}, fn)
    expect(await stream.next()).toEqual({ done: false, value: 1 })
    await expect(stream.next()).rejects.toThrow(/quitter's hook on turn.step failed after it closed the stream/)
    expect(failures.map(f => f.outcome)).toEqual(['rejected'])
  })
})

describe('ModDispatcher.dispatchStream — rejections travel up', () => {
  it('a rejection of core passes through a hook that lets it: rejected, not failed', async () => {
    const { dispatcher, failures } = setup()
    dispatcher.register('a', [
      streamLink('a', 'user', 'turn.step', async function* (call, next) {
        return yield* next(call.e)
      }),
    ])
    const traces: (readonly TraceEntry[])[] = []
    const failure = new Error('provider down')
    const stream = dispatcher.dispatchStream(
      'turn.step',
      {},
      async function* () {
        yield 'partial'
        throw failure
      },
      { trace: t => traces.push(t) },
    )
    expect(await stream.next()).toEqual({ done: false, value: 'partial' })
    await expect(stream.next()).rejects.toBe(failure)
    await expect(stream.result).rejects.toBe(failure)
    expect(failures).toEqual([])
    expect(traces[0]!.map(t => [t.plugin, t.outcome])).toEqual([
      ['a', 'rejected'],
      ['engine', 'rejected'],
    ])
  })

  it('a hook may catch the rejection and answer in its place', async () => {
    const { dispatcher } = setup()
    dispatcher.register('fallback', [
      streamLink('fallback', 'user', 'turn.step', async function* (call, next) {
        try {
          return yield* next(call.e)
        } catch {
          yield 'fallback'
          return 'fallback-result'
        }
      }),
    ])
    const stream = dispatcher.dispatchStream('turn.step', {}, async function* () {
      throw new Error('down')
    })
    await expect(drain(stream)).resolves.toEqual({ chunks: ['fallback'], result: 'fallback-result' })
  })
})

describe("ModDispatcher.dispatchStream — the budget is the hook's OWN time", () => {
  const slowPerChunk = (ms: number) =>
    streamLink('slow', 'user', 'turn.step', async function* (call, next) {
      for await (const chunk of next(call.e)) {
        await sleep(ms)
        yield chunk
      }
      return 'slow-result'
    })

  it("'stream' (turn.step) sums it over the response: expired, the rest from beneath", async () => {
    const { dispatcher, failures } = setup({ budgetMs: 250 })
    dispatcher.register('slow', [slowPerChunk(100)])
    const { fn } = core([1, 2, 3, 4], 'R')
    const { chunks, result } = await drain(dispatcher.dispatchStream('turn.step', {}, fn))
    // Two pieces fit in 250ms; the third outran the sum. What it yielded stays.
    expect(chunks).toEqual([1, 2, 4])
    expect(result).toBe('R')
    expect(failures.map(f => [f.outcome, f.failure.kind])).toEqual([['expired', 'timeout']])
  })

  it("'pull' (process.spawn) gives each piece its budget anew", async () => {
    const { dispatcher, failures } = setup({ budgetMs: 250 })
    dispatcher.register('slow', [
      streamLink('slow', 'user', 'process.spawn', async function* (call, next) {
        for await (const chunk of next(call.e)) {
          await sleep(100)
          yield chunk
        }
        return 'slow-result'
      }),
    ])
    const { fn } = core([1, 2, 3, 4], 'R')
    await expect(
      drain(dispatcher.dispatchStream('process.spawn', {}, fn, { budgetPer: 'pull' })),
    ).resolves.toEqual({ chunks: [1, 2, 3, 4], result: 'slow-result' })
    expect(failures).toEqual([])
  })

  it('never counts a yield, or the time beneath', async () => {
    const { dispatcher, failures } = setup({ budgetMs: 60 })
    dispatcher.register('a', [
      streamLink('a', 'user', 'turn.step', async function* (call, next) {
        return yield* next(call.e)
      }),
    ])
    const slowCore = async function* (): AsyncGenerator<unknown, unknown> {
      for (let i = 0; i < 3; i++) {
        await sleep(40)
        yield i
      }
      return 'R'
    }
    const stream = dispatcher.dispatchStream('turn.step', {}, slowCore)
    const chunks: unknown[] = []
    for (;;) {
      const step = await stream.next()
      if (step.done) break
      chunks.push(step.value)
      // The reader is slow too: the hook is suspended at its yield.
      await sleep(40)
    }
    expect(chunks).toEqual([0, 1, 2])
    expect(failures).toEqual([])
  })

  it('a $ call (whileWaiting) stops the clock, as on a plain event', async () => {
    const { dispatcher, failures } = setup({ budgetMs: 50 })
    dispatcher.register('a', [
      streamLink('a', 'user', 'turn.step', async function* (call, next) {
        await call.whileWaiting(() => sleep(80))
        return yield* next(call.e)
      }),
    ])
    const { fn } = core([1], 'R')
    await expect(drain(dispatcher.dispatchStream('turn.step', {}, fn))).resolves.toEqual({ chunks: [1], result: 'R' })
    expect(failures).toEqual([])
  })
})

describe('ModDispatcher.dispatchStream — .catch, a generator too', () => {
  it("continues the stream: its next is the stream the hook had open, from where it stood", async () => {
    const { dispatcher, failures } = setup()
    dispatcher.register('flaky', [
      streamLink(
        'flaky',
        'user',
        'turn.step',
        async function* (call, next) {
          const beneath = next(call.e)
          yield `hook:${String((await beneath.next()).value)}`
          throw new Error('boom')
        },
        {
          onCatch: async function* (call, next) {
            expect(call.called).toBe(true)
            expect(call.error.message).toBe('boom')
            const rest = next(call.e)
            for (;;) {
              const step = await rest.next()
              if (step.done) return `caught(${String(step.value)})`
              yield `catch:${String(step.value)}`
            }
          },
        },
      ),
    ])
    const { fn, seen } = core([1, 2, 3], 'R')
    await expect(drain(dispatcher.dispatchStream('turn.step', {}, fn))).resolves.toEqual({
      chunks: ['hook:1', 'catch:2', 'catch:3'],
      result: 'caught(R)',
    })
    // Replay-safe: nothing beneath ran again.
    expect(seen.started).toBe(1)
    expect(failures.map(f => f.outcome)).toEqual(['caught'])
  })

  it("the handler's signal is its own: live while it runs, though the hook's was aborted", async () => {
    const { dispatcher } = setup()
    let hookSignal: AbortSignal | undefined
    let handlerAborted: boolean | undefined
    dispatcher.register('flaky', [
      streamLink(
        'flaky',
        'user',
        'turn.step',
        async function* (call) {
          hookSignal = call.signal
          throw new Error('boom')
        },
        {
          onCatch: async function* (call) {
            handlerAborted = call.signal.aborted
            return 'caught'
          },
        },
      ),
    ])
    const { fn } = core([1], 'R')
    await expect(drain(dispatcher.dispatchStream('turn.step', {}, fn))).resolves.toEqual({ chunks: [], result: 'caught' })
    expect(hookSignal?.aborted).toBe(true)
    expect(handlerAborted).toBe(false)
  })

  it('a handler that stands aside (returns nothing, no stream open) leaves the hook absent', async () => {
    const { dispatcher, failures } = setup()
    dispatcher.register('flaky', [
      streamLink(
        'flaky',
        'user',
        'turn.step',
        async function* () {
          throw new Error('boom')
        },
        { onCatch: async function* () {} },
      ),
    ])
    const { fn } = core([1], 'R')
    await expect(drain(dispatcher.dispatchStream('turn.step', {}, fn))).resolves.toEqual({ chunks: [1], result: 'R' })
    expect(failures.map(f => f.outcome)).toEqual(['skipped'])
  })
})

describe('ModDispatcher — which form runs where', () => {
  it('a generator hook runs on streaming events only; a plain hook on plain events only', async () => {
    const { dispatcher } = setup()
    const plain: ChainLink = {
      id: 'plain/1',
      plugin: 'plain',
      tier: 'user',
      pattern: '*',
      run: async call => call.next(call.e),
    }
    dispatcher.register('plain', [plain])
    expect(dispatcher.hasHooksFor('tool.call')).toBe(true)
    expect(dispatcher.hasHooksFor('turn.step')).toBe(false)
    dispatcher.unregister('plain')
    dispatcher.register('gen', [
      streamLink('gen', 'user', '*', async function* (call, next) {
        return yield* next(call.e)
      }),
    ])
    expect(dispatcher.hasHooksFor('turn.step')).toBe(true)
    expect(dispatcher.hasHooksFor('process.spawn')).toBe(true)
    expect(dispatcher.hasHooksFor('tool.call')).toBe(false)
    // The plain dispatch passes it over: core answers.
    await expect(dispatcher.dispatch('tool.call', {}, () => 'core')).resolves.toBe('core')
  })

  it('abandoning the dispatch rejects the pending read with AbortError and aborts the hook', async () => {
    const { dispatcher } = setup()
    let hookSignal: AbortSignal | undefined
    dispatcher.register('a', [
      streamLink('a', 'user', 'turn.step', async function* (call, next) {
        hookSignal = call.signal
        return yield* next(call.e)
      }),
    ])
    const controller = new AbortController()
    const stream = dispatcher.dispatchStream(
      'turn.step',
      {},
      async function* () {
        yield 1
        await new Promise(() => undefined)
      },
      { signal: controller.signal },
    )
    expect(await stream.next()).toEqual({ done: false, value: 1 })
    const pending = stream.next()
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(hookSignal?.aborted).toBe(true)
  })
})
