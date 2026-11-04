import { describe, expect, it } from 'vitest'
import type { BridgeModelRequestPayload } from '../browser/bridge/browserBridgeProtocol'
import type { DriverStreamEvent } from '../models/drivers/driverTypes'
import { compileMasking, type MaskingHit } from '../models/masking/maskingRules'
import { maskPayload, PayloadMasker } from '../models/masking/maskPayload'
import { MAX_TRACE_ENTRIES, traceEntries, type ReplacementEntry } from '../models/masking/replacementTrace'
import { createRestoreFilter } from '../models/masking/restoreStream'

const masking = compileMasking([
  { match: 'AcmeCo', alias: 'Northwind' },
  { match: 'widget', alias: 'beacon' },
])

const pairs = (entries: readonly ReplacementEntry[]) => entries.map(entry => [entry.original, entry.replaced])

/** What the log holds for `raw`, cut from the whole string at once. */
function wholeStringEntries(raw: string): ReplacementEntry[] {
  const hits: MaskingHit[] = []
  const restored = masking.restoreText(raw, hit => hits.push(hit))
  const sink: ReplacementEntry[] = []
  traceEntries('in', 'text', raw, restored, hits, sink)
  return sink
}

function streamed(raw: string, size: number): ReplacementEntry[] {
  const filter = createRestoreFilter(masking)
  for (let i = 0; i < raw.length; i += size) {
    filter.apply([{ type: 'text_delta', text: raw.slice(i, i + size) }])
  }
  filter.flush()
  return filter.entries()
}

const RAW = [
  'Northwind opens the file.',
  ' lorem'.repeat(20),
  ' then beacon and beacon again,',
  ' ipsum'.repeat(12),
  ' and finally Northwind',
].join('')

describe('the log context of a streamed reply', () => {
  it('is the same whatever size the deltas come in', () => {
    const expected = pairs(wholeStringEntries(RAW))
    expect(expected).toHaveLength(4)
    for (const size of [1, 2, 3, 7, 49, 50, 51, 120, RAW.length]) {
      expect(pairs(streamed(RAW, size)), `delta size ${size}`).toEqual(expected)
    }
  })

  it('has 50 characters of the model text and of the restored text around each alias', () => {
    const [first, , third, last] = streamed(RAW, 5)
    expect(first!.original).toBe(RAW.slice(0, 'Northwind'.length + 50))
    expect(first!.replaced.startsWith('AcmeCo opens the file.')).toBe(true)
    expect(first!.replaced).toHaveLength('AcmeCo'.length + 50)
    // The third hit is the second 'beacon'; the aliases around it stay as the model wrote them.
    expect(third!.original).toContain('beacon and beacon again')
    expect(third!.replaced).toContain('widget and widget again')
    expect(last!.original.endsWith('and finally Northwind')).toBe(true)
    expect(last!.replaced.endsWith('and finally AcmeCo')).toBe(true)
  })

  it('keeps each channel apart and logs the other restored strings too', () => {
    const filter = createRestoreFilter(masking)
    const events: DriverStreamEvent[] = [
      { type: 'reasoning_delta', text: 'think Northwind ' },
      { type: 'text_delta', text: 'see beacon ' },
      { type: 'tool_call_start', id: 't', name: 'beacon_tool' },
      { type: 'tool_call_delta', id: 't', argsTextDelta: '{"path":"beacon/x"}' },
      { type: 'tool_call', id: 't', name: 'beacon_tool', input: { path: 'beacon/x' } },
      { type: 'error', message: 'Northwind quota' },
    ]
    filter.apply(events)
    filter.flush()
    const rows = filter.entries().map(entry => [entry.dir, entry.where, entry.original, entry.replaced])
    expect(rows).toEqual(expect.arrayContaining([
      ['in', 'reasoning', 'think Northwind ', 'think AcmeCo '],
      ['in', 'text', 'see beacon ', 'see widget '],
      ['in', 'tool_name', 'beacon_tool', 'widget_tool'],
      ['in', 'tool_args', '{"path":"beacon/x"}', '{"path":"widget/x"}'],
      ['in', 'error', 'Northwind quota', 'AcmeCo quota'],
    ]))
    // The name and arguments streamed first are not logged again on the call itself.
    expect(rows.filter(row => row[1] === 'tool_name')).toHaveLength(1)
    expect(rows).toHaveLength(5)
  })

  it('logs a tool call that was never streamed from its final event', () => {
    const filter = createRestoreFilter(masking)
    filter.apply([{ type: 'tool_call', id: 'u', name: 'beacon_tool', input: { path: 'beacon/x' } }])
    filter.flush()
    expect(filter.entries().map(entry => [entry.where, entry.original])).toEqual([
      ['tool_name', 'beacon_tool'],
      ['tool_args', 'beacon/x'],
    ])
  })

  it('completes an entry that is still waiting for text when the stream ends', () => {
    const filter = createRestoreFilter(masking)
    filter.apply([{ type: 'text_delta', text: 'ends with Northwind' }])
    filter.flush()
    expect(pairs(filter.entries())).toEqual([['ends with Northwind', 'ends with AcmeCo']])
  })

  it('lists entries oldest first and the same on a second call', () => {
    const filter = createRestoreFilter(masking)
    filter.apply([{ type: 'text_delta', text: 'Northwind' }])
    filter.apply([{ type: 'reasoning_delta', text: 'beacon' }])
    filter.flush()
    const first = filter.entries()
    expect(first.map(entry => entry.where)).toEqual(['text', 'reasoning'])
    expect(first.map((entry, i) => i === 0 || entry.at >= first[i - 1]!.at)).toEqual([true, true])
    expect(filter.entries()).toEqual(first)
  })
})

describe('the entry cap', () => {
  it('keeps the newest 5000 outbound entries for one request', () => {
    const payload: BridgeModelRequestPayload = {
      messages: [{ role: 'user', content: `${'widget '.repeat(MAX_TRACE_ENTRIES + 500)}widget END` }],
    }
    const tally: ReplacementEntry[] = []
    maskPayload(payload, new PayloadMasker(masking, tally))
    expect(tally).toHaveLength(MAX_TRACE_ENTRIES)
    expect(tally.at(-1)!.original).toContain('widget END')
    expect(tally.at(-1)!.replaced).toContain('beacon END')
  })

  it('keeps the newest 5000 inbound entries for one reply', () => {
    const filter = createRestoreFilter(masking)
    filter.apply([{ type: 'text_delta', text: `${'beacon '.repeat(MAX_TRACE_ENTRIES + 500)}beacon END` }])
    filter.flush()
    const entries = filter.entries()
    expect(entries).toHaveLength(MAX_TRACE_ENTRIES)
    expect(entries.at(-1)!.original).toContain('beacon END')
  })

  it('keeps the cap across channels sharing one filter', () => {
    const filter = createRestoreFilter(masking)
    const many = 'beacon '.repeat(MAX_TRACE_ENTRIES / 2 + 100)
    filter.apply([{ type: 'text_delta', text: many }, { type: 'reasoning_delta', text: many }])
    filter.flush()
    expect(filter.entries()).toHaveLength(MAX_TRACE_ENTRIES)
  })
})
