import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserBridgeTransport } from '../browser/bridge/browserBridgeProtocol'
import { DriverChunkEmitter } from '../models/drivers/chunkEmitter'
import { runBlockingCall } from '../models/drivers/blockingCall'
import { DriverStreamHost } from '../models/drivers/driverStreamHost'
import {
  createModelProvider,
  mergeHeaders,
  ProviderConfigError,
} from '../models/drivers/modelProvider'
import {
  isRuntimeOnlyProvider,
  listsModelsInRuntime,
  registerProviderDriver,
  resolveProviderSpec,
  verifiesInRuntime,
} from '../models/drivers/driverRegistry'
import { dataModelListing } from '../config/nexusModelConfig/providers/shared/dataListing'
import { anthropicModels } from '../config/nexusModelConfig/providers/anthropic/models'
import { getProviderDefinition } from '../config/nexusModelConfig/providers'
// The real codecs, for the built-in providers' catalog wires.
import '../models/drivers/builtinDrivers'
import { NEXUS_MODEL_CONFIG } from '../config/nexusModelConfig'
import type {
  DriverStreamEvent,
  ProviderDriver,
} from '../models/drivers/driverTypes'

// ── A fake codec: request = JSON of the payload's model; response bytes are
// newline-separated JSON DriverStreamEvents. ────────────────────────────────
const fakeCodec: ProviderDriver = {
  id: 'fake-format',
  auth: { headers: { authorization: 'Bearer {{secret:api_key}}' } },
  buildRequest: (payload, context) => ({
    url: `${context.baseUrl}/fake/stream`,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer {{secret:api_key}}',
    },
    body: new TextEncoder().encode(JSON.stringify({ model: context.model, n: payload.messages.length })),
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
  errorFromResponse: ({ status, bodyText }) => ({
    type: 'error',
    message: `API Error: ${status} ${bodyText}`,
    httpStatus: status,
  }),
}
registerProviderDriver(fakeCodec)

const enc = (events: DriverStreamEvent[]) =>
  new TextEncoder().encode(events.map(e => JSON.stringify(e)).join('\n') + '\n')

describe('DriverChunkEmitter (port of StreamReadResultToBridge)', () => {
  it('opens text/thinking blocks on demand and closes the open one on a switch', () => {
    const emitter = new DriverChunkEmitter()
    const chunks = emitter.emit([
      { type: 'message_start', model: 'm1', usage: { promptTokens: 3, completionTokens: 0 } },
      { type: 'reasoning_delta', text: 'hmm' },
      { type: 'text_delta', text: 'Hel' },
      { type: 'text_delta', text: 'lo' },
      { type: 'finish', finishReason: 'stop', usage: { promptTokens: 3, completionTokens: 2 } },
    ])
    expect(chunks).toEqual([
      {
        type: 'message_start',
        message: {
          model: 'm1',
          usage: { input_tokens: 3, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hel' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'lo' } },
      { type: 'content_block_stop', index: 1 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
      { type: 'message_stop' },
    ])
    expect(emitter.terminalEmitted).toBe(true)
  })

  it('buffers streamed tool calls and emits them whole, in start order, at finish', () => {
    const emitter = new DriverChunkEmitter()
    const chunks = emitter.emit([
      { type: 'text_delta', text: 'ok' },
      { type: 'tool_call_start', id: 'a', name: 'Read' },
      { type: 'tool_call_start', id: 'b', name: 'Bash' },
      { type: 'tool_call_delta', id: 'b', argsTextDelta: '{"command":' },
      { type: 'tool_call_delta', id: 'a', argsTextDelta: '{"file_path":"x"}' },
      { type: 'tool_call_delta', id: 'b', argsTextDelta: '"ls"}' },
      { type: 'finish', finishReason: 'tool_calls' },
    ])
    const starts = chunks.filter(c => c.type === 'content_block_start')
    expect(starts.map(c => c.content_block)).toEqual([
      { type: 'text', text: '' },
      { type: 'tool-call', toolCallId: 'a', toolName: 'Read', args: { file_path: 'x' } },
      { type: 'tool-call', toolCallId: 'b', toolName: 'Bash', args: { command: 'ls' } },
    ])
    expect(chunks.at(-2)).toEqual({ type: 'message_delta', delta: { stop_reason: 'tool_use' } })
  })

  it('a complete tool_call closes its pending entry; unparsable args stay a string', () => {
    const emitter = new DriverChunkEmitter()
    const chunks = emitter.emit([
      { type: 'tool_call_delta', id: 't', name: 'X', argsTextDelta: '{broken' },
      { type: 'tool_call', id: 't' },
      { type: 'tool_call', id: 'u', name: 'Y', input: { a: 1 } },
      { type: 'finish' },
    ])
    const calls = chunks.filter(c => c.type === 'content_block_start').map(c => c.content_block)
    expect(calls).toEqual([
      { type: 'tool-call', toolCallId: 't', toolName: 'X', args: '{broken' },
      { type: 'tool-call', toolCallId: 'u', toolName: 'Y', args: { a: 1 } },
    ])
    // No finish reason and no usage → no message_delta, just the stop.
    expect(chunks.at(-1)).toEqual({ type: 'message_stop' })
    expect(chunks.some(c => c.type === 'message_delta')).toBe(false)
  })

  it('maps finish reasons like FinishReasonToStopReason and carries stop_details', () => {
    const cases: Array<[DriverStreamEvent & { type: 'finish' }, string]> = [
      [{ type: 'finish', finishReason: 'length' }, 'max_tokens'],
      [{ type: 'finish', finishReason: 'content_filter' }, 'content_filter'],
      [{ type: 'finish', finishReason: 'error' }, 'error'],
      [{ type: 'finish', finishReason: 'other' }, 'end_turn'],
      [{ type: 'finish', finishReason: 'unknown' }, 'end_turn'],
    ]
    for (const [event, stop] of cases) {
      const delta = new DriverChunkEmitter().emit([event])[0]
      expect(delta).toEqual({ type: 'message_delta', delta: { stop_reason: stop } })
    }
    const withDetails = new DriverChunkEmitter().emit([
      { type: 'finish', finishReason: 'stop', stopDetails: { type: 'refusal' } },
    ])[0]
    expect(withDetails).toEqual({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_details: { type: 'refusal' } },
    })
  })

  it('an error closes the open block, is terminal, and carries the typed fields', () => {
    const emitter = new DriverChunkEmitter()
    const chunks = emitter.emit([
      { type: 'text_delta', text: 'par' },
      { type: 'error', message: 'API Error: 429 slow down', httpStatus: 429, retryAfterSeconds: 7 },
      { type: 'text_delta', text: 'ignored' },
      { type: 'finish', finishReason: 'stop' },
    ])
    expect(chunks).toHaveLength(4)
    expect(chunks.slice(2, 4)).toEqual([
      { type: 'content_block_stop', index: 0 },
      {
        type: 'error',
        error: { type: 'provider_error', message: 'API Error: 429 slow down', httpStatus: 429, retryAfterSeconds: 7 },
      },
    ])
    expect(emitter.terminalEmitted).toBe(true)
  })

  it('finalizeIfOpen closes a stream that ended without finish', () => {
    const emitter = new DriverChunkEmitter()
    emitter.emit([{ type: 'text_delta', text: 'x' }])
    expect(emitter.finalizeIfOpen()).toEqual([
      { type: 'content_block_stop', index: 0 },
      { type: 'message_stop' },
    ])
    expect(emitter.finalizeIfOpen()).toEqual([])
  })
})

// nexus_llm_bridge_support_unittest.cc.
describe('DriverChunkEmitter — reasoning signature, errors, tool-call args', () => {
  const blockDeltas = (chunks: ReturnType<DriverChunkEmitter['emit']>) =>
    chunks.filter(c => c.type === 'content_block_delta').map(c => [c.index, c.delta] as const)

  it('StreamReadResultPutsReasoningSignatureOnThinkingBlock', () => {
    const chunks = new DriverChunkEmitter().emit([
      { type: 'reasoning_delta', text: 'weigh it' },
      { type: 'text_delta', text: 'Pick B.' },
      { type: 'reasoning_signature', signature: 'velloc-replay-v1:{}' },
    ])
    expect(blockDeltas(chunks)).toEqual([
      [0, { type: 'thinking_delta', thinking: 'weigh it' }],
      [1, { type: 'text_delta', text: 'Pick B.' }],
      // Back on the (closed) thinking block — not the text block, not a new one.
      [0, { type: 'signature_delta', signature: 'velloc-replay-v1:{}' }],
    ])
    expect(chunks.filter(c => c.type === 'content_block_start')).toHaveLength(2)
  })

  it('StreamReadResultOpensThinkingBlockForBareReasoningSignature', () => {
    const emitter = new DriverChunkEmitter()
    const chunks = emitter.emit([{ type: 'reasoning_signature', signature: 'velloc-replay-v1:{}' }])
    expect(chunks).toEqual([
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'velloc-replay-v1:{}' } },
    ])
    // The opened block is the open one: later reasoning continues it.
    expect(emitter.emit([{ type: 'reasoning_delta', text: 'x' }])).toEqual([
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'x' } },
    ])
  })

  it('an empty signature emits nothing', () => {
    expect(new DriverChunkEmitter().emit([{ type: 'reasoning_signature', signature: '' }])).toEqual([])
  })

  it('an empty error message passes through as "" (value_or only fills an absent one)', () => {
    const [empty] = new DriverChunkEmitter().emit([{ type: 'error', message: '' }])
    expect(empty).toEqual({ type: 'error', error: { type: 'provider_error', message: '' } })
    const [absent] = new DriverChunkEmitter().emit([{ type: 'error' } as never])
    expect(absent).toEqual({ type: 'error', error: { type: 'provider_error', message: 'Unknown LLM stream error' } })
  })

  it('tool-call args parse with the host RFC reader (ParseJsonStringOrReturnString)', () => {
    const argsOf = (argsText: string) => {
      const chunks = new DriverChunkEmitter().emit([
        { type: 'tool_call_delta', id: 't', name: 'X', argsTextDelta: argsText },
        { type: 'finish' },
      ])
      return chunks.find(c => c.type === 'content_block_start')!.content_block!.args
    }
    // JSON.parse would accept all three; base::JSONReader (RFC) rejects the
    // first two and drops the BOM of the third.
    expect(argsOf('"\\ud800"')).toBe('"\\ud800"')
    expect(argsOf('1e999')).toBe('1e999')
    expect(argsOf('﻿{"a":1}')).toEqual({ a: 1 })
    expect(argsOf('{"b":2.0,"a":[1]}')).toEqual({ a: [1], b: 2 })
  })

  it('a repeated tool_call_start with the same id keeps the bridge entry (the host layer resets)', () => {
    // StreamReadResultToBridge kToolCallStart: insert only when absent. The
    // host's reset reaches the bridge as the closing tool_call's input
    // (HostToolCallTracker) — without one, the bridge concatenates.
    const chunks = new DriverChunkEmitter().emit([
      { type: 'tool_call_start', id: 'a', name: 'Read' },
      { type: 'tool_call_delta', id: 'a', argsTextDelta: '{"x":' },
      { type: 'tool_call_start', id: 'a' },
      { type: 'tool_call_delta', id: 'a', argsTextDelta: '1}' },
      { type: 'finish' },
    ])
    expect(chunks.filter(c => c.type === 'content_block_start').map(c => c.content_block)).toEqual([
      { type: 'tool-call', toolCallId: 'a', toolName: 'Read', args: { x: 1 } },
    ])
  })
})

describe('ModelProvider (spec over codec)', () => {
  it('merges headers case-insensitively; an empty value removes', () => {
    expect(
      mergeHeaders(
        { 'Content-Type': 'application/json', authorization: 'Bearer {{secret:api_key}}' },
        { 'content-type': 'application/x', Authorization: '', 'x-goog-api-key': '{{secret:api_key}}' },
      ),
    ).toEqual({ 'content-type': 'application/x', 'x-goog-api-key': '{{secret:api_key}}' })
  })

  it('applies base URL, path, User-Agent, headers and query params over the codec', () => {
    const provider = createModelProvider({
      id: 'relay',
      format: 'fake-format',
      baseUrl: 'https://relay.example.com/api/',
      path: '/v1/stream',
      userAgent: 'MyAgent/1.0',
      headers: { 'x-team': 'core', authorization: 'Token {{secret:relay_key}}' },
      queryParams: { key: '{{secret:api_key}}' },
    })
    expect(provider.id).toBe('relay')
    expect(provider.format).toBe('fake-format')
    const request = provider.buildRequest({ messages: [] }, 'm-1')
    expect(request.url).toBe('https://relay.example.com/api/v1/stream')
    expect(request.headers).toEqual({
      'content-type': 'application/json',
      authorization: 'Token {{secret:relay_key}}',
      'user-agent': 'MyAgent/1.0',
      'x-team': 'core',
    })
    expect(request.queryParams).toEqual({ key: '{{secret:api_key}}' })
    expect(JSON.parse(new TextDecoder().decode(request.body))).toEqual({ model: 'm-1', n: 0 })
  })

  it('keeps the codec URL when the spec sets no path', () => {
    const provider = createModelProvider({ id: 'p', format: 'fake-format', baseUrl: 'https://h.example.com' })
    expect(provider.buildRequest({ messages: [] }, 'm').url).toBe('https://h.example.com/fake/stream')
  })

  it('refuses an unknown format or a provider with no base URL', () => {
    expect(() => createModelProvider({ id: 'p', format: 'nope', baseUrl: 'https://h' })).toThrow(ProviderConfigError)
    expect(() => createModelProvider({ id: 'no-such-provider-xyz', format: 'fake-format' })).toThrow(/no base URL/)
  })
})

describe('resolveProviderSpec', () => {
  const env = (value?: string) => ({ getEnv: (name: string) => (name === 'providerDrivers' ? value : undefined) }) as never

  it('reads the per-session override: shorthand or full spec', () => {
    const config = env(JSON.stringify({
      a: 'fake-format',
      b: { format: 'fake-format', userAgent: 'UA', headers: { x: '1' } },
    }))
    expect(resolveProviderSpec('a', config)).toEqual({ id: 'a', format: 'fake-format' })
    expect(resolveProviderSpec('b', config)).toEqual({
      id: 'b', format: 'fake-format', userAgent: 'UA', headers: { x: '1' },
    })
  })

  it('falls back to the native path for unknown formats, bad JSON or no config', () => {
    expect(resolveProviderSpec('a', env(JSON.stringify({ a: 'not-registered' })))).toBeUndefined()
    expect(resolveProviderSpec('a', env('{not json'))).toBeUndefined()
    expect(resolveProviderSpec('a', env())).toBeUndefined()
    expect(resolveProviderSpec(undefined, env('{"a":"fake-format"}'))).toBeUndefined()
  })
})

describe('built-in providers run on a ModelProvider', () => {
  const env = (value?: string) => ({ getEnv: (name: string) => (name === 'providerDrivers' ? value : undefined) }) as never
  const payload = { messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }] } as never

  it('openai, anthropic and kimi resolve to the codec their host class speaks', () => {
    expect(resolveProviderSpec('openai')).toEqual({ id: 'openai', format: 'openai-responses' })
    expect(resolveProviderSpec('anthropic')).toEqual({ id: 'anthropic', format: 'anthropic-messages' })
    expect(resolveProviderSpec('kimi')).toEqual({ id: 'kimi', format: 'openai-chat' })
  })

  it('google runs on the Gemini codec: the model in the path, the key in the x-goog-api-key header', () => {
    expect(resolveProviderSpec('google')).toEqual({ id: 'google', format: 'gemini' })
    const request = createModelProvider(resolveProviderSpec('google')!).buildRequest(payload, 'gemini-3.6-flash')
    expect(request).toMatchObject({
      url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:streamGenerateContent?alt=sse',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': '{{secret:api_key}}' },
    })
    expect(request.queryParams).toBeUndefined()
    expect(Object.keys(request.headers).map(h => h.toLowerCase())).not.toContain('authorization')
  })

  it('the OpenAI-compatible chat providers (the host built each as an OpenAiProvider on chat/completions) reuse the chat codec', () => {
    const expected: Record<string, string> = {
      deepseek: 'https://api.deepseek.com/chat/completions',
      glm: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
      minimax: 'https://api.minimax.io/v1/chat/completions',
      qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    }
    for (const [id, url] of Object.entries(expected)) {
      expect(resolveProviderSpec(id)).toEqual({ id, format: 'openai-chat' })
      // OpenAiProvider::StartStream: base + "/chat/completions", bearer key.
      expect(createModelProvider(resolveProviderSpec(id)!).buildRequest(payload, 'm')).toMatchObject({
        url,
        headers: { authorization: 'Bearer {{secret:api_key}}', 'content-type': 'application/json' },
      })
    }
  })

  it('their requests reach the catalog default endpoint with the codec auth', () => {
    const request = (id: string) => createModelProvider(resolveProviderSpec(id)!).buildRequest(payload, 'm')
    expect(request('openai')).toMatchObject({
      url: 'https://api.openai.com/v1/responses',
      headers: { authorization: 'Bearer {{secret:api_key}}' },
    })
    expect(request('kimi')).toMatchObject({
      url: 'https://api.kimi.com/coding/v1/chat/completions',
      headers: { authorization: 'Bearer {{secret:api_key}}' },
    })
    expect(request('anthropic')).toMatchObject({
      url: 'https://api.anthropic.com/v1/messages',
      headers: { 'x-api-key': '{{secret:api_key}}' },
    })
  })

  it('they list their models and verify keys in the runtime, yet are not runtime-only', () => {
    for (const id of ['openai', 'anthropic', 'kimi']) {
      expect(listsModelsInRuntime(id)).toBe(true)
      expect(verifiesInRuntime(id)).toBe(true)
      expect(isRuntimeOnlyProvider(id)).toBe(false)
    }
    for (const id of ['openrouter', 'vercel-ai-gateway']) {
      expect(isRuntimeOnlyProvider(id)).toBe(true)
      expect(verifiesInRuntime(id)).toBe(true)
    }
    // Still on the host class: its discovery and key probe stay native.
    expect(listsModelsInRuntime('google')).toBe(false)
    expect(verifiesInRuntime('google')).toBe(false)
  })

  it('the shared data[] listing reads ids and display names, as the host discovery did', () => {
    const listing = dataModelListing('/v1/models')
    expect(listing.public).toBeUndefined()
    expect(listing.parse({
      data: [
        { id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5' },
        { id: 'gpt-6-astra', object: 'model' },
        { id: 7 },
        'junk',
      ],
    }, 0)).toEqual([
      { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', supportsTools: true },
      { id: 'gpt-6-astra', supportsTools: true },
    ])
    expect(() => listing.parse({ models: [] }, 0)).toThrow('no data array')
  })

  it('the Anthropic listing reads limits, effort levels and image input (docs shape)', () => {
    const effort = (levels: Record<string, boolean | null>) => ({
      supported: true,
      ...Object.fromEntries(Object.entries(levels).map(([k, v]) => [k, v === null ? null : { supported: v }])),
    })
    expect(anthropicModels.parse({
      data: [
        {
          id: 'claude-opus-5-5',
          display_name: 'Claude Opus 5.5',
          max_input_tokens: 1_000_000,
          max_tokens: 128_000,
          capabilities: {
            effort: effort({ low: true, medium: true, high: true, xhigh: true, max: true }),
            image_input: { supported: true },
            pdf_input: { supported: true },
          },
        },
        {
          // `xhigh: null` and an unsupported level are not tiers.
          id: 'claude-opus-4-6',
          display_name: 'Claude Opus 4.6',
          max_input_tokens: 200_000,
          max_tokens: 64_000,
          capabilities: { effort: effort({ low: true, medium: true, high: true, xhigh: null, max: false }) },
        },
        {
          // No effort control and zero limits: nothing stated.
          id: 'claude-haiku-4-5',
          max_input_tokens: 0,
          max_tokens: null,
          capabilities: { effort: { supported: false, low: { supported: false } }, image_input: { supported: false } },
        },
        { id: 'claude-bare' },
      ],
    }, 0)).toEqual([
      {
        id: 'claude-opus-5-5',
        name: 'Claude Opus 5.5',
        supportsTools: true,
        contextWindow: 1_000_000,
        maxOutputTokens: 128_000,
        supportsImageInput: true,
        supportsPdfInput: true,
        thinkingTiers: ['low', 'medium', 'high', 'extra-high', 'max'],
      },
      {
        id: 'claude-opus-4-6',
        name: 'Claude Opus 4.6',
        supportsTools: true,
        contextWindow: 200_000,
        maxOutputTokens: 64_000,
        thinkingTiers: ['low', 'medium', 'high'],
      },
      { id: 'claude-haiku-4-5', supportsTools: true, supportsImageInput: false },
      { id: 'claude-bare', supportsTools: true },
    ])
    expect(getProviderDefinition('anthropic')?.models).toBe(anthropicModels)
  })

  it('an override naming a format with no codec leaves the provider unserved (no host fallback)', () => {
    // The host's native classes were removed: `native` is just
    // an unknown format now, and only the named provider is affected.
    const config = env(JSON.stringify({ kimi: 'native' }))
    expect(resolveProviderSpec('kimi', config)).toBeUndefined()
    expect(resolveProviderSpec('openai', config)).toEqual({ id: 'openai', format: 'openai-responses' })
  })

  it("the catalog's stream idle timeout becomes the spec's no-bytes abort; a wire's own wins", () => {
    const entry = NEXUS_MODEL_CONFIG.providers.find(p => p.providerId === 'kimi')!
    const saved = { seconds: entry.streamIdleTimeoutSeconds, wire: entry.wire }
    try {
      entry.streamIdleTimeoutSeconds = 120
      expect(resolveProviderSpec('kimi')).toEqual({ id: 'kimi', format: 'openai-chat', idleTimeoutMs: 120_000 })
      entry.wire = { format: 'openai-chat', idleTimeoutMs: 5_000 }
      expect(resolveProviderSpec('kimi')?.idleTimeoutMs).toBe(5_000)
    } finally {
      entry.streamIdleTimeoutSeconds = saved.seconds
      entry.wire = saved.wire
    }
    expect(resolveProviderSpec('kimi')).toEqual({ id: 'kimi', format: 'openai-chat' })
  })
})

// ── DriverStreamHost over a scripted rawStream host ──────────────────────
type Script = {
  open: { ok: true; result: any } | { ok: false; error: { code: string; message: string } }
  reads: Array<{ done: boolean; chunk: Uint8Array; errorCode?: string; errorMessage?: string }>
}
function scriptedTransport(script: Script) {
  const calls: Array<{ action: string; payload: any }> = []
  let pendingRead: ((value: unknown) => void) | undefined
  const transport: BrowserBridgeTransport = {
    async request(req: any) {
      calls.push({ action: req.route.action, payload: req.payload })
      if (req.route.action === 'rawStreamOpen') return script.open as any
      if (req.route.action === 'rawStreamCancel') {
        pendingRead?.({ ok: true, result: { done: true, chunk: new Uint8Array(), errorCode: 'CANCELLED' } })
        return { ok: true, result: { ok: true } } as any
      }
      const next = script.reads.shift()
      if (next) return { ok: true, result: next } as any
      // Nothing scripted: hold the read like a silent upstream.
      return new Promise(resolve => {
        pendingRead = resolve
      }) as any
    },
  }
  return { transport, calls }
}
const OPEN_200 = {
  ok: true as const,
  result: { streamId: 'raw-1', status: 200, statusText: 'OK', finalUrl: 'u', headers: {} },
}
const provider = () => createModelProvider({ id: 'p', format: 'fake-format', baseUrl: 'https://h.example.com' })

async function drain(host: DriverStreamHost, streamId: string) {
  const all: any[] = []
  for (let i = 0; i < 20; i += 1) {
    const read = await host.read(streamId, 1000)
    all.push(...read.chunks)
    if (read.done) return { chunks: all, last: read }
  }
  throw new Error('stream never finished')
}

describe('DriverStreamHost', () => {
  afterEach(() => vi.useRealTimers())

  it('serves a whole stream with the host shapes and forgets it when done', async () => {
    const { transport, calls } = scriptedTransport({
      open: OPEN_200,
      reads: [
        { done: false, chunk: enc([{ type: 'message_start', model: 'm' }, { type: 'text_delta', text: 'Hi' }]) },
        { done: true, chunk: enc([{ type: 'finish', finishReason: 'stop' }]) },
      ],
    })
    const host = new DriverStreamHost(transport)
    const { streamId } = host.start(provider(), { messages: [] }, 'm')
    const { chunks, last } = await drain(host, streamId)
    expect(last).toMatchObject({ done: true, status: 'done' })
    // The host-side message_start (model only) first, then the codec's.
    expect(chunks.map(c => c.type)).toEqual([
      'message_start', 'message_start', 'content_block_start', 'content_block_delta',
      'content_block_stop', 'message_delta', 'message_stop',
    ])
    expect(chunks[0]).toEqual({ type: 'message_start', message: { model: 'm' } })
    expect(host.has(streamId)).toBe(false)
    const open = calls.find(c => c.action === 'rawStreamOpen')!
    expect(open.payload.providerId).toBe('p')
    expect(open.payload.url).toBe('https://h.example.com/fake/stream')
    expect(open.payload.headers.authorization).toBe('Bearer {{secret:api_key}}')
  })

  it('turns a non-2xx response into the codec error chunk', async () => {
    const { transport } = scriptedTransport({
      open: { ok: true, result: { ...OPEN_200.result, status: 401, statusText: 'Unauthorized' } },
      reads: [{ done: true, chunk: new TextEncoder().encode('bad key') }],
    })
    const host = new DriverStreamHost(transport)
    const { streamId } = host.start(provider(), { messages: [] }, 'm')
    const { chunks } = await drain(host, streamId)
    // message_start precedes even an HTTP error, as on the host.
    expect(chunks).toEqual([
      { type: 'message_start', message: { model: 'm' } },
      { type: 'error', error: { type: 'provider_error', message: 'API Error: 401 bad key', httpStatus: 401 } },
    ])
  })

  it('reports a refused open (e.g. an older host) as an error chunk, not a throw', async () => {
    const { transport } = scriptedTransport({
      open: { ok: false, error: { code: 'TARGET_NOT_ALLOWED', message: 'outside domain' } },
      reads: [],
    })
    const host = new DriverStreamHost(transport)
    const { streamId } = host.start(provider(), { messages: [] }, 'm')
    const { chunks } = await drain(host, streamId)
    expect(chunks.map(c => c.type)).toEqual(['message_start', 'error'])
    expect(chunks[1].error.message).toContain('TARGET_NOT_ALLOWED')
  })

  it('a transport error mid-stream ends with an error chunk after the delivered text', async () => {
    const { transport } = scriptedTransport({
      open: OPEN_200,
      reads: [
        { done: false, chunk: enc([{ type: 'text_delta', text: 'part' }]) },
        { done: true, chunk: new Uint8Array(), errorCode: 'NETWORK_ERROR', errorMessage: 'reset' },
      ],
    })
    const host = new DriverStreamHost(transport)
    const { streamId } = host.start(provider(), { messages: [] }, 'm')
    const { chunks } = await drain(host, streamId)
    expect(chunks.map(c => c.type)).toEqual([
      'message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'error',
    ])
    // Worded like the C++ provider (the card shows it), not the transport code.
    expect(chunks.at(-1).error.message).toBe('Stream network error: reset')
  })

  it('a held read that expires returns timeout and cancels upstream, like the host', async () => {
    const { transport, calls } = scriptedTransport({ open: OPEN_200, reads: [] })
    const host = new DriverStreamHost(transport)
    const { streamId } = host.start(provider(), { messages: [] }, 'm')
    const first = await host.read(streamId, 30)
    expect(first.chunks.map(c => c.type)).toEqual(['message_start'])
    const read = await host.read(streamId, 30)
    expect(read).toEqual({ chunks: [], done: false, status: 'timeout' })
    expect(calls.some(c => c.action === 'rawStreamCancel')).toBe(true)
    expect(host.has(streamId)).toBe(false)
  })

  it('cancel closes upstream and forgets the stream; unknown ids throw on read', async () => {
    const { transport, calls } = scriptedTransport({ open: OPEN_200, reads: [] })
    const host = new DriverStreamHost(transport)
    const { streamId } = host.start(provider(), { messages: [] }, 'm')
    await new Promise(r => setTimeout(r, 5))
    await host.cancel(streamId)
    await host.cancel(streamId)
    expect(calls.filter(c => c.action === 'rawStreamCancel')).toHaveLength(1)
    await expect(host.read(streamId, 0)).rejects.toThrow(/Unknown driver stream/)
  })
})

describe('runBlockingCall — model.call on a ModelProvider (a fresh stream, read whole)', () => {
  it("assembles the host's blocking-call message: text, thinking + signature, tool call, stop reason, usage", async () => {
    const { transport } = scriptedTransport({
      open: OPEN_200,
      reads: [
        {
          done: false,
          chunk: enc([
            { type: 'message_start', model: 'm-reported', usage: { promptTokens: 7, completionTokens: 0 } },
            { type: 'reasoning_delta', text: 'think' },
            { type: 'reasoning_delta', text: 'ing' },
            { type: 'reasoning_signature', signature: 'sig' },
            { type: 'text_delta', text: 'Hel' },
          ]),
        },
        {
          done: true,
          chunk: enc([
            { type: 'text_delta', text: 'lo' },
            { type: 'tool_call', id: 't1', name: 'Read', input: { file_path: 'a' } },
            { type: 'finish', finishReason: 'tool_calls', usage: { promptTokens: 7, completionTokens: 3 } },
          ]),
        },
      ],
    })
    const result = await runBlockingCall(new DriverStreamHost(transport), provider(), { messages: [] }, 'm')
    expect(result).toEqual({
      status: 'ok',
      message: {
        role: 'assistant',
        model: 'm-reported',
        stop_reason: 'tool_use',
        usage: expect.objectContaining({ input_tokens: 7, output_tokens: 3 }),
        content: [
          { type: 'thinking', thinking: 'thinking', signature: 'sig' },
          { type: 'text', text: 'Hello' },
          { type: 'tool-call', toolCallId: 't1', toolName: 'Read', args: { file_path: 'a' } },
        ],
      },
    })
  })

  it('a stream that ends in an error rejects with the provider text', async () => {
    const { transport } = scriptedTransport({
      open: { ok: true, result: { ...OPEN_200.result, status: 429, statusText: 'Too Many Requests' } },
      reads: [{ done: true, chunk: new TextEncoder().encode('slow down') }],
    })
    await expect(runBlockingCall(new DriverStreamHost(transport), provider(), { messages: [] }, 'm'))
      .rejects.toThrow('API Error: 429 slow down')
  })

  it('the deadline is the whole-response budget: on expiry the request is cancelled and the result says timeout', async () => {
    // Nothing scripted after the open: the upstream goes silent.
    const { transport, calls } = scriptedTransport({ open: OPEN_200, reads: [] })
    const result = await runBlockingCall(
      new DriverStreamHost(transport),
      provider(),
      { messages: [], deadlineMs: Date.now() + 40 },
      'm',
    )
    expect(result).toEqual({ status: 'timeout', message: { role: 'assistant', content: [] } })
    expect(calls.some(c => c.action === 'rawStreamCancel')).toBe(true)
  })
})
