/**
 * The Gemini runtime driver (models/drivers/geminiDriver.ts): request bodies, SSE decoding, thought-signature
 * replay across turns, finish / block mapping, usage, error responses and key placement.
 */
import { describe, expect, it } from 'vitest'
import type { BridgeModelRequestPayload } from '../browser/bridge/browserBridgeProtocol'
import {
  GEMINI_SKIP_SIGNATURE,
  buildGeminiStreamUrl,
  createGeminiDecoder,
  geminiDriver,
  requiresThoughtSignatures,
} from '../models/drivers/geminiDriver'
import { HostRequestError } from '../models/drivers/hostCallOptions'
import type { DriverStreamEvent, ProviderSpec } from '../models/drivers/driverTypes'
import { ModelProvider } from '../models/drivers/modelProvider'

const context = {
  providerId: 'google',
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  model: 'gemini-3.6-flash',
}

function build(payload: Partial<BridgeModelRequestPayload>, ctx = context) {
  return geminiDriver.buildRequest({ messages: [], ...payload } as BridgeModelRequestPayload, ctx)
}

function bodyText(payload: Partial<BridgeModelRequestPayload>, ctx = context): string {
  return new TextDecoder().decode(build(payload, ctx).body)
}

function body(payload: Partial<BridgeModelRequestPayload>, ctx = context): any {
  return JSON.parse(bodyText(payload, ctx))
}

const enc = new TextEncoder()

/** Gemini frames every payload as `data: <json>\r\n\r\n`. */
function sse(payloads: unknown[]): string {
  return payloads.map(p => `data: ${JSON.stringify(p)}\r\n\r\n`).join('')
}

function counterIds(): () => string {
  let n = 0
  return () => `call-${++n}`
}

function decodeAll(chunks: Uint8Array[], identity?: { providerId: string; model: string }): DriverStreamEvent[] {
  const decoder = createGeminiDecoder(counterIds(), identity)
  const out: DriverStreamEvent[] = []
  for (const c of chunks) out.push(...decoder.push(c))
  out.push(...decoder.end())
  return out
}

function decodeText(text: string, identity?: { providerId: string; model: string }): DriverStreamEvent[] {
  return decodeAll([enc.encode(text)], identity)
}

function splitEvery(bytes: Uint8Array, step: number): Uint8Array[] {
  const out: Uint8Array[] = []
  for (let i = 0; i < bytes.length; i += step) out.push(bytes.slice(i, i + step))
  return out
}

const zeroUsage = { promptTokens: 0, completionTokens: 0, promptCacheHits: 0 }

describe('gemini buildRequest', () => {
  it('targets :streamGenerateContent?alt=sse with the key in the x-goog-api-key header, never the URL', () => {
    const req = build({ messages: [{ role: 'user', content: 'hi' }] })
    expect(req.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:streamGenerateContent?alt=sse',
    )
    expect(req.method).toBe('POST')
    expect(req.headers).toEqual({ 'content-type': 'application/json', 'x-goog-api-key': '{{secret:api_key}}' })
    expect(req.queryParams).toBeUndefined()
    expect(req.url).not.toContain('key=')
  })

  it('drops exactly one trailing slash from the base URL', () => {
    expect(buildGeminiStreamUrl('https://x.test/v1beta/', 'm')).toBe(
      'https://x.test/v1beta/models/m:streamGenerateContent?alt=sse',
    )
    expect(buildGeminiStreamUrl('https://x.test/v1beta//', 'm')).toBe(
      'https://x.test/v1beta//models/m:streamGenerateContent?alt=sse',
    )
  })

  it('writes the exact body for a representative payload', () => {
    const text = bodyText(
      {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Look <here>' },
              { type: 'image', image: 'AAAA', mimeType: 'image/png' },
              { type: 'document', data: 'JVBE', mimeType: 'application/pdf' },
            ],
          },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Calling' },
              { type: 'tool-call', toolCallId: 'c1', toolName: 'Read', args: { path: '/a', limit: 5 } },
            ],
          },
          { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', result: '{"ok":true}' }] },
        ],
        systemPrompt: ['You are X', 'Be brief'],
        tools: [
          {
            type: 'function',
            name: 'Read',
            description: 'Read a file',
            parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
          },
        ],
        maxOutputTokens: 1024,
      } as Partial<BridgeModelRequestPayload>,
      { ...context, model: 'gemini-2.5-pro' },
    )
    expect(text).toBe(
      '{"contents":[{"parts":[{"text":"Look \\u003Chere>"},{"inlineData":{"data":"AAAA","mimeType":"image/png"}},{"inlineData":{"data":"JVBE","mimeType":"application/pdf"}}],"role":"user"},'
        + '{"parts":[{"text":"Calling"},{"functionCall":{"args":{"limit":5,"path":"/a"},"name":"Read"}}],"role":"model"},'
        + '{"parts":[{"functionResponse":{"name":"Read","response":{"output":{"ok":true}}}}],"role":"user"}],'
        + '"generationConfig":{"maxOutputTokens":1024,"thinkingConfig":{"includeThoughts":true}},'
        + '"systemInstruction":{"parts":[{"text":"You are X\\n\\nBe brief"}]},'
        + '"toolConfig":{"functionCallingConfig":{"mode":"AUTO"}},'
        + '"tools":[{"functionDeclarations":[{"description":"Read a file","name":"Read","parametersJsonSchema":{"properties":{"path":{"type":"string"}},"required":["path"],"type":"object"}}]}]}',
    )
  })

  it('always asks for thought summaries; omits systemInstruction / tools / toolConfig when there is nothing to send', () => {
    expect(bodyText({ messages: [{ role: 'user', content: 'hi' }] })).toBe(
      '{"contents":[{"parts":[{"text":"hi"}],"role":"user"}],"generationConfig":{"thinkingConfig":{"includeThoughts":true}}}',
    )
  })

  it('folds bridge system messages and the host instruction (with contexts) into systemInstruction', () => {
    const b = body({
      messages: [
        { role: 'system', content: 'Extra rule' },
        { role: 'user', content: 'hi' },
      ],
      systemPrompt: 'Base',
      userContext: { tz: 'UTC' },
    } as Partial<BridgeModelRequestPayload>)
    expect(b.systemInstruction).toEqual({
      parts: [{ text: 'Base\n\nUser context:\n- tz: UTC' }, { text: 'Extra rule' }],
    })
    expect(b.contents).toEqual([{ role: 'user', parts: [{ text: 'hi' }] }])
  })

  it('sends user images and documents as inlineData; a remote image URL and empty text are not sent', () => {
    const b = body({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '' },
            { type: 'image', image: 'IMG', mimeType: 'image/jpeg' },
            { type: 'image', image: 'NOMIME' },
            { type: 'image', image: 'https://example.com/a.png' },
            { type: 'document', data: 'PDF' },
          ],
        },
      ],
    } as Partial<BridgeModelRequestPayload>)
    expect(b.contents).toEqual([
      {
        role: 'user',
        parts: [
          { inlineData: { mimeType: 'image/jpeg', data: 'IMG' } },
          { inlineData: { mimeType: 'image/png', data: 'NOMIME' } },
          { inlineData: { mimeType: 'application/pdf', data: 'PDF' } },
        ],
      },
    ])
    // An empty text that is the whole turn is kept rather than losing the turn.
    expect(
      body({ messages: [{ role: 'user', content: [{ type: 'text', text: '' }] }] } as Partial<BridgeModelRequestPayload>)
        .contents,
    ).toEqual([{ role: 'user', parts: [{ text: '""' }] }])
  })

  it('round-trips tool calls and results: media lifted out of the response, failures under `error`', () => {
    const b = body(
      {
        messages: [
          { role: 'user', content: 'shoot' },
          {
            role: 'assistant',
            content: [
              { type: 'tool-call', toolCallId: 's1', toolName: 'Shot', args: '{"full":true}' },
              { type: 'tool-call', toolCallId: 's2', toolName: 'Other', args: '[1,2]' },
              { type: 'tool-call', toolCallId: 's3', toolName: 'Mixed', args: {} },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool-result',
                toolCallId: 's1',
                result: [
                  { type: 'text', text: 'captured' },
                  { type: 'image', image: 'IMG', mimeType: 'image/png' },
                  { type: 'image', image: 'JPG', mimeType: 'image/jpeg' },
                  { type: 'document', data: 'PDF' },
                  { type: 'image', image: '' },
                ],
              },
              { type: 'tool-result', toolCallId: 's2', result: 'boom', isError: true },
              { type: 'tool-result', toolCallId: 's3', result: [{ type: 'text', text: 'a' }, { kind: 'raw' }] },
              // Unknown id → no toolName → dropped.
              { type: 'tool-result', toolCallId: 'zz', result: 'lost' },
            ],
          },
          { role: 'user', content: 'next' },
        ],
      },
      { ...context, model: 'gemini-2.5-pro' },
    )
    expect(b.contents).toEqual([
      { role: 'user', parts: [{ text: 'shoot' }] },
      {
        role: 'model',
        parts: [
          { functionCall: { name: 'Shot', args: { full: true } } },
          // A JSON string that is not a dict sends no args at all.
          { functionCall: { name: 'Other' } },
          { functionCall: { name: 'Mixed', args: {} } },
        ],
      },
      {
        role: 'user',
        parts: [
          { functionResponse: { name: 'Shot', response: { output: 'captured' } } },
          { inlineData: { mimeType: 'image/png', data: 'IMG' } },
          { inlineData: { mimeType: 'image/jpeg', data: 'JPG' } },
          { inlineData: { mimeType: 'application/pdf', data: 'PDF' } },
          { functionResponse: { name: 'Other', response: { error: 'boom' } } },
          { functionResponse: { name: 'Mixed', response: { output: [{ type: 'text', text: 'a' }, { kind: 'raw' }] } } },
          // The following user turn merges into the same Gemini `user` content.
          { text: 'next' },
        ],
      },
    ])
    expect(JSON.stringify(b.contents[2])).not.toContain('"image"')
  })

  it('keeps int/double typing and sends the tool schema unchanged as parametersJsonSchema', () => {
    const text = bodyText({
      messages: [{ role: 'user', content: 'x' }],
      tools: [
        {
          type: 'function',
          name: 'T',
          parameters: {
            type: 'object',
            $schema: 'http://json-schema.org/draft-07/schema#',
            additionalProperties: false,
            properties: { n: { type: ['number', 'null'], minimum: 1.5, maximum: 10 } },
          },
          strict: true,
        },
      ],
    } as Partial<BridgeModelRequestPayload>)
    expect(text).toContain(
      '"parametersJsonSchema":{"$schema":"http://json-schema.org/draft-07/schema#","additionalProperties":false,"properties":{"n":{"maximum":10,"minimum":1.5,"type":["number","null"]}},"type":"object"}',
    )
    expect(text).not.toContain('"parameters"')
    expect(text).not.toContain('strict')
  })

  it('merges a providerBodyExtension generationConfig into the built one; other keys replace', () => {
    const b = body({
      messages: [{ role: 'user', content: 'x' }],
      maxOutputTokens: 4096,
      providerBodyExtension: {
        generationConfig: { thinkingConfig: { thinkingBudget: 1024 }, temperature: 0.2 },
        safetySettings: [{ category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' }],
      },
    } as Partial<BridgeModelRequestPayload>)
    expect(b.generationConfig).toEqual({
      maxOutputTokens: 4096,
      temperature: 0.2,
      thinkingConfig: { includeThoughts: true, thinkingBudget: 1024 },
    })
    expect(b.safetySettings).toEqual([{ category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' }])
    const off = body({
      messages: [{ role: 'user', content: 'x' }],
      providerBodyExtension: { generationConfig: { thinkingConfig: { includeThoughts: false } } },
    } as Partial<BridgeModelRequestPayload>)
    expect(off.generationConfig).toEqual({ thinkingConfig: { includeThoughts: false } })
  })

  it('rejects a payload the host would reject (INVALID_ARGS)', () => {
    expect(() =>
      build({
        messages: [{ role: 'user', content: 'x' }],
        tools: [{ type: 'function', name: 'T' }],
      } as unknown as Partial<BridgeModelRequestPayload>),
    ).toThrow(HostRequestError)
  })
})

describe('gemini thought signatures', () => {
  const identity = { providerId: 'google', model: 'gemini-3.6-flash' }
  const turn = sse([
    { candidates: [{ content: { role: 'model', parts: [{ text: 'weighing', thought: true }] } }] },
    {
      candidates: [
        {
          content: {
            role: 'model',
            parts: [
              { text: 'Reading both.' },
              { functionCall: { name: 'Read', args: { path: '/a' } }, thoughtSignature: 'SIG-A' },
              { functionCall: { name: 'Read', args: { path: '/b' } } },
            ],
          },
          finishReason: 'STOP',
        },
      ],
    },
  ])

  function signatureOf(events: DriverStreamEvent[]): string {
    const event = events.find(e => e.type === 'reasoning_signature') as
      | Extract<DriverStreamEvent, { type: 'reasoning_signature' }>
      | undefined
    if (!event) throw new Error('no reasoning_signature')
    return event.signature
  }

  it('emits one replay envelope, bound to provider + model, before the finish', () => {
    const events = decodeText(turn, identity)
    expect(events.map(e => e.type)).toEqual([
      'reasoning_delta', 'text_delta', 'tool_call', 'tool_call', 'reasoning_signature', 'finish',
    ])
    expect(signatureOf(events)).toBe(
      'velloc-replay-v1:{"field":"thoughtSignatures","model":"gemini-3.6-flash","provider":"google","value":[{"call":0,"signature":"SIG-A"}]}',
    )
  })

  it('a decoder without an identity, or a turn without signatures, emits no envelope', () => {
    expect(decodeText(turn).some(e => e.type === 'reasoning_signature')).toBe(false)
    const plain = sse([{ candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }] }])
    expect(decodeText(plain, identity).some(e => e.type === 'reasoning_signature')).toBe(false)
  })

  it('sends each signature back on the function call it came with, and a text signature on the last text', () => {
    const textTurn = sse([
      { candidates: [{ content: { parts: [{ text: 'Done.' }, { text: '', thoughtSignature: 'SIG-T' }] } }] },
    ])
    const callEnvelope = signatureOf(decodeText(turn, identity))
    const textEnvelope = signatureOf(decodeText(textTurn, identity))
    const b = body({
      messages: [
        { role: 'user', content: 'read a and b' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'weighing', signature: callEnvelope },
            { type: 'text', text: 'Reading both.' },
            { type: 'tool-call', toolCallId: 't1', toolName: 'Read', args: { path: '/a' } },
            { type: 'tool-call', toolCallId: 't2', toolName: 'Read', args: { path: '/b' } },
          ],
        },
        {
          role: 'tool',
          content: [
            { type: 'tool-result', toolCallId: 't1', toolName: 'Read', result: 'A' },
            { type: 'tool-result', toolCallId: 't2', toolName: 'Read', result: 'B' },
          ],
        },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Done.' },
            { type: 'thinking', thinking: '', signature: textEnvelope },
          ],
        },
        { role: 'user', content: 'thanks' },
      ],
    } as Partial<BridgeModelRequestPayload>)
    expect(b.contents[1]).toEqual({
      role: 'model',
      parts: [
        { text: 'Reading both.' },
        { functionCall: { name: 'Read', args: { path: '/a' } }, thoughtSignature: 'SIG-A' },
        { functionCall: { name: 'Read', args: { path: '/b' } } },
      ],
    })
    expect(b.contents[3]).toEqual({ role: 'model', parts: [{ text: 'Done.', thoughtSignature: 'SIG-T' }] })
  })

  it('history Gemini did not sign gets the skip value on its first call (Gemini 3+), nothing on 2.x', () => {
    const otherModel = 'velloc-replay-v1:{"field":"thoughtSignatures","model":"gemini-2.5-pro","provider":"google","value":[{"call":0,"signature":"OLD"}]}'
    const payload = {
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'from another model', signature: otherModel },
            { type: 'tool-call', toolCallId: 'x1', toolName: 'Glob', args: { pattern: '*' } },
            { type: 'tool-call', toolCallId: 'x2', toolName: 'Glob', args: { pattern: '**' } },
          ],
        },
        { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'x1', toolName: 'Glob', result: 'a' }] },
      ],
    } as Partial<BridgeModelRequestPayload>
    expect(body(payload).contents[1].parts).toEqual([
      { functionCall: { name: 'Glob', args: { pattern: '*' } }, thoughtSignature: GEMINI_SKIP_SIGNATURE },
      { functionCall: { name: 'Glob', args: { pattern: '**' } } },
    ])
    expect(body(payload, { ...context, model: 'gemini-2.5-flash' }).contents[1].parts).toEqual([
      { functionCall: { name: 'Glob', args: { pattern: '*' } } },
      { functionCall: { name: 'Glob', args: { pattern: '**' } } },
    ])
  })

  it('reads the generation from the model id', () => {
    expect(requiresThoughtSignatures('gemini-3.6-flash')).toBe(true)
    expect(requiresThoughtSignatures('models/gemini-3-pro-preview')).toBe(true)
    expect(requiresThoughtSignatures('gemini-10-ultra')).toBe(true)
    expect(requiresThoughtSignatures('gemini-2.5-pro')).toBe(false)
    expect(requiresThoughtSignatures('gemma-3-27b-it')).toBe(false)
  })
})

describe('gemini SSE decoding', () => {
  const stream = sse([
    {
      candidates: [{ content: { role: 'model', parts: [{ text: 'Let me think ü', thought: true }] } }],
      usageMetadata: { promptTokenCount: 100, cachedContentTokenCount: 40, thoughtsTokenCount: 7 },
    },
    { candidates: [{ content: { role: 'model', parts: [{ text: 'Hello 世界 😀' }] } }] },
    {
      candidates: [
        {
          content: {
            role: 'model',
            parts: [
              { functionCall: { name: 'Read', args: { path: '/a', n: 2 } } },
              { functionCall: { name: 'Grep', args: { q: 'x' } } },
            ],
          },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: {
        promptTokenCount: 120,
        candidatesTokenCount: 30,
        cachedContentTokenCount: 40,
        thoughtsTokenCount: 9,
        totalTokenCount: 159,
      },
    },
  ])

  const expected: DriverStreamEvent[] = [
    { type: 'reasoning_delta', text: 'Let me think ü' },
    { type: 'text_delta', text: 'Hello 世界 😀' },
    { type: 'tool_call', id: 'call-1', name: 'Read', input: { n: 2, path: '/a' } },
    { type: 'tool_call', id: 'call-2', name: 'Grep', input: { q: 'x' } },
    {
      type: 'finish',
      finishReason: 'stop',
      // Prompt exclusive of cache; output includes the thinking tokens.
      usage: { promptTokens: 80, completionTokens: 39, promptCacheHits: 40 },
    },
  ]

  it('decodes a whole stream', () => {
    expect(decodeText(stream)).toEqual(expected)
  })

  it.each([1, 2, 3, 5, 7, 64])('is independent of %i-byte chunk boundaries (incl. inside UTF-8 and \\r\\n)', step => {
    expect(decodeAll(splitEvery(enc.encode(stream), step))).toEqual(expected)
  })

  it('emits nothing terminal before end(); end() is idempotent and push after end is ignored', () => {
    const decoder = createGeminiDecoder(counterIds())
    expect(decoder.push(enc.encode(stream)).some(e => e.type === 'finish')).toBe(false)
    expect(decoder.end()).toHaveLength(1)
    expect(decoder.end()).toEqual([])
    expect(decoder.push(enc.encode(stream))).toEqual([])
  })

  it('maps finishReason: policy stops → content_filter with the reason, faulty calls → error', () => {
    const finishOf = (reason: string) =>
      decodeText(sse([{ candidates: [{ finishReason: reason }] }])).at(-1)
    expect(finishOf('STOP')).toMatchObject({ finishReason: 'stop' })
    expect(finishOf('MAX_TOKENS')).toMatchObject({ finishReason: 'length' })
    for (const reason of ['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY']) {
      expect(finishOf(reason)).toEqual({
        type: 'finish',
        finishReason: 'content_filter',
        usage: zeroUsage,
        stopDetails: { type: 'response_blocked', category: reason },
      })
    }
    for (const reason of [
      'MALFORMED_FUNCTION_CALL', 'UNEXPECTED_TOOL_CALL', 'TOO_MANY_TOOL_CALLS',
      'MISSING_THOUGHT_SIGNATURE', 'MALFORMED_RESPONSE',
    ]) {
      expect(finishOf(reason), reason).toMatchObject({ finishReason: 'error' })
    }
    expect(finishOf('LANGUAGE')).toMatchObject({ finishReason: 'other' })
    expect(finishOf('')).toMatchObject({ finishReason: 'unknown' })
  })

  it('a blocked prompt (promptFeedback, no candidates) ends as content_filter with the block reason and usage', () => {
    expect(
      decodeText(
        sse([{ promptFeedback: { blockReason: 'PROHIBITED_CONTENT' }, usageMetadata: { promptTokenCount: 5 } }]),
      ),
    ).toEqual([
      {
        type: 'finish',
        finishReason: 'content_filter',
        usage: { promptTokens: 5, completionTokens: 0, promptCacheHits: 0 },
        stopDetails: { type: 'prompt_blocked', category: 'PROHIBITED_CONTENT' },
      },
    ])
  })

  it('an in-stream error object ends the stream as a provider error; nothing follows it', () => {
    const decoder = createGeminiDecoder(counterIds())
    const events = decoder.push(
      enc.encode(
        sse([
          { candidates: [{ content: { parts: [{ text: 'partial' }] } }] },
          { error: { code: 503, message: 'The model is overloaded.', status: 'UNAVAILABLE' } },
          { candidates: [{ content: { parts: [{ text: 'after' }] } }] },
        ]),
      ),
    )
    expect(events).toEqual([
      { type: 'text_delta', text: 'partial' },
      { type: 'error', message: 'HTTP 503: The model is overloaded.', httpStatus: 503 },
    ])
    expect(decoder.end()).toEqual([])
  })

  it('ends without a finishReason → unknown, keeping the last usage seen', () => {
    expect(
      decodeText(
        sse([
          {
            candidates: [{ content: { parts: [{ text: 'a' }] } }],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, cachedContentTokenCount: 3 },
          },
          // A later payload without cachedContentTokenCount keeps the old value;
          // a non-int count (double) is ignored.
          {
            candidates: [{ content: { parts: [{ text: 'b' }] } }],
            usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 4.5 },
          },
        ]),
      ),
    ).toEqual([
      { type: 'text_delta', text: 'a' },
      { type: 'text_delta', text: 'b' },
      {
        type: 'finish',
        finishReason: 'unknown',
        usage: { promptTokens: 9, completionTokens: 2, promptCacheHits: 3 },
      },
    ])
  })

  it('clamps prompt tokens at 0 when the cache count exceeds it', () => {
    expect(
      decodeText(
        sse([{ candidates: [{}], usageMetadata: { promptTokenCount: 3, cachedContentTokenCount: 5 } }]),
      ).at(-1),
    ).toEqual({
      type: 'finish',
      finishReason: 'unknown',
      usage: { promptTokens: 0, completionTokens: 0, promptCacheHits: 5 },
    })
  })

  it('part-level rules', () => {
    expect(
      decodeText(
        sse([
          {
            candidates: [
              {
                content: {
                  parts: [
                    // thought + text: reasoning only — its functionCall is skipped.
                    { thought: true, text: 'plan', functionCall: { name: 'Skipped' } },
                    // thought with empty text falls through: its functionCall is emitted.
                    { thought: true, text: '', functionCall: { name: 'A' } },
                    // text and functionCall in one part: text first.
                    { text: 'both', functionCall: { name: 'B', args: { k: [1, 2.5, 'x<y'] } } },
                    // empty text skipped; no args → {}; empty name → absent.
                    { text: '' },
                    { functionCall: { name: '' } },
                    { thought: false, text: 'plain' },
                    'not-a-dict',
                    { functionCall: { name: 'C', args: [1] } },
                  ],
                },
              },
            ],
          },
        ]),
      ),
    ).toEqual([
      { type: 'reasoning_delta', text: 'plan' },
      { type: 'tool_call', id: 'call-1', name: 'A', input: {} },
      { type: 'text_delta', text: 'both' },
      { type: 'tool_call', id: 'call-2', name: 'B', input: { k: [1, 2.5, 'x<y'] } },
      { type: 'tool_call', id: 'call-3', name: undefined, input: {} },
      { type: 'text_delta', text: 'plain' },
      { type: 'tool_call', id: 'call-4', name: 'C', input: {} },
      { type: 'finish', finishReason: 'unknown', usage: zeroUsage },
    ])
  })

  it('only the first candidate counts; a non-dict first candidate drops its parts', () => {
    expect(
      decodeText(
        sse([
          {
            candidates: [
              { content: { parts: [{ text: 'one' }] } },
              { content: { parts: [{ text: 'two' }] } },
            ],
          },
          { candidates: ['x'] },
          { candidates: [] },
        ]),
      ),
    ).toEqual([
      { type: 'text_delta', text: 'one' },
      { type: 'finish', finishReason: 'unknown', usage: zeroUsage },
    ])
  })

  it('line handling: data:/data: prefixes, [DONE], non-data lines, bad JSON / UTF-8, unterminated tail', () => {
    const good = (t: string) => JSON.stringify({ candidates: [{ content: { parts: [{ text: t }] } }] })
    const bytes = [
      enc.encode(`: keep-alive\nevent: message\ndata:${good('nospace')}\n`),
      enc.encode('data: [DONE]\n'),
      enc.encode('data: {not json}\n'),
      // Invalid UTF-8 inside the JSON string: the payload is rejected.
      Uint8Array.of(...enc.encode('data: {"candidates":[{"content":{"parts":[{"text":"'), 0xff, ...enc.encode('"}]}}]}\n')),
      // Two JSON lines inside one SSE event are two payloads (no data joining).
      enc.encode(`data: ${good('l1')}\ndata: ${good('l2')}\n\n`),
      // A trailing line with no '\n' is never parsed.
      enc.encode(`data: ${good('tail')}`),
    ]
    expect(decodeAll(bytes)).toEqual([
      { type: 'text_delta', text: 'nospace' },
      { type: 'text_delta', text: 'l1' },
      { type: 'text_delta', text: 'l2' },
      { type: 'finish', finishReason: 'unknown', usage: zeroUsage },
    ])
  })

  it('the driver decoder mints v4 uuids for tool calls', () => {
    const decoder = geminiDriver.createDecoder(context)
    const events = decoder.push(
      enc.encode(sse([{ candidates: [{ content: { parts: [{ functionCall: { name: 'X' } }] } }] }])),
    )
    expect(events).toHaveLength(1)
    const call = events[0] as Extract<DriverStreamEvent, { type: 'tool_call' }>
    expect(call.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('the driver decoder carries the request context into the envelope', () => {
    const decoder = geminiDriver.createDecoder({ ...context, providerId: 'gw', model: 'gemini-3.8-flash' })
    decoder.push(enc.encode(sse([{ candidates: [{ content: { parts: [{ functionCall: { name: 'X' }, thoughtSignature: 'S' }] } }] }])))
    const signature = decoder.end().find(e => e.type === 'reasoning_signature') as { signature: string }
    expect(signature.signature).toContain('"model":"gemini-3.8-flash","provider":"gw"')
  })
})

describe('gemini errorFromResponse', () => {
  const error = (status: number, bodyText: string, headers: Record<string, string> = {}) =>
    geminiDriver.errorFromResponse({ status, statusText: '', headers, bodyText })

  it('400 invalid API key (Google error envelope)', () => {
    expect(
      error(
        400,
        JSON.stringify({
          error: {
            code: 400,
            message: 'API key not valid. Please pass a valid API key.',
            status: 'INVALID_ARGUMENT',
            details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' }],
          },
        }),
      ),
    ).toEqual({
      type: 'error',
      message: 'HTTP 400: API key not valid. Please pass a valid API key.',
      httpStatus: 400,
    })
  })

  it('429 with Retry-After in any header case', () => {
    expect(
      error(
        429,
        '{"error":{"code":429,"message":"Resource has been exhausted (e.g. check quota).","status":"RESOURCE_EXHAUSTED"}}',
        { 'retry-after': '30' },
      ),
    ).toEqual({
      type: 'error',
      message: 'HTTP 429: Resource has been exhausted (e.g. check quota). (retry-after: 30s)',
      httpStatus: 429,
      retryAfterSeconds: 30,
    })
  })

  it('503 overloaded; a JSON-array or unrecognized body falls back to the bare status', () => {
    expect(error(503, '{"error":{"code":503,"message":"The model is overloaded. Please try again later.","status":"UNAVAILABLE"}}')).toEqual({
      type: 'error',
      message: 'HTTP 503: The model is overloaded. Please try again later.',
      httpStatus: 503,
    })
    expect(error(503, '[{"error":{"code":503,"message":"overloaded"}}]')).toEqual({
      type: 'error',
      message: 'HTTP 503',
      httpStatus: 503,
    })
    expect(error(502, '<html>Bad Gateway</html>', { 'Retry-After': 'Wed, 21 Oct 2015 07:28:00 GMT' })).toEqual({
      type: 'error',
      message: 'HTTP 502',
      httpStatus: 502,
    })
  })
})

describe('gemini byte-order mark', () => {
  const BOM = new Uint8Array([0xef, 0xbb, 0xbf])
  const textChunk = (text: string) => ({ candidates: [{ content: { parts: [{ text }] } }] })

  it('a BOM before `data:` drops that line', () => {
    const events = decodeAll([BOM, enc.encode(sse([textChunk('lost'), textChunk('kept')]))])
    expect(events.filter(e => e.type === 'text_delta')).toEqual([{ type: 'text_delta', text: 'kept' }])
  })

  it('a BOM at the start of the JSON payload is skipped by the reader', () => {
    const events = decodeAll([enc.encode('data: '), BOM, enc.encode(`${JSON.stringify(textChunk('ok'))}\n`)])
    expect(events.filter(e => e.type === 'text_delta')).toEqual([{ type: 'text_delta', text: 'ok' }])
  })
})

describe('gemini key placement through ModelProvider', () => {
  const baseUrl = 'https://gateway.example/v1beta'
  const provider = (extra: Partial<ProviderSpec> = {}) =>
    new ModelProvider({ id: 'gw', format: 'gemini', ...extra } as ProviderSpec, geminiDriver, baseUrl)
  const payload = { messages: [] } as unknown as BridgeModelRequestPayload

  it('model calls and documents carry the key in x-goog-api-key, never ?key=', () => {
    const request = provider().buildRequest(payload, 'gemini-3.6-flash')
    expect(request.headers['x-goog-api-key']).toBe('{{secret:api_key}}')
    expect(request.queryParams).toBeUndefined()
    const listing = provider().documentRequest('/models')
    expect(listing.headers?.['x-goog-api-key']).toBe('{{secret:api_key}}')
    expect(listing.queryParams).toBeUndefined()
  })

  it('a spec that needs ?key= drops the header and adds the query parameter', () => {
    const request = provider({
      headers: { 'x-goog-api-key': '' },
      queryParams: { key: '{{secret:api_key}}' },
    }).buildRequest(payload, 'gemini-3.6-flash')
    expect(request.headers['x-goog-api-key']).toBeUndefined()
    expect(request.queryParams).toEqual({ key: '{{secret:api_key}}' })
  })
})
