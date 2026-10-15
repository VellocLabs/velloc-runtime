import { describe, expect, it } from 'vitest'

import type { BridgeModelRequestPayload } from '../browser/bridge/browserBridgeProtocol'
import { DriverChunkEmitter } from '../models/drivers/chunkEmitter'
import { encodeReasoningReplaySignature } from '../models/drivers/hostCallOptions'
import { parseHostJson, hostValueToJs, type HostDict } from '../models/drivers/hostValue'
import {
  ChatCompletionReasoningDetailsAccumulator,
  documentUnavailableMarker,
  extractChatCompletionReasoningText,
  imageUrlForPart,
  normalizeChatCompletionUsage,
  openaiChatDriver,
} from '../models/drivers/openaiChatDriver'
import type { DriverStreamEvent } from '../models/drivers/driverTypes'

const context = { providerId: 'acme', baseUrl: 'https://api.example.com/v1', model: 'gpt-x' }

function bodyText(p: BridgeModelRequestPayload): string {
  return new TextDecoder().decode(openaiChatDriver.buildRequest(p, context).body)
}

function body(p: BridgeModelRequestPayload): Record<string, unknown> {
  return JSON.parse(bodyText(p)) as Record<string, unknown>
}

function messagesOf(p: BridgeModelRequestPayload): Array<Record<string, unknown>> {
  return body(p).messages as Array<Record<string, unknown>>
}

function dict(json: string): HostDict {
  return parseHostJson(json) as HostDict
}

describe('openaiChatDriver.buildRequest', () => {
  it('builds the exact C++ request: URL, headers and byte-identical body', () => {
    const request = openaiChatDriver.buildRequest(
      {
        systemPrompt: ['You are X.', 'Be brief.'],
        userContext: { cwd: '/w' },
        messages: [
          { role: 'user', content: 'Hello <world>' },
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'hmm', signature: 's' },
              { type: 'text', text: 'Let me look.' },
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
            parameters: {
              type: 'object',
              properties: { path: { type: 'string' } },
              required: ['path'],
              additionalProperties: false,
            },
            strict: true,
          },
        ],
        maxOutputTokens: 4096,
        providerBodyExtension: { temperature: 0.5, max_completion_tokens: 100, reasoning_effort: 'high' },
      },
      context,
    )
    expect(request.url).toBe('https://api.example.com/v1/chat/completions')
    expect(request.method).toBe('POST')
    expect(request.headers).toEqual({
      authorization: 'Bearer {{secret:api_key}}',
      'content-type': 'application/json',
    })
    expect(new TextDecoder().decode(request.body)).toBe(
      String.raw`{"max_completion_tokens":100,"messages":[{"content":"You are X.\n\nBe brief.\n\nUser context:\n- cwd: /w","role":"system"},{"content":"Hello ${'\\'}u003Cworld>","role":"user"},{"content":"Let me look.","role":"assistant","tool_calls":[{"function":{"arguments":"{\"limit\":10,\"path\":\"/a.txt\"}","name":"Read"},"id":"call_1","type":"function"}]},{"content":"file body","role":"tool","tool_call_id":"call_1"}],"model":"gpt-x","reasoning_effort":"high","stream":true,"stream_options":{"include_usage":true},"temperature":0.5,"tool_choice":"auto","tools":[{"function":{"description":"Read a file","name":"Read","parameters":{"additionalProperties":false,"properties":{"path":{"type":"string"}},"required":["path"],"type":"object"},"strict":true},"type":"function"}]}`,
    )
  })

  it('omits tools, tool_choice and max_completion_tokens when absent; joins base URL verbatim', () => {
    expect(bodyText({ messages: [{ role: 'user', content: 'x' }] })).toBe(
      '{"messages":[{"content":"x","role":"user"}],"model":"gpt-x","stream":true,"stream_options":{"include_usage":true}}',
    )
    const request = openaiChatDriver.buildRequest(
      { messages: [] },
      { ...context, baseUrl: 'https://x/v1/' },
    )
    expect(request.url).toBe('https://x/v1//chat/completions')
  })

  it('providerBodyExtension overwrites top-level keys wholesale (no deep merge)', () => {
    const b = body({
      messages: [],
      providerBodyExtension: { stream_options: { foo: 1 }, model: 'override', thinking: { type: 'enabled' } },
    })
    expect(b.stream_options).toEqual({ foo: 1 })
    expect(b.model).toBe('override')
    expect(b.thinking).toEqual({ type: 'enabled' })
  })

  it('user images become image_url parts; documents become the unavailable marker', () => {
    const [msg] = messagesOf({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look' },
            { type: 'image', image: 'AAAA', mimeType: 'image/jpeg' },
            { type: 'image', image: 'https://x/a.png' },
            { type: 'image', image: 'BBBB' },
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
        { type: 'image_url', image_url: { url: 'https://x/a.png' } },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,BBBB' } },
        { type: 'text', text: documentUnavailableMarker('application/pdf') },
      ],
    })
  })

  it('text-only user content with a document collapses to one string', () => {
    const [msg] = messagesOf({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'see' }, { type: 'document', data: 'D', mimeType: 'text/plain' }] }],
    })
    expect(msg.content).toBe('see\n' + documentUnavailableMarker('text/plain'))
  })

  it('assistant: tool calls only → no content; nothing → empty content; non-object args → "{}"', () => {
    const msgs = messagesOf({
      messages: [
        { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'a', toolName: 'T', args: [1, 2] as never }] },
        { role: 'assistant', content: [{ type: 'text', text: '' }] },
      ],
    })
    expect(msgs[0]).toEqual({
      role: 'assistant',
      tool_calls: [{ type: 'function', id: 'a', function: { name: 'T', arguments: '{}' } }],
    })
    // The bridge text "" became `""` in the host (FormatTextValue).
    expect(msgs[1]).toEqual({ role: 'assistant', content: '""' })
  })

  it('tool results: JSON-looking strings are re-serialized by the host', () => {
    const msgs = messagesOf({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'tool-result', toolCallId: 'a', result: '42' },
            { type: 'tool-result', toolCallId: 'b', result: '1.0' },
            { type: 'tool-result', toolCallId: 'c', result: { z: 1, a: '<' } },
            { type: 'tool-result', toolCallId: 'd', result: '"quoted"' },
            { type: 'tool-result', toolCallId: 'e', result: 'null' },
          ],
        },
      ],
    })
    expect(msgs.map(m => m.content)).toEqual(['42', '1.0', '{"a":"\\u003C","z":1}', 'quoted', 'null'])
  })

  // Fixtures shared with the C++ openai_tool_result_messages_unittest.cc
  describe('tool-result messages (openai_tool_result_messages_unittest.cc)', () => {
    const text = (t: string) => ({ type: 'text', text: t })
    const image = (data: string, mimeType: string) => ({ type: 'image', image: data, mimeType })
    const result = (id: string, parts: unknown[]) => ({ type: 'tool-result', toolCallId: id, result: parts })
    const toolTurn = (...parts: unknown[]): BridgeModelRequestPayload => ({
      messages: [{ role: 'user', content: parts as never }],
    })

    it('ChatEmitsOneToolMessagePerResultPart', () => {
      expect(messagesOf(toolTurn(result('call_a', [text('result A')]), result('call_b', [text('result B')])))).toEqual([
        { role: 'tool', tool_call_id: 'call_a', content: 'result A' },
        { role: 'tool', tool_call_id: 'call_b', content: 'result B' },
      ])
    })

    it('ChatDefersImageUserMessageUntilAfterBatch', () => {
      const msgs = messagesOf(
        toolTurn(result('call_a', [text('shot'), image('AAAA', 'image/png')]), result('call_b', [text('result B')])),
      )
      expect(msgs).toEqual([
        { role: 'tool', tool_call_id: 'call_a', content: 'shot' },
        { role: 'tool', tool_call_id: 'call_b', content: 'result B' },
        {
          role: 'user',
          content: [
            text('The images below were returned by the tool calls above, grouped by tool call id.'),
            text('Tool call call_a:'),
            text('shot'),
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
          ],
        },
      ])
    })

    it('ChatStringResultPassesThrough', () => {
      expect(messagesOf(toolTurn({ type: 'tool-result', toolCallId: 'call_a', result: 'plain' }))).toEqual([
        { role: 'tool', tool_call_id: 'call_a', content: 'plain' },
      ])
    })

    it('ChatLabelsHoistedImagesPerToolCall', () => {
      const pdf = (id: string, path: string, img: string) =>
        result(id, [
          text(`PDF file read: ${path} (pages 1-1 of 1)`),
          text('\n<page number="1">'),
          image(img, 'image/jpeg'),
          text('</page>'),
        ])
      const msgs = messagesOf(toolTurn(pdf('call_a', 'a.pdf', 'AAAA'), pdf('call_b', 'b.pdf', 'BBBB'), pdf('call_c', 'c.pdf', 'CCCC')))
      expect(msgs).toHaveLength(4)
      expect(msgs[1].content).toBe('PDF file read: b.pdf (pages 1-1 of 1)\n\n<page number="1">\n</page>')
      const seq = (msgs[3].content as Array<Record<string, any>>).map(p =>
        p.type === 'image_url' ? `<img:${p.image_url.url}>` : p.text,
      )
      expect(seq.slice(1)).toEqual(
        ['a', 'b', 'c'].flatMap(x => [
          `Tool call call_${x}:`,
          `PDF file read: ${x}.pdf (pages 1-1 of 1)`,
          '\n<page number="1">',
          `<img:data:image/jpeg;base64,${x.toUpperCase().repeat(4)}>`,
          '</page>',
        ]),
      )
    })

    it('ChatDoesNotRepeatLongTextAsCaption', () => {
      const msgs = messagesOf(toolTurn(result('call_a', [text('x'.repeat(301)), image('AAAA', 'image/png')])))
      expect(msgs).toHaveLength(2)
      expect((msgs[1].content as unknown[]).length).toBe(3)
    })

    it('ChatDocumentMarkerPointsToPageReads', () => {
      const msgs = messagesOf(toolTurn(result('call_a', [text('PDF file read: a.pdf'), { type: 'document', mimeType: 'application/pdf' }])))
      expect(msgs).toEqual([
        {
          role: 'tool',
          tool_call_id: 'call_a',
          content: 'PDF file read: a.pdf\n' + documentUnavailableMarker(undefined),
        },
      ])
      expect(documentUnavailableMarker('application/pdf')).toMatch(/^\[document: application\/pdf - .*cannot be shown through this provider.*pages parameter/)
    })
  })

  // openai_user_content_unittest.cc ImageUrlForPartWrapsRawData
  it('imageUrlForPart wraps raw data and defaults to image/png', () => {
    expect(imageUrlForPart(dict('{"type":"image","data":"AAAA"}'))).toBe('data:image/png;base64,AAAA')
    expect(imageUrlForPart(dict('{"type":"image"}'))).toBeUndefined()
  })
})

// ── Decoder ────────────────────────────────────────────────────────────────

const enc = new TextEncoder()

function sse(...frames: unknown[]): string {
  return frames.map(f => `data: ${typeof f === 'string' ? f : JSON.stringify(f)}\n\n`).join('')
}

function decodeWhole(text: string): DriverStreamEvent[] {
  const decoder = openaiChatDriver.createDecoder(context)
  return [...decoder.push(enc.encode(text)), ...decoder.end()]
}

function decodeByteWise(text: string): DriverStreamEvent[] {
  const decoder = openaiChatDriver.createDecoder(context)
  const bytes = enc.encode(text)
  const events: DriverStreamEvent[] = []
  for (let i = 0; i < bytes.length; i++) events.push(...decoder.push(bytes.subarray(i, i + 1)))
  return [...events, ...decoder.end()]
}

const delta = (d: Record<string, unknown>, finish: string | null = null) => ({
  choices: [{ index: 0, delta: d, finish_reason: finish }],
})

const zeroUsage = { promptTokens: 0, completionTokens: 0, promptCacheHits: 0, promptCacheWrites: 0 }

describe('openaiChatDriver decoder', () => {
  it('streams text, survives byte-wise splits inside UTF-8 and CRLF, and finishes with usage', () => {
    const body =
      sse(delta({ role: 'assistant', content: '' }), delta({ content: 'héllo ' }), delta({ content: '😀 wörld' }), delta({}, 'stop'))
        .replace(/\n/g, '\r\n')
      + sse({ choices: [], usage: { prompt_tokens: 1000, completion_tokens: 250, prompt_tokens_details: { cached_tokens: 990 } } }, '[DONE]')
    const expected: DriverStreamEvent[] = [
      { type: 'text_delta', text: 'héllo ' },
      { type: 'text_delta', text: '😀 wörld' },
      {
        type: 'finish',
        finishReason: 'stop',
        usage: { promptTokens: 10, completionTokens: 250, promptCacheHits: 990, promptCacheWrites: 0 },
      },
    ]
    expect(decodeWhole(body)).toEqual(expected)
    expect(decodeByteWise(body)).toEqual(expected)
  })

  it('emits reasoning before text on the same chunk, first reasoning source wins', () => {
    const events = decodeWhole(
      sse(
        delta({ reasoning_content: 'think', content: 'say' }),
        delta({ reasoning: 'r', reasoning_details: [{ type: 'reasoning.text', text: 'r' }] }),
        delta({ reasoning_details: [{ type: 'reasoning.text', text: 'a' }, { type: 'reasoning.encrypted', data: 'x' }, { type: 'reasoning.summary', summary: 'b' }] }),
      ),
    )
    expect(events.slice(0, 4)).toEqual([
      { type: 'reasoning_delta', text: 'think' },
      { type: 'text_delta', text: 'say' },
      { type: 'reasoning_delta', text: 'r' },
      { type: 'reasoning_delta', text: 'ab' },
    ])
  })

  it('extractChatCompletionReasoningText prefers reasoning_content, then reasoning', () => {
    expect(extractChatCompletionReasoningText(dict('{"reasoning_content":"","reasoning":"x"}'))).toBe('x')
    expect(extractChatCompletionReasoningText(dict('{"content":"x"}'))).toBe('')
  })

  it('correlates parallel tool calls streamed across deltas by index', () => {
    const tc = (index: number, id: string | undefined, name: string | undefined, args: string) => ({
      index,
      ...(id !== undefined ? { id } : {}),
      type: 'function',
      function: { ...(name !== undefined ? { name } : {}), arguments: args },
    })
    const events = decodeWhole(
      sse(
        delta({ tool_calls: [tc(0, 'call_a', 'Bash', ''), tc(1, 'call_b', 'Read', '')] }),
        delta({ tool_calls: [tc(0, '', undefined, '{"a":')] }),
        delta({ tool_calls: [tc(1, undefined, undefined, '{"b":2}')] }),
        delta({ tool_calls: [tc(0, 'call_a', 'Bash', '1}')] }),
        delta({}, 'tool_calls'),
        { choices: [], usage: { prompt_tokens: 5, completion_tokens: 6 } },
      ),
    )
    expect(events).toEqual([
      { type: 'tool_call_start', id: 'call_a', name: 'Bash' },
      { type: 'tool_call_start', id: 'call_b', name: 'Read' },
      { type: 'tool_call_delta', id: 'call_a', name: 'Bash', argsTextDelta: '{"a":' },
      { type: 'tool_call_delta', id: 'call_b', name: 'Read', argsTextDelta: '{"b":2}' },
      { type: 'tool_call_delta', id: 'call_a', name: 'Bash', argsTextDelta: '1}' },
      // Host `finish`: FlushPendingToolCalls (start order, host-parsed input)
      // before QueueFinishEvent.
      { type: 'tool_call', id: 'call_a', name: 'Bash', input: { a: 1 } },
      { type: 'tool_call', id: 'call_b', name: 'Read', input: { b: 2 } },
      { type: 'finish', finishReason: 'tool_calls', usage: { promptTokens: 5, completionTokens: 6, promptCacheHits: 0, promptCacheWrites: 0 } },
    ])
  })

  it('a second index reusing a tool-call id resets the host entry (tool-call-streaming-start)', () => {
    const events = decodeWhole(
      sse(
        delta({ tool_calls: [{ index: 0, id: 'dup', function: { name: 'Read', arguments: '{"x":1}' } }] }),
        delta({ tool_calls: [{ index: 1, id: 'dup', function: { arguments: '{"y":2}' } }] }),
        delta({}, 'tool_calls'),
      ),
    )
    expect(events.filter(e => e.type === 'tool_call')).toEqual([{ type: 'tool_call', id: 'dup', input: { y: 2 } }])
    // On the bridge the host's input wins; the name falls back to the bridge
    // entry of the FIRST start (the bridge layer does not reset).
    const chunks = new DriverChunkEmitter().emit(events)
    expect(chunks.filter(c => c.type === 'content_block_start').map(c => c.content_block)).toEqual([
      { type: 'tool-call', toolCallId: 'dup', toolName: 'Read', args: { y: 2 } },
    ])
  })

  // openai_tool_call_stream_unittest.cc DashScopeEmptyIdRepeatOpensSingleToolCall
  it('opens a DashScope-style call once when id repeats as ""', () => {
    const events = decodeWhole(
      sse(
        delta({ tool_calls: [{ index: 0, id: 'call_qwen_1', function: { name: 'Bash', arguments: '' } }] }),
        delta({ tool_calls: [{ index: 0, id: '', function: { name: null, arguments: '{"command":' } }] }),
        delta({ tool_calls: [{ index: 0, id: '', function: { arguments: '"git status"}' } }] }),
      ),
    )
    expect(events.filter(e => e.type === 'tool_call_start')).toEqual([{ type: 'tool_call_start', id: 'call_qwen_1', name: 'Bash' }])
    const deltas = events.filter(e => e.type === 'tool_call_delta') as Array<{ id: string; argsTextDelta: string }>
    expect(deltas.every(d => d.id === 'call_qwen_1')).toBe(true)
    expect(deltas.map(d => d.argsTextDelta).join('')).toBe('{"command":"git status"}')
  })

  it('parallel calls all reported at index 0 (Gemini) open one call per new id', () => {
    const events = decodeWhole(
      sse(
        delta({ tool_calls: [{ index: 0, id: 'a', function: { name: 'Read', arguments: '{"p":1}' } }] }),
        delta({ tool_calls: [{ index: 0, id: 'b', function: { name: 'Grep', arguments: '{"q":2}' } }] }),
        delta({}, 'tool_calls'),
      ),
    )
    expect(events.filter(e => e.type === 'tool_call')).toEqual([
      { type: 'tool_call', id: 'a', name: 'Read', input: { p: 1 } },
      { type: 'tool_call', id: 'b', name: 'Grep', input: { q: 2 } },
    ])
  })

  it('finish_reason with usage on the same chunk emits at once', () => {
    const events = decodeWhole(sse({ ...delta({ content: 'x' }, 'length'), usage: { prompt_tokens: 3, completion_tokens: 4 } }))
    expect(events[1]).toEqual({
      type: 'finish',
      finishReason: 'length',
      usage: { promptTokens: 3, completionTokens: 4, promptCacheHits: 0, promptCacheWrites: 0 },
    })
    expect(events).toHaveLength(2)
  })

  it('a finish_reason whose usage never arrives is flushed at end with zero usage', () => {
    expect(decodeWhole(sse(delta({ content: 'x' }, 'stop'), '[DONE]')).at(-1)).toEqual({
      type: 'finish',
      finishReason: 'stop',
      usage: zeroUsage,
    })
  })

  it('a stream with no finish_reason ends with finish(unknown)', () => {
    expect(decodeWhole(sse(delta({ content: 'x' }), '[DONE]')).at(-1)).toEqual({
      type: 'finish',
      finishReason: 'unknown',
      usage: zeroUsage,
    })
  })

  it('drops a final line that never got its newline (no DrainRemaining)', () => {
    const events = decodeWhole(sse(delta({ content: 'a' })) + `data: ${JSON.stringify(delta({ content: 'b' }))}`)
    expect(events.filter(e => e.type === 'text_delta')).toEqual([{ type: 'text_delta', text: 'a' }])
  })

  it('surfaces an in-stream error object at end in the canonical format', () => {
    const events = decodeWhole(sse(delta({ content: 'partial' }), { error: { message: 'boom', type: 'server_error' } }))
    expect(events.at(-1)).toEqual({ type: 'error', message: 'HTTP 200: boom', httpStatus: 200 })
    expect(events.filter(e => e.type === 'finish')).toHaveLength(0)
  })

  it('ignores comments, non-data lines and malformed JSON', () => {
    const events = decodeWhole(': keep-alive\nevent: x\ndata: {bad\n\n' + sse(delta({ content: 'ok' }, 'stop')))
    expect(events.filter(e => e.type === 'text_delta')).toEqual([{ type: 'text_delta', text: 'ok' }])
  })

  it('keeps a BOM before `data:` (the line is dropped) but not one inside the JSON payload', () => {
    const events = decodeWhole(
      '﻿' + sse(delta({ content: 'lost' })) + 'data: ﻿' + JSON.stringify(delta({ content: 'kept' })) + '\n\n',
    )
    expect(events.filter(e => e.type === 'text_delta')).toEqual([{ type: 'text_delta', text: 'kept' }])
    expect(decodeByteWise('﻿' + sse(delta({ content: 'lost' }))).filter(e => e.type === 'text_delta')).toEqual([])
  })

  it('maps finish reasons through the host vocabulary', () => {
    const last = (fr: string) => decodeWhole(sse(delta({}, fr))).at(-1) as { finishReason: string }
    expect(last('tool_calls').finishReason).toBe('tool_calls')
    expect(last('content_filter').finishReason).toBe('content_filter')
    expect(last('function_call').finishReason).toBe('other')
  })
})

// OnStreamComplete(success=false): the buffered finish is flushed before the
// !success check; the host's terminal guard then drops the network error.
describe('openaiChatDriver decoder abort()', () => {
  const pushAll = (text: string) => {
    const decoder = openaiChatDriver.createDecoder(context)
    return { decoder, events: decoder.push(enc.encode(text)) }
  }

  it('flushes a finish_reason whose usage never arrived (pending tool calls first)', () => {
    const { decoder, events } = pushAll(
      sse(delta({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'Bash', arguments: '{"command":"ls"}' } }] }), delta({}, 'tool_calls')),
    )
    expect(events.map(e => e.type)).toEqual(['tool_call_start', 'tool_call_delta'])
    expect(decoder.abort!()).toEqual([
      { type: 'tool_call', id: 'c1', name: 'Bash', input: { command: 'ls' } },
      { type: 'finish', finishReason: 'tool_calls', usage: zeroUsage },
    ])
    // Once: a second abort (or end) adds nothing.
    expect(decoder.abort!()).toEqual([])
  })

  it('emits nothing without a buffered finish — no finish(unknown), no error-body check', () => {
    const { decoder } = pushAll(sse(delta({ content: 'partial' }), { error: { message: 'boom' } }))
    expect(decoder.abort!()).toEqual([])
  })

  it('emits nothing when the finish already went out with its usage', () => {
    const { decoder, events } = pushAll(sse({ ...delta({ content: 'x' }, 'stop'), usage: { prompt_tokens: 1, completion_tokens: 1 } }))
    expect(events.at(-1)!.type).toBe('finish')
    expect(decoder.abort!()).toEqual([])
  })
})

// openai_reasoning_unittest.cc + openai_provider.cc reasoning replay (84fe0bf).
describe('reasoning_details replay (openai-chat)', () => {
  const parse = (json: string) => parseHostJson(json) as HostDict

  it('AccumulatorMergesStreamedDetailsByIndex', () => {
    const acc = new ChatCompletionReasoningDetailsAccumulator()
    expect(acc.empty).toBe(true)
    acc.add(parse('{"reasoning_details": [{"type": "reasoning.text", "text": "First ", "format": "anthropic-claude-v1", "index": 0}]}'))
    acc.add(parse('{"content": "no details here"}'))
    acc.add(parse('{"reasoning_details": [{"type": "reasoning.text", "text": "I weigh it.", "signature": "", "index": 0}]}'))
    acc.add(parse('{"reasoning_details": [{"type": "reasoning.text", "text": "", "signature": "sig-1", "index": 0}]}'))
    acc.add(parse('{"reasoning_details": [{"type": "reasoning.encrypted", "data": "opaque", "index": 1}]}'))
    expect(acc.empty).toBe(false)
    const merged = acc.take()
    expect(acc.empty).toBe(true)
    expect(hostValueToJs(merged)).toEqual([
      { type: 'reasoning.text', text: 'First I weigh it.', signature: 'sig-1', format: 'anthropic-claude-v1', index: 0 },
      { type: 'reasoning.encrypted', data: 'opaque', index: 1 },
    ])
  })

  it('AccumulatorKeepsIndexlessFragmentsInOrder', () => {
    const acc = new ChatCompletionReasoningDetailsAccumulator()
    acc.add(parse('{"reasoning_details": [{"type": "reasoning.summary", "summary": "a"}, {"type": "reasoning.encrypted", "data": "b"}]}'))
    expect(hostValueToJs(acc.take())).toEqual([
      { type: 'reasoning.summary', summary: 'a' },
      { type: 'reasoning.encrypted', data: 'b' },
    ])
  })

  it('orders by int index; a double index counts as absent; null is skipped', () => {
    const acc = new ChatCompletionReasoningDetailsAccumulator()
    acc.add(parse('{"reasoning_details": [{"data": "two", "index": 2}, {"data": "neg", "index": -1, "id": null}, {"data": "implicit", "index": 1.0}]}'))
    // Implicit index after 2 is 3 (max(next, index + 1)).
    expect(hostValueToJs(acc.take())).toEqual([
      { data: 'neg', index: -1 },
      { data: 'two', index: 2 },
      { data: 'implicit', index: 1 },
    ])
  })

  const replayStream = sse(
    delta({ reasoning_details: [{ type: 'reasoning.text', text: 'weigh ', index: 0 }] }),
    delta({ reasoning_details: [{ type: 'reasoning.text', text: 'it', signature: 'sig-1', index: 0 }], content: 'Pick B.' }),
    delta({ reasoning_details: [{ type: 'reasoning.encrypted', data: 'opaque', index: 1 }] }, 'stop'),
    { choices: [], usage: { prompt_tokens: 2, completion_tokens: 3 } },
  )
  const expectedEnvelope =
    'velloc-replay-v1:{"field":"reasoning_details","model":"gpt-x","provider":"acme","value":[{"index":0,"signature":"sig-1","text":"weigh it","type":"reasoning.text"},{"data":"opaque","index":1,"type":"reasoning.encrypted"}]}'

  it('flushes one reasoning_signature (the host envelope) at finish_reason, before the finish', () => {
    const events = decodeWhole(replayStream)
    expect(events.map(e => e.type)).toEqual([
      'reasoning_delta', 'reasoning_delta', 'text_delta', 'reasoning_signature', 'finish',
    ])
    expect(events[3]).toEqual({ type: 'reasoning_signature', signature: expectedEnvelope })
    expect(decodeByteWise(replayStream)).toEqual(events)
    // On the bridge: a signature_delta on the thinking block (index 0).
    const chunks = new DriverChunkEmitter().emit(events)
    expect(chunks.filter(c => c.type === 'content_block_delta').at(-1)).toEqual({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'signature_delta', signature: expectedEnvelope },
    })
  })

  it('no reasoning_details → no signature; details without a finish_reason are never flushed', () => {
    expect(decodeWhole(sse(delta({ reasoning_content: 'r' }, 'stop'))).some(e => e.type === 'reasoning_signature')).toBe(false)
    expect(
      decodeWhole(sse(delta({ reasoning_details: [{ type: 'reasoning.encrypted', data: 'x' }] }))).some(
        e => e.type === 'reasoning_signature',
      ),
    ).toBe(false)
  })

  const assistantWith = (signature: string): BridgeModelRequestPayload => ({
    messages: [
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'weigh it', signature },
          { type: 'text', text: 'Pick B.' },
          { type: 'tool-call', toolCallId: 'c1', toolName: 'T', args: {} },
        ],
      },
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', result: 'ok' }] },
    ],
  })

  it('replays reasoning_details on the assistant message for the same provider + model (byte-exact)', () => {
    expect(bodyText(assistantWith(expectedEnvelope))).toBe(
      '{"messages":[{"content":"q","role":"user"},{"content":"Pick B.","reasoning_details":[{"index":0,"signature":"sig-1","text":"weigh it","type":"reasoning.text"},{"data":"opaque","index":1,"type":"reasoning.encrypted"}],"role":"assistant","tool_calls":[{"function":{"arguments":"{}","name":"T"},"id":"c1","type":"function"}]},{"content":"ok","role":"tool","tool_call_id":"c1"}],"model":"gpt-x","stream":true,"stream_options":{"include_usage":true}}',
    )
  })

  it('drops it after a provider or model switch, and for a non-envelope signature', () => {
    const noReplay = (p: BridgeModelRequestPayload, ctx = context) =>
      (JSON.parse(new TextDecoder().decode(openaiChatDriver.buildRequest(p, ctx).body)).messages[1] as Record<string, unknown>)
        .reasoning_details
    expect(noReplay(assistantWith(expectedEnvelope), { ...context, model: 'gpt-y' })).toBeUndefined()
    expect(noReplay(assistantWith(expectedEnvelope), { ...context, providerId: 'other' })).toBeUndefined()
    expect(noReplay(assistantWith('EqQBCkgIARABGAIi'))).toBeUndefined()
  })

  it('several replay blocks in one turn concatenate their arrays', () => {
    const env = (data: string) =>
      encodeReasoningReplaySignature('acme', 'gpt-x', parse(`{"field":"reasoning_details","value":[{"data":"${data}"}]}`))!
    const [, assistant] = messagesOf({
      messages: [
        { role: 'user', content: 'q' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: '', signature: env('a') },
            { type: 'text', text: 'x' },
            { type: 'thinking', thinking: '', signature: env('b') },
          ],
        },
      ],
    })
    expect(assistant).toEqual({ role: 'assistant', content: 'x', reasoning_details: [{ data: 'a' }, { data: 'b' }] })
  })
})

// openai_usage_unittest.cc
describe('normalizeChatCompletionUsage', () => {
  const norm = (json: string) => hostValueToJs(normalizeChatCompletionUsage(dict(json)))
  it('SubtractsCachedSubsetFromPromptTokens', () => {
    expect(norm('{"prompt_tokens":1000,"completion_tokens":250,"prompt_tokens_details":{"cached_tokens":990}}')).toEqual({
      promptTokens: 10,
      completionTokens: 250,
      promptCacheHits: 990,
    })
  })
  it('NoCachePassesThrough', () => {
    expect(norm('{"prompt_tokens":500,"completion_tokens":40}')).toEqual({ promptTokens: 500, completionTokens: 40 })
  })
  it('ClampsNegativePromptToZero', () => {
    expect(norm('{"prompt_tokens":100,"prompt_tokens_details":{"cached_tokens":150}}')).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      promptCacheHits: 150,
    })
  })
  it('a double-typed count reads as 0 (FindInt)', () => {
    expect(norm('{"prompt_tokens":5.0,"completion_tokens":2}')).toEqual({ promptTokens: 0, completionTokens: 2 })
  })
})

describe('openaiChatDriver.errorFromResponse', () => {
  const err = (status: number, bodyText: string, headers: Record<string, string> = {}) =>
    openaiChatDriver.errorFromResponse({ status, statusText: 'x', headers, bodyText })

  it('401 with an OpenAI error envelope', () => {
    expect(err(401, '{"error":{"message":"Incorrect API key provided","type":"invalid_request_error"}}')).toEqual({
      type: 'error',
      message: 'HTTP 401: Incorrect API key provided',
      httpStatus: 401,
    })
  })

  it('429 with Retry-After (any header case)', () => {
    expect(err(429, '{"error":{"message":"Rate limit reached"}}', { 'retry-after': '7' })).toEqual({
      type: 'error',
      message: 'HTTP 429: Rate limit reached (retry-after: 7s)',
      httpStatus: 429,
      retryAfterSeconds: 7,
    })
    expect(err(429, '', { 'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT' })).toEqual({
      type: 'error',
      message: 'HTTP 429',
      httpStatus: 429,
    })
  })

  it('an SSE-framed error body and an unrecognized body', () => {
    expect(err(400, 'data: {"error":{"message":"bad model"}}\n\n').message).toBe('HTTP 400: bad model')
    expect(err(502, '<html>Bad gateway</html>').message).toBe('HTTP 502')
  })
})
