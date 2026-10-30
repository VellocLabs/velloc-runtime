/**
 * Tests for the Anthropic Messages runtime driver
 * (models/drivers/anthropicMessagesDriver.ts). The driver behaves like our
 * C++ provider (providers/anthropic/anthropic_provider.cc); the cases of that
 * provider's schema-sanitizer and stop-reason unit tests are repeated below as
 * fixtures.
 */
import { describe, expect, it } from 'vitest'
import type { BridgeModelRequestPayload } from '../browser/bridge/browserBridgeProtocol'
import {
  anthropicMessagesDriver,
  normalizeAnthropicStopDetails,
  sanitizeStrictSchemaForAnthropic,
  translateAnthropicStopReason,
} from '../models/drivers/anthropicMessagesDriver'
import { HostRequestError } from '../models/drivers/hostCallOptions'
import {
  OrderedHostDict,
  hostValueFromJs,
  hostValueToJs,
  writeHostJson,
  type HostDict,
} from '../models/drivers/hostValue'
import type { DriverStreamEvent } from '../models/drivers/driverTypes'

const context = { providerId: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-x' }

function build(payload: Partial<BridgeModelRequestPayload>) {
  return anthropicMessagesDriver.buildRequest(
    { messages: [], ...payload } as BridgeModelRequestPayload,
    context,
  )
}

function bodyText(payload: Partial<BridgeModelRequestPayload>): string {
  return new TextDecoder().decode(build(payload).body)
}

function body(payload: Partial<BridgeModelRequestPayload>): any {
  return JSON.parse(bodyText(payload))
}

const enc = new TextEncoder()

function sse(events: Array<[string, unknown]>): string {
  return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('')
}

function decodeAll(chunks: Uint8Array[]): DriverStreamEvent[] {
  const decoder = anthropicMessagesDriver.createDecoder(context)
  const out: DriverStreamEvent[] = []
  for (const c of chunks) out.push(...decoder.push(c))
  out.push(...decoder.end())
  return out
}

/** Feed `bytes` split at every `step` bytes. */
function splitEvery(bytes: Uint8Array, step: number): Uint8Array[] {
  const out: Uint8Array[] = []
  for (let i = 0; i < bytes.length; i += step) out.push(bytes.slice(i, i + step))
  return out
}

describe('anthropic-messages buildRequest', () => {
  it('targets /v1/messages with the C++ headers and a placeholder key', () => {
    const req = build({ messages: [{ role: 'user', content: 'hi' }] })
    expect(req.url).toBe('https://api.anthropic.com/v1/messages')
    expect(req.method).toBe('POST')
    expect(req.headers).toEqual({
      'x-api-key': '{{secret:api_key}}',
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    })
  })

  it('writes the exact JSONWriter bytes: sorted keys, <-escape, system blocks, breakpoints', () => {
    const text = bodyText({
      messages: [{ role: 'user', content: 'Hi <b>' }],
      systemPrompt: ['A', 'B'],
      userContext: { tz: 'UTC', app: 'velloc' },
      maxOutputTokens: 1024,
    })
    expect(text).toBe(
      String.raw`{"max_tokens":1024,"messages":[{"content":[{"cache_control":{"type":"ephemeral"},"text":"Hi ${'\\'}u003Cb>","type":"text"}],"role":"user"}],"model":"claude-x","stream":true,"system":[{"cache_control":{"type":"ephemeral"},"text":"A\n\nB\n\nUser context:\n- app: velloc\n- tz: UTC","type":"text"}]}`,
    )
  })

  it('defaults max_tokens to 8192 and omits system when there is none', () => {
    const b = body({ messages: [{ role: 'user', content: 'x' }] })
    expect(b.max_tokens).toBe(8192)
    expect(b.system).toBeUndefined()
    expect(b.tools).toBeUndefined()
    expect(b.tool_choice).toBeUndefined()
  })

  it('folds system-role messages into the top-level system after the instruction', () => {
    const b = body({
      systemPrompt: 'base',
      messages: [
        { role: 'system', content: 'extra' },
        { role: 'user', content: 'q' },
      ],
    })
    expect(b.system[0].text).toBe('base\n\nextra')
    expect(b.messages).toHaveLength(1)
  })

  it('translates images (base64 / url) and documents', () => {
    const b = body({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', image: 'AAAA', mimeType: 'image/jpeg' },
            { type: 'image', image: 'https://x/y.png' },
            { type: 'image', image: 'BBBB' },
            { type: 'document', data: 'PDF' },
            { type: 'text', text: 'look' },
          ],
        },
      ],
    })
    const content = b.messages[0].content
    expect(content[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } })
    expect(content[1]).toEqual({ type: 'image', source: { type: 'url', url: 'https://x/y.png' } })
    expect(content[2].source.media_type).toBe('image/png')
    expect(content[3]).toEqual({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: 'PDF' },
    })
    expect(content[4].cache_control).toEqual({ type: 'ephemeral' })
  })

  it('drops thinking / redacted_thinking parts (the C++ host does not round-trip them)', () => {
    const b = body({
      messages: [
        { role: 'user', content: 'q' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'hmm', signature: 'sig' },
            { type: 'redacted_thinking', data: 'xx' },
            { type: 'text', text: 'a' },
          ],
        },
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'only' }] },
      ],
    })
    expect(b.messages).toHaveLength(2)
    expect(b.messages[1].content).toEqual([
      { type: 'text', text: 'a', cache_control: { type: 'ephemeral' } },
    ])
  })

  it('translates tool_use / tool_result and merges consecutive same-role messages', () => {
    const b = body({
      messages: [
        { role: 'user', content: 'run' },
        {
          role: 'assistant',
          content: [
            { type: 'tool-call', toolCallId: 't1', toolName: 'Bash', args: { command: 'ls' } },
            { type: 'tool-call', toolCallId: 't2', toolName: 'Read', args: '{"file_path":"a"}' },
            { type: 'tool-call', toolCallId: 't3', toolName: 'Nope', args: [1] },
          ],
        },
        { role: 'user', content: [{ type: 'tool-result', toolCallId: 't1', result: 'out' }] },
        { role: 'user', content: [{ type: 'tool-result', toolCallId: 't2', result: '{"b":1, "a":2}', isError: true }] },
        {
          role: 'user',
          content: [
            {
              type: 'tool-result',
              toolCallId: 't3',
              result: [{ type: 'text', text: 'shot' }, { type: 'image', image: 'IMG', mimeType: 'image/webp' }],
            },
          ],
        },
        { role: 'user', content: [{ type: 'tool-result', toolCallId: 't4', result: '' }] },
        { role: 'user', content: [{ type: 'tool-result', toolCallId: 't5', result: [{ type: 'weird' }] }] },
      ],
    })
    expect(b.messages).toHaveLength(3)
    expect(b.messages[1].content).toEqual([
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
      { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: 'a' } },
      { type: 'tool_use', id: 't3', name: 'Nope', input: {} },
    ])
    const results = b.messages[2].content
    expect(results[0]).toEqual({ type: 'tool_result', tool_use_id: 't1', content: 'out' })
    // Host ParseToolPayloadValue parses the JSON string; JSONWriter re-emits it sorted + minified.
    expect(results[1]).toEqual({ type: 'tool_result', tool_use_id: 't2', content: '{"a":2,"b":1}', is_error: true })
    expect(results[2].content).toEqual([
      { type: 'text', text: 'shot' },
      { type: 'image', source: { type: 'base64', media_type: 'image/webp', data: 'IMG' } },
    ])
    expect(results[3].content).toBe('(no content)')
    expect(results[4].content).toBe('[{"type":"weird"}]')
    expect(results[4].cache_control).toEqual({ type: 'ephemeral' })
  })

  it("a caller's own breakpoints replace the automatic ones; a request with none keeps them", () => {
    const tools = [{ type: 'function' as const, name: 't', parameters: { type: 'object' } }]
    const marked = body({
      systemPrompt: 'S',
      tools,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'RULES', cache_control: { type: 'ephemeral' } },
            { type: 'text', text: 'diff' },
          ],
        },
      ],
    })
    expect(marked.messages[0].content).toEqual([
      { type: 'text', text: 'RULES', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'diff' },
    ])
    expect(marked.system).toEqual([{ type: 'text', text: 'S' }])
    expect(marked.tools[0]).not.toHaveProperty('cache_control')
    const plain = body({ systemPrompt: 'S', tools, messages: [{ role: 'user', content: [{ type: 'text', text: 'RULES' }, { type: 'text', text: 'diff' }] }] })
    expect(plain.messages[0].content[0]).not.toHaveProperty('cache_control')
    expect(plain.messages[0].content[1].cache_control).toEqual({ type: 'ephemeral' })
    expect(plain.system[0].cache_control).toEqual({ type: 'ephemeral' })
    expect(plain.tools[0].cache_control).toEqual({ type: 'ephemeral' })
  })

  it('translates tools: strict + sanitizer, input_examples, cache_control, tool_choice auto', () => {
    const b = body({
      messages: [{ role: 'user', content: 'x' }],
      tools: [
        {
          type: 'function',
          name: 'Grep',
          description: 'search',
          strict: true,
          parameters: {
            type: 'object',
            properties: {
              pattern: { type: 'string' },
              path: { type: ['string', 'null'] },
              limit: { type: ['integer', 'null'], minimum: 1 },
            },
            required: ['pattern', 'path', 'limit'],
            additionalProperties: false,
          },
          inputExamples: [{ pattern: 'a' }],
        },
        {
          type: 'function',
          name: 'Loose',
          strict: false,
          parameters: { type: 'object', properties: { n: { type: ['string', 'null'] }, a: { type: 'string' } } },
        },
      ],
    })
    // Strict sampling follows the schema's property order: declared, never sorted.
    expect(Object.keys(b.tools[0].input_schema.properties)).toEqual(['pattern', 'path', 'limit'])
    expect(Object.keys(b.tools[1].input_schema.properties)).toEqual(['n', 'a'])
    expect(b.tools[0]).toEqual({
      name: 'Grep',
      description: 'search',
      strict: true,
      input_examples: [{ pattern: 'a' }],
      input_schema: {
        type: 'object',
        properties: { pattern: { type: 'string' }, path: { type: 'string' }, limit: { type: 'integer' } },
        required: ['pattern'],
        additionalProperties: false,
      },
    })
    // strict:false never survives the host hop; non-strict schemas pass through.
    expect(b.tools[1]).toEqual({
      name: 'Loose',
      input_schema: { type: 'object', properties: { n: { type: ['string', 'null'] }, a: { type: 'string' } } },
      cache_control: { type: 'ephemeral' },
    })
    expect(b.tool_choice).toEqual({ type: 'auto' })
  })

  it('merges providerBodyExtension last (thinking), but stream stays true', () => {
    const text = bodyText({
      messages: [{ role: 'user', content: 'x' }],
      maxOutputTokens: 32000,
      providerBodyExtension: {
        thinking: { type: 'enabled', budget_tokens: 16000 },
        max_tokens: 64000,
        stream: false,
        temperature: 1.5,
        big: 3000000000,
      },
    })
    const b = JSON.parse(text)
    expect(b.thinking).toEqual({ type: 'enabled', budget_tokens: 16000 })
    expect(b.max_tokens).toBe(64000)
    expect(b.stream).toBe(true)
    // A number outside int32 is a double to the host: JSONWriter adds ".0".
    expect(text).toContain('"big":3000000000.0')
    expect(text).toContain('"temperature":1.5')
  })
})

describe('anthropic-messages host validation (BuildMojoLlmRequest INVALID_ARGS)', () => {
  /** The HostRequestError the host would answer with, or a failure. */
  function rejection(payload: unknown): HostRequestError {
    try {
      anthropicMessagesDriver.buildRequest(payload as BridgeModelRequestPayload, context)
    } catch (error) {
      expect(error).toBeInstanceOf(HostRequestError)
      return error as HostRequestError
    }
    throw new Error('expected the payload to be rejected')
  }

  it('rejects a tool without parameters (no silent input_schema:{type:object})', () => {
    expect(
      rejection({
        messages: [{ role: 'user', content: 'x' }],
        tools: [{ type: 'function', name: 'T', description: 'd' }],
      }).message,
    ).toBe('Bridge tool definitions must include a parameters object')
  })

  it('rejects an assistant tool-call with an empty toolCallId (no orphaned tool_result)', () => {
    expect(
      rejection({
        messages: [
          { role: 'user', content: 'run' },
          { role: 'assistant', content: [{ type: 'tool-call', toolCallId: '', toolName: 'Bash', args: {} }] },
          { role: 'user', content: [{ type: 'tool-result', toolCallId: 't1', result: 'out' }] },
        ],
      }).message,
    ).toBe('Bridge tool-call parts must include toolCallId')
  })

  it('rejects an unknown role', () => {
    expect(rejection({ messages: [{ role: 'developer', content: 'x' }] }).message).toBe(
      'Bridge messages must include a valid role',
    )
  })

  it('rejects a payload with no messages array', () => {
    expect(rejection({ systemPrompt: 'x' }).message).toBe('LLM request "messages" must be an array')
  })
})

describe('anthropic-messages SSE decoding', () => {
  const stream = sse([
    ['message_start', { type: 'message_start', message: { usage: { input_tokens: 10, cache_read_input_tokens: 7, cache_creation_input_tokens: 3, output_tokens: 1 } } }],
    ['ping', { type: 'ping' }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'let me think' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'SIG' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'héllo 世界 🎉' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 1 }],
    ['content_block_start', { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} } }],
    ['content_block_delta', { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"comm' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: 'and":"ls"}' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 2 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 42 } }],
    ['message_stop', { type: 'message_stop' }],
  ])
  const usage = { promptTokens: 10, promptCacheHits: 7, promptCacheWrites: 3 }
  const expected: DriverStreamEvent[] = [
    { type: 'message_start', model: 'claude-x', usage: { ...usage, completionTokens: 0 } },
    { type: 'reasoning_delta', text: 'let me think' },
    { type: 'text_delta', text: 'héllo 世界 🎉' },
    { type: 'tool_call_start', id: 'toolu_1', name: 'Bash' },
    { type: 'tool_call_delta', id: 'toolu_1', argsTextDelta: '{"comm' },
    { type: 'tool_call_delta', id: 'toolu_1', argsTextDelta: 'and":"ls"}' },
    { type: 'tool_call', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } },
    { type: 'finish', finishReason: 'tool_calls', usage: { ...usage, completionTokens: 42 } },
  ]

  it('decodes a whole stream in the C++ event order', () => {
    expect(decodeAll([enc.encode(stream)])).toEqual(expected)
  })

  it('is independent of chunk boundaries (incl. inside UTF-8 characters)', () => {
    const bytes = enc.encode(stream)
    for (const step of [1, 2, 3, 5, 7, 64]) {
      expect(decodeAll(splitEvery(bytes, step))).toEqual(expected)
    }
  })

  it('accepts CRLF line endings inside an event (C++ strips a trailing \\r per line)', () => {
    const text =
      'event: content_block_delta\r\ndata: {"index":0,"delta":{"type":"text_delta","text":"a"}}\r\n\n'
    const events = decodeAll(splitEvery(enc.encode(text), 1))
    expect(events[0]).toEqual({ type: 'text_delta', text: 'a' })
  })

  it('maps refusal to content_filter and carries normalized stop_details', () => {
    const events = decodeAll([
      enc.encode(
        sse([
          ['message_delta', { delta: { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: null, extra: 'x' } }, usage: { output_tokens: 2 } }],
        ]),
      ),
    ])
    expect(events).toEqual([
      {
        type: 'finish',
        finishReason: 'content_filter',
        usage: { promptTokens: 0, completionTokens: 2, promptCacheHits: 0, promptCacheWrites: 0 },
        stopDetails: { type: 'refusal', category: 'cyber' },
      },
    ])
  })

  it('an in-stream error event is terminal and parsed like the host does', () => {
    const events = decodeAll([
      enc.encode(
        sse([
          ['content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'a' } }],
          ['error', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }],
          ['content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'b' } }],
        ]),
      ),
    ])
    expect(events).toEqual([
      { type: 'text_delta', text: 'a' },
      { type: 'error', message: 'Overloaded' },
    ])
  })

  it('an unterminated stream ends with the host fallback finish', () => {
    const events = decodeAll([enc.encode('event: ping\ndata: {}\n\nevent: content_block_delta\ndata: {"index":0,')])
    expect(events).toEqual([
      {
        type: 'finish',
        finishReason: 'unknown',
        usage: { promptTokens: 0, completionTokens: 0, promptCacheHits: 0, promptCacheWrites: 0 },
      },
    ])
  })

  it('skips unparseable data and empty deltas like the C++ (and host) do', () => {
    const events = decodeAll([
      enc.encode(
        'event: content_block_delta\ndata: {not json}\n\n'
        + sse([['content_block_delta', { index: 0, delta: { type: 'text_delta', text: '' } }]]),
      ),
    ])
    expect(events.map(e => e.type)).toEqual(['finish'])
  })
})

describe('anthropic-messages errorFromResponse', () => {
  const err = (status: number, bodyText: string, headers: Record<string, string> = {}) =>
    anthropicMessagesDriver.errorFromResponse({ status, statusText: '', headers, bodyText })

  it('401 with the Anthropic error envelope', () => {
    expect(err(401, '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}')).toEqual({
      type: 'error',
      message: 'HTTP 401: invalid x-api-key',
      httpStatus: 401,
    })
  })

  it('429 with Retry-After (any header case)', () => {
    expect(err(429, '{"error":{"message":"rate limited"}}', { 'retry-after': '17' })).toEqual({
      type: 'error',
      message: 'HTTP 429: rate limited (retry-after: 17s)',
      httpStatus: 429,
      retryAfterSeconds: 17,
    })
    // HTTP-date form is not parsed.
    expect(err(429, '', { 'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT' }).message).toBe('HTTP 429')
  })

  it('529 overloaded, and SSE-framed / unrecognized bodies', () => {
    expect(err(529, '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}').message).toBe(
      'HTTP 529: Overloaded',
    )
    expect(err(502, 'event: error\r\ndata: {"error":{"message":"upstream"}}\r\n').message).toBe('HTTP 502: upstream')
    expect(err(500, '<html>oops</html>').message).toBe('HTTP 500')
    expect(err(400, '{"detail":"bad"}').message).toBe('HTTP 400: bad')
  })
})

describe('writeHostJson key order', () => {
  it('writes an OrderedHostDict in insertion order and a plain dict sorted', () => {
    const inner: HostDict = new Map([['pattern', 'x'], ['path', 'y']])
    const ordered = new OrderedHostDict([['pattern', inner], ['path', 'p']])
    expect(writeHostJson(ordered)).toBe('{"pattern":{"path":"y","pattern":"x"},"path":"p"}')
    expect(writeHostJson(inner)).toBe('{"path":"y","pattern":"x"}')
  })
})

// ── Cases from the C++ unit tests──────────────────────────────────────

function sanitize(schema: unknown): any {
  return hostValueToJs(sanitizeStrictSchemaForAnthropic(hostValueFromJs(schema) as HostDict))
}

describe('schema sanitizer (cases of anthropic_schema_sanitizer_unittest.cc)', () => {
  it('CollapsesNullableTypesAndRewritesRequired', () => {
    const out = sanitize({
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'regex' },
        path: { type: ['string', 'null'] },
        head_limit: { type: ['integer', 'null'] },
        multiline: { type: ['boolean', 'null'] },
      },
      required: ['pattern', 'path', 'head_limit', 'multiline'],
      additionalProperties: false,
    })
    expect(out.properties.path.type).toBe('string')
    expect(out.properties.head_limit.type).toBe('integer')
    expect(out.properties.multiline.type).toBe('boolean')
    expect(out.properties.pattern).toEqual({ type: 'string', description: 'regex' })
    expect(out.required).toEqual(['pattern'])
    expect(out.additionalProperties).toBe(false)
    expect(Object.keys(out.properties)).toHaveLength(4)
  })

  it('drops "Use null" advice from a description once null leaves the type', () => {
    const out = sanitize({
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression. Use null never applies here.' },
        path: {
          type: ['string', 'null'],
          description: 'File or directory to search. The working directory unless set. Use null to select the default.',
        },
        type: { type: ['string', 'null'], description: 'Use null when no type filter is needed.' },
        glob: { type: ['string', 'null'], description: 'No filter unless set. Use null when not needed. Several may be listed.' },
      },
      required: ['pattern', 'path', 'type', 'glob'],
      additionalProperties: false,
    })
    expect(out.properties.pattern.description).toBe('Regular expression. Use null never applies here.')
    expect(out.properties.path.description).toBe('File or directory to search. The working directory unless set.')
    expect(out.properties.type).toEqual({ type: 'string' })
    expect(out.properties.glob.description).toBe('No filter unless set. Several may be listed.')
  })

  it('StripsNullFromEnums', () => {
    const out = sanitize({
      type: 'object',
      properties: {
        output_mode: { type: ['string', 'null'], enum: [null, 'files_with_matches', 'content', 'count'] },
      },
      required: ['output_mode'],
      additionalProperties: false,
    })
    expect(out.properties.output_mode.type).toBe('string')
    expect(out.properties.output_mode.enum).toEqual(['files_with_matches', 'content', 'count'])
    expect(out.required).toEqual([])
  })

  it('RecursesNestedObjectsItemsAndCombinators', () => {
    const out = sanitize({
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          items: {
            type: 'object',
            properties: { content: { type: 'string' }, note: { type: ['string', 'null'] } },
            required: ['content', 'note'],
            additionalProperties: false,
          },
        },
        mode: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      },
      required: ['todos', 'mode'],
      additionalProperties: false,
    })
    expect(out.properties.todos.items.properties.note.type).toBe('string')
    expect(out.properties.todos.items.required).toEqual(['content'])
    expect(out.properties.mode.anyOf).toEqual([{ type: 'string' }])
    expect(out.required).toEqual(['todos'])
  })

  it('StripsNumericRangeKeywords', () => {
    const out = sanitize({
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'path' },
        offset: { type: ['integer', 'null'], minimum: 0 },
        limit: { type: ['integer', 'null'], minimum: 1 },
        max_results: { type: ['integer', 'null'], maximum: 100, exclusiveMinimum: 0, exclusiveMaximum: 101, multipleOf: 2 },
      },
      required: ['file_path', 'offset', 'limit', 'max_results'],
      additionalProperties: false,
    })
    expect(out.properties.offset).toEqual({ type: 'integer' })
    expect(out.properties.limit).toEqual({ type: 'integer' })
    expect(out.properties.max_results).toEqual({ type: 'integer' })
    expect(out.properties.file_path.description).toBe('path')
    expect(out.required).toEqual(['file_path'])
  })

  it('PlainOptionalSchemaPassesThroughUnchanged', () => {
    const schema = {
      type: 'object',
      properties: { command: { type: 'string' }, timeout: { type: 'integer' } },
      required: ['command'],
      additionalProperties: false,
    }
    expect(sanitize(schema)).toEqual(schema)
  })
})

describe('stop-reason translation (cases of anthropic_stop_reason_unittest.cc)', () => {
  it('RefusalMapsToContentFilter + KnownValues', () => {
    expect(translateAnthropicStopReason('refusal')).toBe('content_filter')
    expect(translateAnthropicStopReason('end_turn')).toBe('stop')
    expect(translateAnthropicStopReason('stop_sequence')).toBe('stop')
    expect(translateAnthropicStopReason('max_tokens')).toBe('length')
    expect(translateAnthropicStopReason('tool_use')).toBe('tool_calls')
  })

  it('UnknownFallsThroughToOther', () => {
    for (const r of ['', 'pause_turn', 'REFUSAL', 'content_filter']) {
      expect(translateAnthropicStopReason(r)).toBe('other')
    }
  })

  it('StopDetailsCopiesStringFields', () => {
    const raw = {
      type: 'refusal',
      category: 'cyber',
      explanation: 'This request was declined by a safety classifier.',
      recommended_model: 'claude-opus-4-8',
    }
    expect(normalizeAnthropicStopDetails(hostValueFromJs(raw))).toEqual(raw)
  })

  it('StopDetailsSkipsNullAndNonStringFields', () => {
    expect(
      normalizeAnthropicStopDetails(
        hostValueFromJs({ type: 'refusal', category: null, explanation: 42, unrelated: 'dropped' }),
      ),
    ).toEqual({ type: 'refusal' })
  })

  it('StopDetailsAbsentNullOrEmptyYieldsNothing', () => {
    expect(normalizeAnthropicStopDetails(undefined)).toBeUndefined()
    expect(normalizeAnthropicStopDetails(null)).toBeUndefined()
    expect(normalizeAnthropicStopDetails('refusal')).toBeUndefined()
    expect(normalizeAnthropicStopDetails(new Map())).toBeUndefined()
    expect(normalizeAnthropicStopDetails(hostValueFromJs({ category: '' }))).toBeUndefined()
  })
})
