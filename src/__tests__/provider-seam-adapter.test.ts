/**
 * Provider mods PM-6 — the adapter from the driver request seam to the
 * provider mod runtime, against a fake runtime: which hooks are defined, the
 * cold start outside the budget, and failing closed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DriverHttpRequest } from '../models/drivers/driverTypes'
import { ProviderHookError, ProviderRequestFlow } from '../models/drivers/providerRequestSeam'
import {
  ProviderHookUnansweredError,
  ProviderModUnavailableError,
  type ProviderCallOptions,
} from '../mods/provider/ProviderModRuntime'
import type { ProviderEventName } from '../mods/provider/providerEvents'
import { createProviderSeam, type ProviderSeamRuntime } from '../mods/provider/providerSeamAdapter'

type Call = { providerId: string; event: ProviderEventName; e: Record<string, unknown>; options: ProviderCallOptions<unknown> }

/** A runtime that answers each event from a script and remembers the calls. */
function fakeRuntime(script: {
  hooks?: Partial<Record<ProviderEventName, boolean | undefined>>
  answer?: (event: ProviderEventName, e: Record<string, unknown>) => unknown
  whenLoaded?: (signal?: AbortSignal) => Promise<void>
}) {
  const calls: Call[] = []
  const loads: Array<AbortSignal | undefined> = []
  const runtime: ProviderSeamRuntime = {
    hasHook: (_id, event) => script.hooks?.[event],
    whenLoaded: async (_id, signal) => {
      loads.push(signal)
      await script.whenLoaded?.(signal)
    },
    call: (async (providerId: string, event: ProviderEventName, e: Record<string, unknown> = {}, options = {}) => {
      calls.push({ providerId, event, e, options })
      if (script.hooks?.[event] === false) return { raised: false }
      const value = script.answer?.(event, e)
      if (value === NOT_RAISED) return { raised: false }
      return { raised: true, value }
    }) as ProviderSeamRuntime['call'],
  }
  return { runtime, calls, loads }
}
const NOT_RAISED = Symbol('not raised')

const built: DriverHttpRequest = {
  url: 'https://api.vendor.example/v1/chat',
  method: 'POST',
  headers: { authorization: 'Bearer {{secret:k}}' },
  body: new TextEncoder().encode('{"n":1}'),
}
const facts = { provider: 'mod.acme.zen', model: 'm-1', format: 'openai-chat', baseUrl: 'https://api.vendor.example' }
const flowOf = (seam: ReturnType<typeof createProviderSeam>, signal = new AbortController().signal) =>
  new ProviderRequestFlow(seam, facts, signal)

afterEach(() => {
  vi.useRealTimers()
})

describe('createProviderSeam — which hooks exist', () => {
  it('a hook the module is known not to have is not defined: nothing is raised, no digest is taken', async () => {
    const digest = vi.spyOn(crypto.subtle, 'digest')
    const { runtime, calls } = fakeRuntime({
      hooks: { 'provider.request': true, 'provider.sign': false, 'provider.retry': false },
      answer: () => ({ headers: { 'x-a': '1' } }),
    })
    const seam = createProviderSeam(runtime, 'mod.acme.zen')
    expect(seam.request).toBeTypeOf('function')
    expect(seam.sign).toBeUndefined()
    expect(seam.retry).toBeUndefined()
    const prepared = await flowOf(seam).prepare(built)
    expect(prepared.request.headers['x-a']).toBe('1')
    expect(calls.map(c => c.event)).toEqual(['provider.request'])
    expect(digest).not.toHaveBeenCalled()
    expect(await flowOf(seam).retryAfter({ status: 400, headers: {}, bodyText: '' }, prepared)).toBeUndefined()
    digest.mockRestore()
  })

  it('unknown yet (the module never loaded): the hooks are defined and the call finds out', async () => {
    const { runtime, calls } = fakeRuntime({ hooks: {}, answer: () => NOT_RAISED })
    const seam = createProviderSeam(runtime, 'mod.acme.zen')
    expect(seam.request).toBeTypeOf('function')
    expect(seam.sign).toBeTypeOf('function')
    expect(seam.retry).toBeTypeOf('function')
    const prepared = await flowOf(seam).prepare(built)
    // Not raised = no answer = the request as built (and as signed: not at all).
    expect(prepared.request).toEqual(built)
    expect(calls.map(c => c.event)).toEqual(['provider.request', 'provider.sign'])
  })

  it('what the load found out is used for the rest of the stream: sign, learnt absent, is skipped', async () => {
    const hooks: Partial<Record<ProviderEventName, boolean | undefined>> = {}
    const { runtime, calls } = fakeRuntime({
      hooks,
      answer: event => {
        // The first call loads the module; afterwards its hooks are known.
        hooks['provider.request'] = true
        hooks['provider.sign'] = false
        hooks['provider.retry'] = true
        return event === 'provider.request' ? { headers: { 'x-a': '1' } } : undefined
      },
    })
    const seam = createProviderSeam(runtime, 'mod.acme.zen')
    const prepared = await flowOf(seam).prepare(built)
    expect(calls.map(c => c.event)).toEqual(['provider.request'])
    expect(prepared.request.headers['x-a']).toBe('1')
    expect(seam.sign).toBeUndefined()
    expect(seam.retry).toBeTypeOf('function')
  })

  it('carries the declared needs, validated: a bad declaration throws', () => {
    const { runtime } = fakeRuntime({})
    expect(createProviderSeam(runtime, 'p')).toMatchObject({ requestNeeds: [] })
    expect(createProviderSeam(runtime, 'p', { requestNeeds: ['system', 'body'], signNeeds: 'body' })).toMatchObject({
      requestNeeds: ['system', 'body'],
      signNeeds: 'body',
    })
    expect(() => createProviderSeam(runtime, 'p', { requestNeeds: ['messages'] })).toThrow(TypeError)
    expect(() => createProviderSeam(runtime, 'p', { signNeeds: 'digest' })).toThrow(/signNeeds/)
  })
})

describe('createProviderSeam — the events', () => {
  it('request / sign / retry become provider.request / provider.sign / provider.retry with the stream signal', async () => {
    const { runtime, calls } = fakeRuntime({
      hooks: { 'provider.request': true, 'provider.sign': true, 'provider.retry': true },
      answer: (event, e) => {
        if (event === 'provider.request') return { headers: { 'x-req': String(e.model) } }
        if (event === 'provider.sign') return { headers: { 'x-sig': String(e.bodySha256).slice(0, 8) } }
        return { retry: { headers: { 'x-retry': '1' } } }
      },
    })
    const controller = new AbortController()
    const flow = flowOf(createProviderSeam(runtime, 'mod.acme.zen'), controller.signal)
    const prepared = await flow.prepare(built)
    expect(prepared.request.headers['x-req']).toBe('m-1')
    expect(prepared.request.headers['x-sig']).toMatch(/^[0-9a-f]{8}$/)
    const again = await flow.retryAfter({ status: 400, headers: {}, bodyText: 'bad' }, prepared)
    expect(again!.request.headers['x-retry']).toBe('1')
    expect(calls.map(c => [c.providerId, c.event])).toEqual([
      ['mod.acme.zen', 'provider.request'],
      ['mod.acme.zen', 'provider.sign'],
      ['mod.acme.zen', 'provider.retry'],
      ['mod.acme.zen', 'provider.sign'],
    ])
    for (const call of calls) expect(call.options.signal).toBe(controller.signal)
    // A retry that nobody answers has a core: nothing.
    expect((calls[2]!.options.core as () => unknown)()).toBeUndefined()
    expect(calls[0]!.options.core).toBeUndefined()
  })
})

describe('createProviderSeam — the cold start is not the hook budget', () => {
  it('whenReady loads the module; the 2 s start when it is loaded, however long the load took', async () => {
    vi.useFakeTimers()
    let finishLoad!: () => void
    const { runtime, loads } = fakeRuntime({
      hooks: { 'provider.request': true, 'provider.sign': false },
      whenLoaded: () => new Promise<void>(resolve => {
        finishLoad = resolve
      }),
      answer: () => ({ headers: { 'x-warm': '1' } }),
    })
    const seam = createProviderSeam(runtime, 'mod.acme.zen')
    let settled: 'pending' | 'ok' | Error = 'pending'
    flowOf(seam).prepare(built).then(
      () => (settled = 'ok'),
      error => (settled = error),
    )
    await vi.advanceTimersByTimeAsync(10_000)
    expect(loads).toHaveLength(1)
    expect(settled).toBe('pending')
    finishLoad()
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe('ok')
  })

  it('a module that cannot load fails the request closed, naming the hook', async () => {
    const { runtime } = fakeRuntime({
      hooks: {},
      whenLoaded: async () => {
        throw new ProviderModUnavailableError('acme: the provider module cannot load')
      },
    })
    const error = await flowOf(createProviderSeam(runtime, 'mod.acme.zen')).prepare(built).catch(e => e)
    expect(error).toBeInstanceOf(ProviderHookError)
    expect(error.message).toContain('The request hook of the provider mod.acme.zen failed')
    expect(error.message).toContain('cannot load')
  })
})

describe('createProviderSeam — failing closed', () => {
  const failures: Array<[string, () => Error]> = [
    ['unavailable', () => new ProviderModUnavailableError('acme: the provider module is off — dead')],
    ['unanswered', () => new ProviderHookUnansweredError('provider.request', 'mod.acme.zen')],
  ]

  it('request and sign that cannot be served or were not answered end in a hook error: nothing is sent', async () => {
    for (const [name, failure] of failures) {
      for (const hook of ['provider.request', 'provider.sign'] as const) {
        const { runtime } = fakeRuntime({
          hooks: { [hook]: true },
          answer: event => {
            if (event === hook) throw failure()
            return undefined
          },
        })
        const error = await flowOf(createProviderSeam(runtime, 'mod.acme.zen')).prepare(built).catch(e => e)
        expect(error, `${name} ${hook}`).toBeInstanceOf(ProviderHookError)
        expect(error.message, `${name} ${hook}`).toContain(`The ${hook.slice(9)} hook of the provider mod.acme.zen failed`)
      }
    }
  })

  it('a retry that cannot be served or was not answered leaves the engine to its own ladder', async () => {
    for (const [name, failure] of failures) {
      const { runtime } = fakeRuntime({
        hooks: { 'provider.retry': true },
        answer: event => {
          if (event === 'provider.retry') throw failure()
          return undefined
        },
      })
      const flow = flowOf(createProviderSeam(runtime, 'mod.acme.zen'))
      const prepared = await flow.prepare(built)
      expect(await flow.retryAfter({ status: 400, headers: {}, bodyText: '' }, prepared), name).toBeUndefined()
    }
  })

  it('a stream cancelled while the module loads is an abort, not a hook failure', async () => {
    const controller = new AbortController()
    const { runtime } = fakeRuntime({
      hooks: {},
      whenLoaded: () => new Promise<void>(() => {}),
    })
    const pending = flowOf(createProviderSeam(runtime, 'mod.acme.zen'), controller.signal).prepare(built)
    controller.abort()
    const error = await pending.catch(e => e)
    expect(error).not.toBeInstanceOf(ProviderHookError)
    expect(controller.signal.aborted).toBe(true)
  })
})
