/**
 * The provider hooks on the request path (F-27): the plan fields of a
 * `provider.request` answer, `provider.classify` with its replay, and the
 * `provider.outcome` observer.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserBridgeTransport } from '../browser/bridge/browserBridgeProtocol'
import { assembleTurnDependencies } from '../engine/turn/turnDependencies'
import { DriverStreamHost } from '../models/drivers/driverStreamHost'
import { registerProviderDriver, setHostPrimitives } from '../models/drivers/driverRegistry'
import { createModelProvider } from '../models/drivers/modelProvider'
import type { DriverStreamEvent, ProviderDriver } from '../models/drivers/driverTypes'
import {
  endAnomaly,
  readClassifyAnswer,
  refineDeclared,
  replayPermitted,
  StreamTally,
  verdictOfFailure,
  type ProviderClassifyEvent,
} from '../models/drivers/providerClassify'
import {
  OUTCOME_CALL_FIELD,
  openOutcomeCall,
  raiseProviderOutcome,
  type ProviderOutcomeEvent,
} from '../models/drivers/providerOutcome'
import { RAW_STREAM_EGRESS_PRIMITIVE, type ProviderEgressTable } from '../models/drivers/providerEgress'
import type { ProviderPolicy } from '../models/drivers/providerPolicy'
import {
  PLAN_CONTEXT_WINDOW_CEILING,
  PLAN_MAX_OUTPUT_TOKENS_CEILING,
  readRequestPlan,
} from '../models/drivers/providerRequestPlan'
import {
  registerProviderRequestSeam,
  resetProviderRequestSeams,
  type ProviderRequestEvent,
  type ProviderRequestSeam,
  type ProviderRetryEvent,
} from '../models/drivers/providerRequestSeam'
import { CONTENT_TIMEOUT_FLOOR_MS, STREAM_TIMEOUT_CEILING_MS } from '../models/drivers/providerTimeouts'
import { PROVIDER_EVENTS } from '../mods/provider/providerEvents'
import { createProviderSeam, type ProviderSeamRuntime } from '../mods/provider/providerSeamAdapter'
import {
  DefaultRuntimeConfig,
  NoopPlatformCapabilities,
  createEmptyAppState,
  createNoopToolUseContext,
} from '../runtime/testing/noopAdapters'
import type { Message } from '../runtime/RuntimeTypes'
import { ProviderApiError, classifyProviderConnectivityIssue } from '../utils/providerConnectivity'

// ── a codec whose request shows what it was built from ──────────────────────
const codec: ProviderDriver = {
  id: 'stream-hooks-lines',
  auth: { headers: {} },
  buildRequest: (payload, context) => ({
    url: `${context.baseUrl}/v1/chat`,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode(
      JSON.stringify({
        model: context.model,
        n: 1,
        max: payload.maxOutputTokens ?? null,
        tier: (payload as { thinkingTier?: string }).thinkingTier ?? null,
      }),
    ),
  }),
  createDecoder: () => {
    const decoder = new TextDecoder()
    let buffered = ''
    const drain = (): DriverStreamEvent[] => {
      const lines = buffered.split('\n')
      buffered = lines.pop() ?? ''
      return lines.filter(line => line.startsWith('{"type"')).map(line => JSON.parse(line) as DriverStreamEvent)
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
  errorFromResponse: ({ status, bodyText }) => ({ type: 'error', message: `HTTP ${status}: ${bodyText}`, httpStatus: status }),
}
registerProviderDriver(codec)

const PROVIDER_ID = 'acme'
const provider = () => createModelProvider({ id: PROVIDER_ID, format: 'stream-hooks-lines', baseUrl: 'https://api.acme.example' })
const lines = (events: DriverStreamEvent[], extra = '') =>
  new TextEncoder().encode(extra + events.map(e => JSON.stringify(e)).join('\n') + '\n')
const text = (value: string) => new TextEncoder().encode(value)
const OK = lines([
  { type: 'text_delta', text: 'hi' },
  { type: 'finish', finishReason: 'stop', usage: { promptTokens: 11, completionTokens: 3, promptCacheHits: 5 } },
])

type Reply = { status: number; body: Uint8Array; headers?: Record<string, string> }

/** A host that answers each open with the next scripted reply, its body in one read. */
function scripted(replies: Reply[]) {
  const opens: Array<Record<string, any>> = []
  const bodies = new Map<string, Uint8Array>()
  let next = 0
  const transport: BrowserBridgeTransport = {
    async request(req: any) {
      const action = req.route.action
      if (action === 'rawStreamOpen') {
        opens.push(req.payload)
        const reply = replies.shift() ?? { status: 200, body: OK }
        next += 1
        const streamId = `raw-${next}`
        bodies.set(streamId, reply.body)
        return {
          ok: true,
          result: { streamId, status: reply.status, statusText: 'S', finalUrl: req.payload.url, headers: reply.headers ?? {} },
        } as any
      }
      if (action === 'rawStreamCancel') return { ok: true, result: { ok: true } } as any
      const body = bodies.get(req.payload.streamId) ?? new Uint8Array()
      bodies.set(req.payload.streamId, new Uint8Array())
      return { ok: true, result: { done: true, chunk: body } } as any
    },
  }
  return { transport, opens }
}

async function run(transport: BrowserBridgeTransport, extra: Record<string, unknown> = {}) {
  const host = new DriverStreamHost(transport)
  const { streamId } = host.start(provider(), { messages: [], maxOutputTokens: 1000, ...extra } as never, 'big-1')
  const chunks: any[] = []
  for (let i = 0; i < 50; i += 1) {
    const read = await host.read(streamId, 5000)
    chunks.push(...read.chunks)
    if (read.done) return chunks
  }
  throw new Error('the stream never finished')
}

const bodyOf = (open: Record<string, any>) => JSON.parse(new TextDecoder().decode(open.body))
const errorOf = (chunks: any[]) => chunks.find(c => c.type === 'error')?.error
const textOf = (chunks: any[]) =>
  chunks.filter(c => c.type === 'content_block_delta' && c.delta?.type === 'text_delta').map(c => c.delta.text).join('')
const stops = (chunks: any[]) => chunks.filter(c => c.type === 'message_stop').length

type Script = {
  policy?: ProviderPolicy
  egress?: ProviderEgressTable
  request?: (e: ProviderRequestEvent) => unknown
  classify?: (e: ProviderClassifyEvent) => unknown
  retry?: (e: ProviderRetryEvent) => unknown
  outcome?: (e: ProviderOutcomeEvent) => unknown
  credentials?: ProviderRequestSeam['credentials']
  budgetMs?: number
}

function plug(script: Script) {
  const calls = {
    request: [] as ProviderRequestEvent[],
    classify: [] as ProviderClassifyEvent[],
    retry: [] as ProviderRetryEvent[],
    outcome: [] as ProviderOutcomeEvent[],
    order: [] as string[],
  }
  const seam: ProviderRequestSeam = {
    ...(script.policy ? { policy: script.policy } : {}),
    ...(script.egress ? { egress: script.egress } : {}),
    ...(script.budgetMs !== undefined ? { budgetMs: script.budgetMs } : {}),
    ...(script.credentials ? { credentials: script.credentials } : {}),
    ...(script.request
      ? {
          request: e => {
            calls.request.push(e)
            calls.order.push('request')
            return script.request!(e) as never
          },
        }
      : {}),
    ...(script.classify
      ? {
          classify: e => {
            calls.classify.push(e)
            calls.order.push('classify')
            return script.classify!(e)
          },
        }
      : {}),
    ...(script.retry
      ? {
          retry: e => {
            calls.retry.push(e)
            calls.order.push('retry')
            return script.retry!(e) as never
          },
        }
      : {}),
    ...(script.outcome
      ? {
          outcome: e => {
            calls.outcome.push(e)
            return script.outcome!(e) as never
          },
        }
      : {}),
  }
  registerProviderRequestSeam(PROVIDER_ID, seam)
  return calls
}

afterEach(() => {
  resetProviderRequestSeams()
  setHostPrimitives(undefined)
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const EGRESS: ProviderEgressTable = {
  'pool-a': { url: '{{secret:proxy_a}}', hosts: ['proxy-a.example.com'] },
}

// ── request-plan fields ─────────────────────────────────────────────────────

describe('the plan fields of a request answer', () => {
  it('an answer without them has no plan', () => {
    expect(readRequestPlan({ headers: { a: 'b' }, idleTimeoutMs: 5 })).toBeUndefined()
    expect(readRequestPlan({ limits: {}, timeouts: {} })).toBeUndefined()
  })

  it('a limit is held to what the model row states, else to the platform ceiling', () => {
    expect(readRequestPlan({ limits: { maxOutputTokens: 64_000, contextWindow: 900_000 } }, { maxOutputTokens: 32_000, contextWindow: 200_000 }))
      .toEqual({ limits: { maxOutputTokens: 32_000, contextWindow: 200_000 } })
    expect(readRequestPlan({ limits: { maxOutputTokens: 9_999_999, contextWindow: 99_999_999 } })).toEqual({
      limits: { maxOutputTokens: PLAN_MAX_OUTPUT_TOKENS_CEILING, contextWindow: PLAN_CONTEXT_WINDOW_CEILING },
    })
    expect(readRequestPlan({ limits: { maxOutputTokens: 500 } }, { maxOutputTokens: 32_000 })).toEqual({ limits: { maxOutputTokens: 500 } })
  })

  it('a timeout is held to the bounds of a declared one', () => {
    expect(readRequestPlan({ timeouts: { idleMs: 999_999, firstByteMs: 20_000, stallMs: 5, firstContentMs: 0 } })).toEqual({
      timeouts: { idleMs: STREAM_TIMEOUT_CEILING_MS, firstByteMs: 20_000, stallMs: CONTENT_TIMEOUT_FLOOR_MS, firstContentMs: 0 },
    })
  })

  it.each([
    [{ limits: 5 }, 'limits is not an object'],
    [{ limits: { maxOutputTokens: 0 } }, 'limits.maxOutputTokens is not a whole number'],
    [{ limits: { contextWindow: 1.5 } }, 'limits.contextWindow is not a whole number'],
    [{ limits: { maxTokens: 5 } }, 'limits.maxTokens is not a known property'],
    [{ timeouts: 'fast' }, 'timeouts is not an object'],
    [{ timeouts: { idleMs: -1 } }, 'timeouts.idleMs is not a number'],
    [{ timeouts: { idle: 5 } }, 'timeouts.idle is not a known property'],
    [{ route: 5 }, 'route is not the name of an egress'],
    [{ route: 'pool-a' }, 'route "pool-a" is not an egress this provider declares'],
  ])('refuses %j', (answer, problem) => {
    expect(() => readRequestPlan(answer as Record<string, unknown>)).toThrow(problem)
  })

  it('reads a route as the declared egress of that name', () => {
    expect(readRequestPlan({ route: 'pool-a' }, {}, EGRESS)).toEqual({
      egress: { name: 'pool-a', url: '{{secret:proxy_a}}', hosts: ['proxy-a.example.com'] },
    })
    expect(() => readRequestPlan({ route: 'pool-b' }, {}, EGRESS)).toThrow('route "pool-b" is not an egress this provider declares')
    expect(() => readRequestPlan({ route: 'toString' }, {}, EGRESS)).toThrow('is not an egress this provider declares')
    expect(() => readRequestPlan({ route: '' }, {}, EGRESS)).toThrow('route is not the name of an egress')
  })

  it('a route sends the request through the declared egress, as declared', async () => {
    setHostPrimitives([RAW_STREAM_EGRESS_PRIMITIVE])
    plug({ egress: EGRESS, request: () => ({ route: 'pool-a' }) })
    const { transport, opens } = scripted([])
    const chunks = await run(transport)
    expect(opens).toHaveLength(1)
    expect(opens[0]!.egress).toEqual({ url: '{{secret:proxy_a}}', hosts: ['proxy-a.example.com'] })
    expect(textOf(chunks)).toBe('hi')
  })

  it('no route follows the host setting: nothing about an egress is sent', async () => {
    setHostPrimitives([RAW_STREAM_EGRESS_PRIMITIVE])
    plug({ egress: EGRESS, request: () => ({ headers: { 'x-a': '1' } }) })
    const { transport, opens } = scripted([])
    await run(transport)
    expect(opens[0]).not.toHaveProperty('egress')
  })

  it('a route to an egress the provider does not declare is not sent at all', async () => {
    setHostPrimitives([RAW_STREAM_EGRESS_PRIMITIVE])
    plug({ egress: EGRESS, request: () => ({ route: 'elsewhere' }) })
    const { transport, opens } = scripted([])
    const chunks = await run(transport)
    expect(opens).toEqual([])
    expect(JSON.stringify(errorOf(chunks))).toContain('is not an egress this provider declares')
  })

  it('a host that does not list the primitive is not sent the request', async () => {
    setHostPrimitives(['model.rawStreamOpen.oauth'])
    plug({ egress: EGRESS, request: () => ({ route: 'pool-a' }) })
    const { transport, opens } = scripted([])
    const chunks = await run(transport)
    expect(opens).toEqual([])
    expect(JSON.stringify(errorOf(chunks))).toContain('the request was not sent')
  })

  it('a re-send after a retry keeps the egress', async () => {
    setHostPrimitives([RAW_STREAM_EGRESS_PRIMITIVE])
    plug({
      egress: EGRESS,
      request: () => ({ route: 'pool-a' }),
      retry: () => ({ retry: { headers: { 'x-again': '1' } } }),
    })
    const { transport, opens } = scripted([{ status: 409, body: text('again') }])
    await run(transport)
    expect(opens.length).toBeGreaterThan(1)
    for (const open of opens) {
      expect(open.egress).toEqual({ url: '{{secret:proxy_a}}', hosts: ['proxy-a.example.com'] })
    }
  })

  it('limits.maxOutputTokens builds the request again under the cap; a patch still applies', async () => {
    const calls = plug({ request: () => ({ limits: { maxOutputTokens: 400 }, patch: [{ op: 'set', path: '/n', value: 2 }] }) })
    const { transport, opens } = scripted([])
    const chunks = await run(transport)
    expect(calls.request[0]!.maxOutputTokens).toBe(1000)
    expect(bodyOf(opens[0]!)).toMatchObject({ max: 400, n: 2 })
    expect(textOf(chunks)).toBe('hi')
  })

  it('timeouts in the answer set this request\'s thresholds, within bounds', async () => {
    plug({ request: () => ({ timeouts: { idleMs: 999_999, firstByteMs: 10_000 } }) })
    const { transport, opens } = scripted([])
    await run(transport)
    expect(opens[0]).toMatchObject({ idleTimeoutMs: STREAM_TIMEOUT_CEILING_MS })
  })

  it('idleTimeoutMs alone is the idle threshold, as `timeouts.idleMs` is', async () => {
    plug({ request: () => ({ idleTimeoutMs: 200_000 }) })
    const { transport, opens } = scripted([])
    await run(transport)
    expect(opens[0]).toMatchObject({ idleTimeoutMs: 200_000 })
  })

  it('an answer with none of them sends the request as built, under the 90 s idle', async () => {
    plug({ request: () => ({ headers: { 'x-a': '1' } }) })
    const { transport, opens } = scripted([])
    await run(transport)
    expect(bodyOf(opens[0]!)).toMatchObject({ max: 1000, n: 1 })
    expect(opens[0]!.idleTimeoutMs).toBe(90_000)
  })

  it.each([
    ['a route', { route: 'pool-a' }],
    ['a malformed limit', { limits: { maxOutputTokens: 'lots' } }],
    ['a misspelt timeout', { timeouts: { idleMS: 1000 } }],
  ])('%s fails the request closed: nothing is sent', async (_name, answer) => {
    plug({ request: () => answer })
    const { transport, opens } = scripted([])
    const chunks = await run(transport)
    expect(opens).toHaveLength(0)
    expect(errorOf(chunks).message).toContain('The request hook of the provider acme failed')
  })
})

// ── provider.classify ───────────────────────────────────────────────────────

const MESSAGE = { en: 'Not on the free tier.', 'zh-CN': '免费层不可用。' }
const RULES: ProviderPolicy = {
  errors: [{ match: { status: 403, bodyContains: 'FreeTier' }, kind: 'provider_policy', scope: 'model', retryable: false, code: 'free_tier' }],
  messages: { free: MESSAGE },
}

describe('reading a classify answer', () => {
  it('nothing is an answer of nothing', () => {
    expect(readClassifyAnswer(undefined, undefined)).toEqual({})
    expect(readClassifyAnswer(null, undefined)).toEqual({})
    expect(readClassifyAnswer({}, undefined)).toEqual({})
  })

  it('reads the verdict parts and the replay', () => {
    expect(
      readClassifyAnswer(
        { kind: 'quota', scope: 'account', retryable: false, resetsAt: 5, code: 'c', messageKey: 'free', replay: { effort: 'none', patch: [], headers: { a: 'b' } } },
        RULES.messages,
      ),
    ).toEqual({
      refinement: { kind: 'quota', scope: 'account', retryable: false, resetsAt: 5, code: 'c', message: MESSAGE },
      replay: { effort: 'none', patch: [], headers: { a: 'b' } },
    })
  })

  it.each([
    ['not an object', 'retry please'],
    ['an unknown property', { kind: 'quota', retryAfter: 5 }],
    ['an unknown kind', { kind: 'vendor_special' }],
    ['an unknown scope', { scope: 'planet' }],
    ['a retryable that is no boolean', { retryable: 'yes' }],
    ['a negative resetsAt', { resetsAt: -1 }],
    ['an empty code', { code: '' }],
    ['a messageKey the manifest does not hold', { messageKey: 'missing' }],
    ['free text in place of a key', { message: 'Upstream said no' }],
    ['a replay that is no object', { replay: true }],
    ['a replay with an unknown property', { replay: { body: {} } }],
    ['a replay at an unknown tier', { replay: { effort: 'turbo' } }],
    ['replay headers that are no strings', { replay: { headers: { a: 1 } } }],
  ])('%s is no answer at all', (_name, raw) => {
    expect(readClassifyAnswer(raw, RULES.messages)).toBeUndefined()
  })

  it('an answer that keeps the kind adds to the rule; one that changes it starts from the new kind', () => {
    const declared = { kind: 'provider_policy', scope: 'model', retryable: false, code: 'free_tier' } as const
    expect(refineDeclared(null, declared, { scope: 'account' })).toEqual({ ...declared, scope: 'account' })
    expect(refineDeclared(null, { ...declared, anomaly: 'in_body_error' }, { kind: 'quota', resetsAt: 9 })).toEqual({
      kind: 'quota',
      anomaly: 'in_body_error',
      resetsAt: 9,
    })
    expect(refineDeclared(null, undefined, { retryable: false })).toBeUndefined()
    expect(refineDeclared(null, declared, undefined)).toBe(declared)
  })

  it('a replay is permitted until text or a tool call has been passed on', () => {
    expect(replayPermitted({ reasoning: false, text: false, toolCalls: false })).toBe(true)
    expect(replayPermitted({ reasoning: true, text: false, toolCalls: false })).toBe(true)
    expect(replayPermitted({ reasoning: true, text: true, toolCalls: false })).toBe(false)
    expect(replayPermitted({ reasoning: false, text: false, toolCalls: true })).toBe(false)
  })

  it('names what is odd about an end', () => {
    const tally = (events: DriverStreamEvent[]) => {
      const t = new StreamTally()
      t.note(events)
      return t
    }
    expect(endAnomaly(tally([{ type: 'text_delta', text: 'a' }, { type: 'finish', finishReason: 'stop' }]))).toBeUndefined()
    expect(endAnomaly(tally([{ type: 'tool_call', name: 't' }, { type: 'finish', finishReason: 'tool_calls' }]))).toBeUndefined()
    expect(endAnomaly(tally([{ type: 'text_delta', text: 'a' }, { type: 'finish', finishReason: 'length' }]))).toBeUndefined()
    expect(endAnomaly(tally([{ type: 'reasoning_delta', text: 'a' }, { type: 'finish', finishReason: 'length' }]))).toBe('truncated')
    expect(endAnomaly(tally([{ type: 'text_delta', text: 'a' }]))).toBe('truncated')
    expect(endAnomaly(tally([{ type: 'reasoning_delta', text: 'a' }, { type: 'finish', finishReason: 'stop' }]))).toBe('empty')
    expect(endAnomaly(tally([{ type: 'finish' }]))).toBe('empty')
  })
})

describe('provider.classify on a failed attempt', () => {
  it('sees the verdict after the platform and the rules, and its answer is laid over them', async () => {
    const calls = plug({ policy: RULES, classify: () => ({ scope: 'account', messageKey: 'free' }) })
    const { transport, opens } = scripted([{ status: 403, body: text('{"error":"FreeTier"}'), headers: { 'x-plan': 'free' } }])
    const chunks = await run(transport)
    expect(opens).toHaveLength(1)
    expect(calls.classify).toHaveLength(1)
    expect(calls.classify[0]).toMatchObject({
      provider: PROVIDER_ID,
      model: 'big-1',
      stage: 'response',
      status: 403,
      headers: { 'x-plan': 'free' },
      bodyText: '{"error":"FreeTier"}',
      delivered: { reasoning: false, text: false, toolCalls: false },
      attempt: 1,
      replayed: false,
      // The rule's reading, over the platform's 403.
      verdict: { kind: 'provider_policy', scope: 'model', retryable: false, code: 'free_tier', status: 403 },
    })
    expect(calls.classify[0]!.context.requestId).toEqual(expect.any(String))
    expect(errorOf(chunks)).toMatchObject({
      httpStatus: 403,
      verdict: { kind: 'provider_policy', scope: 'account', retryable: false, code: 'free_tier', message: MESSAGE },
    })
  })

  it('without a rule it sees the platform\'s verdict, and may give the failure a kind of its own', async () => {
    const calls = plug({ classify: () => ({ kind: 'quota', code: 'daily_cap', resetsAt: Date.now() + 60_000 }) })
    const { transport } = scripted([{ status: 429, body: text('slow down') }])
    const chunks = await run(transport)
    expect(calls.classify[0]!.verdict).toMatchObject({ kind: 'rate_limit', retryable: true })
    expect(errorOf(chunks).verdict).toMatchObject({ kind: 'quota', code: 'daily_cap' })
  })

  it('its verdict still passes the platform\'s limits', async () => {
    plug({ classify: () => ({ kind: 'credentials', retryable: true, resetsAt: Date.now() + 5_000, code: 'x'.repeat(64) }) })
    const { transport } = scripted([{ status: 500, body: text('boom') }])
    const error = errorOf(await run(transport))
    const verdict = classifyProviderConnectivityIssue(
      new ProviderApiError(`provider_error: ${error.message}`, { httpStatus: error.httpStatus, declared: error.verdict }),
    )
    expect(verdict).toMatchObject({ kind: 'credentials', retryable: false })
    expect(verdict?.resetsAt).toBeUndefined()
  })

  it('a replay it asks for is sent before the retry hook is asked, changed as it said', async () => {
    const calls = plug({
      classify: e => (e.replayed ? undefined : { replay: { headers: { 'x-replay': '1' }, patch: [{ op: 'set', path: '/n', value: 9 }] } }),
      retry: () => ({ retry: { headers: { 'x-retry': '1' } } }),
    })
    const { transport, opens } = scripted([{ status: 500, body: text('boom') }])
    const chunks = await run(transport)
    expect(opens).toHaveLength(2)
    expect(opens[1]!.headers['x-replay']).toBe('1')
    expect(bodyOf(opens[1]!).n).toBe(9)
    expect(calls.order).toEqual(['classify'])
    expect(textOf(chunks)).toBe('hi')
    expect(errorOf(chunks)).toBeUndefined()
  })

  it('with no replay the retry hook is asked next', async () => {
    const calls = plug({ classify: () => ({ code: 'seen' }), retry: () => ({ retry: { headers: { 'x-retry': '1' } } }) })
    const { transport, opens } = scripted([{ status: 500, body: text('boom') }])
    const chunks = await run(transport)
    expect(calls.order).toEqual(['classify', 'retry'])
    expect(opens[1]!.headers['x-retry']).toBe('1')
    expect(textOf(chunks)).toBe('hi')
  })

  it('a replay that cannot be built leaves the re-send to the retry hook', async () => {
    const calls = plug({
      classify: () => ({ replay: { patch: [{ op: 'set', path: '/missing/deep', value: 1 }] } }),
      retry: () => ({ retry: { headers: { 'x-retry': '1' } } }),
    })
    const { transport, opens } = scripted([{ status: 500, body: text('boom') }])
    const chunks = await run(transport)
    expect(calls.order).toEqual(['classify', 'retry'])
    expect(opens).toHaveLength(2)
    expect(opens[1]!.headers['x-retry']).toBe('1')
    expect(textOf(chunks)).toBe('hi')
  })

  it('a 401 of a provider that refreshes is refreshed first; the hook is not asked about it', async () => {
    let epoch = 1
    const refresh = vi.fn(async () => {
      epoch += 1
      return 'refreshed' as const
    })
    const calls = plug({
      classify: () => ({ replay: { headers: { 'x-replay': '1' } } }),
      credentials: { tokenExpiresAt: () => undefined, epoch: () => epoch, refresh },
    })
    const { transport, opens } = scripted([{ status: 401, body: text('expired') }])
    const chunks = await run(transport)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(calls.classify).toHaveLength(0)
    expect(opens).toHaveLength(2)
    expect(opens[1]!.headers['x-replay']).toBeUndefined()
    expect(textOf(chunks)).toBe('hi')
  })

  it('a request is sent twice at most: a replay asked for after the re-send is ignored', async () => {
    const calls = plug({ classify: () => ({ code: 'again', replay: { headers: { 'x-replay': '1' } } }) })
    const { transport, opens } = scripted([
      { status: 500, body: text('boom') },
      { status: 500, body: text('boom again') },
    ])
    const chunks = await run(transport)
    expect(opens).toHaveLength(2)
    expect(calls.classify.map(e => [e.attempt, e.replayed])).toEqual([[1, false], [2, true]])
    expect(errorOf(chunks)).toMatchObject({ httpStatus: 500, verdict: { kind: 'service', code: 'again' } })
  })

  it('once text has been passed on, a replay is ignored and only the verdict is taken', async () => {
    const calls = plug({ classify: () => ({ kind: 'service', code: 'mid_stream', replay: { effort: 'none' } }) })
    const { transport, opens } = scripted([
      { status: 200, body: lines([{ type: 'text_delta', text: 'half an ans' }, { type: 'error', message: 'overloaded' }]) },
    ])
    const chunks = await run(transport)
    expect(opens).toHaveLength(1)
    expect(calls.classify[0]).toMatchObject({ stage: 'stream', status: 200, finishReason: 'error', delivered: { text: true, toolCalls: false } })
    expect(textOf(chunks)).toBe('half an ans')
    expect(errorOf(chunks).verdict).toMatchObject({ kind: 'service', code: 'mid_stream' })
  })

  it('a tool call still being assembled forbids a replay too', async () => {
    plug({ classify: () => ({ replay: { effort: 'none' } }) })
    const { transport, opens } = scripted([
      { status: 200, body: lines([{ type: 'tool_call_start', id: 't1', name: 'Read' }, { type: 'error', message: 'overloaded' }]) },
    ])
    await run(transport)
    expect(opens).toHaveLength(1)
  })

  it('only reasoning and the output cap: the turn is replayed once with thinking off', async () => {
    const calls = plug({
      request: e => (e.effort === 'none' ? { headers: { 'x-thinking': 'off' } } : undefined),
      classify: e =>
        e.stage === 'end' && e.finishReason === 'max-tokens' && e.delivered.reasoning && !e.delivered.text
          ? { replay: { effort: 'none' } }
          : undefined,
    })
    const { transport, opens } = scripted([
      { status: 200, body: lines([{ type: 'reasoning_delta', text: 'thinking hard' }, { type: 'finish', finishReason: 'length' }]) },
      { status: 200, body: lines([{ type: 'text_delta', text: 'the answer' }, { type: 'finish', finishReason: 'stop' }]) },
    ])
    const chunks = await run(transport, { thinkingTier: 'high' })
    expect(opens).toHaveLength(2)
    expect(bodyOf(opens[0]!).tier).toBe('high')
    // Built again at the new tier, and put to the request hook again so it maps the tier to its wire.
    expect(bodyOf(opens[1]!).tier).toBe('none')
    expect(calls.request.map(e => [e.effort, e.context.attempt])).toEqual([['high', 1], ['none', 2]])
    expect(opens[1]!.headers['x-thinking']).toBe('off')
    expect(calls.classify).toHaveLength(1)
    expect(calls.classify[0]!.verdict).toBeUndefined()
    expect(textOf(chunks)).toBe('the answer')
    expect(errorOf(chunks)).toBeUndefined()
    expect(stops(chunks)).toBe(1)
  })

  it('a 200 whose body is an error the wire does not know is reported as a failure', async () => {
    const calls = plug({
      policy: { messages: { broken: 'The vendor reported an error.' } },
      classify: e => (e.bodyText?.includes('"info":{"error"') ? { kind: 'service', retryable: false, code: 'info_error', messageKey: 'broken' } : undefined),
    })
    const { transport } = scripted([{ status: 200, body: text('{"info":{"error":"quota_exhausted"}}\n') }])
    const chunks = await run(transport)
    expect(calls.classify[0]).toMatchObject({ stage: 'end', status: 200, delivered: { reasoning: false, text: false, toolCalls: false } })
    expect(errorOf(chunks).verdict).toEqual({
      kind: 'service',
      retryable: false,
      code: 'info_error',
      message: 'The vendor reported an error.',
      anomaly: 'truncated',
    })
  })

  it('an odd end the hook says nothing about is passed on as it came', async () => {
    const calls = plug({ classify: () => undefined })
    const { transport } = scripted([{ status: 200, body: lines([{ type: 'reasoning_delta', text: 'hm' }, { type: 'finish', finishReason: 'stop' }]) }])
    const chunks = await run(transport)
    expect(calls.classify[0]).toMatchObject({ stage: 'end', finishReason: 'stop' })
    expect(errorOf(chunks)).toBeUndefined()
    expect(stops(chunks)).toBe(1)
  })

  it('a reply that ended well never raises the hook', async () => {
    const calls = plug({ classify: () => ({ kind: 'service' }) })
    const { transport } = scripted([])
    const chunks = await run(transport)
    expect(calls.classify).toHaveLength(0)
    expect(textOf(chunks)).toBe('hi')
  })

  it('a rule that states an end anomaly makes it a failure without any hook', async () => {
    plug({ policy: { errors: [{ match: { anomaly: 'empty' }, kind: 'service', code: 'empty_reply' }] } })
    const { transport } = scripted([{ status: 200, body: lines([{ type: 'finish', finishReason: 'stop' }]) }])
    expect(errorOf(await run(transport)).verdict).toEqual({ kind: 'service', code: 'empty_reply', anomaly: 'empty' })
  })

  it('a provider with neither a hook nor such a rule has its odd ends passed on untouched', async () => {
    plug({ policy: { errors: [{ match: { status: 403 }, kind: 'billing' }] } })
    const { transport } = scripted([{ status: 200, body: lines([{ type: 'finish', finishReason: 'stop' }]) }])
    const chunks = await run(transport)
    expect(errorOf(chunks)).toBeUndefined()
    expect(stops(chunks)).toBe(1)
  })

  it.each([
    ['throws', () => { throw new Error('bug in the mod') }],
    ['answers a kind the platform does not have', () => ({ kind: 'vendor_special', replay: { effort: 'none' } })],
    ['names a text the manifest does not hold', () => ({ messageKey: 'nope' })],
    ['answers a string', () => 'retry'],
  ])('a hook that %s leaves the verdict as it was and sends nothing again', async (_name, classify) => {
    plug({ policy: RULES, classify })
    const { transport, opens } = scripted([{ status: 403, body: text('{"error":"FreeTier"}') }])
    const chunks = await run(transport)
    expect(opens).toHaveLength(1)
    expect(errorOf(chunks)).toMatchObject({
      httpStatus: 403,
      verdict: { kind: 'provider_policy', scope: 'model', retryable: false, code: 'free_tier' },
    })
  })

  it('a hook that overruns its budget leaves the verdict as it was', async () => {
    plug({ policy: RULES, budgetMs: 20, classify: () => new Promise(() => {}) })
    const { transport, opens } = scripted([{ status: 403, body: text('{"error":"FreeTier"}') }])
    const chunks = await run(transport)
    expect(opens).toHaveLength(1)
    expect(errorOf(chunks).verdict).toEqual({ kind: 'provider_policy', scope: 'model', retryable: false, code: 'free_tier' })
  })

  it('a replay that cannot be built leaves the failure as the hook judged it', async () => {
    plug({ classify: () => ({ code: 'judged', replay: { patch: [{ op: 'set', path: '/a/b/c', value: 1 }] } }) })
    const { transport, opens } = scripted([{ status: 500, body: text('boom') }])
    const chunks = await run(transport)
    expect(opens).toHaveLength(1)
    expect(errorOf(chunks).verdict).toMatchObject({ kind: 'service', code: 'judged' })
  })

  it('the verdict of a failure is the one the turn will make of its error', () => {
    expect(verdictOfFailure({ type: 'error', message: 'HTTP 503: unavailable', httpStatus: 503 })).toMatchObject({ kind: 'service', retryable: true })
    expect(verdictOfFailure({ type: 'error', message: 'something nobody recognises' })).toBeNull()
  })
})

// ── provider.outcome ────────────────────────────────────────────────────────

describe('provider.outcome', () => {
  it('is told of a request that ended well, with what the stream learned', async () => {
    const calls = plug({ outcome: () => undefined })
    const { transport } = scripted([])
    const chunks = await run(transport)
    expect(textOf(chunks)).toBe('hi')
    expect(calls.outcome).toHaveLength(1)
    expect(calls.outcome[0]).toMatchObject({
      provider: PROVIDER_ID,
      model: 'big-1',
      target: { provider: PROVIDER_ID, model: 'big-1' },
      ok: true,
      status: 200,
      finishReason: 'stop',
      usage: { inputTokens: 11, outputTokens: 3, cacheReadTokens: 5 },
      hadReasoning: false,
      hadOutput: true,
      attempts: 1,
    })
    expect(calls.outcome[0]!.verdict).toBeUndefined()
    expect(calls.outcome[0]!.durationMs).toEqual(expect.any(Number))
    expect(calls.outcome[0]!.firstByteMs).toEqual(expect.any(Number))
    expect(calls.outcome[0]!.context).toMatchObject({ attempt: 1, requestId: expect.any(String) })
  })

  it('is told of a request that failed, with its verdict and every send counted', async () => {
    const calls = plug({ retry: () => ({ retry: {} }), outcome: () => undefined })
    const { transport } = scripted([
      { status: 500, body: text('boom') },
      { status: 503, body: text('still down') },
    ])
    await run(transport)
    expect(calls.outcome).toHaveLength(1)
    expect(calls.outcome[0]).toMatchObject({
      ok: false,
      status: 503,
      finishReason: 'error',
      verdict: { kind: 'service', retryable: true, status: 503 },
      hadOutput: false,
      attempts: 2,
    })
  })

  it.each([
    ['throws', () => { throw new Error('bug in the observer') }],
    ['rejects', () => Promise.reject(new Error('later bug'))],
    ['never returns', () => new Promise(() => {})],
  ])('an observer that %s changes nothing about the request', async (_name, outcome) => {
    const calls = plug({ outcome })
    const { transport } = scripted([])
    const chunks = await run(transport)
    expect(calls.outcome).toHaveLength(1)
    expect(textOf(chunks)).toBe('hi')
    expect(errorOf(chunks)).toBeUndefined()
    expect(stops(chunks)).toBe(1)
  })

  it('raising it never throws, whatever the seam does', () => {
    const event = { provider: 'p', model: 'm', target: { provider: 'p', model: 'm' }, ok: true, attempts: 1, durationMs: 1 }
    expect(() => raiseProviderOutcome(undefined, event)).not.toThrow()
    expect(() => raiseProviderOutcome({}, event)).not.toThrow()
    expect(() => raiseProviderOutcome({ get outcome(): never { throw new Error('getter') } }, event)).not.toThrow()
  })

  it('a provider without the hook is told nothing, and nothing is kept for it', async () => {
    const calls = plug({ request: () => undefined })
    const { transport } = scripted([])
    await run(transport)
    expect(calls.outcome).toHaveLength(0)
  })

  it('a stream of a call its caller counts reports to the call and leaves the telling to the caller', async () => {
    const calls = plug({ outcome: () => undefined })
    const call = openOutcomeCall()
    const { transport } = scripted([{ status: 500, body: text('boom') }])
    await run(transport, { [OUTCOME_CALL_FIELD]: call.key })
    expect(calls.outcome).toHaveLength(0)
    const reported = call.close()
    expect(reported.sends).toBe(1)
    expect(reported.last).toMatchObject({ status: 500, hadOutput: false })
    // A stream that ends after its call was closed says nothing: the caller has told the hook.
    await run(scripted([]).transport, { [OUTCOME_CALL_FIELD]: call.key })
    expect(calls.outcome).toHaveLength(0)
    // A mark that is no call's key is no call at all.
    await run(scripted([]).transport, { [OUTCOME_CALL_FIELD]: 'not-a-call' })
    expect(calls.outcome).toHaveLength(1)
  })
})

describe('provider.outcome for a call of the turn', () => {
  function callParams() {
    const toolUseContext = createNoopToolUseContext({
      tools: [],
      platformCapabilities: new NoopPlatformCapabilities(),
      appState: createEmptyAppState(),
      setAppState: () => {},
    })
    const user = {
      type: 'user',
      uuid: 'u-1',
      timestamp: '2026-01-01T00:00:00.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    } as unknown as Message
    return {
      messages: [user],
      baseInstructions: 'test',
      userContext: {},
      systemAmbient: {},
      callContext: toolUseContext,
      querySource: 'test',
      providerId: PROVIDER_ID,
    }
  }

  /** A model transport that answers each stream with the next list of chunks (the last one again once they run out). */
  function modelRoutes(streams: unknown[][]) {
    const payloads: Array<Record<string, unknown>> = []
    const transport = {
      servesModelRoutes: true,
      request: async (req: { route: { action: string }; payload: Record<string, unknown> }) => {
        if (req.route.action === 'streamStart') {
          payloads.push(req.payload)
          return { ok: true as const, result: { streamId: `s${payloads.length}` } }
        }
        if (req.route.action === 'streamRead') {
          const chunks = streams[Math.min(payloads.length, streams.length) - 1]!
          return { ok: true as const, result: { done: true, chunks } }
        }
        if (req.route.action === 'streamCancel') return { ok: true as const, result: { ok: true } }
        return { ok: false as const, error: { code: 'UNEXPECTED', message: `unexpected ${req.route.action}` } }
      },
    }
    return { transport, payloads }
  }

  async function runCall(streams: unknown[][]) {
    const runtimeConfig = new DefaultRuntimeConfig()
    const routes = modelRoutes(streams)
    const deps = assembleTurnDependencies(runtimeConfig, {}, { bridgeTransport: routes.transport as never, runtimeConfig })
    const values: any[] = []
    for await (const value of deps.callModel(callParams() as never) as AsyncGenerator<unknown>) values.push(value)
    return { values, payloads: routes.payloads }
  }

  const SERVICE_ERROR = { type: 'error', error: { type: 'provider_error', message: 'HTTP 503: unavailable', httpStatus: 503 } }

  it('one event for the whole call, after the ladder gave up, with the ladder\'s attempts', async () => {
    const calls = plug({ policy: { retry: { maxRetries: 2, initialDelayMs: 0, maxDelayMs: 0 } }, outcome: () => undefined })
    const { values, payloads } = await runCall([[SERVICE_ERROR]])
    expect(payloads).toHaveLength(3)
    // Every attempt's payload carries the same mark for the stream host.
    expect(new Set(payloads.map(p => p[OUTCOME_CALL_FIELD])).size).toBe(1)
    expect(payloads[0]![OUTCOME_CALL_FIELD]).toEqual(expect.any(String))
    expect(values.find(v => v?.isApiErrorMessage)).toBeDefined()
    expect(calls.outcome).toHaveLength(1)
    expect(calls.outcome[0]).toMatchObject({
      provider: PROVIDER_ID,
      ok: false,
      finishReason: 'error',
      verdict: { kind: 'service', status: 503 },
      attempts: 3,
    })
  })

  it('a call that ends well is told as ok', async () => {
    plug({})
    // The chunks the stream host makes of an ordinary reply.
    const host = new DriverStreamHost(scripted([]).transport)
    const { streamId } = host.start(provider(), { messages: [] } as never, 'big-1')
    const good: unknown[] = []
    for (let i = 0; i < 10; i += 1) {
      const read = await host.read(streamId, 1000)
      good.push(...read.chunks)
      if (read.done) break
    }
    resetProviderRequestSeams()

    const calls = plug({ outcome: () => { throw new Error('an observer bug') } })
    const { values } = await runCall([good])
    expect(values.some(v => v?.type === 'assistant' && !v.isApiErrorMessage)).toBe(true)
    expect(calls.outcome).toHaveLength(1)
    expect(calls.outcome[0]).toMatchObject({ ok: true, attempts: 1 })
    expect(calls.outcome[0]!.verdict).toBeUndefined()
  })

  it('a provider without the hook gets no mark on its payload', async () => {
    plug({ policy: { retry: { maxRetries: 0 } } })
    const { payloads } = await runCall([[SERVICE_ERROR]])
    expect(payloads[0]![OUTCOME_CALL_FIELD]).toBeUndefined()
  })
})

// ── the module side ─────────────────────────────────────────────────────────

describe('the hooks as a provider module\'s events', () => {
  it('provider.classify has 2 s, provider.outcome 1 s, and neither fails a request closed', () => {
    expect(PROVIDER_EVENTS['provider.classify']).toMatchObject({ budgetMs: 2_000, failClosed: false, void: false })
    expect(PROVIDER_EVENTS['provider.outcome']).toMatchObject({ budgetMs: 1_000, failClosed: false, void: true })
    expect(PROVIDER_EVENTS['provider.classify'].accepts(undefined)).toBe(true)
    expect(PROVIDER_EVENTS['provider.classify'].accepts({ kind: 'quota' })).toBe(true)
    expect(PROVIDER_EVENTS['provider.classify'].accepts('retry')).toBe(false)
  })

  function runtimeWith(hooks: Record<string, boolean | undefined>, answer?: (event: string, e: unknown) => unknown) {
    const raised: Array<{ event: string; e: any; options: any }> = []
    const runtime: ProviderSeamRuntime = {
      hasHook: (_id, event) => (event in hooks ? hooks[event] : false),
      whenLoaded: async () => {},
      call: async (_id, event, e, options) => {
        raised.push({ event, e, options })
        return { raised: true, value: (answer ? answer(event, e) : undefined) as never }
      },
    }
    return { runtime, raised }
  }

  it('a module known not to hook them has neither on its seam', () => {
    const seam = createProviderSeam(runtimeWith({}).runtime, 'acme')
    expect(seam.classify).toBeUndefined()
    expect(seam.outcome).toBeUndefined()
  })

  it('classify is raised as provider.classify, and a hook that fails has said nothing', async () => {
    const { runtime, raised } = runtimeWith({ 'provider.classify': true }, () => ({ kind: 'quota' }))
    const seam = createProviderSeam(runtime, 'acme')
    const event = { stage: 'response' } as never
    await expect(seam.classify!(event)).resolves.toEqual({ kind: 'quota' })
    expect(raised[0]).toMatchObject({ event: 'provider.classify', e: { stage: 'response' } })
    expect(raised[0]!.options.core()).toBeUndefined()
  })

  it('outcome is raised only for a module known to hook it', async () => {
    const event = { provider: 'acme', model: 'm', target: { provider: 'acme', model: 'm' }, ok: true, attempts: 1, durationMs: 1 }
    const unknown = runtimeWith({ 'provider.outcome': undefined })
    await createProviderSeam(unknown.runtime, 'acme').outcome!(event)
    expect(unknown.raised).toEqual([])

    const hooked = runtimeWith({ 'provider.outcome': true })
    await createProviderSeam(hooked.runtime, 'acme').outcome!(event)
    expect(hooked.raised[0]).toMatchObject({ event: 'provider.outcome', e: { ok: true, attempts: 1 } })
  })
})
