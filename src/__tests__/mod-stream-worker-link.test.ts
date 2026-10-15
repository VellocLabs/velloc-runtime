/**
 * A streaming hook end to end, minus the Worker: an `async function*` hook
 * registered in `ModWorkerHost` on one end of a real MessageChannel, seated
 * by `ModInstance` in a real `ModDispatcher` on the other, and the engine
 * reading `dispatchStream`. Every pull, chunk and read of beneath crosses the
 * port exactly as it will in a worker. The chain's rules themselves, with
 * hooks beside it, are `mod-stream-dispatch.test.ts`.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { ModDispatcher, type HookFailureReport } from '../mods/ModDispatcher'
import { ModInstance } from '../mods/ModInstance'
import { installModWorkerHost, isAsyncGeneratorFunction, type HooksModule } from '../mods/ModWorkerHost'
import type { PluginTier, TraceEntry } from '../mods/modTypes'

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/* eslint-disable @typescript-eslint/no-explicit-any -- a hooks module is untyped JS here */
type On = (pattern: any, a?: any, b?: any) => { catch(handler: any): void }
type Register = (on: On, options: any) => unknown

const open: MessagePort[] = []
afterEach(() => {
  for (const port of open.splice(0)) port.close()
})

function world(options: { budgetMs?: number; catchMs?: number } = {}) {
  const failures: HookFailureReport[] = []
  const dispatcher = new ModDispatcher({
    budgetMs: options.budgetMs ?? 5_000,
    catchMs: options.catchMs ?? 5_000,
    onHookFailure: report => failures.push(report),
  })
  const mod = async (plugin: string, register: Register, tier: PluginTier = 'user') => {
    const channel = new MessageChannel()
    open.push(channel.port1, channel.port2)
    installModWorkerHost(channel.port2, {
      loadModule: async () => ({ register }) as unknown as HooksModule,
    })
    const instance = new ModInstance({
      key: plugin,
      plugin,
      tier,
      generation: 1,
      peer: channel.port1,
      dispatcher,
      serveCall: async call => {
        if (call.noun === 'clock' && call.method === 'sleep') {
          await sleep((call.args[0] as { ms: number }).ms)
          return undefined
        }
        if (call.noun === 'slow') {
          await sleep(call.args[0] as number)
          return 'served'
        }
        throw new Error(`$.${call.noun}.${call.method} is not served in this test`)
      },
    })
    const hooks = await instance.load('unused', {})
    return { instance, hooks }
  }
  return { dispatcher, failures, mod }
}

function core(chunks: readonly unknown[], result: unknown = 'core-result') {
  const seen = { started: 0, closed: 0, e: [] as unknown[] }
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

async function drain(stream: AsyncGenerator<unknown, unknown, undefined>) {
  const chunks: unknown[] = []
  for (;;) {
    const step = await stream.next()
    if (step.done) return { chunks, result: step.value }
    chunks.push(step.value)
  }
}

describe('a streaming hook — registering', () => {
  it('reads the form off the function: an async function* streams, anything else does not', () => {
    expect(isAsyncGeneratorFunction(async function* () {})).toBe(true)
    expect(isAsyncGeneratorFunction(function* () {})).toBe(false)
    expect(isAsyncGeneratorFunction(async () => undefined)).toBe(false)
    expect(isAsyncGeneratorFunction({})).toBe(false)
  })

  it('reports `streams` on the registration, and seats it for streaming events only', async () => {
    const { dispatcher, mod } = world()
    const { hooks } = await mod('acme', on => {
      on('turn.step', async function* (_$: any, e: any, next: any) {
        return yield* next(e)
      })
      on('tool.call', (_$: any, e: any, next: any) => next(e))
    })
    expect(hooks.map(h => [h.pattern, h.streams === true])).toEqual([
      ['turn.step', true],
      ['tool.call', false],
    ])
    expect(dispatcher.hasHooksFor('turn.step')).toBe(true)
    expect(dispatcher.hasHooksFor('tool.call')).toBe(true)
  })

  it.each([
    ['a plain .catch on a generator hook', (on: On) =>
      on('turn.step', async function* () {}).catch(() => undefined), /its handler must be one too/],
    ['a generator .catch on a plain hook', (on: On) =>
      on('tool.call', () => 1).catch(async function* () {}), /the hook is not/],
  ])('does not load %s', async (_name, register, message) => {
    const { mod } = world()
    await expect(mod('acme', register as Register)).rejects.toThrow(message)
  })
})

describe('a streaming hook — across the port', () => {
  it('`return yield* next(e)` passes every chunk and the result; e is its own frozen copy', async () => {
    const { dispatcher, mod } = world()
    let frozen = false
    await mod('acme', on => {
      on('turn.step', async function* (_$: any, e: any, next: any) {
        frozen = Object.isFrozen(e) && Object.isFrozen(e.nested)
        return yield* next(e)
      })
    })
    const traces: (readonly TraceEntry[])[] = []
    const { fn, seen } = core([{ kind: 'text', text: 'a' }, { kind: 'text', text: 'b' }], { answer: 'ab' })
    await expect(
      drain(dispatcher.dispatchStream('turn.step', { nested: { x: 1 } }, fn, { trace: t => traces.push(t) })),
    ).resolves.toEqual({ chunks: [{ kind: 'text', text: 'a' }, { kind: 'text', text: 'b' }], result: { answer: 'ab' } })
    expect(frozen).toBe(true)
    expect(seen.e).toEqual([{ nested: { x: 1 } }])
    // A hook in a worker answers with a copy of its own: `returned`.
    expect(traces[0]!.map(t => [t.plugin, t.outcome, t.chunks])).toEqual([
      ['acme', 'returned', 2],
      ['engine', 'returned', 2],
    ])
  })

  it('transforms with for await, rewrites e, and reads next(e).result after the end', async () => {
    const { dispatcher, mod } = world()
    await mod('acme', on => {
      on('turn.step', async function* (_$: any, e: any, next: any) {
        const beneath = next({ ...e, model: 'small' })
        for await (const chunk of beneath) yield String(chunk).toUpperCase()
        return `${String(await beneath.result)}!`
      })
    })
    const { fn, seen } = core(['a', 'b'], 'r')
    await expect(drain(dispatcher.dispatchStream('turn.step', { model: 'big' }, fn))).resolves.toEqual({
      chunks: ['A', 'B'],
      result: 'r!',
    })
    expect(seen.e).toEqual([{ model: 'small' }])
  })

  it('answers alone without next: core never runs', async () => {
    const { dispatcher, mod } = world()
    await mod('cache', on => {
      on('turn.step', async function* () {
        yield 'cached'
        return 'cached-result'
      })
    })
    const { fn, seen } = core(['live'])
    await expect(drain(dispatcher.dispatchStream('turn.step', {}, fn))).resolves.toEqual({
      chunks: ['cached'],
      result: 'cached-result',
    })
    expect(seen.started).toBe(0)
  })

  it('a `break` out of its loop closes what is beneath; its own result stands', async () => {
    const { dispatcher, mod } = world()
    await mod('acme', on => {
      on('turn.step', async function* (_$: any, e: any, next: any) {
        const beneath = next(e)
        for await (const chunk of beneath) {
          yield chunk
          break
        }
        await expect(beneath.result).rejects.toThrow(/closed before its end/)
        return 'mine'
      })
    })
    const { fn, seen } = core([1, 2, 3])
    await expect(drain(dispatcher.dispatchStream('turn.step', {}, fn))).resolves.toEqual({
      chunks: [1],
      result: 'mine',
    })
    await sleep(10)
    expect(seen.closed).toBe(1)
  })

  it('a hook that throws mid-stream after next is left: the rest from beneath (kept)', async () => {
    const { dispatcher, failures, mod } = world()
    await mod('flaky', on => {
      on('turn.step', async function* (_$: any, e: any, next: any) {
        const beneath = next(e)
        const first = await beneath.next()
        yield `flaky:${String(first.value)}`
        throw new Error('boom')
      })
    })
    const { fn } = core([1, 2, 3], 'R')
    await expect(drain(dispatcher.dispatchStream('turn.step', {}, fn))).resolves.toEqual({
      chunks: ['flaky:1', 2, 3],
      result: 'R',
    })
    expect(failures.map(f => [f.plugin, f.outcome, f.failure.message])).toEqual([['flaky', 'kept', 'boom']])
  })

  it("letting a rejection from beneath pass is not a failure: the engine gets its own error back", async () => {
    const { dispatcher, failures, mod } = world()
    await mod('acme', on => {
      on('turn.step', async function* (_$: any, e: any, next: any) {
        return yield* next(e)
      })
    })
    const failure = new Error('provider down')
    const stream = dispatcher.dispatchStream('turn.step', {}, async function* () {
      yield 'partial'
      throw failure
    })
    expect(await stream.next()).toEqual({ done: false, value: 'partial' })
    await expect(stream.next()).rejects.toBe(failure)
    expect(failures).toEqual([])
  })

  it('.catch is a generator too, continuing the stream from where the hook stood', async () => {
    const { dispatcher, failures, mod } = world()
    await mod('flaky', on => {
      on('turn.step', async function* (_$: any, e: any, next: any) {
        const beneath = next(e)
        yield `hook:${String((await beneath.next()).value)}`
        throw new Error('boom')
      }).catch(async function* (_$: any, e: any, next: any) {
        if (!next.called || next.error.message !== 'boom') throw new Error('wrong failure')
        for await (const chunk of next(e)) yield `catch:${String(chunk)}`
        return 'caught'
      })
    })
    const { fn, seen } = core([1, 2, 3], 'R')
    await expect(drain(dispatcher.dispatchStream('turn.step', {}, fn))).resolves.toEqual({
      chunks: ['hook:1', 'catch:2', 'catch:3'],
      result: 'caught',
    })
    expect(seen.started).toBe(1)
    expect(failures.map(f => f.outcome)).toEqual(['caught'])
  })
})

describe('a streaming hook — its own time, and being stopped', () => {
  it("never counts a yield, reading beneath, or a $ call; next.budget reads it", async () => {
    const { dispatcher, failures, mod } = world({ budgetMs: 150 })
    const remaining: number[] = []
    await mod('acme', on => {
      on('turn.step', async function* ($: any, e: any, next: any) {
        await $.slow.call(200)
        for await (const chunk of next(e)) {
          remaining.push(next.budget.remainingMs)
          yield chunk
        }
        return 'done'
      })
    })
    const slowCore = async function* (): AsyncGenerator<unknown, unknown> {
      for (let i = 0; i < 3; i++) {
        await sleep(80)
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
      await sleep(80)
    }
    expect(chunks).toEqual([0, 1, 2])
    expect(failures).toEqual([])
    expect(remaining).toHaveLength(3)
    for (const ms of remaining) expect(ms).toBeGreaterThan(50)
  })

  it("'pull' restarts next.budget at each piece", async () => {
    const { dispatcher, mod } = world({ budgetMs: 1_000 })
    const remaining: number[] = []
    await mod('acme', on => {
      on('process.spawn', async function* ($: any, e: any, next: any) {
        for await (const chunk of next(e)) {
          await $.clock.sleep(60)
          remaining.push(next.budget.remainingMs)
          yield chunk
        }
        return 'done'
      })
    })
    const { fn } = core([1, 2, 3], 'R')
    await drain(dispatcher.dispatchStream('process.spawn', {}, fn, { budgetPer: 'pull' }))
    // Each piece spends ~60ms of a fresh 1000: none goes below ~900.
    for (const ms of remaining) expect(ms).toBeGreaterThan(850)
  })

  it('closing the stream the engine reads stops the hook: its finally runs in the worker', async () => {
    const { dispatcher, mod } = world()
    let stopped = false
    let signalAborted = false
    await mod('acme', on => {
      on('turn.step', async function* (_$: any, e: any, next: any) {
        try {
          return yield* next(e)
        } finally {
          stopped = true
          signalAborted = next.signal.aborted
        }
      })
    })
    const { fn, seen } = core([1, 2, 3])
    const stream = dispatcher.dispatchStream('turn.step', {}, fn)
    expect(await stream.next()).toEqual({ done: false, value: 1 })
    await stream.return(undefined)
    await sleep(20)
    expect(stopped).toBe(true)
    expect(signalAborted).toBe(true)
    expect(seen.closed).toBe(1)
  })

  it('a hook over budget is left, its generator returned; the rest comes from beneath', async () => {
    const { dispatcher, failures, mod } = world({ budgetMs: 80 })
    let stopped = false
    await mod('slow', on => {
      on('turn.step', async function* ($: any, e: any, next: any) {
        try {
          for await (const chunk of next(e)) {
            await $.clock.sleep(50)
            yield chunk
          }
          return 'never'
        } finally {
          stopped = true
        }
      })
    })
    const { fn } = core([1, 2, 3, 4], 'R')
    const { chunks, result } = await drain(dispatcher.dispatchStream('turn.step', {}, fn))
    expect(result).toBe('R')
    expect(chunks[0]).toBe(1)
    expect(chunks.at(-1)).toBe(4)
    expect(failures.map(f => f.outcome)).toEqual(['expired'])
    await sleep(80)
    expect(stopped).toBe(true)
  })
})
