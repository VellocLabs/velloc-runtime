import { describe, expect, it } from 'vitest'

import type { BridgeModelRequestPayload } from '../browser/bridge/browserBridgeProtocol'
import { ollamaChatDriver } from '../models/drivers/ollamaChatDriver'
import { createModelProvider } from '../models/drivers/modelProvider'
import { resolveProviderSpec } from '../models/drivers/driverRegistry'
import '../models/drivers/builtinDrivers'
import type { DriverStreamEvent } from '../models/drivers/driverTypes'

// Port of ollama_provider.cc (OllamaProvider): request bytes, stream decoding
// and the host's chunk handling, case by case.

const context = { providerId: 'ollama', baseUrl: 'http://localhost:11434', model: 'qwen3.5' }

function bodyText(p: BridgeModelRequestPayload): string {
  return new TextDecoder().decode(ollamaChatDriver.buildRequest(p, context).body)
}

function body(p: BridgeModelRequestPayload): Record<string, unknown> {
  return JSON.parse(bodyText(p)) as Record<string, unknown>
}

function messagesOf(p: BridgeModelRequestPayload): Array<Record<string, unknown>> {
  return body(p).messages as Array<Record<string, unknown>>
}

describe('ollamaChatDriver.buildRequest', () => {
  it('builds the exact C++ request: URL, headers (no Authorization) and byte-identical body', () => {
    const request = ollamaChatDriver.buildRequest(
      {
        systemPrompt: ['You are X.'],
        messages: [
          { role: 'user', content: 'Hello <world>' },
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'hmm', signature: 's' },
              { type: 'text', text: 'Let me ' },
              { type: 'text', text: 'look.' },
              { type: 'tool-call', toolCallId: 'call_1', toolName: 'Read', args: { path: '/a.txt', limit: 10 } },
            ],
          },
          { role: 'user', content: [{ type: 'tool-result', toolCallId: 'call_1', result: 'file body' }] },
        ],
        tools: [
          {
            type: 'function',
            name: 'Read',
            description: 'Read a file',
            parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
            strict: true,
          },
        ],
        maxOutputTokens: 4096,
        providerBodyExtension: { think: true },
      },
      context,
    )
    // DoStream: base + "/v1/chat/completions"; Content-Type only — the host
    // applies the User-Agent preset, and Ollama sends no credential.
    expect(request.url).toBe('http://localhost:11434/v1/chat/completions')
    expect(request.method).toBe('POST')
    expect(request.headers).toEqual({ 'content-type': 'application/json' })
    expect(request.queryParams).toBeUndefined()
    // max_tokens (not max_completion_tokens); assistant texts joined with
    // nothing; no `strict`; the host's tool choice object sent as is.
    expect(new TextDecoder().decode(request.body)).toBe(
      String.raw`{"max_tokens":4096,"messages":[{"content":"You are X.","role":"system"},{"content":"Hello ${'\\'}u003Cworld>","role":"user"},{"content":"Let me look.","role":"assistant","tool_calls":[{"function":{"arguments":"{\"limit\":10,\"path\":\"/a.txt\"}","name":"Read"},"id":"call_1","type":"function"}]},{"content":"file body","role":"tool","tool_call_id":"call_1"}],"model":"qwen3.5","stream":true,"stream_options":{"include_usage":true},"think":true,"tool_choice":{"type":"auto"},"tools":[{"function":{"description":"Read a file","name":"Read","parameters":{"properties":{"path":{"type":"string"}},"required":["path"],"type":"object"}},"type":"function"}]}`,
    )
  })

  it('omits tools, tool_choice and max_tokens when absent; joins the base URL verbatim', () => {
    expect(bodyText({ messages: [{ role: 'user', content: 'x' }] })).toBe(
      '{"messages":[{"content":"x","role":"user"}],"model":"qwen3.5","stream":true,"stream_options":{"include_usage":true}}',
    )
    expect(ollamaChatDriver.buildRequest({ messages: [] }, { ...context, baseUrl: 'http://h:1/' }).url)
      .toBe('http://h:1//v1/chat/completions')
  })

  it('assistant: tool calls only → no content key', () => {
    const messages = messagesOf({
      messages: [{ role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'a', toolName: 'T', args: { x: 1 } }] }],
    })
    expect(messages[0]).toEqual({
      role: 'assistant',
      tool_calls: [{ id: 'a', type: 'function', function: { name: 'T', arguments: '{"x":1}' } }],
    })
  })

  it('user images go out as a data URI from the `image` bytes of the host part; documents become the marker', () => {
    const [msg] = messagesOf({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look' },
            { type: 'image', image: 'AAAA', mimeType: 'image/jpeg' },
            { type: 'document', data: 'PDF', mimeType: 'application/pdf' },
          ],
        },
      ],
    })
    expect(msg).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'look' },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } },
        {
          type: 'text',
          text:
            '[document: application/pdf - its content cannot be shown through this provider. '
            + 'Read it with the pages parameter (e.g. pages: "1-5") to receive the pages as images.]',
        },
      ],
    })
  })

  it('text-only user content concatenates its parts with no separator', () => {
    const [msg] = messagesOf({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }],
    })
    expect(msg).toEqual({ role: 'user', content: 'ab' })
  })

  it('tool results hoist their images into one user message after the batch (shared with openai-chat)', () => {
    const messages = messagesOf({
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'c1',
              result: [{ type: 'text', text: 'shot' }, { type: 'image', image: 'QUJD', mimeType: 'image/png' }],
            },
          ],
        },
      ],
    })
    expect(messages.map(m => m.role)).toEqual(['tool', 'user'])
    expect(JSON.stringify(messages[1])).toContain('data:image/png;base64,QUJD')
  })
})

// ── Decoder ───────────────────────────────────────────────────────────────

const enc = new TextEncoder()
const sse = (...frames: Array<object | string>) =>
  frames.map(f => `data: ${typeof f === 'string' ? f : JSON.stringify(f)}\n\n`).join('')

function decodeWhole(text: string): DriverStreamEvent[] {
  const decoder = ollamaChatDriver.createDecoder(context)
  return [...decoder.push(enc.encode(text)), ...decoder.end()]
}

function decodeByteWise(text: string): DriverStreamEvent[] {
  const decoder = ollamaChatDriver.createDecoder(context)
  const bytes = enc.encode(text)
  const events: DriverStreamEvent[] = []
  for (let i = 0; i < bytes.length; i++) events.push(...decoder.push(bytes.subarray(i, i + 1)))
  return [...events, ...decoder.end()]
}

const delta = (d: Record<string, unknown>, finish: string | null = null) => ({
  choices: [{ index: 0, delta: d, finish_reason: finish }],
})

const zeroUsage = { promptTokens: 0, completionTokens: 0, promptCacheHits: 0, promptCacheWrites: 0 }

describe('ollamaChatDriver decoder', () => {
  it('streams reasoning then text, survives byte-wise splits in UTF-8 and CRLF, finishes once usage arrives', () => {
    const text =
      sse(delta({ role: 'assistant', reasoning: 'think' }), delta({ content: 'héllo 😀' }), delta({}, 'stop')).replace(/\n/g, '\r\n')
      + sse({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 25, prompt_tokens_details: { cached_tokens: 40 } } }, '[DONE]')
    const expected: DriverStreamEvent[] = [
      { type: 'reasoning_delta', text: 'think' },
      { type: 'text_delta', text: 'héllo 😀' },
      {
        type: 'finish',
        finishReason: 'stop',
        usage: { promptTokens: 60, completionTokens: 25, promptCacheHits: 40, promptCacheWrites: 0 },
      },
    ]
    expect(decodeWhole(text)).toEqual(expected)
    expect(decodeByteWise(text)).toEqual(expected)
  })

  it('reads bare NDJSON lines, `data:` with any number of spaces, and a final line without its newline', () => {
    const events = decodeWhole(
      JSON.stringify(delta({ content: 'a' })) + '\n'
      + 'data:' + JSON.stringify(delta({ content: 'b' })) + '\n'
      + 'data:   ' + JSON.stringify(delta({ content: 'c' })) + '\n'
      + JSON.stringify({ ...delta({ content: 'd' }, 'stop'), usage: { prompt_tokens: 1, completion_tokens: 2 } }) + '\r',
    )
    expect(events).toEqual([
      { type: 'text_delta', text: 'a' },
      { type: 'text_delta', text: 'b' },
      { type: 'text_delta', text: 'c' },
      { type: 'text_delta', text: 'd' },
      { type: 'finish', finishReason: 'stop', usage: { promptTokens: 1, completionTokens: 2, promptCacheHits: 0, promptCacheWrites: 0 } },
    ])
  })

  it('ignores comments, event lines and malformed JSON', () => {
    const events = decodeWhole(': ping\nevent: x\nid: 7\ndata: {bad\n' + sse(delta({ content: 'ok' })))
    expect(events.filter(e => e.type === 'text_delta')).toEqual([{ type: 'text_delta', text: 'ok' }])
  })

  it('correlates streamed tool-call arguments by index and flushes the calls before the finish', () => {
    const events = decodeWhole(
      sse(
        delta({ tool_calls: [{ index: 0, id: 'call_a', function: { name: 'Bash', arguments: '{"c":' } }] }),
        delta({ tool_calls: [{ index: 0, function: { arguments: '1}' } }] }),
        delta({}, 'tool_calls'),
        { choices: [], usage: { prompt_tokens: 5, completion_tokens: 6 } },
      ),
    )
    expect(events).toEqual([
      { type: 'tool_call_start', id: 'call_a', name: 'Bash' },
      { type: 'tool_call_delta', id: 'call_a', name: 'Bash', argsTextDelta: '{"c":' },
      { type: 'tool_call_delta', id: 'call_a', name: 'Bash', argsTextDelta: '1}' },
      { type: 'tool_call', id: 'call_a', name: 'Bash', input: { c: 1 } },
      { type: 'finish', finishReason: 'tool_calls', usage: { promptTokens: 5, completionTokens: 6, promptCacheHits: 0, promptCacheWrites: 0 } },
    ])
  })

  it('a repeated id re-opens the call (the C++ emits a streaming start for every id it sees)', () => {
    const events = decodeWhole(
      sse(
        delta({ tool_calls: [{ index: 0, id: 'x', function: { name: 'Read', arguments: '{"a":1}' } }] }),
        delta({ tool_calls: [{ index: 0, id: 'x', function: { arguments: '{"b":2}' } }] }),
        delta({}, 'tool_calls'),
      ),
    )
    expect(events.filter(e => e.type === 'tool_call_start')).toHaveLength(2)
    // The host's second start resets the pending call: only its arguments remain.
    expect(events.filter(e => e.type === 'tool_call')).toEqual([{ type: 'tool_call', id: 'x', input: { b: 2 } }])
  })

  it('arguments at an index with no id get a fresh host id', () => {
    const events = decodeWhole(sse(delta({ tool_calls: [{ index: 3, function: { name: 'T', arguments: '{}' } }] }), delta({}, 'stop')))
    const [d] = events.filter(e => e.type === 'tool_call_delta') as Array<{ id: string }>
    expect(d?.id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('a finish_reason whose usage never arrives is flushed at end with zero usage', () => {
    expect(decodeWhole(sse(delta({ content: 'x' }, 'length'), '[DONE]')).at(-1)).toEqual({
      type: 'finish',
      finishReason: 'length',
      usage: zeroUsage,
    })
  })

  it('a stream with no finish_reason — or only an in-stream error object — ends with finish(unknown)', () => {
    expect(decodeWhole(sse(delta({ content: 'x' }), '[DONE]')).at(-1)).toEqual({ type: 'finish', finishReason: 'unknown', usage: zeroUsage })
    expect(decodeWhole(sse({ error: { message: 'model not found' } }))).toEqual([
      { type: 'finish', finishReason: 'unknown', usage: zeroUsage },
    ])
  })

  it('abort() never flushes a buffered finish: the transport error ends the stream', () => {
    const decoder = ollamaChatDriver.createDecoder(context)
    decoder.push(enc.encode(sse(delta({ content: 'x' }, 'stop'))))
    expect(decoder.abort?.()).toEqual([])
  })
})

describe('ollamaChatDriver.errorFromResponse', () => {
  it('reports the canonical provider error with status and Retry-After', () => {
    expect(
      ollamaChatDriver.errorFromResponse({
        status: 404,
        statusText: 'Not Found',
        headers: {},
        bodyText: '{"error":{"message":"model \\"nope\\" not found, try pulling it first"}}',
      }),
    ).toMatchObject({ type: 'error', httpStatus: 404, message: 'HTTP 404: model "nope" not found, try pulling it first' })
    expect(ollamaChatDriver.isStreamStatus).toBeUndefined()
  })
})

describe('ollama runs on its ModelProvider', () => {
  it('the catalog wire resolves to the ollama codec at the catalog default URL, keyless', () => {
    expect(resolveProviderSpec('ollama')).toEqual({ id: 'ollama', format: 'ollama-chat' })
    const request = createModelProvider(resolveProviderSpec('ollama')!).buildRequest({ messages: [] }, 'llama3')
    expect(request.url).toBe('http://localhost:11434/v1/chat/completions')
    expect(JSON.stringify(request)).not.toContain('{{secret:')
  })
})
