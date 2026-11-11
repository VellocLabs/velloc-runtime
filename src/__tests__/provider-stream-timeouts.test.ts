/**
 * A provider's declared stream timeouts (F-27): the manifest validation of
 * `policy.timeouts` and `policy.messages`, how the thresholds of one send are
 * resolved and bounded, the watchdog, and the stream host under a fake clock.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserBridgeTransport } from '../browser/bridge/browserBridgeProtocol'
import { __test_only_getRouteTimeoutMs } from '../browser/bridge/DirectPortBridgeTransport'
import { createBridgeRoute } from '../browser/bridge/browserBridgeProtocol'
import {
  RAW_STREAM_DECLARED_MAX_IDLE_TIMEOUT_MS,
  RAW_STREAM_MAX_IDLE_TIMEOUT_MS,
} from '../browser/bridge/rawProviderStream'
import { DriverStreamHost } from '../models/drivers/driverStreamHost'
import { registerProviderDriver } from '../models/drivers/driverRegistry'
import { createModelProvider } from '../models/drivers/modelProvider'
import type { DriverStreamEvent, ProviderDriver } from '../models/drivers/driverTypes'
import { verdictOfFailure } from '../models/drivers/providerClassify'
import type { ProviderPolicy } from '../models/drivers/providerPolicy'
import { registerProviderRequestSeam, resetProviderRequestSeams } from '../models/drivers/providerRequestSeam'
import {
  CONTENT_TIMEOUT_FLOOR_MS,
  DEFAULT_IDLE_TIMEOUT_MS,
  STREAM_TIMEOUT_CEILING_MS,
  StreamWatchdog,
  clampTimeouts,
  hostIdleTimeoutMs,
  resolveStreamTimeouts,
  type StreamExpiry,
} from '../models/drivers/providerTimeouts'
import { PROVIDER_WIRE_FORMATS } from '../mods/provider/providerManifest'
import { checkPolicy } from '../mods/provider/providerPolicyManifest'
import { POLICY_MESSAGES_MAX } from '../mods/provider/providerTimeoutsManifest'

/** Three of the wire formats a manifest may name. */
const [CHAT, RESPONSES, , OTHER] = PROVIDER_WIRE_FORMATS as readonly [string, string, string, string]

function policyOf(raw: unknown): { policy: ProviderPolicy | undefined; problems: string[]; warnings: string[] } {
  const problems: string[] = []
  const warnings: string[] = []
  const policy = checkPolicy(raw, message => problems.push(message), PROVIDER_WIRE_FORMATS, message => warnings.push(message))
  return { policy, problems, warnings }
}

describe('policy.timeouts in a manifest', () => {
  it('reads the four thresholds and a table per wire format', () => {
    const { policy, problems } = policyOf({
      timeouts: {
        firstByteMs: 30_000,
        idleMs: 120_000,
        firstContentMs: 90_000,
        stallMs: 0,
        [RESPONSES]: { idleMs: 300_000 },
      },
    })
    expect(problems).toEqual([])
    expect(policy?.timeouts).toEqual({
      firstByteMs: 30_000,
      idleMs: 120_000,
      firstContentMs: 90_000,
      stallMs: 0,
      [RESPONSES]: { idleMs: 300_000 },
    })
  })

  it('holds a threshold to the platform bounds instead of refusing it, and warns of each', () => {
    const { policy, problems, warnings } = policyOf({ timeouts: { idleMs: 900_000, stallMs: 5_000, firstContentMs: 400_000 } })
    expect(problems).toEqual([])
    expect(warnings).toEqual([
      'policy.timeouts.idleMs: 900000 is outside the allowed range; 300000 is used',
      'policy.timeouts.stallMs: 5000 is outside the allowed range; 60000 is used',
      'policy.timeouts.firstContentMs: 400000 is outside the allowed range; 300000 is used',
    ])
    expect(policy?.timeouts).toEqual({
      idleMs: STREAM_TIMEOUT_CEILING_MS,
      stallMs: CONTENT_TIMEOUT_FLOOR_MS,
      firstContentMs: STREAM_TIMEOUT_CEILING_MS,
    })
  })

  it.each([
    [{ timeouts: 5 }, 'policy.timeouts: expected an object'],
    [{ timeouts: { idleMs: '90s' } }, 'policy.timeouts.idleMs: expected a whole number of milliseconds, 1 or more'],
    [{ timeouts: { idleMs: 0 } }, 'policy.timeouts.idleMs: expected a whole number of milliseconds, 1 or more'],
    [{ timeouts: { firstByteMs: 1.5 } }, 'policy.timeouts.firstByteMs: expected a whole number of milliseconds, 1 or more'],
    [{ timeouts: { stallMs: -1 } }, 'policy.timeouts.stallMs: expected a whole number of milliseconds, 0 or more'],
    [{ timeouts: { idelMs: 1000 } }, 'policy.timeouts.idelMs: not a known property'],
    [{ timeouts: { [CHAT]: 5 } }, `policy.timeouts.${CHAT}: expected an object of thresholds`],
    [{ timeouts: { [OTHER]: { idleMs: 1000, [OTHER]: {} } } }, `policy.timeouts.${OTHER}.${OTHER}: not a known property`],
    [{ timeouts: { 'made-up-wire': { idleMs: 1000 } } }, 'policy.timeouts.made-up-wire: not a known property'],
  ])('refuses %j', (raw, problem) => {
    const { problems } = policyOf(raw)
    expect(problems.some(line => line.startsWith(problem))).toBe(true)
  })

  it('a figure within range is taken without a warning', () => {
    expect(policyOf({ timeouts: { idleMs: 120_000, stallMs: 0 } }).warnings).toEqual([])
  })

  it('an empty block states nothing', () => {
    expect(policyOf({ timeouts: {} })).toEqual({ policy: {}, problems: [], warnings: [] })
  })
})

describe('policy.messages in a manifest', () => {
  it('reads texts by key', () => {
    const { policy, problems } = policyOf({ messages: { free_tier: { en: 'Not on the free tier.', 'zh-CN': '免费层不可用。' }, busy: 'Busy.' } })
    expect(problems).toEqual([])
    expect(policy?.messages).toEqual({ free_tier: { en: 'Not on the free tier.', 'zh-CN': '免费层不可用。' }, busy: 'Busy.' })
  })

  it.each([
    [{ messages: [] }, 'policy.messages: expected an object of texts by key'],
    [{ messages: { 'bad key': 'x' } }, 'policy.messages.bad key: a key is'],
    [{ messages: { ok: 5 } }, 'policy.messages.ok'],
  ])('refuses %j', (raw, problem) => {
    const { problems } = policyOf(raw)
    expect(problems.some(line => line.startsWith(problem))).toBe(true)
  })

  it('refuses more texts than the table holds', () => {
    const messages = Object.fromEntries(Array.from({ length: POLICY_MESSAGES_MAX + 1 }, (_, i) => [`k${i}`, 'x']))
    expect(policyOf({ messages }).problems[0]).toContain(`the most is ${POLICY_MESSAGES_MAX}`)
  })
})

describe('the thresholds of one send', () => {
  it('nothing stated anywhere resolves to nothing', () => {
    expect(resolveStreamTimeouts({ format: CHAT })).toBeUndefined()
    expect(resolveStreamTimeouts({ format: CHAT, declared: {}, specIdleMs: 60_000 })).toBeUndefined()
  })

  it('the first-byte threshold defaults to the idle one, and the content ones are off', () => {
    expect(resolveStreamTimeouts({ format: CHAT, declared: { idleMs: 120_000 } })).toEqual({
      firstByteMs: 120_000,
      idleMs: 120_000,
      firstContentMs: 0,
      stallMs: 0,
    })
    expect(resolveStreamTimeouts({ format: CHAT, declared: { firstByteMs: 30_000 } })).toEqual({
      firstByteMs: 30_000,
      idleMs: DEFAULT_IDLE_TIMEOUT_MS,
      firstContentMs: 0,
      stallMs: 0,
    })
  })

  it('the request is over the format table, which is over the provider', () => {
    const declared = { idleMs: 100_000, firstByteMs: 20_000, [RESPONSES]: { idleMs: 200_000 } } as const
    expect(resolveStreamTimeouts({ format: RESPONSES, declared })?.idleMs).toBe(200_000)
    expect(resolveStreamTimeouts({ format: CHAT, declared })?.idleMs).toBe(100_000)
    expect(resolveStreamTimeouts({ format: RESPONSES, declared, request: { idleMs: 250_000 } })).toMatchObject({
      idleMs: 250_000,
      firstByteMs: 20_000,
    })
  })

  it('the hook\'s idleTimeoutMs is the idle threshold, unless `timeouts.idleMs` is answered too', () => {
    expect(resolveStreamTimeouts({ format: OTHER, requestIdleMs: 45_000 })?.idleMs).toBe(45_000)
    expect(resolveStreamTimeouts({ format: OTHER, requestIdleMs: 45_000, request: { idleMs: 50_000 } })?.idleMs).toBe(50_000)
  })

  it('every source is held to the same bounds', () => {
    expect(clampTimeouts({ firstByteMs: 999_999, idleMs: 999_999, firstContentMs: 1, stallMs: 999_999 })).toEqual({
      firstByteMs: STREAM_TIMEOUT_CEILING_MS,
      idleMs: STREAM_TIMEOUT_CEILING_MS,
      firstContentMs: CONTENT_TIMEOUT_FLOOR_MS,
      stallMs: STREAM_TIMEOUT_CEILING_MS,
    })
    expect(clampTimeouts({ firstContentMs: 0, stallMs: 0, idleMs: 0 })).toEqual({ firstContentMs: 0, stallMs: 0 })
    expect(resolveStreamTimeouts({ format: OTHER, request: { stallMs: 10 } })?.stallMs).toBe(CONTENT_TIMEOUT_FLOOR_MS)
    expect(resolveStreamTimeouts({ format: OTHER, requestIdleMs: 10_000_000 })?.idleMs).toBe(STREAM_TIMEOUT_CEILING_MS)
  })

  it('the host gets the longer of the two byte thresholds', () => {
    expect(hostIdleTimeoutMs({ firstByteMs: 30_000, idleMs: 120_000, firstContentMs: 0, stallMs: 0 })).toBe(120_000)
    expect(hostIdleTimeoutMs({ firstByteMs: 200_000, idleMs: 120_000, firstContentMs: 0, stallMs: 0 })).toBe(200_000)
  })

  it('the bridge waits for a response head longer than the longest declared idle', () => {
    expect(RAW_STREAM_DECLARED_MAX_IDLE_TIMEOUT_MS).toBe(STREAM_TIMEOUT_CEILING_MS)
    expect(__test_only_getRouteTimeoutMs(createBridgeRoute('model', 'rawStreamOpen'), 1)).toBeGreaterThan(STREAM_TIMEOUT_CEILING_MS)
    expect(__test_only_getRouteTimeoutMs(createBridgeRoute('model', 'rawStreamRead'), 1)).toBe(100_000)
  })
})

describe('the watchdog', () => {
  afterEach(() => vi.useRealTimers())

  function watch(timeouts: Partial<Record<'firstByteMs' | 'idleMs' | 'firstContentMs' | 'stallMs', number>>) {
    vi.useFakeTimers()
    const fired: StreamExpiry[] = []
    const dog = new StreamWatchdog(
      { firstByteMs: 30_000, idleMs: 120_000, firstContentMs: 0, stallMs: 0, ...timeouts },
      expiry => fired.push(expiry),
    )
    dog.start()
    return { dog, fired }
  }

  it('no response head in time is a first-byte timeout', () => {
    const { fired } = watch({})
    vi.advanceTimersByTime(29_999)
    expect(fired).toEqual([])
    vi.advanceTimersByTime(1)
    expect(fired).toEqual([{ anomaly: 'first_byte_timeout', afterMs: 30_000 }])
  })

  it('any byte resets the idle threshold; silence runs it out', () => {
    const { dog, fired } = watch({})
    dog.head()
    for (let i = 0; i < 10; i += 1) {
      vi.advanceTimersByTime(119_000)
      dog.bytes()
    }
    expect(fired).toEqual([])
    vi.advanceTimersByTime(120_000)
    expect(fired).toEqual([{ anomaly: 'idle_timeout', afterMs: 120_000 }])
  })

  it('the content thresholds do not exist unless stated', () => {
    const { dog, fired } = watch({})
    dog.head()
    for (let i = 0; i < 30; i += 1) {
      vi.advanceTimersByTime(60_000)
      dog.bytes()
    }
    expect(fired).toEqual([])
  })

  it('bytes do not reset a stated content threshold; content does', () => {
    const first = watch({ firstContentMs: 60_000 })
    first.dog.head()
    vi.advanceTimersByTime(30_000)
    first.dog.bytes()
    vi.advanceTimersByTime(30_000)
    expect(first.fired).toEqual([{ anomaly: 'first_content_timeout', afterMs: 60_000 }])

    const stall = watch({ firstContentMs: 60_000, stallMs: 70_000 })
    stall.dog.head()
    vi.advanceTimersByTime(50_000)
    stall.dog.content()
    vi.advanceTimersByTime(60_000)
    stall.dog.bytes()
    stall.dog.content()
    vi.advanceTimersByTime(60_000)
    stall.dog.bytes()
    expect(stall.fired).toEqual([])
    vi.advanceTimersByTime(10_000)
    expect(stall.fired).toEqual([{ anomaly: 'stall_timeout', afterMs: 70_000 }])
  })

  it('fires once, and never after it is stopped', () => {
    const { dog, fired } = watch({ firstContentMs: 60_000 })
    vi.advanceTimersByTime(30_000)
    expect(fired).toHaveLength(1)
    vi.advanceTimersByTime(600_000)
    expect(fired).toHaveLength(1)

    const stopped = watch({})
    stopped.dog.stop()
    vi.advanceTimersByTime(600_000)
    expect(stopped.fired).toEqual([])
    expect(dog).toBeDefined()
  })
})

// ── the stream host under a fake clock ──────────────────────────────────────

const linesCodec: ProviderDriver = {
  id: 'stream-timeouts-lines',
  auth: { headers: {} },
  buildRequest: (_payload, context) => ({
    url: `${context.baseUrl}/v1/chat`,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode('{}'),
  }),
  createDecoder: () => {
    const decoder = new TextDecoder()
    let buffered = ''
    const drain = (): DriverStreamEvent[] => {
      const lines = buffered.split('\n')
      buffered = lines.pop() ?? ''
      // A blank line is this wire's keep-alive: bytes that decode to nothing.
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
  errorFromResponse: ({ status, bodyText }) => ({ type: 'error', message: `HTTP ${status}: ${bodyText}`, httpStatus: status }),
}
registerProviderDriver(linesCodec)

const PROVIDER_ID = 'slowco'
const provider = () => createModelProvider({ id: PROVIDER_ID, format: 'stream-timeouts-lines', baseUrl: 'https://api.slowco.example' })
const bytesOf = (events: DriverStreamEvent[]) => new TextEncoder().encode(events.map(e => JSON.stringify(e)).join('\n') + '\n')
const KEEP_ALIVE = new TextEncoder().encode('\n')

/** A host whose response the test feeds by hand: the open may be held, and each read waits for the next fed chunk. */
function liveHost(options: { holdOpen?: boolean } = {}) {
  const opens: Array<Record<string, any>> = []
  const cancels: string[] = []
  const fed: Array<{ chunk?: Uint8Array; done: boolean }> = []
  let waiting: ((read: { chunk?: Uint8Array; done: boolean }) => void) | undefined
  let releaseOpen: (() => void) | undefined
  let cancelled = false
  const give = (read: { chunk?: Uint8Array; done: boolean }): void => {
    if (waiting) {
      const resolve = waiting
      waiting = undefined
      resolve(read)
    } else fed.push(read)
  }
  const transport: BrowserBridgeTransport = {
    async request(req: any) {
      const action = req.route.action
      if (action === 'rawStreamOpen') {
        opens.push(req.payload)
        if (options.holdOpen) await new Promise<void>(resolve => (releaseOpen = resolve))
        if (cancelled) return { ok: false, error: { code: 'CANCELLED', message: 'cancelled' } } as any
        return { ok: true, result: { streamId: 'live', status: 200, statusText: 'OK', finalUrl: req.payload.url, headers: {} } } as any
      }
      if (action === 'rawStreamCancel') {
        cancels.push(req.payload.streamId)
        cancelled = true
        releaseOpen?.()
        give({ done: false })
        return { ok: true, result: { ok: true } } as any
      }
      const next = fed.shift() ?? (await new Promise<{ chunk?: Uint8Array; done: boolean }>(resolve => (waiting = resolve)))
      return { ok: true, result: next } as any
    },
  }
  return {
    transport,
    opens,
    cancels,
    feed: (chunk: Uint8Array) => give({ chunk, done: false }),
    end: () => give({ done: true }),
  }
}

/** Reads the stream as the engine does, a held read at a time, until it ends. */
function collect(host: DriverStreamHost, streamId: string, waitMs = 60_000) {
  const chunks: any[] = []
  const state = { status: 'open' as 'open' | 'done' | 'timeout' }
  const finished = (async () => {
    for (;;) {
      const read = await host.read(streamId, waitMs)
      chunks.push(...read.chunks)
      if (read.done) return void (state.status = 'done')
      if (read.status === 'timeout') return void (state.status = 'timeout')
    }
  })()
  return { chunks, state, finished }
}

const errorOf = (chunks: any[]) => chunks.find(c => c.type === 'error')?.error
const textOf = (chunks: any[]) =>
  chunks.filter(c => c.type === 'content_block_delta' && c.delta?.type === 'text_delta').map(c => c.delta.text).join('')

async function started(policy: ProviderPolicy | undefined, live: ReturnType<typeof liveHost>, waitMs?: number) {
  resetProviderRequestSeams()
  if (policy) registerProviderRequestSeam(PROVIDER_ID, { policy })
  const host = new DriverStreamHost(live.transport)
  const { streamId } = host.start(provider(), { messages: [] } as never, 'slow-1')
  const reading = collect(host, streamId, waitMs)
  await vi.advanceTimersByTimeAsync(0)
  return reading
}

describe('a stream under declared timeouts', () => {
  afterEach(() => {
    resetProviderRequestSeams()
    vi.useRealTimers()
  })

  const DECLARED: ProviderPolicy = { timeouts: { firstByteMs: 30_000, idleMs: 120_000 } }

  it('keep-alives keep a model that thinks for five minutes alive, and the reply arrives whole', async () => {
    vi.useFakeTimers()
    const live = liveHost()
    const reading = await started(DECLARED, live)
    expect(live.opens[0]).toMatchObject({ idleTimeoutMs: 120_000 })
    for (let minute = 0; minute < 5; minute += 1) {
      await vi.advanceTimersByTimeAsync(60_000)
      live.feed(KEEP_ALIVE)
    }
    await vi.advanceTimersByTimeAsync(60_000)
    // Six minutes in, nothing has cancelled the request.
    expect(live.cancels).toEqual([])
    expect(reading.state.status).toBe('open')
    live.feed(bytesOf([{ type: 'text_delta', text: 'the answer' }, { type: 'finish', finishReason: 'stop' }]))
    live.end()
    await vi.advanceTimersByTimeAsync(0)
    await reading.finished
    expect(reading.state.status).toBe('done')
    expect(errorOf(reading.chunks)).toBeUndefined()
    expect(textOf(reading.chunks)).toBe('the answer')
  })

  it('a held read that runs out does not cancel a watched stream, even with no bytes at all', async () => {
    vi.useFakeTimers()
    const live = liveHost()
    // The engine's hold is 60 s; the provider declared 120 s of silence.
    const reading = await started(DECLARED, live, 60_000)
    await vi.advanceTimersByTimeAsync(110_000)
    expect(reading.state.status).toBe('open')
    expect(live.cancels).toEqual([])
    live.feed(bytesOf([{ type: 'text_delta', text: 'late' }, { type: 'finish', finishReason: 'stop' }]))
    live.end()
    await vi.advanceTimersByTimeAsync(0)
    await reading.finished
    expect(textOf(reading.chunks)).toBe('late')
  })

  it('real silence trips idleMs: the stream is cancelled and fails as a network timeout', async () => {
    vi.useFakeTimers()
    const live = liveHost()
    const reading = await started(DECLARED, live)
    live.feed(KEEP_ALIVE)
    await vi.advanceTimersByTimeAsync(119_000)
    expect(reading.state.status).toBe('open')
    await vi.advanceTimersByTimeAsync(1_000)
    await reading.finished
    expect(live.cancels).toHaveLength(1)
    const error = errorOf(reading.chunks)
    expect(error.verdict).toEqual({ kind: 'network', anomaly: 'idle_timeout' })
    expect(error.message).toContain('timed out')
    // The verdict the turn makes of it: a retryable network failure that names the threshold.
    expect(verdictOfFailure({ type: 'error', message: error.message, verdict: error.verdict })).toMatchObject({
      kind: 'network',
      retryable: true,
      anomaly: 'idle_timeout',
    })
  })

  it('a server that accepts the connection and never answers is cancelled at firstByteMs', async () => {
    vi.useFakeTimers()
    const live = liveHost({ holdOpen: true })
    const reading = await started(DECLARED, live)
    await vi.advanceTimersByTimeAsync(29_000)
    expect(reading.state.status).toBe('open')
    await vi.advanceTimersByTimeAsync(1_000)
    await reading.finished
    expect(live.cancels).toHaveLength(1)
    expect(errorOf(reading.chunks).verdict).toEqual({ kind: 'network', anomaly: 'first_byte_timeout' })
  })

  it('a stated firstContentMs ends a stream that only keeps alive', async () => {
    vi.useFakeTimers()
    const live = liveHost()
    const reading = await started({ timeouts: { idleMs: 120_000, firstContentMs: 90_000 } }, live)
    for (let i = 0; i < 2; i += 1) {
      await vi.advanceTimersByTimeAsync(30_000)
      live.feed(KEEP_ALIVE)
    }
    expect(reading.state.status).toBe('open')
    await vi.advanceTimersByTimeAsync(30_000)
    await reading.finished
    expect(errorOf(reading.chunks).verdict).toEqual({ kind: 'network', anomaly: 'first_content_timeout' })
  })

  it('a stated stallMs ends a stream whose content stops while it keeps alive', async () => {
    vi.useFakeTimers()
    const live = liveHost()
    const reading = await started({ timeouts: { idleMs: 120_000, stallMs: 60_000 } }, live)
    live.feed(bytesOf([{ type: 'reasoning_delta', text: 'hm' }]))
    for (let i = 0; i < 2; i += 1) {
      await vi.advanceTimersByTimeAsync(29_000)
      live.feed(KEEP_ALIVE)
    }
    expect(reading.state.status).toBe('open')
    await vi.advanceTimersByTimeAsync(2_000)
    await reading.finished
    expect(errorOf(reading.chunks).verdict).toEqual({ kind: 'network', anomaly: 'stall_timeout' })
  })

  it('a rule that states the anomaly gives the timeout its verdict', async () => {
    vi.useFakeTimers()
    const live = liveHost()
    const reading = await started(
      {
        timeouts: { idleMs: 60_000 },
        errors: [
          { match: { model: 'slow-' }, kind: 'billing' },
          { match: { anomaly: 'idle_timeout' }, kind: 'service', retryable: false, code: 'gone_quiet' },
        ],
      },
      live,
    )
    await vi.advanceTimersByTimeAsync(60_000)
    await reading.finished
    // The rule without an anomaly is for refused responses; it does not speak to a timeout.
    expect(errorOf(reading.chunks).verdict).toEqual({ kind: 'service', retryable: false, code: 'gone_quiet', anomaly: 'idle_timeout' })
  })

  it('a declared idle above 90 s reaches the host, up to 300 s', async () => {
    vi.useFakeTimers()
    const live = liveHost()
    const reading = await started({ timeouts: { idleMs: 280_000, firstByteMs: 20_000 } }, live)
    expect(live.opens[0]!.idleTimeoutMs).toBe(280_000)
    live.end()
    await vi.advanceTimersByTimeAsync(0)
    await reading.finished
  })
})

describe('a watched send whose watchdog has stopped', () => {
  afterEach(() => {
    resetProviderRequestSeams()
    vi.useRealTimers()
  })

  it('falls back to the held read: a refresh that never answers does not hold the stream open', async () => {
    vi.useFakeTimers()
    const opens: Array<Record<string, any>> = []
    const cancels: string[] = []
    const transport: BrowserBridgeTransport = {
      async request(req: any) {
        const action = req.route.action
        if (action === 'rawStreamOpen') {
          opens.push(req.payload)
          return { ok: true, result: { streamId: 'r1', status: 401, statusText: 'U', finalUrl: req.payload.url, headers: {} } } as any
        }
        if (action === 'rawStreamCancel') {
          cancels.push(req.payload.streamId)
          return { ok: true, result: { ok: true } } as any
        }
        return { ok: true, result: { done: true, chunk: new TextEncoder().encode('expired') } } as any
      },
    }
    resetProviderRequestSeams()
    registerProviderRequestSeam(PROVIDER_ID, {
      policy: { timeouts: { idleMs: 120_000 } },
      credentials: { tokenExpiresAt: () => undefined, epoch: () => 1, refresh: () => new Promise(() => {}) },
    })
    const host = new DriverStreamHost(transport)
    const { streamId } = host.start(provider(), { messages: [] } as never, 'slow-1')
    const reading = collect(host, streamId, 90_000)
    await vi.advanceTimersByTimeAsync(90_000)
    await reading.finished
    expect(opens).toHaveLength(1)
    expect(reading.state.status).toBe('timeout')
  })
})

describe('a provider that declares no timeouts', () => {
  afterEach(() => {
    resetProviderRequestSeams()
    vi.useRealTimers()
  })

  it.each([
    ['without a seam', undefined],
    ['with a policy that states no timeouts', { retry: { maxRetries: 1 } } as ProviderPolicy],
  ])('%s: the host gets the 90 s idle, and a held read that runs out cancels the stream', async (_name, policy) => {
    vi.useFakeTimers()
    const live = liveHost()
    const reading = await started(policy, live, 90_000)
    expect(live.opens[0]!.idleTimeoutMs).toBe(RAW_STREAM_MAX_IDLE_TIMEOUT_MS)
    await vi.advanceTimersByTimeAsync(90_000)
    await reading.finished
    expect(reading.state.status).toBe('timeout')
    expect(live.cancels).toHaveLength(1)
    expect(errorOf(reading.chunks)).toBeUndefined()
  })

  it('keep-alives keep it alive under the 90 s idle', async () => {
    vi.useFakeTimers()
    const live = liveHost()
    const reading = await started(undefined, live, 90_000)
    for (let i = 0; i < 5; i += 1) {
      await vi.advanceTimersByTimeAsync(60_000)
      live.feed(KEEP_ALIVE)
    }
    live.feed(bytesOf([{ type: 'text_delta', text: 'ok' }, { type: 'finish', finishReason: 'stop' }]))
    live.end()
    await vi.advanceTimersByTimeAsync(0)
    await reading.finished
    expect(reading.state.status).toBe('done')
    expect(textOf(reading.chunks)).toBe('ok')
  })
})
