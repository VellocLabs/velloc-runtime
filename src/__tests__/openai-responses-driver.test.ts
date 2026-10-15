import { describe, expect, it } from 'vitest'

import type { BridgeModelRequestPayload } from '../browser/bridge/browserBridgeProtocol'
import { extractApiErrorMessage } from '../models/drivers/hostCallOptions'
import { type HostDict, hostValueFromJs } from '../models/drivers/hostValue'
import {
  buildResponsesApiErrorMessage as buildMsg,
  extractResponsesApiErrorCode as extractCode,
  extractResponsesApiErrorMessage as extractMsg,
  openaiResponsesDriver,
  serializeEventForDiagnosis as serializeDiag,
} from '../models/drivers/openaiResponsesDriver'
import type { DriverRequestContext, DriverStreamEvent } from '../models/drivers/driverTypes'

const h = (v: unknown) => hostValueFromJs(v) as HostDict
const buildResponsesApiErrorMessage = (v: unknown) => buildMsg(h(v))
const extractResponsesApiErrorCode = (v: unknown) => extractCode(h(v))
const extractResponsesApiErrorMessage = (v: unknown) => extractMsg(h(v))
const serializeEventForDiagnosis = (v: unknown) => serializeDiag(h(v))

const ctx: DriverRequestContext = {
  providerId: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-5.5',
}

function bodyText(payload: BridgeModelRequestPayload, context = ctx): string {
  return new TextDecoder().decode(openaiResponsesDriver.buildRequest(payload, context).body)
}

function body(payload: BridgeModelRequestPayload, context = ctx): Record<string, unknown> {
  return JSON.parse(bodyText(payload, context)) as Record<string, unknown>
}

const enc = new TextEncoder()

function decodeAll(chunks: Array<string | Uint8Array>): DriverStreamEvent[] {
  const decoder = openaiResponsesDriver.createDecoder(ctx)
  const events: DriverStreamEvent[] = []
  for (const c of chunks) events.push(...decoder.push(typeof c === 'string' ? enc.encode(c) : c))
  events.push(...decoder.end())
  return events
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

describe('openaiResponsesDriver.buildRequest', () => {
  it('targets {base}/responses with placeholder auth and exact compact sorted JSON', () => {
    const req = openaiResponsesDriver.buildRequest(
      { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi <b>' }] }] },
      ctx,
    )
    expect(req.url).toBe('https://api.openai.com/v1/responses')
    expect(req.method).toBe('POST')
    expect(req.headers).toEqual({
      authorization: 'Bearer {{secret:api_key}}',
      'content-type': 'application/json',
    })
    expect(new TextDecoder().decode(req.body)).toBe(
      '{"input":[{"content":"hi \\u003Cb>","role":"user","type":"message"}],' +
        '"model":"gpt-5.5","store":false,"stream":true}',
    )
  })

  it('hoists the system prompt + contexts into instructions', () => {
    const b = body({
      systemPrompt: ['Role block', 'Tools block'],
      userContext: { zeta: 'z', alpha: 'a' },
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'extra' }] },
        { role: 'user', content: 'q' },
      ],
    })
    expect(b.instructions).toBe(
      'Role block\n\nTools block\n\nUser context:\n- alpha: a\n- zeta: z\n\nextra',
    )
    expect(b.input).toEqual([{ type: 'message', role: 'user', content: 'q' }])
  })

  it('adds the default instructions only on the Codex backend', () => {
    expect(body({ messages: [{ role: 'user', content: 'q' }] }).instructions).toBeUndefined()
    const codex = body(
      { messages: [{ role: 'user', content: 'q' }], maxOutputTokens: 100 },
      { ...ctx, baseUrl: 'https://chatgpt.com/backend-api/codex' },
    )
    expect(codex.instructions).toBe('You are a helpful assistant.')
    expect(codex.max_output_tokens).toBeUndefined()
    expect(body({ messages: [], maxOutputTokens: 100 }).max_output_tokens).toBe(100)
  })

  it('translates images and documents to input_image / input_file', () => {
    const payload: BridgeModelRequestPayload = {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look' },
            { type: 'image', image: 'QUJD', mimeType: 'image/jpeg' },
            { type: 'image', image: 'https://x/y.png' },
            { type: 'document', data: 'UERG' },
            { type: 'document', data: 'VFhU', mimeType: 'text/plain' },
          ],
        },
      ],
    }
    expect(body(payload).input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'look' },
          { type: 'input_image', image_url: 'data:image/jpeg;base64,QUJD' },
          { type: 'input_image', image_url: 'https://x/y.png' },
          { type: 'input_file', filename: 'document.pdf', file_data: 'data:application/pdf;base64,UERG' },
          { type: 'input_file', filename: 'document.txt', file_data: 'data:text/plain;base64,VFhU' },
        ],
      },
    ])
    // Codex has no input_file: the document becomes the marker text.
    const codex = body(payload, { ...ctx, baseUrl: 'https://chatgpt.com/backend-api/codex' })
    const content = (codex.input as Array<{ content: Array<{ type: string; text?: string }> }>)[0].content
    expect(content[3].type).toBe('input_text')
    expect(content[3].text).toContain('[document: application/pdf - its content cannot be shown')
  })

  it('round-trips a tool call and its results, hoisting result images', () => {
    const text = bodyText({
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'calling' },
            { type: 'tool-call', toolCallId: 'c1', toolName: 'Read', args: { path: 'a<b', b: 1, a: [1.5] } },
            { type: 'tool-call', toolCallId: 'c2', toolName: 'Shot', args: {} },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool-result', toolCallId: 'c1', result: '{"z":1,"a":2}' },
            {
              type: 'tool-result',
              toolCallId: 'c2',
              result: [
                { type: 'text', text: 'caption' },
                { type: 'image', image: 'SU1H', mimeType: 'image/png' },
              ],
            },
          ],
        },
      ],
    })
    const b = JSON.parse(text) as { input: unknown[] }
    expect(b.input).toEqual([
      { type: 'message', role: 'user', content: 'go' },
      { type: 'message', role: 'assistant', content: 'calling' },
      { type: 'function_call', call_id: 'c1', name: 'Read', arguments: '{"a":[1.5],"b":1,"path":"a\\u003Cb"}' },
      { type: 'function_call', call_id: 'c2', name: 'Shot', arguments: '{}' },
      // A JSON-string result is parsed host-side, then re-serialized sorted.
      { type: 'function_call_output', call_id: 'c1', output: '{"a":2,"z":1}' },
      { type: 'function_call_output', call_id: 'c2', output: 'caption' },
      {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: 'The images below were returned by the tool calls above, grouped by tool call id.',
          },
          { type: 'input_text', text: 'Tool call c2:' },
          { type: 'input_text', text: 'caption' },
          { type: 'input_image', image_url: 'data:image/png;base64,SU1H' },
        ],
      },
    ])
  })

  it('serializes arguments with base::JSONWriter number typing', () => {
    const b = body({
      messages: [
        { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c', toolName: 'T', args: { big: 3e9, n: 2 } }] },
      ],
    }) as { input: Array<{ arguments: string }> }
    expect(b.input[0].arguments).toBe('{"big":3000000000.0,"n":2}')
  })

  it('emits flat strict tools with tool_choice auto', () => {
    const b = body({
      messages: [{ role: 'user', content: 'q' }],
      tools: [
        { type: 'function', name: 'Bash', description: 'run', parameters: { type: 'object' }, strict: true },
        { type: 'function', name: 'Read', description: '', parameters: { type: 'object' }, strict: false },
      ],
    })
    expect(b.tools).toEqual([
      { type: 'function', name: 'Bash', description: 'run', parameters: { type: 'object' }, strict: true },
      { type: 'function', name: 'Read', parameters: { type: 'object' } },
    ])
    expect(b.tool_choice).toBe('auto')
  })

  it('maps the reasoning extension and forwards the residue last', () => {
    expect(
      body({ messages: [], providerBodyExtension: { reasoning_effort: 'high', service_tier: 'flex', model: 'm2' } }),
    ).toMatchObject({ reasoning: { effort: 'high' }, service_tier: 'flex', model: 'm2' })
    // Sorted iteration: reasoning_effort (later) overrides reasoning.
    expect(
      body({ messages: [], providerBodyExtension: { reasoning: { effort: 'low', summary: 'auto' }, reasoning_effort: 'high' } })
        .reasoning,
    ).toEqual({ effort: 'high' })
    expect(body({ messages: [], providerBodyExtension: { reasoning: { summary: 'auto' } } }).reasoning).toEqual({
      summary: 'auto',
    })
  })
})

describe('openaiResponsesDriver decoder', () => {
  const completed = (usage?: unknown) => sse('response.completed', { type: 'response.completed', response: { usage } })

  it('decodes text, reasoning and usage (cached tokens exclusive)', () => {
    const events = decodeAll([
      sse('response.created', { response: {} }),
      sse('response.reasoning_summary_text.delta', { delta: 'think' }),
      sse('response.reasoning_summary_part.added', { summary_index: 1 }),
      sse('response.reasoning_text.delta', { delta: 'more' }),
      sse('response.output_text.delta', { delta: 'Hello' }),
      sse('response.output_text.delta', { delta: '' }),
      completed({ input_tokens: 100, output_tokens: 7, input_tokens_details: { cached_tokens: 40 } }),
    ])
    expect(events).toEqual([
      { type: 'reasoning_delta', text: 'think' },
      { type: 'reasoning_delta', text: '\n\n' },
      { type: 'reasoning_delta', text: 'more' },
      { type: 'text_delta', text: 'Hello' },
      {
        type: 'finish',
        finishReason: 'stop',
        usage: { promptTokens: 60, completionTokens: 7, promptCacheHits: 40 },
      },
    ])
  })

  it('handles byte splits inside CRLF and inside a UTF-8 character', () => {
    const wire = enc.encode(
      'event: response.output_text.delta\r\ndata: {"delta":"中文"}\r\n\r\n' +
        completed().replace(/\n/g, '\r\n'),
    )
    const pieces: Uint8Array[] = []
    for (let i = 0; i < wire.length; i++) pieces.push(wire.subarray(i, i + 1))
    expect(decodeAll(pieces)).toEqual([
      { type: 'text_delta', text: '中文' },
      { type: 'finish', finishReason: 'stop' },
    ])
  })

  it('falls back to the JSON type when there is no event line', () => {
    expect(decodeAll([`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'x' })}\n\n`])[0]).toEqual({
      type: 'text_delta',
      text: 'x',
    })
  })

  it('streams parallel function calls keyed by item id', () => {
    const events = decodeAll([
      sse('response.output_item.added', { item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'Read' } }),
      sse('response.output_item.added', { item: { type: 'function_call', id: 'fc_2', call_id: 'call_2', name: 'Grep' } }),
      sse('response.function_call_arguments.delta', { item_id: 'fc_2', delta: '{"p":' }),
      sse('response.function_call_arguments.delta', { item_id: 'fc_1', delta: '{}' }),
      sse('response.function_call_arguments.delta', { item_id: 'fc_2', delta: '1}' }),
      sse('response.function_call_arguments.delta', { item_id: 'unknown', delta: 'x' }),
      sse('response.function_call_arguments.done', { item_id: 'fc_1', arguments: '{}' }),
      sse('response.output_item.added', { item: { type: 'function_call', id: 'fc_3', name: 'Ls' } }),
      completed({ input_tokens: 5, output_tokens: 2 }),
    ])
    expect(events).toEqual([
      { type: 'tool_call_start', id: 'call_1', name: 'Read' },
      { type: 'tool_call_start', id: 'call_2', name: 'Grep' },
      { type: 'tool_call_delta', id: 'call_2', argsTextDelta: '{"p":' },
      { type: 'tool_call_delta', id: 'call_1', argsTextDelta: '{}' },
      { type: 'tool_call_delta', id: 'call_2', argsTextDelta: '1}' },
      // No call_id yet: the item id stands in (openai_provider.cc:1260).
      { type: 'tool_call_start', id: 'fc_3', name: 'Ls' },
      { type: 'finish', finishReason: 'tool_calls', usage: { promptTokens: 5, completionTokens: 2 } },
    ])
  })

  it('maps response.incomplete reasons', () => {
    const incomplete = (reason?: string) =>
      decodeAll([
        sse('response.incomplete', {
          response: { incomplete_details: reason ? { reason } : {}, usage: { input_tokens: 3, output_tokens: 9 } },
        }),
      ])
    expect(incomplete('max_output_tokens')).toEqual([
      { type: 'finish', finishReason: 'length', usage: { promptTokens: 3, completionTokens: 9 } },
    ])
    expect(incomplete('content_filter')[0]).toMatchObject({ finishReason: 'content_filter' })
    expect(incomplete()[0]).toMatchObject({ finishReason: 'stop' })
  })

  it('turns response.failed and error events into terminal errors', () => {
    expect(
      decodeAll([
        sse('response.output_text.delta', { delta: 'part' }),
        sse('response.failed', { response: { error: { code: 'server_is_overloaded', message: 'busy' } } }),
      ]),
    ).toEqual([
      { type: 'text_delta', text: 'part' },
      { type: 'error', message: 'server_is_overloaded: busy' },
    ])
    expect(decodeAll([sse('error', { type: 'error', message: 'plain failure' })])).toEqual([
      { type: 'error', message: 'plain failure' },
    ])
  })

  it('ends a stream without response.completed as finish(unknown)', () => {
    expect(decodeAll([sse('response.output_text.delta', { delta: 'a' }), 'event: response.output_text.delta\ndata: {"delta":"cut'])).toEqual([
      { type: 'text_delta', text: 'a' },
      { type: 'finish', finishReason: 'unknown' },
    ])
  })

  it('surfaces a 200 JSON error body as the done error', () => {
    expect(decodeAll(['{"detail":"The model is not supported when using Codex."}'])).toEqual([
      { type: 'error', message: 'HTTP 200: The model is not supported when using Codex.', httpStatus: 200 },
    ])
  })
})

describe('openaiResponsesDriver.errorFromResponse', () => {
  it('builds the canonical provider error with retry-after', () => {
    expect(
      openaiResponsesDriver.errorFromResponse({
        status: 429,
        statusText: 'Too Many Requests',
        headers: { 'Retry-After': '12' },
        bodyText: '{"error":{"message":"Rate limit reached","type":"requests"}}',
      }),
    ).toEqual({
      type: 'error',
      message: 'HTTP 429: Rate limit reached (retry-after: 12s)',
      httpStatus: 429,
      retryAfterSeconds: 12,
    })
    expect(
      openaiResponsesDriver.errorFromResponse({ status: 502, statusText: '', headers: { 'retry-after': 'Wed, 21 Oct' }, bodyText: '<html>' }),
    ).toEqual({ type: 'error', message: 'HTTP 502', httpStatus: 502 })
  })

  it('reads an error from SSE data frames', () => {
    expect(extractApiErrorMessage('event: error\r\ndata: {"error":{"message":"bad key"}}\r\n\r\n')).toBe('bad key')
  })
})

// Fixtures shared with the C++ openai_responses_error_unittest.cc.
describe('Responses error envelope (openai_responses_error_unittest.cc)', () => {
  it('ReadsCodexNestedErrorEnvelope', () => {
    const event = {
      error: {
        code: 'server_is_overloaded',
        message: 'Our servers are currently overloaded. Please try again later.',
        param: null,
        type: 'service_unavailable_error',
      },
      sequence_number: 2,
      type: 'error',
    }
    expect(extractResponsesApiErrorMessage(event)).toBe('Our servers are currently overloaded. Please try again later.')
    expect(extractResponsesApiErrorCode(event)).toBe('server_is_overloaded')
    expect(buildResponsesApiErrorMessage(event)).toBe(
      'server_is_overloaded: Our servers are currently overloaded. Please try again later.',
    )
  })
  it('ReadsFlatMessageShape', () => {
    const event = { type: 'error', message: 'Something went wrong.', code: 'server_error' }
    expect(buildResponsesApiErrorMessage(event)).toBe('server_error: Something went wrong.')
  })
  it('ReadsErrorAsBareString', () => {
    expect(buildResponsesApiErrorMessage({ type: 'error', error: 'upstream connect failure' })).toBe(
      'upstream connect failure',
    )
  })
  it('DoesNotTreatTopLevelTypeAsCode', () => {
    expect(extractResponsesApiErrorCode({ type: 'error', message: 'plain failure' })).toBe('')
  })
  it('DoesNotDoublePrefixCode', () => {
    expect(
      buildResponsesApiErrorMessage({ error: { code: 'rate_limit_exceeded', message: 'rate_limit_exceeded: slow down' } }),
    ).toBe('rate_limit_exceeded: slow down')
  })
  it('PreservesUnrecognizedEventVerbatim', () => {
    const built = buildResponsesApiErrorMessage({ type: 'error', detail: { nested: 'in a shape we do not know' } })
    expect(built).toBe('unrecognized error event: {"detail":{"nested":"in a shape we do not know"},"type":"error"}')
  })
  it('BoundsAnEnormousUnrecognizedEvent', () => {
    const built = buildResponsesApiErrorMessage({ type: 'error', junk: 'x'.repeat(8 * 1024) })
    expect(built.length).toBeLessThan(1024 + 128)
    expect(built).toContain('...(truncated)')
  })
  it('PrunesRequestPayloadFromTheDiagnosticEvent', () => {
    const diag = serializeEventForDiagnosis({
      type: 'response.failed',
      response: {
        id: 'resp_abc',
        status: 'failed',
        instructions: 'SYSTEM PROMPT',
        input: [{ role: 'user', content: 'secret question' }],
        output: [{ text: 'partial answer' }],
        error: { code: 'server_is_overloaded', message: 'overloaded' },
      },
    })
    expect(diag).toBe(
      '{"response":{"error":{"code":"server_is_overloaded","message":"overloaded"},"id":"resp_abc","status":"failed"},"type":"response.failed"}',
    )
  })
  it('TruncatesUnrecognizedEventOnACodepointBoundary', () => {
    const built = buildResponsesApiErrorMessage({ type: 'error', junk: '中'.repeat(2000) })
    expect(new TextEncoder().encode(built).length).toBeLessThan(1024 + 128)
    expect(built).toContain('...(truncated)')
    expect(built).not.toContain('�')
  })
  it('TreatsEmptyMessageAsUnrecognized', () => {
    expect(buildResponsesApiErrorMessage({ type: 'error', message: '', error: { message: '' } })).toMatch(
      /^unrecognized error event: /,
    )
  })
})

describe('openaiResponsesDriver byte-order mark, as the C++ provider reads it', () => {
  const BOM = new Uint8Array([0xef, 0xbb, 0xbf])
  const delta = (text: string) => sse('response.output_text.delta', { delta: text })

  it('a BOM before `data:` makes that line a non-data line, as C++ matches raw bytes', () => {
    // C++ ProcessSseLine checks starts_with("data:") on the raw line: the BOM
    // byte sequence defeats it and the first delta is lost.
    const lost = `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'lost' })}\n\n`
    const events = decodeAll([BOM, enc.encode(lost), delta('kept')])
    expect(events.filter(e => e.type === 'text_delta')).toEqual([{ type: 'text_delta', text: 'kept' }])
  })

  it('a BOM at the start of the JSON payload is skipped, as base::JSONReader does', () => {
    const events = decodeAll([
      enc.encode('event: response.output_text.delta\ndata: '),
      BOM,
      enc.encode(`${JSON.stringify({ delta: 'ok' })}\n\n`),
    ])
    expect(events.filter(e => e.type === 'text_delta')).toEqual([{ type: 'text_delta', text: 'ok' }])
  })
})

