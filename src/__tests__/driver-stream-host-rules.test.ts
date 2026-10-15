import { describe, expect, it } from 'vitest'
import type { BrowserBridgeTransport } from '../browser/bridge/browserBridgeProtocol'
import '../models/drivers/builtinDrivers'
import { DriverStreamHost } from '../models/drivers/driverStreamHost'
import { parseHostJson } from '../models/drivers/hostValue'
import { createModelProvider } from '../models/drivers/modelProvider'
import { registerProviderDriver } from '../models/drivers/driverRegistry'
import type { DriverStreamEvent, ProviderDriver } from '../models/drivers/driverTypes'
import { classifyProviderConnectivityIssue } from '../utils/providerConnectivity'

// Host-level rules DriverStreamHost applies for every codec — the parts of
// NexusLlmHost that sit between a provider's events and the bridge chunks.

// A codec whose response bytes are newline-separated JSON events.
const jsonLinesCodec: ProviderDriver = {
  id: 'host-rules-lines',
  auth: {},
  buildRequest: (_payload, context) => ({
    url: `${context.baseUrl}/x`,
    headers: {},
    body: new Uint8Array(),
  }),
  createDecoder: () => {
    const text = new TextDecoder()
    let buffered = ''
    const drain = (): DriverStreamEvent[] => {
      const lines = buffered.split('\n')
      buffered = lines.pop() ?? ''
      return lines.filter(Boolean).map(l => JSON.parse(l) as DriverStreamEvent)
    }
    return {
      push: bytes => {
        buffered += text.decode(bytes, { stream: true })
        return drain()
      },
      end: () => {
        buffered += '\n'
        return drain()
      },
    }
  },
  errorFromResponse: ({ status }) => ({ type: 'error', message: `HTTP ${status}`, httpStatus: status }),
}
registerProviderDriver(jsonLinesCodec)

function transportServing(status: number, body: string): BrowserBridgeTransport {
  let served = false
  return {
    async request(req: any) {
      if (req.route.action === 'rawStreamOpen') {
        return {
          ok: true,
          result: { streamId: 'r', status, statusText: '', finalUrl: 'u', headers: {} },
        } as any
      }
      if (req.route.action === 'rawStreamCancel') return { ok: true, result: { ok: true } } as any
      const chunk = served ? new Uint8Array() : new TextEncoder().encode(body)
      served = true
      return { ok: true, result: { done: true, chunk } } as any
    },
  }
}

async function drain(host: DriverStreamHost, streamId: string) {
  const chunks: any[] = []
  for (let i = 0; i < 10; i += 1) {
    const read = await host.read(streamId, 1000)
    chunks.push(...read.chunks)
    if (read.done) return chunks
  }
  throw new Error('stream never finished')
}

const lines = (events: DriverStreamEvent[]) => events.map(e => JSON.stringify(e)).join('\n') + '\n'

describe('DriverStreamHost — NexusLlmHost rules', () => {
  const provider = () =>
    createModelProvider({ id: 'p', format: 'host-rules-lines', baseUrl: 'https://h.example.com' })

  it('every finish carries usage — zeros when the provider reported none (QueueFinishEvent)', async () => {
    const host = new DriverStreamHost(
      transportServing(200, lines([{ type: 'text_delta', text: 'a' }, { type: 'finish', finishReason: 'stop' }])),
    )
    const { streamId } = host.start(provider(), { messages: [] }, 'm')
    const chunks = await drain(host, streamId)
    expect(chunks.find(c => c.type === 'message_delta')).toEqual({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    })
  })

  it('keeps the provider usage when it reported one', async () => {
    const host = new DriverStreamHost(
      transportServing(200, lines([{ type: 'finish', finishReason: 'stop', usage: { promptTokens: 7, completionTokens: 2 } }])),
    )
    const { streamId } = host.start(provider(), { messages: [] }, 'm')
    const chunks = await drain(host, streamId)
    expect(chunks.find(c => c.type === 'message_delta').usage).toMatchObject({ input_tokens: 7, output_tokens: 2 })
  })
})

describe('parseHostJson — base::JSONReader byte-order mark', () => {
  it('skips one leading BOM, as the reader does in every mode', () => {
    expect(parseHostJson('﻿{"a":1}')).toBeDefined()
    expect(parseHostJson('﻿﻿{"a":1}')).toBeUndefined()
    expect(parseHostJson('{"a":1}﻿')).toBeUndefined()
  })
})

// ── With the real codecs ──────────────────────────────────────────────────

function scripted(status: number, reads: Array<{ done: boolean; text?: string; errorCode?: string; errorMessage?: string }>): BrowserBridgeTransport {
  return {
    async request(req: any) {
      if (req.route.action === 'rawStreamOpen') {
        return { ok: true, result: { streamId: 'r', status, statusText: '', finalUrl: 'u', headers: {} } } as any
      }
      if (req.route.action === 'rawStreamCancel') return { ok: true, result: { ok: true } } as any
      const next = reads.shift() ?? { done: true }
      return {
        ok: true,
        result: {
          done: next.done,
          chunk: new TextEncoder().encode(next.text ?? ''),
          ...(next.errorCode ? { errorCode: next.errorCode, errorMessage: next.errorMessage } : {}),
        },
      } as any
    },
  }
}

const payload = { messages: [{ role: 'user', content: 'hi' }] } as any

describe('DriverStreamHost — which statuses stream (per codec, as the C++ providers)', () => {
  it('Anthropic streams only a 200: a proxy 204 is an HTTP error, not an empty turn', async () => {
    const host = new DriverStreamHost(scripted(204, [{ done: true }]))
    const provider = createModelProvider({ id: 'anthropic', format: 'anthropic-messages', baseUrl: 'https://api.anthropic.com' })
    const { streamId } = host.start(provider, payload, 'claude-x')
    const chunks = await drain(host, streamId)
    expect(chunks.map(c => c.type)).toEqual(['message_start', 'error'])
    expect(chunks[1].error).toMatchObject({ message: 'HTTP 204', httpStatus: 204 })
  })

  it('OpenAI chat decodes any status below 400 as the stream', async () => {
    const sse = 'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
    const host = new DriverStreamHost(scripted(203, [{ done: true, text: sse }]))
    const provider = createModelProvider({ id: 'kimi', format: 'openai-chat', baseUrl: 'https://api.example.com/v1' })
    const { streamId } = host.start(provider, payload, 'k3')
    const chunks = await drain(host, streamId)
    expect(chunks.some(c => c.type === 'error')).toBe(false)
    expect(chunks.find(c => c.type === 'content_block_delta').delta.text).toBe('ok')
  })
})

describe('DriverStreamHost — a connection drop after finish_reason (OnStreamComplete)', () => {
  it('OpenAI chat: the buffered finish still ends the turn and no error follows', async () => {
    const sse = 'data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}\n\n'
    const host = new DriverStreamHost(
      scripted(200, [
        { done: false, text: sse },
        { done: true, errorCode: 'NETWORK_ERROR', errorMessage: 'Request failed: net::ERR_CONNECTION_RESET' },
      ]),
    )
    const provider = createModelProvider({ id: 'kimi', format: 'openai-chat', baseUrl: 'https://api.example.com/v1' })
    const { streamId } = host.start(provider, payload, 'k3')
    const chunks = await drain(host, streamId)
    expect(chunks.some(c => c.type === 'error')).toBe(false)
    expect(chunks.find(c => c.type === 'message_delta').delta).toEqual({ stop_reason: 'end_turn' })
    expect(chunks.at(-1)).toEqual({ type: 'message_stop' })
  })

  it('OpenAI chat: a drop before any finish is the network error', async () => {
    const sse = 'data: {"choices":[{"delta":{"content":"part"}}]}\n\n'
    const host = new DriverStreamHost(
      scripted(200, [
        { done: false, text: sse },
        { done: true, errorCode: 'NETWORK_ERROR', errorMessage: 'Request failed: net::ERR_CONNECTION_RESET' },
      ]),
    )
    const provider = createModelProvider({ id: 'kimi', format: 'openai-chat', baseUrl: 'https://api.example.com/v1' })
    const { streamId } = host.start(provider, payload, 'k3')
    const chunks = await drain(host, streamId)
    expect(chunks.at(-1).type).toBe('error')
    // Classified like the C++ "Stream network error (net::ERR = N)": network, retryable.
    expect(chunks.at(-1).error.message).toBe('Stream network error: Request failed: net::ERR_CONNECTION_RESET')
    expect(classifyProviderConnectivityIssue(chunks.at(-1).error.message)).toMatchObject({ kind: 'network', retryable: true })
  })
})

describe('DriverStreamHost - cancel before the response head', () => {
  it('a cancel during the pending open reaches the host and ends the stream with no error chunk', async () => {
    const calls: Array<{ action: string; payload: any }> = []
    const transport: BrowserBridgeTransport = {
      async request(req: any) {
        calls.push({ action: req.route.action, payload: req.payload })
        if (req.route.action === 'rawStreamOpen') {
          // The head never comes; a new host fails the open once the cancel
          // for its id lands.
          return await new Promise<any>(resolve => {
            const timer = setInterval(() => {
              if (calls.some(c => c.action === 'rawStreamCancel' && c.payload.streamId === req.payload.streamId)) {
                clearInterval(timer)
                resolve({ ok: false, error: { code: 'CANCELLED', message: 'cancelled' } })
              }
            }, 1)
          })
        }
        return { ok: true, result: { ok: true } } as any
      },
    }
    const host = new DriverStreamHost(transport)
    const provider = createModelProvider({ id: 'p', format: 'host-rules-lines', baseUrl: 'https://h.example.com' })
    const { streamId } = host.start(provider, { messages: [] } as any, 'm')
    // message_start is queued at once; the next read is held on the open.
    expect((await host.read(streamId, 2000)).chunks.map(c => (c as any).type)).toEqual(['message_start'])
    const reading = host.read(streamId, 2000)
    await host.cancel(streamId)
    const result = await reading
    expect(result.status).toBe('done')
    expect(result.chunks.some(c => (c as any).type === 'error')).toBe(false)
    const openId = calls.find(c => c.action === 'rawStreamOpen')!.payload.streamId
    expect(calls.filter(c => c.action === 'rawStreamCancel').map(c => c.payload.streamId)).toEqual([openId])
  })
})
