import { describe, expect, it } from 'vitest'

import type { BridgeModelRequestPayload } from '../browser/bridge/browserBridgeProtocol'
import {
  HostRequestError,
  buildHostCallOptions,
  buildHostPrompt,
  buildHostRequest,
  buildProviderErrorMessage,
  buildSystemInstruction,
  buildToolUseInput,
  decodeReasoningReplaySignatureFor,
  encodeReasoningReplaySignature,
  extractApiErrorMessage,
  HostToolCallTracker,
  parseFinishReasonString,
  parseProviderErrorMessage,
} from '../models/drivers/hostCallOptions'
import {
  HostDouble,
  HostInt,
  hostValueToJs,
  parseHostJson,
  writeHostJson,
} from '../models/drivers/hostValue'

function payload(extra: Partial<BridgeModelRequestPayload>): BridgeModelRequestPayload {
  return { messages: [], ...extra }
}

function prompt(p: BridgeModelRequestPayload): unknown {
  return hostValueToJs(buildHostPrompt(buildHostRequest(p)))
}

describe('hostValue — byte-exact with base::JSONWriter / JSONReader', () => {
  it('escapes like EscapeJSONString: < and U+2028/9 escaped, / and non-ASCII raw', () => {
    expect(writeHostJson('</a>/é\u2028\u2029\u0001\u007f\t"\\')).toBe(
      '"\\u003C/a>/é\\u2028\\u2029\\u0001\u007f\\t\\\"\\\\"',
    )
  })

  it('writes dict keys in sorted UTF-8 byte order, not insertion or UTF-16 order', () => {
    const value = parseHostJson('{"b":1,"a":2,"Z":3,"\u{1F600}":4,"\uFF01":5,"é":6}')!
    expect(writeHostJson(value)).toBe('{"Z":3,"a":2,"b":1,"é":6,"\uFF01":5,"\u{1F600}":4}')
  })

  it('types numbers like JSONReader and prints doubles like JSONWriter', () => {
    expect(parseHostJson('1')).toEqual(new HostInt(1))
    expect(parseHostJson('1.0')).toEqual(new HostDouble(1))
    const cases: Array<[string, string]> = [
      ['1', '1'],
      ['-7', '-7'],
      ['1.0', '1.0'],
      ['1e2', '100.0'],
      ['0.5', '0.5'],
      ['2147483647', '2147483647'],
      ['2147483648', '2147483648.0'],
      ['3000000000000', '3e+12'],
      ['123456789012.5', '123456789012.5'],
      ['1e-7', '1e-7'],
      ['0.000001', '0.000001'],
      ['1e21', '1e+21'],
    ]
    for (const [input, written] of cases) {
      expect(writeHostJson(parseHostJson(input)!), input).toBe(written)
    }
  })

  it('rejects what JSON_PARSE_RFC rejects', () => {
    for (const bad of ['[1,]', '{"a":1,}', '1e400', '"\\ud800"', '"a\u0001"', "'x'", '01', '[1] x', '"\\x41"']) {
      expect(parseHostJson(bad), bad).toBeUndefined()
    }
    expect(parseHostJson(' {"a" : [true, false, null]} ')).toBeDefined()
  })
})

describe('buildSystemInstruction (BuildSystemInstruction + FormatContextSection)', () => {
  it('joins prompt blocks and context sections with a blank line', () => {
    const text = buildSystemInstruction(
      payload({
        systemPrompt: ['# Role\nYou are X.', '', '# Style\nBe brief.'],
        userContext: { b: 'two', a: 'one', Z: 'zed' },
        systemContext: { gitStatus: 'clean' },
        toolUseContext: { k: { n: 1, m: 'x<y' }, e: '', list: ['p', '', 'q'], num: 1.5 },
      }),
    )
    expect(text).toBe(
      [
        '# Role\nYou are X.',
        // An empty block is NOT skipped: FlattenTextValue('') writes `""`.
        '""',
        '# Style\nBe brief.',
        'User context:\n- Z: zed\n- a: one\n- b: two',
        'System context:\n- gitStatus: clean',
        // A dict flattens to JSONWriter output; an empty string is written
        // as JSON (`""`) by AppendFlattenedText's non-empty check.
        'Tool use context:\n- e: ""\n- k: {"m":"x\\u003Cy","n":1}\n- list: p\n""\nq\n- num: 1.5',
      ].join('\n\n'),
    )
  })

  it('accepts a single string prompt and omits empty sections', () => {
    expect(buildSystemInstruction(payload({ systemPrompt: 'Only this', userContext: {} }))).toBe('Only this')
    expect(buildSystemInstruction(payload({}))).toBe('')
  })
})

describe('host message translation (ConvertBridgeMessages → TranslateBridgeMessages)', () => {
  it('drops thinking, keeps text/tool-call, re-roles tool-result-only user messages', () => {
    const out = prompt(
      payload({
        systemPrompt: ['S'],
        messages: [
          { role: 'user', content: 'hi' },
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'secret', signature: 'sig' },
              { type: 'redacted_thinking', data: 'x' },
              { type: 'text', text: 'ok' },
              { type: 'tool-call', toolCallId: 'c1', toolName: 'Read', args: { path: '/a' } },
            ],
          },
          { role: 'assistant', content: [{ type: 'thinking', thinking: 'only' }] },
          {
            role: 'user',
            content: [{ type: 'tool-result', toolCallId: 'c1', result: '{"a":1}', isError: false }],
          },
        ],
      }),
    )
    expect(out).toEqual([
      { role: 'system', content: [{ type: 'text', text: 'S' }] },
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'ok' },
          { type: 'tool-call', toolCallId: 'c1', toolName: 'Read', args: { path: '/a' } },
        ],
      },
      {
        role: 'tool',
        content: [
          // toolName recovered from the earlier call; the JSON string result
          // is parsed (ParseToolPayloadValue).
          { type: 'tool-result', toolCallId: 'c1', toolName: 'Read', result: { a: 1 }, isError: false },
        ],
      },
    ])
  })

  it('normalizes images, documents and text quirks', () => {
    const out = prompt(
      payload({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: '' },
              { type: 'text', text: ['a', 'b'] } as never,
              'bare string' as never,
              { type: 'image', data: 'AAAA', mime_type: 'image/gif' },
              { type: 'image', image: '' },
              { type: 'document', data: 'PDF' },
              { type: 'document', data: '' },
            ],
          },
          { role: 'user', content: [] },
        ],
      }),
    )
    expect(out).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: '""' },
          { type: 'text', text: 'a\nb' },
          { type: 'text', text: 'bare string' },
          { type: 'image', image: 'AAAA', mimeType: 'image/gif' },
          { type: 'document', data: 'PDF', mimeType: 'application/pdf' },
        ],
      },
    ])
  })

  it('keeps a user message with mixed text + tool-result as role user', () => {
    const out = prompt(
      payload({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'tool-result', toolCallId: 'c9', result: 'r' },
              { type: 'text', text: 't' },
            ],
          },
        ],
      }),
    ) as Array<{ role: string }>
    expect(out[0].role).toBe('user')
  })

  it('rejects malformed payloads with the host INVALID_ARGS text', () => {
    const cases: Array<[BridgeModelRequestPayload, string]> = [
      [{ messages: 'x' } as never, 'LLM request "messages" must be an array'],
      [payload({ messages: [{ role: 'bogus', content: 'x' }] }), 'Bridge messages must include a valid role'],
      [
        payload({ messages: [{ role: 'user', content: [{ type: 'video' }] }] }),
        'Bridge content part type "video" is not supported',
      ],
      [
        payload({ messages: [{ role: 'assistant', content: [{ type: 'tool-call', toolCallId: '', toolName: 'X' }] }] }),
        'Bridge tool-call parts must include toolCallId',
      ],
      [
        payload({ tools: [{ type: 'function', name: 'X', parameters: {}, input_schema: {} } as never] }),
        'Bridge tool definitions must use parameters, not input_schema',
      ],
      [payload({ maxOutputTokens: 2 ** 31 }), '"maxOutputTokens" is out of range'],
    ]
    for (const [p, message] of cases) {
      expect(() => buildHostRequest(p)).toThrow(new HostRequestError(message))
    }
  })
})

describe('buildHostCallOptions', () => {
  it('carries tools (strict only when true), auto tool choice, max tokens and the extension', () => {
    const request = buildHostRequest(
      payload({
        tools: [
          { type: 'function', name: 'A', description: '', parameters: { type: 'object' }, strict: false },
          { type: 'function', name: 'B', parameters: { type: 'object' }, strict: true },
        ],
        maxOutputTokens: '25' as never,
        providerBodyExtension: { x: 1 },
      }),
    )
    const options = hostValueToJs(buildHostCallOptions(request, 'm')) as Record<string, unknown>
    expect(options.modelId).toBe('m')
    expect(options.maxTokens).toBe(25)
    expect(options.tool_choice).toBe('auto')
    expect(options.tools).toEqual([
      { type: 'function', name: 'A', parameters: { type: 'object' } },
      { type: 'function', name: 'B', parameters: { type: 'object' }, strict: true },
    ])
    expect(options.providerBodyExtension).toEqual({ x: 1 })
  })
})

describe('provider error text (llm_error_extract.cc)', () => {
  it('builds and parses the canonical shape', () => {
    expect(buildProviderErrorMessage(429, '12', 'slow down')).toBe('HTTP 429: slow down (retry-after: 12s)')
    expect(buildProviderErrorMessage(500, '', '')).toBe('HTTP 500')
    expect(buildProviderErrorMessage(503, 'Wed, 21 Oct 2026 07:28:00 GMT', '')).toBe('HTTP 503')
    expect(buildProviderErrorMessage(-1, '5', 'net')).toBe('net (retry-after: 5s)')
    expect(parseProviderErrorMessage('HTTP 429: slow down (retry-after: 12s)')).toEqual({
      httpStatus: 429,
      retryAfterSeconds: 12,
    })
    expect(parseProviderErrorMessage('HTTP 4291 nope')).toEqual({})
  })

  it('extracts messages from JSON bodies and SSE frames', () => {
    expect(extractApiErrorMessage('{"error":{"message":"bad key"}}')).toBe('bad key')
    expect(extractApiErrorMessage('{"error":"plain"}')).toBe('plain')
    expect(extractApiErrorMessage('{"detail":"codex"}')).toBe('codex')
    expect(extractApiErrorMessage('event: x\r\ndata: {"error":{"message":"framed"}}\r\n\r\n')).toBe('framed')
    expect(extractApiErrorMessage('data: {"choices":[]}\n\ndata: [DONE]\n')).toBe('')
    expect(extractApiErrorMessage('<html>502</html>')).toBe('')
  })

  it('maps finish reasons like ParseFinishReasonString', () => {
    expect(parseFinishReasonString('stop')).toBe('stop')
    expect(parseFinishReasonString('END-TURN')).toBe('stop')
    expect(parseFinishReasonString('max_tokens')).toBe('length')
    expect(parseFinishReasonString('tool_calls')).toBe('tool_calls')
    expect(parseFinishReasonString('content_filter')).toBe('content_filter')
    expect(parseFinishReasonString('function_call')).toBe('other')
    expect(parseFinishReasonString('')).toBe('unknown')
  })
})

// reasoning_replay_unittest.cc (custom_browser 84fe0bf)
describe('reasoning replay envelope (reasoning_replay.cc)', () => {
  const detailsReplayPart = () =>
    parseHostJson(
      '{"type":"reasoning-replay","field":"reasoning_details","value":[{"type":"reasoning.text","text":"think","signature":"sig-abc"}]}',
    ) as Map<string, never>

  it('RoundTripsForTheSameProviderAndModel', () => {
    const signature = encodeReasoningReplaySignature('custom-openai-1', 'anthropic/claude-sonnet-5.5', detailsReplayPart())
    // JSONWriter: sorted keys, `type` of the part is not carried.
    expect(signature).toBe(
      'velloc-replay-v1:{"field":"reasoning_details","model":"anthropic/claude-sonnet-5.5","provider":"custom-openai-1","value":[{"signature":"sig-abc","text":"think","type":"reasoning.text"}]}',
    )
    const part = decodeReasoningReplaySignatureFor(signature!, 'custom-openai-1', 'anthropic/claude-sonnet-5.5')
    expect(part && writeHostJson(part)).toBe(writeHostJson(detailsReplayPart()))
  })

  it('OtherProviderOrModelGetsNothing', () => {
    const signature = encodeReasoningReplaySignature('custom-openai-1', 'anthropic/claude-sonnet-5.5', detailsReplayPart())!
    expect(decodeReasoningReplaySignatureFor(signature, 'kimi', 'anthropic/claude-sonnet-5.5')).toBeUndefined()
    expect(decodeReasoningReplaySignatureFor(signature, 'custom-openai-1', 'google/gemini-3-pro')).toBeUndefined()
  })

  it('ForeignOrBrokenSignaturesGetNothing', () => {
    expect(decodeReasoningReplaySignatureFor('EqQBCkgIARABGAIi', 'p', 'm')).toBeUndefined()
    expect(decodeReasoningReplaySignatureFor('velloc-replay-v1:{not json', 'p', 'm')).toBeUndefined()
    expect(
      decodeReasoningReplaySignatureFor('velloc-replay-v1:{"provider":"p","model":"m","field":"f"}', 'p', 'm'),
    ).toBeUndefined()
    // null value and empty field are refused too.
    expect(
      decodeReasoningReplaySignatureFor('velloc-replay-v1:{"provider":"p","model":"m","field":"f","value":null}', 'p', 'm'),
    ).toBeUndefined()
    expect(
      decodeReasoningReplaySignatureFor('velloc-replay-v1:{"provider":"p","model":"m","field":"","value":1}', 'p', 'm'),
    ).toBeUndefined()
  })

  it('MalformedPartsAreNotEncoded', () => {
    expect(encodeReasoningReplaySignature('p', 'm', parseHostJson('{"value":"x"}') as never)).toBeUndefined()
    expect(encodeReasoningReplaySignature('p', 'm', parseHostJson('{"field":"reasoning_details"}') as never)).toBeUndefined()
    expect(encodeReasoningReplaySignature('p', 'm', parseHostJson('{"field":"f","value":null}') as never)).toBeUndefined()
    expect(encodeReasoningReplaySignature('', 'm', detailsReplayPart())).toBeUndefined()
    expect(encodeReasoningReplaySignature('p', '', detailsReplayPart())).toBeUndefined()
  })

  it('TranslateBridgeParts turns a same-provider+model thinking signature into a reasoning-replay part, in place', () => {
    const envelope = encodeReasoningReplaySignature('p', 'm', detailsReplayPart())!
    const request = buildHostRequest(
      payload({
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'hmm', signature: envelope },
              { type: 'thinking', thinking: 'anthropic', signature: 'EqQBCkgIARABGAIi' },
              { type: 'text', text: 'ok' },
            ],
          },
        ],
      }),
    )
    const promptOf = (providerId?: string, model = 'm') =>
      hostValueToJs(buildHostCallOptions(request, model, providerId).get('prompt')!)
    const replayPart = {
      type: 'reasoning-replay',
      field: 'reasoning_details',
      value: [{ signature: 'sig-abc', text: 'think', type: 'reasoning.text' }],
    }
    expect(promptOf('p')).toEqual([{ role: 'assistant', content: [replayPart, { type: 'text', text: 'ok' }] }])
    // Another provider or model, or a caller that does not name its provider:
    // every thinking block is dropped.
    const dropped = [{ role: 'assistant', content: [{ type: 'text', text: 'ok' }] }]
    expect(promptOf('q')).toEqual(dropped)
    expect(promptOf('p', 'other')).toEqual(dropped)
    expect(promptOf(undefined)).toEqual(dropped)
    expect(prompt(payload({ messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'x', signature: envelope }] }] }))).toEqual([])
  })
})

// nexus_llm_host.cc OnStreamChunk tool-call branches + FlushPendingToolCalls.
describe('HostToolCallTracker', () => {
  it('a repeated tool-call-streaming-start with the same id resets the host entry (args and name)', () => {
    const t = new HostToolCallTracker()
    expect(t.streamingStart('a', 'Read')).toEqual({ type: 'tool_call_start', id: 'a', name: 'Read' })
    expect(t.delta('a', undefined, '{"x":1}')).toEqual({ type: 'tool_call_delta', id: 'a', name: 'Read', argsTextDelta: '{"x":1}' })
    t.streamingStart('b', 'Bash')
    // Same id again, no name: fresh entry, kept in its original order slot.
    expect(t.streamingStart('a', '')).toEqual({ type: 'tool_call_start', id: 'a' })
    expect(t.delta('a', undefined, '{"y":2}')).toEqual({ type: 'tool_call_delta', id: 'a', argsTextDelta: '{"y":2}' })
    expect(t.flush()).toEqual([
      { type: 'tool_call', id: 'a', input: { y: 2 } },
      { type: 'tool_call', id: 'b', name: 'Bash', input: {} },
    ])
    expect(t.flush()).toEqual([])
  })

  it('an uncorrelated delta becomes a call of its own; a whole tool-call closes its pending entry', () => {
    const t = new HostToolCallTracker()
    const stray = t.delta(undefined, undefined, 'raw') as { id: string }
    expect(stray.id).toMatch(/^[0-9a-f-]{36}$/)
    t.streamingStart('c', 'X')
    t.delta('c', undefined, '{"k":"v"}')
    expect(t.complete('c', undefined, undefined)).toEqual({ type: 'tool_call', id: 'c', name: 'X', input: { k: 'v' } })
    expect(t.flush()).toEqual([{ type: 'tool_call', id: stray.id, input: 'raw' }])
  })

  it('BuildToolUseInput uses the host RFC reader', () => {
    expect(buildToolUseInput('')).toEqual({})
    expect(buildToolUseInput('{"a":[1,2.5]}')).toEqual({ a: [1, 2.5] })
    expect(buildToolUseInput('1e999')).toBe('1e999')
    // An escaped lone surrogate: JSON.parse accepts it, the host reader does not.
    expect(buildToolUseInput('"\\ud800"')).toBe('"\\ud800"')
    expect(buildToolUseInput('\uFEFF{"a":1}')).toEqual({ a: 1 })
  })
})
