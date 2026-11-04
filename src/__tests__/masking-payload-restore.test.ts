import { describe, expect, it } from 'vitest'
import type { BridgeModelRequestPayload } from '../browser/bridge/browserBridgeProtocol'
import type { DriverStreamEvent } from '../models/drivers/driverTypes'
import { compileMasking, type MaskingRule } from '../models/masking/maskingRules'
import { maskPayload, MaskingTally, PayloadMasker } from '../models/masking/maskPayload'
import { MaskingUndecodableError } from '../models/masking/egressGuard'
import { createRestoreFilter, type RestoreWhere } from '../models/masking/restoreStream'

const RULES: MaskingRule[] = [
  { match: 'AcmeCo', alias: 'Northwind' },
  { match: 'widget', alias: 'beacon' },
]
const masking = compileMasking(RULES)

function payload(): BridgeModelRequestPayload {
  return {
    messages: [
      { role: 'user', content: 'Fix the widget build for AcmeCo' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'the widget repo', signature: 'sig-widget' },
          { type: 'text', text: 'Reading widget/src' },
          { type: 'tool-call', toolCallId: 'c1', toolName: 'mcp__widget__read', args: { path: 'widget/a.ts', n: 3 } },
        ],
      },
      {
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: 'c1', toolName: 'mcp__widget__read', result: { out: 'origin git@AcmeCo/widget' } },
          { type: 'image', data: 'd2lkZ2V0', mimeType: 'image/png' },
        ],
      },
      { type: 'user', message: { role: 'user', content: 'nested widget' }, uuid: 'widget-uuid' },
    ],
    requestContext: { sessionId: 'widget-session', purpose: 'turn', querySource: 'sdk' },
    systemPrompt: ['You work on widget.', 'Owner: AcmeCo'],
    userContext: { projectNotes: 'widget rules' },
    systemContext: { gitStatus: 'branch widget' },
    providerId: 'widget-provider',
    model: 'widget-model',
    tools: [
      {
        type: 'function',
        name: 'mcp__widget__read',
        description: 'Read a widget file',
        parameters: { type: 'object', properties: { widget: { type: 'string', description: 'widget path', enum: ['widget'] } } },
      },
    ],
    providerBodyExtension: { metadata: { user: 'AcmeCo' } },
  }
}

describe('maskPayload', () => {
  it('masks the text the provider reads and leaves identifiers and bytes alone', () => {
    const original = payload()
    const snapshot = JSON.parse(JSON.stringify(original))
    const tally = new MaskingTally(false)
    const out = maskPayload(original, new PayloadMasker(masking, tally))

    expect(original).toEqual(snapshot)
    expect(out.messages[0]!.content).toBe('Fix the beacon build for Northwind')
    const assistant = out.messages[1]!.content as any[]
    expect(assistant[0]).toEqual({ type: 'thinking', thinking: 'the beacon repo', signature: 'sig-widget' })
    expect(assistant[1].text).toBe('Reading beacon/src')
    expect(assistant[2]).toMatchObject({ toolName: 'mcp__beacon__read', args: { path: 'beacon/a.ts', n: 3 } })
    const tool = out.messages[2]!.content as any[]
    expect(tool[0].result).toEqual({ out: 'origin git@Northwind/beacon' })
    expect(tool[1]).toBe((original.messages[2]!.content as any[])[1])
    expect((out.messages[3] as any).message.content).toBe('nested beacon')
    expect((out.messages[3] as any).uuid).toBe('widget-uuid')

    expect(out.requestContext).toBe(original.requestContext)
    expect(out.providerId).toBe('widget-provider')
    expect(out.model).toBe('widget-model')
    expect(out.systemPrompt).toEqual(['You work on beacon.', 'Owner: Northwind'])
    expect(out.userContext).toEqual({ projectNotes: 'beacon rules' })
    expect(out.systemContext).toEqual({ gitStatus: 'branch beacon' })
    expect(out.tools![0]).toEqual({
      type: 'function',
      name: 'mcp__beacon__read',
      description: 'Read a beacon file',
      parameters: { type: 'object', properties: { beacon: { type: 'string', description: 'beacon path', enum: ['beacon'] } } },
    })
    expect(out.providerBodyExtension).toEqual({ metadata: { user: 'Northwind' } })

    expect(tally.hits.get('messages')!.get(1)).toBe(8)
    expect(tally.hits.get('tools')!.get(1)).toBe(5)
    expect(tally.collisions.size).toBe(0)
  })

  it('shares untouched parts and records collisions and context', () => {
    const tally = new MaskingTally(true)
    const original: BridgeModelRequestPayload = {
      messages: [{ role: 'user', content: 'plain' }, { role: 'user', content: 'Northwind already, and AcmeCo' }],
    }
    const out = maskPayload(original, new PayloadMasker(masking, tally))
    expect(out.messages[0]).toBe(original.messages[0])
    expect([...tally.collisions]).toEqual(['messages'])
    expect(tally.contexts).toEqual([
      { rule: 0, where: 'messages', context: 'Northwind already, and ⟦Northwind⟧' },
    ])
  })
})

describe('maskPayload: what counts as opaque', () => {
  it('masks fields named data, image, document or signature in tool arguments, results and schemas', () => {
    const original: BridgeModelRequestPayload = {
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool-call', toolCallId: 'c', toolName: 'Write', args: { data: 'AcmeCo', image: 'widget', document: { signature: 'AcmeCo' } } }],
        },
        { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c', result: { data: 'from AcmeCo' } }] },
      ],
      tools: [{ type: 'function', name: 'Write', parameters: { properties: { data: { description: 'AcmeCo data' } } } }],
      providerBodyExtension: { data: 'AcmeCo' },
    }
    const out = maskPayload(original, new PayloadMasker(masking, new MaskingTally(false)))
    expect(JSON.stringify(out)).not.toMatch(/AcmeCo|widget/)
  })

  it('leaves image parts whole wherever they sit, and a thinking signature as is', () => {
    const image = { type: 'image', url: 'data:image/png;base64,AcmeCowidget', mimeType: 'image/png' }
    const original: BridgeModelRequestPayload = {
      messages: [
        { role: 'user', content: [image] },
        { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c', result: [image, { type: 'text', text: 'AcmeCo' }] }] },
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'AcmeCo', signature: 'AcmeCo-sig' }] },
      ],
    }
    const out = maskPayload(original, new PayloadMasker(masking, new MaskingTally(false)))
    expect((out.messages[0]!.content as any[])[0]).toBe(image)
    const nested = (out.messages[1]!.content as any[])[0].result
    expect(nested[0]).toBe(image)
    expect(nested[1].text).toBe('Northwind')
    expect((out.messages[2]!.content as any[])[0]).toEqual({ type: 'thinking', thinking: 'Northwind', signature: 'AcmeCo-sig' })
  })

  it('masks object keys in tool arguments and results, and restore puts them back', () => {
    const original: BridgeModelRequestPayload = {
      messages: [{ role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c', toolName: 'Edit', args: { AcmeCo: { widget: 1 } } }] }],
    }
    const out = maskPayload(original, new PayloadMasker(masking, new MaskingTally(false)))
    expect((out.messages[0]!.content as any[])[0].args).toEqual({ Northwind: { beacon: 1 } })
    const filter = createRestoreFilter(masking, () => {})
    const [call] = filter.apply([{ type: 'tool_call', id: 'c', name: 'Edit', input: { Northwind: { beacon: 1 } } }])
    expect((call as any).input).toEqual({ AcmeCo: { widget: 1 } })
  })

  it('masks a text/* document inside its base64, and leaves a PDF whole', () => {
    const b64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)))
    const text = { type: 'document', data: b64('notes about AcmeCo'), mimeType: 'text/plain' }
    const pdf = { type: 'document', data: b64('%PDF AcmeCo'), mimeType: 'application/pdf' }
    const out = maskPayload({ messages: [{ role: 'user', content: [text, pdf] }] }, new PayloadMasker(masking, new MaskingTally(false)))
    const [maskedText, keptPdf] = out.messages[0]!.content as any[]
    expect(new TextDecoder().decode(Uint8Array.from(atob(maskedText.data), c => c.charCodeAt(0)))).toBe('notes about Northwind')
    expect(keptPdf).toBe(pdf)
  })

  describe('a text/* document it cannot read as UTF-8 text', () => {
    const bytes = (values: number[]) => btoa(String.fromCharCode(...values))
    const latin1 = (text: string) => bytes([...text].map(c => c.charCodeAt(0)))
    const utf16le = (text: string) => bytes([...text].flatMap(c => [c.charCodeAt(0) & 0xff, c.charCodeAt(0) >> 8]))
    const mask = (part: Record<string, unknown>) =>
      maskPayload({ messages: [{ role: 'user', content: [part as never] }] }, new PayloadMasker(masking, new MaskingTally(false)))

    for (const [name, part] of [
      ['Latin-1 bytes', { type: 'document', data: latin1('AcmeCo caf\u00e9 plan'), mimeType: 'text/plain' }],
      ['UTF-16LE bytes', { type: 'document', data: bytes([0xff, 0xfe, ...[...'AcmeCo secret'].flatMap(c => [c.charCodeAt(0), 0])]), mimeType: 'text/plain; charset=utf-16' }],
      ['data that is not base64', { type: 'document', data: 'AcmeCo plan, not base64!', mimeType: 'text/markdown' }],
      ['data that is not a string', { type: 'document', data: { text: 'AcmeCo' }, mimeType: 'text/plain' }],
      ['an undecodable document field', { type: 'document', document: latin1('AcmeCo \u00e9'), mimeType: 'text/csv' }],
      ['one nested in a tool result', { type: 'tool-result', toolCallId: 't', content: [{ type: 'document', data: latin1('AcmeCo \u00e9'), media_type: 'TEXT/plain' }] }],
    ] as const) {
      it(`${name}: refused, never sent as it is`, () => {
        expect(() => mask(part)).toThrow(MaskingUndecodableError)
      })
    }

    it('UTF-16 without a byte-order mark (valid UTF-8 with NULs) is refused, keyword or not', () => {
      expect(() => mask({ type: 'document', data: utf16le('AcmeCo secret'), mimeType: 'text/plain' })).toThrow(MaskingUndecodableError)
      expect(() => mask({ type: 'document', data: utf16le('hello'), mimeType: 'text/plain' })).toThrow(MaskingUndecodableError)
    })

    it('a UTF-8 document with an accent is still masked, and a PDF still sent whole', () => {
      const b64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)))
      const out = mask({ type: 'document', data: b64('AcmeCo caf\u00e9'), mimeType: 'text/plain' })
      const [part] = out.messages[0]!.content as any[]
      expect(new TextDecoder().decode(Uint8Array.from(atob(part.data), c => c.charCodeAt(0)))).toBe('Northwind caf\u00e9')
      const pdf = { type: 'document', data: latin1('%PDF (AcmeCo) Tj \u00e9'), mimeType: 'application/pdf' }
      expect((mask(pdf).messages[0]!.content as any[])[0]).toBe(pdf)
    })
  })

  it('the log context never shows a neighbouring match in clear', () => {
    const tally = new MaskingTally(true)
    maskPayload({ messages: [{ role: 'user', content: 'AcmeCo and widget' }] }, new PayloadMasker(masking, tally))
    expect(tally.contexts!.map(c => c.context)).toEqual(['⟦Northwind⟧ and beacon', 'Northwind and ⟦beacon⟧'])
    expect(JSON.stringify(tally.contexts)).not.toMatch(/AcmeCo|widget/)
  })
})

function restoreAll(events: DriverStreamEvent[][]) {
  const hits: Array<[RestoreWhere, number]> = []
  const filter = createRestoreFilter(masking, (where, rule) => hits.push([where, rule]))
  const out = events.flatMap(batch => filter.apply(batch))
  out.push(...filter.flush())
  return { out, hits }
}

const textOf = (events: DriverStreamEvent[], type: 'text_delta' | 'reasoning_delta') =>
  events.filter(e => e.type === type).map(e => (e as { text: string }).text).join('')

describe('createRestoreFilter', () => {
  it('restores an alias split into one-character deltas', () => {
    const reply = 'Built beacon for Northwind, and beacon again.'
    const { out, hits } = restoreAll([...reply].map(ch => [{ type: 'text_delta', text: ch }]))
    expect(textOf(out, 'text_delta')).toBe('Built widget for AcmeCo, and widget again.')
    expect(hits).toEqual([['text', 1], ['text', 0], ['text', 1]])
  })

  it('keeps channels apart and flushes a held tail before another channel', () => {
    const { out } = restoreAll([
      [{ type: 'reasoning_delta', text: 'think bea' }],
      [{ type: 'reasoning_delta', text: 'con' }],
      [{ type: 'text_delta', text: 'see North' }],
      [{ type: 'tool_call_start', id: 't1', name: 'mcp__beacon__read' }],
      [{ type: 'tool_call_delta', id: 't1', argsTextDelta: '{"path":"bea' }],
      [{ type: 'tool_call_delta', id: 't1', argsTextDelta: 'con/x"}' }],
      [{ type: 'tool_call', id: 't1', name: 'mcp__beacon__read' }],
      [{ type: 'text_delta', text: 'wind' }],
      [{ type: 'finish', finishReason: 'tool_calls' }],
    ])
    expect(textOf(out, 'reasoning_delta')).toBe('think widget')
    // The text tail was flushed when the tool call opened: a split across
    // another channel is not joined.
    expect(textOf(out, 'text_delta')).toBe('see Northwind')
    expect(out.find(e => e.type === 'tool_call_start')).toEqual({ type: 'tool_call_start', id: 't1', name: 'mcp__widget__read' })
    const args = out
      .filter(e => e.type === 'tool_call_delta')
      .map(e => (e as { argsTextDelta?: string }).argsTextDelta ?? '')
      .join('')
    expect(args).toBe('{"path":"widget/x"}')
    expect(out.at(-1)).toEqual({ type: 'finish', finishReason: 'tool_calls' })
    const types = out.map(e => e.type)
    expect(types.indexOf('tool_call')).toBeLessThan(types.indexOf('finish'))
  })

  it('restores a whole tool input object, names and error messages', () => {
    const { out } = restoreAll([
      [{ type: 'tool_call', id: 'g1', name: 'beacon_tool', input: { path: 'beacon/a', list: ['Northwind', 2] } }],
      [{ type: 'error', message: 'Northwind quota exceeded', httpStatus: 429 }],
    ])
    expect(out).toEqual([
      { type: 'tool_call', id: 'g1', name: 'widget_tool', input: { path: 'widget/a', list: ['AcmeCo', 2] } },
      { type: 'error', message: 'AcmeCo quota exceeded', httpStatus: 429 },
    ])
  })

  it('releases a held tail at the end of the stream', () => {
    const { out } = restoreAll([[{ type: 'text_delta', text: 'ends with Nor' }]])
    expect(textOf(out, 'text_delta')).toBe('ends with Nor')
  })
})

describe('createRestoreFilter: argument text and anonymous calls', () => {
  const quoting = compileMasking([{ match: 'say "hi" C:\\x', alias: 'GREETING' }])

  it('puts a match back JSON-escaped in streamed tool arguments, so the arguments still parse', () => {
    const filter = createRestoreFilter(quoting, () => {})
    const out = [
      ...filter.apply([
        { type: 'tool_call_start', id: 't', name: 'Echo' },
        { type: 'tool_call_delta', id: 't', argsTextDelta: '{"text":"GREE' },
        { type: 'tool_call_delta', id: 't', argsTextDelta: 'TING"}' },
      ]),
      ...filter.flush(),
    ]
    const args = out.filter(e => e.type === 'tool_call_delta').map(e => (e as any).argsTextDelta).join('')
    expect(JSON.parse(args)).toEqual({ text: 'say "hi" C:\\x' })
  })

  it('keeps tool calls without an id apart: an alias split across two calls is not joined', () => {
    const filter = createRestoreFilter(masking, () => {})
    const out = [
      ...filter.apply([
        { type: 'tool_call_start', name: 'A' },
        { type: 'tool_call_delta', argsTextDelta: '{"a":"North' },
        { type: 'tool_call_start', name: 'B' },
        { type: 'tool_call_delta', argsTextDelta: 'wind"}' },
      ]),
      ...filter.flush(),
    ]
    const deltas = out.filter(e => e.type === 'tool_call_delta').map(e => (e as any).argsTextDelta)
    expect(deltas).toEqual(['{"a":"', 'North', 'wind"}'])
    expect(JSON.stringify(out)).not.toContain('AcmeCo')
  })
})
