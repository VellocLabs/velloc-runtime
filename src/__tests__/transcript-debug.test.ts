import { describe, expect, it } from 'vitest'
import type { Message } from '../runtime/RuntimeTypes'
import { SYSTEM_SUBTYPE_COMPACT_BOUNDARY } from '../runtime/VercelModelConstants'
import {
  analyzeTranscript,
  formatTranscriptDebugReport,
  parseTranscriptFile,
  parseTranscriptMessages,
} from '../utils/transcriptDebug'

function assistant(
  blocks: unknown[],
  usage?: Record<string, number>,
): Message {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: blocks, ...(usage ? { usage } : {}) },
  }
}

function user(blocks: unknown[]): Message {
  return { type: 'user', message: { role: 'user', content: blocks } }
}

function call(id: string, name: string, args: Record<string, unknown>): unknown {
  return { type: 'tool-call', toolCallId: id, toolName: name, args }
}

function result(id: string, name: string, size: number): unknown {
  return { type: 'tool-result', toolCallId: id, toolName: name, result: 'x'.repeat(size) }
}

function boundary(): Message {
  return { type: 'system', subtype: SYSTEM_SUBTYPE_COMPACT_BOUNDARY, message: '' }
}

describe('analyzeTranscript', () => {
  it('splits on compaction boundaries and attributes tool sizes', () => {
    const messages: Message[] = [
      assistant([{ type: 'text', text: 'hello' }, call('a', 'Read', { file_path: '/a.ts' })], {
        input_tokens: 100,
        output_tokens: 10,
      }),
      user([result('a', 'Read', 500)]),
      boundary(),
      assistant([call('b', 'Grep', { pattern: 'foo' })], { input_tokens: 50, output_tokens: 5 }),
      user([result('b', 'Grep', 300)]),
      assistant([call('c', 'Read', { file_path: '/c.ts' })]),
      user([result('c', 'Read', 1000)]),
    ]

    const segments = analyzeTranscript(messages)
    expect(segments).toHaveLength(2)

    const [seg0, seg1] = segments
    // Segment 0: one Read of 500 bytes, one assistant + one user message.
    expect(seg0!.messageCount).toBe(2)
    expect(seg0!.callTotal).toBe(1)
    expect(seg0!.readBytes).toBe(500)
    expect(seg0!.grepBytes).toBe(0)
    expect(seg0!.toolResultBytes).toBe(500)
    expect(seg0!.assistantTextBytes).toBe('hello'.length)
    expect(seg0!.inputTokens).toBe(100)
    expect(seg0!.generatedTokens).toBe(10)

    // Segment 1: the boundary marker + a Grep (300) + a Read (1000).
    expect(seg1!.readBytes).toBe(1000)
    expect(seg1!.grepBytes).toBe(300)
    expect(seg1!.toolResultBytes).toBe(1300)
    expect(seg1!.callTotal).toBe(2)
    expect(seg1!.systemMessages).toBe(1) // the boundary marker
    // Largest output in the segment is the 1000-byte Read of /c.ts.
    expect(seg1!.largest[0]).toMatchObject({
      toolName: 'Read',
      bytes: 1000,
      target: '/c.ts',
    })
  })

  it('resolves a result tool name from the call id when the block omits it', () => {
    const messages: Message[] = [
      assistant([call('x', 'Grep', { pattern: 'p' })]),
      // Legacy-style result: no toolName, only tool_use_id.
      user([{ type: 'tool_result', tool_use_id: 'x', content: 'y'.repeat(42) }]),
    ]
    const [seg] = analyzeTranscript(messages)
    expect(seg!.grepBytes).toBe(42)
  })

  it('returns a single empty segment for an empty transcript', () => {
    const segments = analyzeTranscript([])
    expect(segments).toHaveLength(1)
    expect(segments[0]!.messageCount).toBe(0)
  })

  it('counts error tool-results (canonical isError and legacy is_error)', () => {
    const messages: Message[] = [
      user([
        { type: 'tool-result', toolCallId: 'a', toolName: 'Bash', result: 'boom', isError: true },
        { type: 'tool_result', tool_use_id: 'b', content: 'boom2', is_error: true },
        result('c', 'Read', 5),
      ]),
    ]
    const [seg] = analyzeTranscript(messages)
    expect(seg!.toolErrorCount).toBe(2)
  })

  it('measures thinking and reasoning block bytes', () => {
    const messages: Message[] = [
      assistant([
        { type: 'thinking', thinking: 'a'.repeat(10) },
        { type: 'reasoning', text: 'b'.repeat(7) },
        { type: 'text', text: 'hi' },
      ]),
    ]
    const [seg] = analyzeTranscript(messages)
    expect(seg!.thinkingBytes).toBe(17)
    expect(seg!.assistantTextBytes).toBe(2)
  })

  it('stamps the segment time range from message timestamps', () => {
    const messages: Message[] = [
      { ...user([result('a', 'Read', 1)]), timestamp: '2026-07-01T10:00:00.000Z' },
      { ...assistant([{ type: 'text', text: 'ok' }]), timestamp: '2026-07-01T10:05:00.000Z' },
    ]
    const [seg] = analyzeTranscript(messages)
    expect(seg!.firstTimestamp).toBe('2026-07-01T10:00:00.000Z')
    expect(seg!.lastTimestamp).toBe('2026-07-01T10:05:00.000Z')
  })

  it('derives model response and tool execution times from message timestamps', () => {
    const messages: Message[] = [
      // User prompt at T+0.
      { ...user([{ type: 'text', text: 'go' }]), timestamp: '2026-07-01T10:00:00.000Z' },
      // Model answers with a tool call 5s later.
      {
        ...assistant([call('a', 'Read', { file_path: '/a.ts' })]),
        timestamp: '2026-07-01T10:00:05.000Z',
      },
      // Tool result lands 1.5s after the call.
      { ...user([result('a', 'Read', 10)]), timestamp: '2026-07-01T10:00:06.500Z' },
      // Follow-up model response 2s after the result.
      {
        ...assistant([{ type: 'text', text: 'done' }]),
        timestamp: '2026-07-01T10:00:08.500Z',
      },
    ]
    const [seg] = analyzeTranscript(messages)
    expect(seg!.modelResponses).toBe(2)
    expect(seg!.modelResponseMs).toBe(7000) // 5s + 2s
    expect(seg!.modelResponseMaxMs).toBe(5000)
    expect(seg!.toolDurations).toBe(1)
    expect(seg!.toolDurationMs).toBe(1500)
    expect(seg!.toolDurationMaxMs).toBe(1500)
    // Slowest steps are ranked across both kinds.
    expect(seg!.slowest[0]).toMatchObject({ kind: 'model', ms: 5000 })
    expect(seg!.slowest.map(s => s.ms)).toEqual([5000, 2000, 1500])
    const toolStep = seg!.slowest.find(s => s.kind === 'tool')
    expect(toolStep).toMatchObject({ label: 'Read /a.ts', ms: 1500 })
  })

  it('skips timing for messages without usable timestamps', () => {
    const messages: Message[] = [
      user([{ type: 'text', text: 'go' }]), // no timestamp
      assistant([call('a', 'Read', { file_path: '/a.ts' })]), // no timestamp
      user([result('a', 'Read', 10)]), // no timestamp
    ]
    const [seg] = analyzeTranscript(messages)
    expect(seg!.modelResponses).toBe(0)
    expect(seg!.toolDurations).toBe(0)
    expect(seg!.slowest).toEqual([])
  })
})

describe('parseTranscriptMessages', () => {
  it('parses multi-line JSONL and skips non-message + malformed entries', () => {
    const text = [
      JSON.stringify(user([result('a', 'Read', 3)])),
      JSON.stringify({ type: '__session_meta', sessionId: 's' }),
      JSON.stringify({ type: 'custom-title', sessionId: 's', title: 'x' }),
      '{ not valid json',
      JSON.stringify(assistant([{ type: 'text', text: 'hi' }])),
    ].join('\n')
    const messages = parseTranscriptMessages(text)
    expect(messages.map(m => m.type)).toEqual(['user', 'assistant'])
  })

  it('parses a single-line conversation-record shape', () => {
    const text = JSON.stringify({
      sessionId: 's',
      messages: [user([result('a', 'Read', 3)]), { type: '__session_meta', sessionId: 's' }],
    })
    const messages = parseTranscriptMessages(text)
    expect(messages).toHaveLength(1)
    expect(messages[0]!.type).toBe('user')
  })

  it('parses a single-line bare array shape', () => {
    const text = JSON.stringify([assistant([{ type: 'text', text: 'hi' }])])
    expect(parseTranscriptMessages(text)).toHaveLength(1)
  })

  it('parses a single JSONL message line', () => {
    const text = JSON.stringify(user([result('a', 'Read', 3)]))
    expect(parseTranscriptMessages(text)).toHaveLength(1)
  })

  it('returns [] for empty input', () => {
    expect(parseTranscriptMessages('')).toEqual([])
    expect(parseTranscriptMessages('\n\n')).toEqual([])
  })

  it('drops same-uuid duplicates (first wins) and counts them', () => {
    const first = { ...user([result('a', 'Read', 3)]), uuid: 'u1' }
    const dupe = { ...user([result('a', 'Read', 999)]), uuid: 'u1' }
    const other = { ...assistant([{ type: 'text', text: 'x' }]), uuid: 'u2' }
    const text = [first, dupe, other].map(m => JSON.stringify(m)).join('\n')
    const parsed = parseTranscriptFile(text)
    expect(parsed.messages).toHaveLength(2)
    expect(parsed.duplicateCount).toBe(1)
    // First entry wins — 3-byte Read, not the 999-byte dupe.
    const [seg] = analyzeTranscript(parsed.messages)
    expect(seg!.readBytes).toBe(3)
  })

  it('keeps uuid-less entries and counts malformed lines', () => {
    const text = [
      JSON.stringify(user([result('a', 'Read', 1)])),
      'not json{{{',
      JSON.stringify(user([result('b', 'Read', 2)])),
    ].join('\n')
    const parsed = parseTranscriptFile(text)
    expect(parsed.messages).toHaveLength(2)
    expect(parsed.duplicateCount).toBe(0)
    expect(parsed.malformedLines).toBe(1)
  })

  it('requires sessionId on the single-line record shape (storage-layer gate)', () => {
    // Without sessionId this is NOT a conversation record — treated as one
    // JSONL message line (type present → kept as a single message).
    const notARecord = JSON.stringify({ type: 'user', messages: [1, 2, 3] })
    expect(parseTranscriptMessages(notARecord)).toHaveLength(1)
  })

  it('round-trips through analyzeTranscript', () => {
    const text = [
      JSON.stringify(user([result('a', 'Read', 500)])),
      JSON.stringify(boundary()),
      JSON.stringify(user([result('b', 'Grep', 300)])),
    ].join('\n')
    const segments = analyzeTranscript(parseTranscriptMessages(text))
    expect(segments).toHaveLength(2)
    expect(segments[0]!.readBytes).toBe(500)
    expect(segments[1]!.grepBytes).toBe(300)
  })
})

describe('formatTranscriptDebugReport', () => {
  it('renders header, totals, and a note when empty', () => {
    const report = formatTranscriptDebugReport([], {
      sessionId: 'abc',
      transcriptPath: '/x/transcript.jsonl',
    })
    expect(report).toContain('session abc')
    expect(report).toContain('/x/transcript.jsonl')
    expect(report).toContain('No messages in this session yet')
  })

  it('labels the single-segment case as "no compaction"', () => {
    const report = formatTranscriptDebugReport(
      [user([result('a', 'Read', 10)])],
      { sessionId: 's', transcriptPath: null },
    )
    expect(report).toContain('1 compaction segment(s)')
    expect(report).toContain('Segment 1 (no compaction)')
    expect(report).toContain('(unavailable')
  })

  it('renders file size, duplicate + malformed diagnostics, and error counts', () => {
    const report = formatTranscriptDebugReport(
      [
        user([
          { type: 'tool-result', toolCallId: 'a', toolName: 'Bash', result: 'boom', isError: true },
        ]),
      ],
      {
        sessionId: 's',
        transcriptPath: '/x/transcript.jsonl',
        source: 'disk',
        fileBytes: 2048,
        duplicateCount: 3,
        malformedLines: 1,
      },
    )
    expect(report).toContain('| File size | 2.0 KB |')
    expect(report).toContain('3 duplicate entries on disk')
    expect(report).toContain('1 malformed line(s) skipped')
    expect(report).toContain('| Tool calls | 0 (1 error(s)) |')
  })

  it('renders the segment time range with a duration', () => {
    const report = formatTranscriptDebugReport(
      [
        { ...user([result('a', 'Read', 1)]), timestamp: '2026-07-01T10:00:00.000Z' },
        { ...assistant([{ type: 'text', text: 'ok' }]), timestamp: '2026-07-01T10:05:00.000Z' },
      ],
      { sessionId: 's', transcriptPath: null },
    )
    expect(report).toContain(
      '| Time | 2026-07-01T10:00:00.000Z → 2026-07-01T10:05:00.000Z (5m',
    )
  })

  it('reports thinking bytes alongside assistant text', () => {
    const report = formatTranscriptDebugReport(
      [assistant([
        { type: 'text', text: 'hi' },
        { type: 'thinking', thinking: 'y'.repeat(50) },
      ])],
      { sessionId: 's', transcriptPath: null },
    )
    expect(report).toContain('| Assistant text output | 2 B + thinking 50 B |')
  })

  it('renders timing rows and the slowest-steps table', () => {
    const report = formatTranscriptDebugReport(
      [
        { ...user([{ type: 'text', text: 'go' }]), timestamp: '2026-07-01T10:00:00.000Z' },
        {
          ...assistant([call('a', 'Read', { file_path: '/a.ts' })]),
          timestamp: '2026-07-01T10:00:05.000Z',
        },
        { ...user([result('a', 'Read', 10)]), timestamp: '2026-07-01T10:00:05.250Z' },
      ],
      { sessionId: 's', transcriptPath: null },
    )
    expect(report).toContain(
      '| Model response time | 5.0s across 1 response(s) (avg 5.0s, max 5.0s) |',
    )
    expect(report).toContain(
      '| Tool execution time | 250 ms across 1 result(s) (avg 250 ms, max 250 ms) |',
    )
    expect(report).toContain('**Slowest steps**')
    expect(report).toContain('| 250 ms | tool | `Read /a.ts` |')
  })

  it('renders — for timing when timestamps are absent', () => {
    const report = formatTranscriptDebugReport(
      [user([result('a', 'Read', 10)])],
      { sessionId: 's', transcriptPath: null },
    )
    expect(report).toContain('| Model response time | — |')
    expect(report).toContain('| Tool execution time | — |')
    expect(report).not.toContain('**Slowest steps**')
  })

  it('counts attachment messages as "other" so the split sums to the total', () => {
    const report = formatTranscriptDebugReport(
      [
        user([result('a', 'Read', 1)]),
        { type: 'attachment', attachment: { type: 'browser_context' } } as Message,
      ],
      { sessionId: 's', transcriptPath: null },
    )
    expect(report).toContain('| Messages | 2 (1 user, 0 assistant, 0 system, 1 other) |')
  })
})
