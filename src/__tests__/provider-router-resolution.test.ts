/**
 * The resolution step for a router provider (F-27), driven by a router
 * written in the test and registered directly: the stream host under a
 * scripted raw endpoint, then the whole call with its retries.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserBridgeTransport } from '../browser/bridge/browserBridgeProtocol'
import { DriverStreamHost } from '../models/drivers/driverStreamHost'
import { registerProviderDriver } from '../models/drivers/driverRegistry'
import { withModelProviders } from '../models/drivers/driverTransport'
import { createModelProvider } from '../models/drivers/modelProvider'
import type { DriverStreamEvent, ProviderDriver } from '../models/drivers/driverTypes'
import { registerProviderRequestSeam, resetProviderRequestSeams } from '../models/drivers/providerRequestSeam'
import { checkRouteAnswer, type RouteAnswerFacts } from '../models/drivers/providerRouteAnswer'
import { routeCallOf, routedViaOf } from '../models/drivers/providerRouteCall'
import {
  registerProviderRouter,
  resetProviderRouters,
  ROUTE_HOPS_MAX,
  type ProviderRouter,
  type RouteAnswer,
  type RouteEvent,
  type RouteOutcomeEvent,
} from '../models/drivers/providerRouter'
import { resetRuntimeProviders, setRuntimeProviderConfigs } from '../models/drivers/runtimeProviders'
import { assembleTurnDependencies } from '../engine/turn/turnDependencies'
import { recoverThroughMods } from '../engine/turn/recoverThroughMods'
import { RouteSwitchError } from '../models/drivers/providerRouter'
import { getProviderErrorFields, ProviderApiError } from '../utils/providerConnectivity'
import {
  DefaultRuntimeConfig,
  NoopPlatformCapabilities,
  createEmptyAppState,
  createNoopToolUseContext,
} from '../runtime/testing/noopAdapters'
import type { RuntimeConfig } from '../runtime/interfaces/RuntimeConfig'
import { fakeProviderRequestSeam } from './_helpers/fakeProviderRequestSeam'
import { logRowOf, routeMemberFacts, tierForTarget } from '../models/drivers/providerRouteResolution'
import { findConfiguredModel } from '../config/nexusModelConfig/findConfiguredModel'
import { recordRequest } from '../models/usage/requestLogWriter'
import type { RequestLogRow } from '../models/usage/requestLogStore'

vi.mock('../models/usage/requestLogWriter', async original => ({
  ...(await original<typeof import('../models/usage/requestLogWriter')>()),
  recordRequest: vi.fn(),
}))
vi.mock('../config/nexusModelConfig/findConfiguredModel', async original => {
  const real = await original<typeof import('../config/nexusModelConfig/findConfiguredModel')>()
  return { ...real, findConfiguredModel: vi.fn(real.findConfiguredModel) }
})
const loggedRows = (): RequestLogRow[] => vi.mocked(recordRequest).mock.calls.map(call => call[0])

// ── a JSON codec: the request body names the model; the reply is JSON lines ──
const codec: ProviderDriver = {
  id: 'route-json',
  auth: { headers: { authorization: 'Bearer {{secret:api_key}}' } },
  buildRequest: (payload, context) => ({
    url: `${context.baseUrl}/v1/chat`,
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer {{secret:api_key}}' },
    body: new TextEncoder().encode(JSON.stringify({
      model: context.model,
      n: payload.messages.length,
      tier: (payload as { thinkingTier?: string }).thinkingTier ?? null,
    })),
  }),
  createDecoder: () => {
    const decoder = new TextDecoder()
    let buffered = ''
    const drain = (): DriverStreamEvent[] => {
      const lines = buffered.split('\n')
      buffered = lines.pop() ?? ''
      return lines.filter(Boolean).map(line => JSON.parse(line) as DriverStreamEvent)
    }
    return {
      push: bytes => {
        buffered += decoder.decode(bytes, { stream: true })
        return drain()
      },
      end: () => {
        buffered += '\n'
        return drain()
      },
    }
  },
  errorFromResponse: ({ status, bodyText }) => ({
    type: 'error',
    message: `API Error: ${status} ${bodyText}`,
    httpStatus: status,
  }),
}
registerProviderDriver(codec)

const enc = (events: DriverStreamEvent[]) =>
  new TextEncoder().encode(events.map(e => JSON.stringify(e)).join('\n') + '\n')
const reply = (text: string) => enc([
  { type: 'text_delta', text },
  { type: 'finish', finishReason: 'stop', usage: { promptTokens: 11, completionTokens: 3 } },
])
const refusedWith = (status: number, text = 'no'): Reply => ({ status, body: new TextEncoder().encode(text) })
/** A reply that starts and then loses its connection. */
const cutAfter = (text: string): Reply => ({ status: 200, body: enc([{ type: 'text_delta', text }]), cut: true })

type Reply = { status: number; body: Uint8Array; cut?: boolean; hang?: boolean }

/** A host that answers each provider's `rawStreamOpen` from that provider's
 *  script and records every open. */
function rawHost(script: Record<string, Reply[]>) {
  const opens: Array<Record<string, any>> = []
  const live = new Map<string, { reply: Reply; reads: number; release?: () => void }>()
  let next = 0
  const transport: BrowserBridgeTransport = {
    async request(req: any) {
      const action = req.route.action
      if (action === 'rawStreamOpen') {
        opens.push(req.payload)
        const found = script[req.payload.providerId]?.shift() ?? { status: 200, body: reply(`from ${req.payload.providerId}`) }
        next += 1
        const streamId = `raw-${next}`
        live.set(streamId, { reply: found, reads: 0 })
        return {
          ok: true,
          result: { streamId, status: found.status, statusText: 'S', finalUrl: req.payload.url, headers: {} },
        } as any
      }
      const entry = live.get(req.payload.streamId)
      if (action === 'rawStreamCancel') {
        entry?.release?.()
        return { ok: true, result: { ok: true } } as any
      }
      if (!entry) return { ok: true, result: { done: true, chunk: new Uint8Array() } } as any
      entry.reads += 1
      if (entry.reply.hang) {
        await new Promise<void>(resolve => { entry.release = resolve })
        return { ok: true, result: { done: true, chunk: new Uint8Array() } } as any
      }
      if (entry.reply.cut) {
        return entry.reads === 1
          ? ({ ok: true, result: { done: false, chunk: entry.reply.body } } as any)
          : ({ ok: true, result: { done: true, errorCode: 'NETWORK_ERROR', errorMessage: 'NETWORK_ERROR: Request failed: net::ERR_CONNECTION_RESET' } } as any)
      }
      return { ok: true, result: { done: true, chunk: entry.reads === 1 ? entry.reply.body : new Uint8Array() } } as any
    },
  }
  return { transport, opens }
}

const ROUTER = 'mod.pick.any'
const A = 'target-a'
const B = 'target-b'
const SPECS = {
  [A]: { format: 'route-json', baseUrl: 'https://a.vendor.example' },
  [B]: { format: 'route-json', baseUrl: 'https://b.vendor.example' },
  'target-unset': { format: 'route-json', baseUrl: 'https://c.vendor.example' },
}

const config = (env: Record<string, string> = {}): RuntimeConfig =>
  new DefaultRuntimeConfig({ providerDrivers: JSON.stringify(SPECS), ...env })

const entry = (id: string) => ({ family: id, version: '1', id })

/** A router that answers from a script and records what it was asked. */
function testRouter(answers: Array<RouteAnswer | ((e: RouteEvent) => RouteAnswer)>) {
  const events: RouteEvent[] = []
  const outcomes: RouteOutcomeEvent[] = []
  const router: ProviderRouter = {
    async route(e) {
      events.push(structuredClone(e))
      const next = answers.length > 1 ? answers.shift() : answers[0]
      return typeof next === 'function' ? next(e) : next
    },
    outcome: e => { outcomes.push(e) },
  }
  return { router, events, outcomes }
}

const toA: RouteAnswer = { provider: A, model: 'm-a' }
const toB: RouteAnswer = { provider: B, model: 'm-b' }

const CONTEXT = { sessionId: 'session-1', agentId: 'agent-1', purpose: 'main' as const, querySource: 'test' }
const payload = (extra: Record<string, unknown> = {}) => ({
  providerId: ROUTER,
  model: 'route-row',
  messages: [{ role: 'user', content: 'x' }],
  maxOutputTokens: 1000,
  requestContext: CONTEXT,
  ...extra,
})

let nextId = 0
async function model(transport: BrowserBridgeTransport, action: string, body: unknown): Promise<any> {
  nextId += 1
  return transport.request({ id: `r-${nextId}`, route: { capability: 'model', action }, payload: body } as never)
}

/** Opens a stream on the wrapped transport and reads it to its end. */
async function stream(wrapped: BrowserBridgeTransport, body: unknown = payload()) {
  const started = await model(wrapped, 'streamStart', body)
  if (!started.ok) return { started, chunks: [] as any[] }
  const chunks: any[] = []
  for (let i = 0; i < 50; i += 1) {
    const read = await model(wrapped, 'streamRead', { streamId: started.result.streamId, waitMs: 5000 })
    if (!read.ok) throw new Error(read.error.message)
    chunks.push(...read.result.chunks)
    if (read.result.done) return { started, chunks }
  }
  throw new Error('stream never finished')
}

const textOf = (chunks: any[]) => chunks
  .filter(c => c.type === 'content_block_delta')
  .map(c => c.delta?.text ?? '')
  .join('')
const errorOf = (chunks: any[]) => chunks.find(c => c.type === 'error')?.error
const bodyOf = (open: Record<string, any>) => JSON.parse(new TextDecoder().decode(open.body))

beforeEach(() => {
  setRuntimeProviderConfigs({
    [A]: { apiKey: 'k', modelEntries: [entry('m-a')] },
    [B]: { apiKey: 'k', modelEntries: [entry('m-b')] },
    'target-unset': { modelEntries: [entry('m-c')] },
    'target-unserved': { apiKey: 'k', modelEntries: [entry('m-d')] },
  } as never)
})

afterEach(() => {
  resetProviderRouters()
  resetProviderRequestSeams()
  resetRuntimeProviders()
})

// ── the answer check ────────────────────────────────────────────────────────

describe('checkRouteAnswer', () => {
  const facts: RouteAnswerFacts = {
    routesTo: ['def-1', 'def-2'],
    isSetUp: p => p !== 'unset',
    isRouter: p => p === 'a-router',
    definitionOf: p => (p === 'inst-1b' ? 'def-1' : p),
    serves: p => p !== 'unserved',
    knownModel: (_p, m) => m !== 'ghost',
  }

  it('accepts a target inside the boundary, by the definition of its instance', () => {
    expect(checkRouteAnswer({ provider: 'def-1', model: 'm' }, facts)).toEqual({ kind: 'target', target: { provider: 'def-1', model: 'm' } })
    // A second instance of a listed definition is inside, and stays its own id.
    expect(checkRouteAnswer({ provider: 'inst-1b', model: 'm' }, facts)).toEqual({ kind: 'target', target: { provider: 'inst-1b', model: 'm' } })
    expect(checkRouteAnswer({ provider: 'anything', model: 'm' }, { ...facts, routesTo: '*' }).kind).toBe('target')
  })

  it('keeps an effort of the tier vocabulary and drops any other', () => {
    expect(checkRouteAnswer({ provider: 'def-1', model: 'm', effort: 'high' }, facts)).toMatchObject({ target: { effort: 'high' } })
    const dropped = checkRouteAnswer({ provider: 'def-1', model: 'm', effort: 'ludicrous' }, facts)
    expect(dropped).toEqual({ kind: 'target', target: { provider: 'def-1', model: 'm' } })
  })

  it('reads nothing as no answer, and a stop with its message', () => {
    expect(checkRouteAnswer(undefined, facts)).toEqual({ kind: 'none' })
    expect(checkRouteAnswer(null, facts)).toEqual({ kind: 'none' })
    expect(checkRouteAnswer({ stop: true }, facts)).toEqual({ kind: 'stop' })
    expect(checkRouteAnswer({ stop: true, message: '  all members are cooling  ' }, facts)).toEqual({ kind: 'stop', message: 'all members are cooling' })
  })

  it.each([
    ['a router', { provider: 'a-router', model: 'm' }, 'is a router'],
    ['outside the boundary', { provider: 'def-3', model: 'm' }, 'outside what this router may send through'],
    ['not set up', { provider: 'unset', model: 'm' }, 'is not set up'],
    ['an unknown model', { provider: 'def-1', model: 'ghost' }, 'does not list the model ghost'],
    ['not served', { provider: 'unserved', model: 'm' }, 'cannot be sent from here'],
    ['no provider', { model: 'm' }, '`provider` must be a non-empty string'],
    ['an empty model', { provider: 'def-1', model: '' }, '`model` must be a non-empty string'],
    ['a model too long', { provider: 'def-1', model: 'x'.repeat(257) }, 'longer than 256'],
    ['a stop that is not true', { stop: 'yes' }, '`stop` must be true'],
    ['a stop with a target', { stop: true, provider: 'def-1', model: 'm' }, 'both a target and `stop`'],
    ['not an object', 'def-1', 'not an object'],
  ])('refuses %s, naming the reason', (_name, answer, reason) => {
    const checked = checkRouteAnswer(answer, { ...facts, routesTo: facts.routesTo === '*' ? '*' : [...facts.routesTo, 'unset', 'unserved', 'a-router'] })
    expect(checked.kind).toBe('refused')
    expect((checked as { reason: string }).reason).toContain(reason)
  })
})

// ── the stream host ─────────────────────────────────────────────────────────

describe('a request to a router provider', () => {
  it('goes to the target the router names, through the target\'s own seam', async () => {
    const { transport, opens } = rawHost({})
    const hooks = fakeProviderRequestSeam({ request: () => ({ headers: { 'x-target-hook': 'ran' } }) })
    registerProviderRequestSeam(A, hooks.seam)
    const { router, events, outcomes } = testRouter([{ provider: A, model: 'm-a', effort: 'high' }])
    registerProviderRouter(ROUTER, router, { routesTo: '*' })

    const { chunks } = await stream(withModelProviders(transport, config()))

    expect(textOf(chunks)).toBe(`from ${A}`)
    expect(opens).toHaveLength(1)
    expect(opens[0]!.providerId).toBe(A)
    expect(opens[0]!.url).toBe('https://a.vendor.example/v1/chat')
    expect(opens[0]!.headers['x-target-hook']).toBe('ran')
    expect(bodyOf(opens[0]!)).toMatchObject({ model: 'm-a', tier: 'high' })
    expect(hooks.calls.request).toHaveLength(1)
    expect(hooks.calls.request[0]!.provider).toBe(A)
    expect(events).toEqual([
      { model: 'route-row', requestContext: CONTEXT, callId: expect.any(String), attempt: 1, request: { tools: false } },
    ])
    // The reply's first chunk names the target's model, as a request of its own would.
    expect(chunks[0]).toMatchObject({ type: 'message_start', message: { model: 'm-a' } })
    expect(outcomes).toEqual([expect.objectContaining({
      provider: ROUTER,
      model: 'route-row',
      callId: events[0]!.callId,
      target: { provider: A, model: 'm-a' },
      ok: true,
      usage: { inputTokens: 11, outputTokens: 3 },
      attempts: 1,
    })])
  })

  it('moves to another target under the same stream when the first refuses before the reply', async () => {
    const { transport, opens } = rawHost({ [A]: [refusedWith(429, 'slow down')] })
    const { router, events } = testRouter([toA, toB])
    registerProviderRouter(ROUTER, router, { routesTo: [A, B] })

    const { chunks } = await stream(withModelProviders(transport, config()))

    expect(opens.map(o => o.providerId)).toEqual([A, B])
    expect(errorOf(chunks)).toBeUndefined()
    expect(textOf(chunks)).toBe(`from ${B}`)
    expect(chunks.filter(c => c.type === 'message_stop')).toHaveLength(1)
    expect(events[1]).toMatchObject({
      attempt: 2,
      lastFailure: { provider: A, model: 'm-a', status: 429, streamStarted: false, verdict: { kind: 'rate_limit' } },
    })
    expect(events[1]!.lastFailure!.message).toContain('slow down')
  })

  it('moves to another target when the first rejects its credentials before the reply', async () => {
    const { transport, opens } = rawHost({ [A]: [refusedWith(401, 'Missing Authentication header')] })
    const { router, events } = testRouter([toA, toB])
    registerProviderRouter(ROUTER, router, { routesTo: [A, B] })

    const { chunks } = await stream(withModelProviders(transport, config()))

    expect(opens.map(o => o.providerId)).toEqual([A, B])
    expect(errorOf(chunks)).toBeUndefined()
    expect(events[1]).toMatchObject({ lastFailure: { provider: A, status: 401, verdict: { kind: 'credentials' } } })
  })

  it('tells every ask of a call one call id, and another call another', async () => {
    const { transport } = rawHost({ [A]: [refusedWith(429, 'slow down')] })
    const { router, events } = testRouter([toA, toB, toA])
    registerProviderRouter(ROUTER, router, { routesTo: [A, B] })
    const wrapped = withModelProviders(transport, config())

    await stream(wrapped)
    await stream(wrapped)

    expect(events.map(e => e.attempt)).toEqual([1, 2, 1])
    expect(events[0]!.callId).not.toBe('')
    expect(events[1]!.callId).toBe(events[0]!.callId)
    expect(events[2]!.callId).not.toBe(events[0]!.callId)
  })

  it('tells the router whether the request carries tool definitions', async () => {
    const { transport } = rawHost({})
    const { router, events } = testRouter([toA])
    registerProviderRouter(ROUTER, router, { routesTo: '*' })
    const wrapped = withModelProviders(transport, config())
    const tool = { name: 'read', description: 'reads', inputSchema: { type: 'object' } }

    await stream(wrapped, payload({ tools: [tool] }))
    await stream(wrapped, payload({ tools: [] }))
    await stream(wrapped)

    expect(events.map(e => e.request)).toEqual([{ tools: true }, { tools: false }, { tools: false }])
  })

  it('writes one request-log row per send, the sends of a call under one call id', async () => {
    vi.mocked(recordRequest).mockClear()
    const { transport } = rawHost({ [A]: [refusedWith(429, 'slow down')] })
    const { router, events, outcomes } = testRouter([toA, toB, toA])
    registerProviderRouter(ROUTER, router, { routesTo: [A, B] })
    const wrapped = withModelProviders(transport, config())

    await stream(wrapped)
    await stream(wrapped)

    const rows = loggedRows()
    // The log's call id is the one the route and outcome events carry.
    expect(rows.map(row => String(row.callId))).toEqual([events[0]!.callId, events[1]!.callId, events[2]!.callId])
    expect(outcomes.map(o => o.callId)).toEqual([events[0]!.callId, events[2]!.callId])
    // Each row is written through the bridge the call came on.
    expect(vi.mocked(recordRequest).mock.calls.every(call => call[1] === transport)).toBe(true)
    expect(rows.map(row => [row.provider, row.model, row.hop, row.outcome])).toEqual([
      [A, 'm-a', 1, 'failed'],
      [B, 'm-b', 2, 'ok'],
      [A, 'm-a', 1, 'ok'],
    ])
    expect(rows[0]).toMatchObject({ failureKind: 'rate_limit', httpStatus: 429, sessionId: 'session-1' })
    expect(rows[0]).not.toHaveProperty('switchedFrom')
    expect(rows[1]).toMatchObject({
      router: { provider: ROUTER, row: 'route-row' },
      switchedFrom: { provider: A, model: 'm-a', kind: 'rate_limit' },
      usage: { inputTokens: 11, outputTokens: 3 },
    })
    expect(rows[1]!.callId).toBe(rows[0]!.callId)
    expect(rows[2]!.callId).not.toBe(rows[0]!.callId)
    expect(rows[2]).not.toHaveProperty('switchedFrom')
  })

  it('a leg\'s row carries its own cache counts', async () => {
    vi.mocked(recordRequest).mockClear()
    const cached = enc([
      { type: 'text_delta', text: 'cached' },
      { type: 'finish', finishReason: 'stop', usage: { promptTokens: 40, completionTokens: 5, promptCacheHits: 30, promptCacheWrites: 6 } },
    ])
    const { transport } = rawHost({ [A]: [{ status: 200, body: cached }] })
    registerProviderRouter(ROUTER, testRouter([toA]).router, { routesTo: '*' })
    await stream(withModelProviders(transport, config()))
    expect(loggedRows()[0]!.usage).toEqual({ inputTokens: 40, outputTokens: 5, cacheReadTokens: 30, cacheWriteTokens: 6 })
  })

  it('a cancel mid-leg writes that leg as aborted, once', async () => {
    vi.mocked(recordRequest).mockClear()
    const { transport, opens } = rawHost({ [A]: [{ status: 200, body: new Uint8Array(), hang: true }] })
    registerProviderRouter(ROUTER, testRouter([toA]).router, { routesTo: '*' })
    const wrapped = withModelProviders(transport, config())
    const started = await model(wrapped, 'streamStart', payload())
    await vi.waitFor(() => expect(opens).toHaveLength(1))
    await model(wrapped, 'streamCancel', { streamId: started.result.streamId })
    await model(wrapped, 'streamCancel', { streamId: started.result.streamId })
    expect(loggedRows().map(row => [row.provider, row.hop, row.outcome])).toEqual([[A, 1, 'aborted']])
    expect(loggedRows()[0]).not.toHaveProperty('failureKind')
  })

  it('a cancel while the router decides on a failed leg writes that leg as failed', async () => {
    vi.mocked(recordRequest).mockClear()
    const { transport } = rawHost({ [A]: [refusedWith(429, 'slow down')] })
    let release!: () => void
    const held = new Promise<RouteAnswer>(resolve => { release = () => resolve(toB) })
    const { router, events } = testRouter([toA, (() => held) as never])
    registerProviderRouter(ROUTER, router, { routesTo: [A, B] })
    const wrapped = withModelProviders(transport, config())
    const started = await model(wrapped, 'streamStart', payload())
    const reading = (async () => {
      for (let i = 0; i < 50; i += 1) {
        const read = await model(wrapped, 'streamRead', { streamId: started.result.streamId, waitMs: 5000 })
        if (!read.ok || read.result.done) return
      }
    })()
    await vi.waitFor(() => expect(events).toHaveLength(2))
    await model(wrapped, 'streamCancel', { streamId: started.result.streamId })
    release()
    await reading.catch(() => {})
    expect(loggedRows()).toHaveLength(1)
    expect(loggedRows()[0]).toMatchObject({ provider: A, outcome: 'failed', failureKind: 'rate_limit', httpStatus: 429 })
  })

  it('a request the router ends before any send writes no request-log row', async () => {
    vi.mocked(recordRequest).mockClear()
    const { transport } = rawHost({})
    registerProviderRouter(ROUTER, testRouter([{ stop: true }]).router, { routesTo: '*' })
    await stream(withModelProviders(transport, config()))
    expect(loggedRows()).toEqual([])
  })

  it('asks the router after the target\'s own verdict and before the target\'s own re-send', async () => {
    const order: string[] = []
    const run = async (second: RouteAnswer) => {
      order.length = 0
      const { transport, opens } = rawHost({ [A]: [refusedWith(429, 'slow down'), refusedWith(429, 'still')] })
      const hooks = fakeProviderRequestSeam({
        retry: () => {
          order.push('retry')
          return { retry: {} }
        },
      })
      registerProviderRequestSeam(A, {
        ...hooks.seam,
        policy: { errors: [{ match: { status: 429 }, kind: 'quota', retryable: false }] },
        classify: () => {
          order.push('classify')
          return { code: 'plan-used-up' }
        },
      })
      const router = testRouter([toA, e => {
        order.push(`route:${e.lastFailure?.verdict.kind}:${e.lastFailure?.verdict.code}`)
        return second
      }])
      registerProviderRouter(ROUTER, router.router, { routesTo: '*' })
      const { chunks } = await stream(withModelProviders(transport, config()))
      return { chunks, opens }
    }

    // The router takes the failure: the target's `retry` hook is never raised.
    const switched = await run(toB)
    expect(order).toEqual(['classify', 'route:quota:plan-used-up'])
    expect(switched.opens.map(o => o.providerId)).toEqual([A, B])

    // The router leaves it: the target's own re-send follows.
    const left = await run(undefined)
    expect(order.slice(0, 3)).toEqual(['classify', 'route:quota:plan-used-up', 'retry'])
    expect(left.opens.map(o => o.providerId)).toEqual([A, A])
  })

  it('leaves a failure the router does not answer exactly as the target\'s own request has it', async () => {
    const script = () => ({ [A]: [refusedWith(503, 'down'), refusedWith(503, 'down again')] })
    const seam = () => fakeProviderRequestSeam({ retry: () => ({ retry: {} }) }).seam

    // The target's own request, with no router in the way.
    const plain = rawHost(script())
    registerProviderRequestSeam(A, seam())
    const host = new DriverStreamHost(plain.transport)
    const { streamId } = host.start(
      createModelProvider({ id: A, ...SPECS[A] }),
      { ...payload(), providerId: A, model: 'm-a' } as never,
      'm-a',
    )
    const expected: any[] = []
    for (;;) {
      const read = await host.read(streamId, 5000)
      expected.push(...read.chunks)
      if (read.done) break
    }

    const routed = rawHost(script())
    registerProviderRequestSeam(A, seam())
    registerProviderRouter(ROUTER, testRouter([toA, undefined]).router, { routesTo: '*' })
    const { chunks } = await stream(withModelProviders(routed.transport, config()))

    expect(chunks).toEqual(expected)
    expect(errorOf(chunks).message).toContain('down again')
    expect(routed.opens.map(o => o.url)).toEqual(plain.opens.map(o => o.url))
  })

  it('marks a failure after the reply started with the target the router chose', async () => {
    const { transport, opens } = rawHost({ [A]: [cutAfter('half')] })
    const { router, events, outcomes } = testRouter([toA, toB])
    registerProviderRouter(ROUTER, router, { routesTo: '*' })

    const { chunks } = await stream(withModelProviders(transport, config()))

    expect(textOf(chunks)).toBe('half')
    expect(errorOf(chunks)).toMatchObject({ route: { switch: { provider: B, model: 'm-b' } } })
    expect(errorOf(chunks).message).toContain('ERR_CONNECTION_RESET')
    // Nothing is sent to the new target by this stream: the caller sends the call again.
    expect(opens.map(o => o.providerId)).toEqual([A])
    expect(events[1]!.lastFailure).toMatchObject({ provider: A, streamStarted: true, verdict: { kind: 'network' } })
    // The stream is over even though the call goes on: the router hears of it.
    expect(outcomes).toEqual([expect.objectContaining({ ok: false, target: { provider: A, model: 'm-a' } })])
  })

  it('ends with the target\'s error when the router stops, and sends nothing again', async () => {
    const { transport, opens } = rawHost({ [A]: [refusedWith(429, 'slow down')] })
    const { router, outcomes } = testRouter([toA, { stop: true }])
    registerProviderRouter(ROUTER, router, { routesTo: '*' })

    const { chunks } = await stream(withModelProviders(transport, config()))

    expect(opens).toHaveLength(1)
    expect(errorOf(chunks)).toMatchObject({ httpStatus: 429, route: { stop: true } })
    expect(errorOf(chunks).message).toContain('slow down')
    expect(outcomes).toEqual([expect.objectContaining({ ok: false, status: 429, target: { provider: A, model: 'm-a' } })])
  })

  it.each([
    ['is not set up', { provider: 'target-unset', model: 'm-c' }, 'the provider target-unset is not set up'],
    ['is a router', { provider: ROUTER, model: 'route-row' }, `the provider ${ROUTER} is a router`],
    ['is outside the boundary', toB, `the provider ${B} is outside what this router may send through`],
    ['does not list the model', { provider: A, model: 'm-zzz' }, `the provider ${A} does not list the model m-zzz`],
    ['cannot be served', { provider: 'target-unserved', model: 'm-d' }, 'requests to the provider target-unserved cannot be sent from here'],
  ])('fails closed on the first send when the target %s', async (_name, answer, reason) => {
    const { transport, opens } = rawHost({})
    registerProviderRouter(ROUTER, testRouter([answer as RouteAnswer]).router, { routesTo: [A, 'target-unset', 'target-unserved'] })

    const { chunks } = await stream(withModelProviders(transport, config()))

    expect(opens).toHaveLength(0)
    expect(errorOf(chunks).message).toContain(`provider.route of ${ROUTER}: its answer was refused: ${reason}`)
    expect(errorOf(chunks).route).toEqual({ stop: true })
  })

  it('fails closed on the first send when the router names nothing or throws', async () => {
    const { transport, opens } = rawHost({})
    registerProviderRouter(ROUTER, testRouter([undefined]).router, { routesTo: '*' })
    const silent = await stream(withModelProviders(transport, config()))
    expect(errorOf(silent.chunks).message).toContain('it named no target; the request was not sent')

    registerProviderRouter(ROUTER, { route: async () => { throw new Error('boom') } }, { routesTo: '*' })
    const thrown = await stream(withModelProviders(transport, config()))
    expect(errorOf(thrown.chunks).message).toContain('the hook failed: boom')
    expect(opens).toHaveLength(0)
  })

  it('ends the request with the router\'s message when it stops before the first send', async () => {
    const { transport, opens } = rawHost({})
    registerProviderRouter(ROUTER, testRouter([{ stop: true, message: 'every member is used up' }]).router, { routesTo: '*' })
    const { chunks } = await stream(withModelProviders(transport, config()))
    expect(opens).toHaveLength(0)
    expect(errorOf(chunks)).toMatchObject({ message: 'every member is used up', route: { stop: true } })
  })

  it('counts a refused answer after a failure as no answer', async () => {
    const { transport, opens } = rawHost({ [A]: [refusedWith(429, 'slow down')] })
    registerProviderRouter(ROUTER, testRouter([toA, { provider: 'target-unset', model: 'm-c' }]).router, { routesTo: '*' })
    const { chunks } = await stream(withModelProviders(transport, config()))
    expect(opens.map(o => o.providerId)).toEqual([A])
    expect(errorOf(chunks)).toMatchObject({ httpStatus: 429 })
    expect(errorOf(chunks).route).toBeUndefined()
  })

  it(`sends one call to at most ${ROUTE_HOPS_MAX} targets and ends with the last failure`, async () => {
    const always = (text: string) => Array.from({ length: 20 }, () => refusedWith(429, text))
    const { transport, opens } = rawHost({ [A]: always('a is busy'), [B]: always('b is busy') })
    const { router, events } = testRouter([e => (e.attempt % 2 === 1 ? toA : toB)])
    registerProviderRouter(ROUTER, router, { routesTo: '*' })

    const { chunks } = await stream(withModelProviders(transport, config()))

    expect(opens).toHaveLength(ROUTE_HOPS_MAX)
    expect(events).toHaveLength(ROUTE_HOPS_MAX)
    expect(errorOf(chunks)).toMatchObject({ httpStatus: 429 })
    expect(errorOf(chunks).message).toContain('b is busy')
    expect(errorOf(chunks).route).toBeUndefined()
  })

  it('moves to another target when a held read finds the first one silent', async () => {
    const { transport, opens } = rawHost({ [A]: [{ status: 200, body: new Uint8Array(), hang: true }] })
    const { router, events } = testRouter([toA, toB])
    registerProviderRouter(ROUTER, router, { routesTo: '*' })
    const wrapped = withModelProviders(transport, config())

    const started = await model(wrapped, 'streamStart', payload())
    const streamId = started.result.streamId
    const chunks: any[] = []
    let statuses = ''
    for (let i = 0; i < 20; i += 1) {
      const read = await model(wrapped, 'streamRead', { streamId, waitMs: 40 })
      statuses += `${read.result.status} `
      chunks.push(...read.result.chunks)
      if (read.result.done) break
    }

    expect(statuses).not.toContain('timeout')
    expect(opens.map(o => o.providerId)).toEqual([A, B])
    expect(textOf(chunks)).toBe(`from ${B}`)
    expect(events[1]!.lastFailure).toMatchObject({ provider: A, streamStarted: false })
  })

  it('serves the blocking route the same way', async () => {
    const { transport, opens } = rawHost({ [A]: [refusedWith(503, 'down')] })
    const { router, events, outcomes } = testRouter([toA, toB])
    registerProviderRouter(ROUTER, router, { routesTo: '*' })

    const answer = await model(withModelProviders(transport, config()), 'call', payload())

    expect(answer.ok).toBe(true)
    expect(opens.map(o => o.providerId)).toEqual([A, B])
    expect(answer.result.message.content).toEqual([expect.objectContaining({ type: 'text', text: `from ${B}` })])
    expect(answer.result.message.model).toBe('m-b')
    expect(events.map(e => e.attempt)).toEqual([1, 2])
    expect(events[1]!.callId).toBe(events[0]!.callId)
    expect(outcomes).toEqual([expect.objectContaining({ ok: true, callId: events[0]!.callId, target: { provider: B, model: 'm-b' } })])
  })

  it('tells each call\'s outcome that call\'s id', async () => {
    const { transport } = rawHost({})
    const { router, events, outcomes } = testRouter([toA])
    registerProviderRouter(ROUTER, router, { routesTo: '*' })
    const wrapped = withModelProviders(transport, config())

    await stream(wrapped)
    await stream(wrapped)

    expect(outcomes.map(o => o.callId)).toEqual(events.map(e => e.callId))
    expect(outcomes[1]!.callId).not.toBe(outcomes[0]!.callId)
  })

  it('leaves a provider that is no router on its own path', async () => {
    const { transport, opens } = rawHost({})
    registerProviderRouter(ROUTER, testRouter([toB]).router, { routesTo: '*' })
    const { chunks } = await stream(withModelProviders(transport, config()), { ...payload(), providerId: A, model: 'm-a' })
    expect(opens.map(o => o.providerId)).toEqual([A])
    expect(textOf(chunks)).toBe(`from ${A}`)
  })
})

// ── the whole call: the ladder, the usage figure, the reply's record ───────

describe('a call to a router provider', () => {
  function params(extra: { sessionId?: string; messages?: unknown[] } = {}) {
    const callContext = createNoopToolUseContext({
      tools: [],
      platformCapabilities: new NoopPlatformCapabilities(),
      appState: createEmptyAppState(),
      setAppState: () => {},
    })
    ;(callContext.options as { sessionId?: string }).sessionId = extra.sessionId
    return {
      messages: extra.messages ?? [{ type: 'user', uuid: 'u-1', message: { role: 'user', content: 'hello' } }],
      baseInstructions: 'test',
      userContext: {},
      systemAmbient: {},
      callContext,
      querySource: 'test',
      providerId: ROUTER,
      model: 'route-row',
    }
  }

  async function call(transport: BrowserBridgeTransport, runtimeConfig: RuntimeConfig, p = params()) {
    const deps = assembleTurnDependencies(runtimeConfig, {}, { bridgeTransport: transport as never, runtimeConfig })
    const out: any[] = []
    for await (const value of deps.callModel(p as never) as AsyncGenerator<unknown>) out.push(value)
    return out
  }
  const assistants = (values: any[]) => values.filter(v => v?.type === 'assistant')
  const replyText = (values: any[]) => assistants(values)
    .flatMap(v => v.message.content)
    .map((block: any) => block.text ?? '')
    .join('')

  it('sends a call again at once after a reply that broke off, and records who served it', async () => {
    const { transport, opens } = rawHost({ [A]: [cutAfter('half')] })
    const { router, events } = testRouter([toA, toB])
    registerProviderRouter(ROUTER, router, { routesTo: '*' })

    const startedAt = Date.now()
    const values = await call(transport, config())

    expect(opens.map(o => o.providerId)).toEqual([A, B])
    expect(Date.now() - startedAt).toBeLessThan(400)
    // The failure is put to the router where it happened, then the call's
    // second attempt is resolved with it.
    expect(events).toHaveLength(3)
    expect(events[2]).toMatchObject({ attempt: 2, lastFailure: { provider: A, model: 'm-a', streamStarted: true } })
    const served = assistants(values).filter(v => !v.isApiErrorMessage)
    expect(replyText(served)).toContain(`from ${B}`)
    expect(served.at(-1).routedVia).toEqual({
      provider: B,
      model: 'm-b',
      switchedFrom: { provider: A, model: 'm-a', reason: 'network' },
    })
  })

  it('ends with the API error of the target when the router stops, with no retry', async () => {
    const { transport, opens } = rawHost({ [A]: [cutAfter('half')] })
    registerProviderRouter(ROUTER, testRouter([toA, { stop: true }]).router, { routesTo: '*' })

    const values = await call(transport, config())

    expect(opens).toHaveLength(1)
    const failed = assistants(values).find(v => v.isApiErrorMessage)
    expect(failed.errorDetails).toContain('ERR_CONNECTION_RESET')
    expect(failed.errorRetryCount).toBe(0)
    expect(failed.routedVia).toBeUndefined()
  })

  it('shows the router\'s own message when it stops with one', async () => {
    const { transport } = rawHost({ [A]: [refusedWith(429, 'slow down')] })
    registerProviderRouter(ROUTER, testRouter([toA, { stop: true, message: 'every member is used up' }]).router, { routesTo: '*' })
    const failed = assistants(await call(transport, config())).find(v => v.isApiErrorMessage)
    expect(failed.errorDetails).toContain('every member is used up')
    expect(failed.errorRetryCount).toBe(0)
  })

  it('retries under the router\'s declared policy, not the target\'s', async () => {
    const down = () => Array.from({ length: 6 }, () => refusedWith(503, 'down'))
    registerProviderRequestSeam(A, { policy: { retry: { maxRetries: 0 } } })

    // The router declares two retries: the target's "none" does not apply.
    const first = rawHost({ [A]: down() })
    registerProviderRouter(ROUTER, testRouter([toA, undefined]).router, {
      routesTo: '*',
      retry: { maxRetries: 2, initialDelayMs: 1, maxDelayMs: 2, jitterRatio: 0 },
    })
    const values = await call(first.transport, config())
    expect(first.opens).toHaveLength(3)
    expect(assistants(values).find(v => v.isApiErrorMessage).errorRetryCount).toBe(2)

    // The target's own request keeps the target's policy.
    const own = rawHost({ [A]: down() })
    await call(own.transport, config(), { ...params(), providerId: A, model: 'm-a' })
    expect(own.opens).toHaveLength(1)
  })

  it('waits on the schedule of the router when it gives no answer, and asks again before each re-send', async () => {
    const { transport, opens } = rawHost({ [A]: Array.from({ length: 6 }, () => refusedWith(503, 'down')) })
    // The member allows no retry and has one re-send of its own per stream.
    const hooks = fakeProviderRequestSeam({ retry: () => undefined })
    registerProviderRequestSeam(A, { ...hooks.seam, policy: { retry: { maxRetries: 0 } } })
    const { router, events } = testRouter([toA, undefined])
    registerProviderRouter(ROUTER, router, {
      routesTo: '*',
      retry: { maxRetries: 2, initialDelayMs: 60, maxDelayMs: 60, jitterRatio: 0 },
    })

    const startedAt = Date.now()
    const values = await call(transport, config())

    // Three sends, with the two waits the router declared between them.
    expect(opens.map(o => o.providerId)).toEqual([A, A, A])
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(110)
    expect(assistants(values).find(v => v.isApiErrorMessage).errorRetryCount).toBe(2)
    // The member's own recovery was offered each failure, after the router.
    expect(hooks.calls.retry).toHaveLength(3)
    // Asked at each failure, and again before each re-send of the ladder,
    // with the attempt number and the failure.
    expect(events.map(e => [e.attempt, e.lastFailure?.status])).toEqual([
      [1, undefined],
      [2, 503], [2, 503],
      [3, 503], [3, 503],
      [4, 503],
    ])
    expect(events[2]!.lastFailure).toMatchObject({ provider: A, model: 'm-a', verdict: { kind: 'service', retryable: true } })
  })

  it('does not retry a failure the verdict of the member calls final, whatever the router declares', async () => {
    const { transport, opens } = rawHost({ [A]: [refusedWith(400, 'malformed request')] })
    registerProviderRouter(ROUTER, testRouter([toA, undefined]).router, {
      routesTo: '*',
      retry: { maxRetries: 5, initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
    })
    const values = await call(transport, config())
    expect(opens).toHaveLength(1)
    expect(assistants(values).find(v => v.isApiErrorMessage).errorRetryCount).toBe(0)
  })

  it('sends at once, with no wait, only when the router names a target at the re-send', async () => {
    const { transport, opens } = rawHost({ [A]: [cutAfter('half')] })
    // Silent at the failure, a target when the ladder is about to send again.
    const { router } = testRouter([toA, undefined, toB])
    registerProviderRouter(ROUTER, router, {
      routesTo: '*',
      retry: { maxRetries: 2, initialDelayMs: 80, maxDelayMs: 80, jitterRatio: 0 },
    })
    const startedAt = Date.now()
    const values = await call(transport, config())
    // The ladder's wait ran (the router had not answered the failure), then
    // the re-send went to the target the router named.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(70)
    expect(opens.map(o => o.providerId)).toEqual([A, B])
    expect(assistants(values).at(-1).routedVia).toMatchObject({ provider: B, switchedFrom: { provider: A, reason: 'network' } })
  })

  it('uses the schedule of the platform, never the member\'s, when the router declares none', async () => {
    const { transport, opens } = rawHost({ [A]: Array.from({ length: 6 }, () => refusedWith(503, 'down')) })
    registerProviderRequestSeam(A, { policy: { retry: { maxRetries: 0 } } })
    registerProviderRouter(ROUTER, testRouter([toA, undefined]).router, { routesTo: '*' })
    const startedAt = Date.now()
    const values = await call(transport, config({ e2eProviderMaxRetries: '1' }))
    // The member allows none; the platform's ladder (held to one retry here)
    // still retries, after the platform's own first backoff.
    expect(opens).toHaveLength(2)
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(300)
    expect(assistants(values).find(v => v.isApiErrorMessage).errorRetryCount).toBe(1)
  })

  it('tells the router the session\'s context in tokens, as the usage meter counts it', async () => {
    const { transport } = rawHost({})
    const { router, events } = testRouter([toA])
    registerProviderRouter(ROUTER, router, { routesTo: '*' })
    const history = [
      { type: 'user', uuid: 'u-1', message: { role: 'user', content: 'hello' } },
      {
        type: 'assistant',
        uuid: 'a-1',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'hi' }],
          usage: { input_tokens: 1200, cache_creation_input_tokens: 300, cache_read_input_tokens: 4000, output_tokens: 90 },
        },
      },
      { type: 'user', uuid: 'u-2', message: { role: 'user', content: 'again' } },
    ]

    await call(transport, config(), params({ sessionId: 'session-9', messages: history }))
    expect(events[0]!.usage).toEqual({ contextTokens: 5500 })

    // A session with no counted reply yet has an empty context.
    await call(transport, config(), params({ sessionId: 'session-9' }))
    expect(events[1]!.usage).toEqual({ contextTokens: 0 })

    // A request that belongs to no session carries no figure.
    await call(transport, config(), params({ messages: history }))
    expect(events[2]).not.toHaveProperty('usage')
  })

  it('records the target on the reply, and a move from the previous reply\'s target', async () => {
    const { transport } = rawHost({})
    registerProviderRouter(ROUTER, testRouter([toA]).router, { routesTo: '*' })

    const first = assistants(await call(transport, config()))
    expect(first.at(-1).routedVia).toEqual({ provider: A, model: 'm-a' })

    const after = (via: unknown) => params({
      messages: [
        { type: 'user', uuid: 'u-1', message: { role: 'user', content: 'hello' } },
        { type: 'assistant', uuid: 'a-1', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] }, routedVia: via },
        { type: 'user', uuid: 'u-2', message: { role: 'user', content: 'again' } },
      ],
    })
    const same = assistants(await call(transport, config(), after({ provider: A, model: 'm-a' })))
    expect(same.at(-1).routedVia).toEqual({ provider: A, model: 'm-a' })

    const moved = assistants(await call(transport, config(), after({ provider: B, model: 'm-b' })))
    expect(moved.at(-1).routedVia).toEqual({ provider: A, model: 'm-a', switchedFrom: { provider: B, model: 'm-b' } })
  })

  it('names the member on the first stream event of a reply, before the reply row', async () => {
    const { transport } = rawHost({})
    registerProviderRouter(ROUTER, testRouter([toA]).router, { routesTo: '*' })
    const values = await call(transport, config())
    const events = values.filter((v: any) => v?.type === 'stream_event')
    expect(events.length).toBeGreaterThan(1)
    expect(events[0].routedVia).toEqual({ provider: A, model: 'm-a' })
    expect(events.slice(1).every((v: any) => !('routedVia' in v))).toBe(true)
    expect(values.indexOf(events[0])).toBeLessThan(values.findIndex((v: any) => v?.type === 'assistant'))
  })

  it('records nothing for a provider that is no router', async () => {
    const { transport } = rawHost({})
    const all = await call(transport, config(), { ...params(), providerId: A, model: 'm-a' })
    expect(all.some((v: any) => v && 'routedVia' in v)).toBe(false)
    const values = assistants(all)
    expect(values.at(-1)).not.toHaveProperty('routedVia')
    expect(routedViaOf({})).toBeUndefined()
    expect(routeCallOf({})).toEqual({ id: expect.any(String), logCallId: expect.any(Number), sends: 0, hops: 0 })
  })

  it('sends the call to the target chosen at a broken reply when the router names none at the re-send', async () => {
    const { transport, opens } = rawHost({ [A]: [cutAfter('half')] })
    const { router, events } = testRouter([toA, toB, undefined])
    registerProviderRouter(ROUTER, router, { routesTo: '*' })

    const startedAt = Date.now()
    const values = await call(transport, config())

    expect(opens.map(o => o.providerId)).toEqual([A, B])
    expect(Date.now() - startedAt).toBeLessThan(400)
    expect(events).toHaveLength(3)
    expect(assistants(values).at(-1).routedVia).toEqual({
      provider: B,
      model: 'm-b',
      switchedFrom: { provider: A, model: 'm-a', reason: 'network' },
    })
  })

  it('sends the call to the target chosen at a broken reply when the hop bound ends the asking', async () => {
    const busy = () => refusedWith(429, 'busy')
    // Sends one to seven alternate A and B, each refused before a reply; the
    // seventh (A) breaks off mid-reply and the router's eighth answer is B.
    const { transport, opens } = rawHost({
      [A]: [busy(), busy(), busy(), cutAfter('half')],
      [B]: [busy(), busy(), busy()],
    })
    const { router, events } = testRouter([e => (e.lastFailure?.provider === A ? toB : toA)])
    registerProviderRouter(ROUTER, router, { routesTo: '*' })

    const values = await call(transport, config())

    // The re-send cannot ask again, and goes to B, never back to A.
    expect(events).toHaveLength(ROUTE_HOPS_MAX)
    expect(opens.map(o => o.providerId)).toEqual([A, B, A, B, A, B, A, B])
    expect(replyText(assistants(values).filter(v => !v.isApiErrorMessage))).toContain(`from ${B}`)
  })

  it('ends a blocking fallback with the router\'s stop, not a retry of the failure\'s text', async () => {
    const empty: Reply = { status: 200, body: enc([]) }
    const { transport, opens } = rawHost({ [A]: [empty, refusedWith(429, 'rate limit')] })
    registerProviderRouter(ROUTER, testRouter([toA, toA, { stop: true, message: 'every member is used up' }]).router, {
      routesTo: '*',
      retry: { maxRetries: 3, initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
    })

    const values = await call(transport, config())

    expect(opens).toHaveLength(2)
    const failed = assistants(values).find(v => v.isApiErrorMessage)
    expect(failed.errorDetails).toContain('every member is used up')
    expect(failed.errorRetryCount).toBe(0)
  })

  it('compares with the last routed reply, past an error card', async () => {
    const { transport } = rawHost({})
    registerProviderRouter(ROUTER, testRouter([toA]).router, { routesTo: '*' })
    const p = params({
      messages: [
        { type: 'user', uuid: 'u-1', message: { role: 'user', content: 'hello' } },
        { type: 'assistant', uuid: 'a-1', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] }, routedVia: { provider: B, model: 'm-b' } },
        { type: 'user', uuid: 'u-2', message: { role: 'user', content: 'again' } },
        { type: 'assistant', uuid: 'a-2', message: { role: 'assistant', content: [{ type: 'text', text: 'API Error' }] }, isApiErrorMessage: true },
        { type: 'user', uuid: 'u-3', message: { role: 'user', content: 'once more' } },
      ],
    })
    const values = assistants(await call(transport, config(), p))
    expect(values.at(-1).routedVia).toEqual({ provider: A, model: 'm-a', switchedFrom: { provider: B, model: 'm-b' } })
  })

  it('keeps the failure\'s status and declared verdict on a switch', () => {
    const cause = new ProviderApiError('API Error: 402 plan used up', {
      httpStatus: 402,
      retryAfterMs: 5000,
      declared: { kind: 'billing', retryable: false, errorCode: 'plan-used-up' } as never,
    })
    const error = new RouteSwitchError({ provider: B, model: 'm-b' }, cause)
    expect(error.httpStatus).toBe(402)
    expect(error.retryAfterMs).toBe(5000)
    expect(error.declared).toEqual(getProviderErrorFields(cause).declared)
    expect(error.declared?.kind).toBe('billing')
  })

  it('still puts a switch to turn.recover, as the retry the ladder decided', async () => {
    const seen: any[] = []
    const p = params()
    ;(p.callContext.options as { mods?: unknown }).mods = {
      hasTurnRecoverHooks: () => true,
      turnRecover: async (e: any) => {
        seen.push(e)
        return e.decision
      },
    }
    const error = new RouteSwitchError({ provider: B, model: 'm-b' }, new Error('Stream network error: cut'))
    const decision = await recoverThroughMods(
      { ...p, modStep: { turnId: 'turn-1' } } as never,
      error,
      { attempt: 1, maxAttempts: 3, attemptDurationMs: 5 },
    )
    expect(decision).toEqual({ retry: true, delayMs: 0, notify: false })
    expect(seen[0]).toMatchObject({ failure: { kind: 'connectivity', retryAfterMs: 0 }, decision: { retry: true, delayMs: 0 } })
  })

  it("records the member's tiers with the reply, so a reader needs no catalog row for it", async () => {
    const real = vi.mocked(findConfiguredModel).getMockImplementation()!
    vi.mocked(findConfiguredModel).mockImplementation((provider, model) =>
      provider === A && model === 'm-a' ? ({ availableThinkingTiers: ['low', 'high'], defaultThinkingTier: 'low' } as never) : real(provider, model))
    try {
      expect(routeMemberFacts(A, 'm-a')).toEqual({ tiers: ['low', 'high'], defaultTier: 'low' })
      expect(routeMemberFacts(A, 'unlisted')).toEqual({})
      const { transport } = rawHost({})
      const { router } = testRouter([{ provider: A, model: 'm-a' }])
      registerProviderRouter(ROUTER, router, { routesTo: '*' })
      const values = await call(transport, config())
      expect(assistants(values).at(-1).routedVia).toEqual({ provider: A, model: 'm-a', tiers: ['low', 'high'], defaultTier: 'low' })
    } finally {
      vi.mocked(findConfiguredModel).mockImplementation(real)
    }
  })
})

describe('logRowOf', () => {
  const send = (provider: string, model: string, outcome: 'ok' | 'failed' | 'aborted', status?: number) => ({
    target: { provider, model },
    model,
    startedMs: 1_000,
    durationMs: 20,
    outcome,
    ...(status !== undefined ? { failure: { type: 'error' as const, message: 'refused', httpStatus: status } } : {}),
    usage: {},
  })

  it('a re-send to the same target is the next hop and names no switch', () => {
    const call = routeCallOf({})
    const first = logRowOf('r', 'row', undefined, call, send('a', 'm', 'failed', 503))
    const again = logRowOf('r', 'row', undefined, call, send('a', 'm', 'ok'))
    expect([first.hop, again.hop]).toEqual([1, 2])
    expect(again.callId).toBe(first.callId)
    expect(again).not.toHaveProperty('switchedFrom')
    expect(first).not.toHaveProperty('sessionId')
    expect(again).not.toHaveProperty('failureKind')
  })

  it('a move off a cancelled send names the kind as error', () => {
    const call = routeCallOf({})
    logRowOf('r', 'row', 's', call, send('a', 'm', 'aborted'))
    const moved = logRowOf('r', 'row', 's', call, send('b', 'n', 'ok'))
    expect(moved.switchedFrom).toEqual({ provider: 'a', model: 'm', kind: 'error' })
    expect(moved.sessionId).toBe('s')
  })
})

describe('tierForTarget: the tier a routed target is sent', () => {
  it('keeps a tier the target lists, or any tier when it lists none', () => {
    expect(tierForTarget('high', ['low', 'high'])).toBe('high')
    expect(tierForTarget('max', undefined)).toBe('max')
    expect(tierForTarget('max', [])).toBe('max')
    expect(tierForTarget(undefined, ['low'])).toBeUndefined()
  })

  it('moves a tier the target lacks to the nearest it lists, the lower on a tie', () => {
    expect(tierForTarget('max', ['low', 'medium', 'high'])).toBe('high')
    expect(tierForTarget('minimal', ['medium', 'high'])).toBe('medium')
    expect(tierForTarget('medium', ['low', 'high'])).toBe('low')
  })

  it('drops a tier outside the runtime vocabulary when the target lists tiers', () => {
    expect(tierForTarget('turbo', ['low', 'high'])).toBeUndefined()
  })
})

describe('a routed send carries the tier its target lists', () => {
  it("moves the router's effort to the nearest tier the target's catalog row lists", async () => {
    const real = vi.mocked(findConfiguredModel).getMockImplementation()!
    vi.mocked(findConfiguredModel).mockImplementation((provider, model) =>
      provider === A && model === 'm-a' ? ({ availableThinkingTiers: ['low', 'high'] } as never) : real(provider, model))
    try {
      const { transport, opens } = rawHost({})
      const { router } = testRouter([{ provider: A, model: 'm-a', effort: 'max' }])
      registerProviderRouter(ROUTER, router, { routesTo: '*' })
      await stream(withModelProviders(transport, config()))
      expect(bodyOf(opens[0]!)).toMatchObject({ model: 'm-a', tier: 'high' })
    } finally {
      vi.mocked(findConfiguredModel).mockImplementation(real)
    }
  })
})
