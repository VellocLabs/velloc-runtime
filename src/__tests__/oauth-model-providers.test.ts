/**
 * The OAuth providers (chatgpt-pro, github-copilot, qwen-code) on runtime
 * ModelProviders: their catalog wires reproduce the C++ factory's requests
 * (llm_provider_factory.cc) with the host's `{{oauth:NAME}}` placeholders, are
 * served only by a host whose manifest lists `model.rawStreamOpen.oauth`, and
 * chatgpt-pro's one-request-at-a-time cap runs as a runtime FIFO (the
 * same cap the C++ `LlmStreamGuard` enforces).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BrowserBridgeTransport } from '../browser/bridge/browserBridgeProtocol'
import { NEXUS_MODEL_CONFIG } from '../config/nexusModelConfig'
import { resolveDocumentInputMode } from '../config/nexusModelConfig/documentInput'
import { QUEUE_TIMEOUT_MESSAGE, runBlockingCall } from '../models/drivers/blockingCall'
import {
  DriverStreamHost,
  OAUTH_SIGN_IN_MESSAGE,
  queuedDriverStreamCount,
  resetDriverStreamPools,
} from '../models/drivers/driverStreamHost'
import { createModelProvider } from '../models/drivers/modelProvider'
import { SIGN_IN_AGAIN_MESSAGE } from '../models/drivers/providerRequestSeam'
import { classifyProviderConnectivityIssue } from '../utils/providerConnectivity'
import {
  RAW_STREAM_OAUTH_PRIMITIVE,
  registerProviderDriver,
  resolveProviderSpec,
  RAW_STREAM_OAUTH_OPTIONAL_PRIMITIVE,
  setHostPrimitives,
} from '../models/drivers/driverRegistry'
import { publishBrokerProviderBaseUrls } from '../models/endpoints/endpointTrust'
import { withModelProviders } from '../models/drivers/driverTransport'
import '../models/drivers/builtinDrivers'
import type { DriverStreamEvent, ProviderDriver } from '../models/drivers/driverTypes'

const OAUTH_IDS = ['chatgpt-pro', 'github-copilot', 'qwen-code'] as const
const env = (value?: string) =>
  ({ getEnv: (name: string) => (name === 'providerDrivers' ? value : undefined) }) as never
const payload = {
  messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }],
  maxOutputTokens: 1024,
  stopSequences: ['STOP'],
} as never
const text = (body: Uint8Array) => JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>

afterEach(() => {
  setHostPrimitives(undefined)
  publishBrokerProviderBaseUrls([])
  resetDriverStreamPools()
})

describe('the OAuth providers are gated on the host primitive', () => {
  it('are not served on a host that does not list model.rawStreamOpen.oauth (or sent no manifest)', () => {
    for (const id of OAUTH_IDS) expect(resolveProviderSpec(id)).toBeUndefined()
    // An older host: it has the raw stream and secret templates, not OAuth.
    setHostPrimitives(['network.streamOpen', 'network.secretTemplates'])
    for (const id of OAUTH_IDS) expect(resolveProviderSpec(id)).toBeUndefined()
  })

  it('a spec with an optional OAuth value also needs model.rawStreamOpen.oauthOptional', () => {
    // A host with OAuth but not the optional omit: chatgpt-pro's account id
    // would be refused for a token without one.
    setHostPrimitives([RAW_STREAM_OAUTH_PRIMITIVE])
    expect(resolveProviderSpec('chatgpt-pro')).toBeUndefined()
    expect(resolveProviderSpec('github-copilot')).toMatchObject({ format: 'openai-chat' })
    setHostPrimitives([RAW_STREAM_OAUTH_PRIMITIVE, RAW_STREAM_OAUTH_OPTIONAL_PRIMITIVE])
    expect(resolveProviderSpec('chatgpt-pro')).toMatchObject({ format: 'openai-responses' })
  })

  it('run on their ModelProvider once the host lists it', () => {
    setHostPrimitives([RAW_STREAM_OAUTH_PRIMITIVE, RAW_STREAM_OAUTH_OPTIONAL_PRIMITIVE])
    expect(resolveProviderSpec('chatgpt-pro')).toMatchObject({ format: 'openai-responses', maxConcurrentStreams: 1 })
    expect(resolveProviderSpec('github-copilot')).toMatchObject({ format: 'openai-chat' })
    expect(resolveProviderSpec('qwen-code')).toMatchObject({ format: 'openai-chat' })
  })

  it('a per-session OAuth override is gated too, and inherits the catalog cap', () => {
    const override = env(JSON.stringify({
      'chatgpt-pro': { format: 'openai-responses', headers: { Authorization: 'Bearer {{oauth:access_token}}' } },
    }))
    expect(resolveProviderSpec('chatgpt-pro', override)).toBeUndefined()
    setHostPrimitives([RAW_STREAM_OAUTH_PRIMITIVE])
    expect(resolveProviderSpec('chatgpt-pro', override)).toMatchObject({ maxConcurrentStreams: 1 })
  })

  it('an API-key provider never needs the primitive', () => {
    expect(resolveProviderSpec('openai')).toEqual({ id: 'openai', format: 'openai-responses' })
  })
})

describe('requests match the C++ factory\'s', () => {
  beforeEach(() => setHostPrimitives([RAW_STREAM_OAUTH_PRIMITIVE, RAW_STREAM_OAUTH_OPTIONAL_PRIMITIVE]))

  it('chatgpt-pro: the Codex /responses endpoint, the OAuth bearer + account id, the compiled-in headers, the Codex body rules', () => {
    const request = createModelProvider(resolveProviderSpec('chatgpt-pro')!).buildRequest(payload, 'gpt-5.6-terra')
    expect(request.url).toBe('https://chatgpt.com/backend-api/codex/responses')
    expect(request.headers).toEqual({
      Authorization: 'Bearer {{oauth:access_token}}',
      'content-type': 'application/json',
      originator: 'browseros',
      'OpenAI-Beta': 'responses=experimental',
      'ChatGPT-Account-Id': '{{oauth:account_id}}',
    })
    expect(request.queryParams).toBeUndefined()
    const body = text(request.body)
    // BuildResponsesApiRequestBody with IsCodexBackend().
    expect(body).toMatchObject({ model: 'gpt-5.6-terra', stream: true, store: false })
    expect(body.instructions).toBe('You are a helpful assistant.')
    expect(body).not.toHaveProperty('max_output_tokens')
    expect(body).not.toHaveProperty('stop')
  })

  it('github-copilot: chat/completions on api.githubcopilot.com with the Copilot session token and the editor headers', () => {
    const request = createModelProvider(resolveProviderSpec('github-copilot')!).buildRequest(payload, 'gpt-4.1')
    expect(request.url).toBe('https://api.githubcopilot.com/chat/completions')
    expect(request.headers).toEqual({
      Authorization: 'Bearer {{oauth:access_token}}',
      'content-type': 'application/json',
      'Copilot-Integration-Id': 'vscode-chat',
      'Editor-Version': 'vscode/1.96.0',
      'Editor-Plugin-Version': 'copilot-chat/0.23.0',
      'Openai-Intent': 'conversation-edits',
      'x-initiator': 'user',
    })
    expect(text(request.body)).toMatchObject({ model: 'gpt-4.1', stream: true })
  })

  it("qwen-code: chat/completions on the account's resource host (the broker's base URL), else the portal", () => {
    const build = () => createModelProvider(resolveProviderSpec('qwen-code')!).buildRequest(payload, 'qwen3-coder-plus')
    expect(build().url).toBe('https://portal.qwen.ai/v1/chat/completions')
    // SaveTokens writes the token's resource_url into the provider's base_url.
    publishBrokerProviderBaseUrls([{ id: 'qwen-code', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' }])
    const request = build()
    expect(request.url).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions')
    expect(request.headers).toEqual({
      Authorization: 'Bearer {{oauth:access_token}}',
      'content-type': 'application/json',
    })
  })

  it('the catalog entries add nothing the host would read differently: passthrough, no rows, the host default URLs', () => {
    const entry = (id: string) => NEXUS_MODEL_CONFIG.providers.find(p => p.providerId === id)!
    expect(entry('github-copilot')).toMatchObject({ filterMode: 'passthrough', models: [], defaultBaseUrl: 'https://api.githubcopilot.com' })
    expect(entry('qwen-code')).toMatchObject({ filterMode: 'passthrough', models: [], defaultBaseUrl: 'https://portal.qwen.ai/v1' })
    expect(entry('chatgpt-pro').defaultBaseUrl).toBe('https://chatgpt.com/backend-api/codex')
    // PDFs: page images on both chat wires (the table that used to say so
    // outside their directories is gone).
    for (const id of ['github-copilot', 'qwen-code']) {
      expect(entry(id).documentInput).toBe('rasterize')
      expect(resolveDocumentInputMode(undefined, id, 'some-model')).not.toBe('native')
    }
  })
})

// ── Over the transport: what reaches model.rawStreamOpen ──────────────────

type Call = { action: string; payload: any }

/** A host that answers rawStreamOpen per `open`, and every read with one
 *  finished SSE body (`data: [DONE]`-free: the fake codec below decodes JSON
 *  lines). */
function hostTransport(open: (payload: any) => { ok: boolean; result?: unknown; error?: unknown }) {
  const calls: Call[] = []
  const held: Array<() => void> = []
  const transport: BrowserBridgeTransport = {
    async request(req: any) {
      calls.push({ action: req.route.action, payload: req.payload })
      if (req.route.action === 'rawStreamOpen') return { id: req.id, route: req.route, ...open(req.payload) } as any
      if (req.route.action === 'rawStreamCancel') {
        held.splice(0).forEach(release => release())
        return { id: req.id, route: req.route, ok: true, result: { ok: true } } as any
      }
      if (req.route.action === 'rawStreamRead') {
        // Hold every read until the test releases it (finishStreams()).
        await new Promise<void>(resolve => held.push(resolve))
        return {
          id: req.id,
          route: req.route,
          ok: true,
          result: { done: true, chunk: enc([{ type: 'text_delta', text: 'ok' }, { type: 'finish', finishReason: 'stop' }]) },
        } as any
      }
      return { id: req.id, route: req.route, ok: false, error: { code: 'NOT_IMPLEMENTED', message: '' } } as any
    },
  }
  return {
    transport,
    calls,
    opens: () => calls.filter(c => c.action === 'rawStreamOpen'),
    /** Lets the oldest held read finish its stream. */
    finishOne: () => held.shift()?.(),
  }
}
const OPEN_200 = { ok: true, result: { streamId: 'raw-x', status: 200, statusText: 'OK', finalUrl: 'u', headers: {} } }
const enc = (events: DriverStreamEvent[]) =>
  new TextEncoder().encode(events.map(e => JSON.stringify(e)).join('\n') + '\n')
const settle = () => new Promise(resolve => setTimeout(resolve, 5))

describe('withModelProviders: an OAuth turn goes out with the placeholders, never a value', () => {
  beforeEach(() => setHostPrimitives([RAW_STREAM_OAUTH_PRIMITIVE, RAW_STREAM_OAUTH_OPTIONAL_PRIMITIVE]))

  it('streamStart on chatgpt-pro opens a raw stream for chatgpt-pro carrying {{oauth:…}} verbatim', async () => {
    const host = hostTransport(() => OPEN_200)
    const wrapped = withModelProviders(host.transport, env())
    const started = await wrapped.request({
      id: 'r1',
      route: { capability: 'model', action: 'streamStart' },
      payload: { ...(payload as object), providerId: 'chatgpt-pro', model: 'gpt-5.6-terra' },
    } as never) as any
    expect(started.ok).toBe(true)
    await settle()
    const [open] = host.opens()
    expect(open!.payload).toMatchObject({
      providerId: 'chatgpt-pro',
      url: 'https://chatgpt.com/backend-api/codex/responses',
      headers: {
        Authorization: 'Bearer {{oauth:access_token}}',
        'ChatGPT-Account-Id': '{{oauth:account_id}}',
      },
    })
    host.finishOne()
  })

  it('without the primitive the request is refused, never sent with the placeholder text', async () => {
    setHostPrimitives([])
    const host = hostTransport(() => OPEN_200)
    const wrapped = withModelProviders(host.transport, env())
    const response: any = await wrapped.request({
      id: 'r1',
      route: { capability: 'model', action: 'streamStart' },
      payload: { ...(payload as object), providerId: 'qwen-code', model: 'qwen3-coder-plus' },
    } as never)
    expect(response).toMatchObject({ ok: false, error: { code: 'provider_error' } })
    expect(host.calls).toEqual([])
  })
})

describe('a refused OAuth open reads like the C++ path', () => {
  it('OAUTH_UNAVAILABLE (not signed in) becomes the host\'s sign-in sentence', async () => {
    setHostPrimitives([RAW_STREAM_OAUTH_PRIMITIVE])
    const host = hostTransport(() => ({
      ok: false,
      error: { code: 'OAUTH_UNAVAILABLE', message: 'qwen-code is not signed in, or its token could not be refreshed.' },
    }))
    const streams = new DriverStreamHost(host.transport)
    const provider = createModelProvider(resolveProviderSpec('qwen-code')!)
    const { streamId } = streams.start(provider, payload, 'qwen3-coder-plus')
    const chunks: any[] = []
    for (;;) {
      const read = await streams.read(streamId, 1000)
      chunks.push(...read.chunks)
      if (read.done) break
    }
    expect(chunks.map(c => c.type)).toEqual(['message_start', 'error'])
    expect(chunks[1].error.message).toBe(OAUTH_SIGN_IN_MESSAGE)
  })

  it('the sign-in sentences name no internal component and classify as a sign-in problem', () => {
    for (const message of [OAUTH_SIGN_IN_MESSAGE, SIGN_IN_AGAIN_MESSAGE]) {
      expect(message).not.toMatch(/nexus/i)
      expect(classifyProviderConnectivityIssue(`provider_error: ${message}`)).toMatchObject({
        kind: 'credentials',
        error: 'authentication_failed',
        retryable: false,
        settingsRecommended: true,
        detail: message,
      })
    }
  })
})

// ── The concurrency cap (chatgpt-pro: 1) ─────────────────────────────────

const lineCodec: ProviderDriver = {
  id: 'oauth-test-lines',
  auth: {},
  buildRequest: (_payload, context) => ({
    url: `${context.baseUrl}/x`,
    method: 'POST',
    headers: {},
    body: new Uint8Array(),
  }),
  createDecoder: () => {
    let buffered = ''
    const decoder = new TextDecoder()
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
  errorFromResponse: ({ status }) => ({ type: 'error', message: `HTTP ${status}` }),
}
registerProviderDriver(lineCodec)

const capped = (id = 'capped') =>
  createModelProvider({ id, format: 'oauth-test-lines', baseUrl: 'https://h.example.com', maxConcurrentStreams: 1 })

async function readAll(streams: DriverStreamHost, streamId: string) {
  const chunks: any[] = []
  for (let i = 0; i < 50; i += 1) {
    const read = await streams.read(streamId, 1000)
    chunks.push(...read.chunks)
    if (read.done) return chunks
  }
  throw new Error('never finished')
}

describe('maxConcurrentStreams: a FIFO in the runtime, as the C++ LlmStreamGuard caps it', () => {
  it('a second request waits — nothing goes upstream — until the first finishes, across stream hosts', async () => {
    const host = hostTransport(() => OPEN_200)
    // Two hosts = two sessions' transports: the pool is the provider's.
    const a = new DriverStreamHost(host.transport)
    const b = new DriverStreamHost(host.transport)
    const first = a.start(capped(), payload, 'm')
    const second = b.start(capped(), payload, 'm')
    await settle()
    expect(host.opens()).toHaveLength(1)
    expect(queuedDriverStreamCount('capped')).toBe(1)

    // The waiting stream's held read expires as `queued`, keeping its place
    // (no cancel), after the host-side message_start it already has.
    expect((await b.read(second.streamId, 10)).chunks.map(c => c.type)).toEqual(['message_start'])
    expect(await b.read(second.streamId, 10)).toEqual({ chunks: [], done: false, status: 'queued' })
    expect(host.calls.some(c => c.action === 'rawStreamCancel')).toBe(false)
    expect(b.has(second.streamId)).toBe(true)

    host.finishOne()
    expect((await readAll(a, first.streamId)).map(c => c.type)).toContain('message_stop')
    await settle()
    expect(host.opens()).toHaveLength(2)
    host.finishOne()
    expect((await readAll(b, second.streamId)).map(c => c.type)).toContain('message_stop')
    expect(queuedDriverStreamCount('capped')).toBe(0)
  })

  it('a request cancelled while queued never opens and frees nothing it did not hold', async () => {
    const host = hostTransport(() => OPEN_200)
    const streams = new DriverStreamHost(host.transport)
    const first = streams.start(capped(), payload, 'm')
    const second = streams.start(capped(), payload, 'm')
    const third = streams.start(capped(), payload, 'm')
    await settle()
    await streams.cancel(second.streamId)
    expect(queuedDriverStreamCount('capped')).toBe(1)
    host.finishOne()
    await readAll(streams, first.streamId)
    await settle()
    // The third, not the cancelled second, took the slot.
    expect(host.opens()).toHaveLength(2)
    host.finishOne()
    await readAll(streams, third.streamId)
  })

  it('other providers are not held by the cap', async () => {
    const host = hostTransport(() => OPEN_200)
    const streams = new DriverStreamHost(host.transport)
    streams.start(capped(), payload, 'm')
    streams.start(capped('other'), payload, 'm')
    await settle()
    expect(host.opens()).toHaveLength(2)
    host.finishOne()
    host.finishOne()
  })

  it('a blocking call whose deadline runs out in the queue is cancelled with the host queue_timeout error', async () => {
    const host = hostTransport(() => OPEN_200)
    const streams = new DriverStreamHost(host.transport)
    const first = streams.start(capped(), payload, 'm')
    await settle()
    await expect(
      runBlockingCall(streams, capped(), { ...(payload as object), deadlineMs: Date.now() + 30 } as never, 'm'),
    ).rejects.toThrow(QUEUE_TIMEOUT_MESSAGE)
    expect(queuedDriverStreamCount('capped')).toBe(0)
    host.finishOne()
    await readAll(streams, first.streamId)
    await settle()
    expect(host.opens()).toHaveLength(1)
  })
})
