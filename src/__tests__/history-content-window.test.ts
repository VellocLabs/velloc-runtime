import { describe, expect, it } from 'vitest'
import type { ThreadMessageLike } from '@assistant-ui/react'
import { fromThreadMessageLike } from '@assistant-ui/core/internal'

import {
  CONTENT_STUB_KEY,
  HISTORY_MATERIALIZE_CHUNK,
  isRowMaterialized,
  mergeWantedRows,
  stubRowsKey,
  windowMessageContent,
} from '../browser/webview/historyContentWindow'
import {
  INITIAL_ACTIVE_TAIL,
  MESSAGE_TAIL_KEEP,
  buildMessageSegments,
  collectKeptRows,
} from '../browser/webview/messageVirtualization'
import { shareRowsById, shareStructure } from '../browser/webview/structuralSharing'
import { convertTranscriptToThreadMessages } from '../browser/webview/assistantUiAdapter'
import type { Message } from '../runtime/RuntimeTypes'

/**
 * The UI's history-content window: rows outside the virtualizer's window reach assistant-ui as contentless stubs
 * that stay the same objects across renders, and a turn-boundary reconversion reuses every unchanged row object.
 */

const row = (id: string, parts = 3): ThreadMessageLike => ({
  id,
  role: 'assistant',
  content: Array.from({ length: parts }, (_, i) => ({
    type: 'text' as const,
    text: `${id} part ${i}`,
  })),
  metadata: { custom: { lineFrom: 1, lineTo: 2 } },
})

const rows = (count: number) =>
  Array.from({ length: count }, (_, i) => row(`m${i}`))

const contentLength = (message: ThreadMessageLike) =>
  Array.isArray(message.content) ? message.content.length : -1

describe('isRowMaterialized', () => {
  it('always materializes the tail, published or not', () => {
    const count = 100
    const wanted = new Set([3])
    for (let i = count - MESSAGE_TAIL_KEEP; i < count; i++) {
      expect(isRowMaterialized(i, count, wanted)).toBe(true)
    }
    expect(isRowMaterialized(count - MESSAGE_TAIL_KEEP - 1, count, wanted)).toBe(false)
    expect(isRowMaterialized(3, count, wanted)).toBe(true)
  })

  it('before the first publish materializes the initial render tail', () => {
    const count = 100
    expect(isRowMaterialized(count - INITIAL_ACTIVE_TAIL, count, null)).toBe(true)
    expect(isRowMaterialized(count - INITIAL_ACTIVE_TAIL - 1, count, null)).toBe(false)
  })
})

describe('windowMessageContent', () => {
  it('stubs every row outside the window, keeping id and metadata', () => {
    const messages = rows(40)
    const windowed = windowMessageContent(messages, new Set([5, 6]))
    expect(windowed).toHaveLength(40)
    windowed.forEach((message, index) => {
      expect(message.id).toBe(messages[index]!.id)
      const kept = index === 5 || index === 6 || index >= 40 - MESSAGE_TAIL_KEEP
      if (kept) {
        expect(message).toBe(messages[index])
      } else {
        expect(contentLength(message)).toBe(0)
        const custom = message.metadata?.custom as Record<string, unknown>
        expect(custom.lineFrom).toBe(1)
        expect(custom[CONTENT_STUB_KEY]).toBe(true)
      }
    })
  })

  it('returns the very same stub object for the same message across calls', () => {
    const messages = rows(40)
    const first = windowMessageContent(messages, new Set([5]))
    const second = windowMessageContent(messages, new Set([6]))
    expect(second[0]).toBe(first[0])
    // 5 left the window: it is stubbed now, and stays the same stub after.
    expect(contentLength(second[5]!)).toBe(0)
    expect(windowMessageContent(messages, new Set([6]))[5]).toBe(second[5])
  })

  it('only produces stubs assistant-ui accepts, for every role', () => {
    // A stub assistant-ui rejects throws inside the runtime and takes the
    // whole thread down (a system row stubbed to `content: []` did exactly
    // that: "System messages must have exactly one text message part").
    const mixed: ThreadMessageLike[] = [
      { id: 's', role: 'system', content: [{ type: 'text', text: 'boundary' }] },
      { id: 'u', role: 'user', content: [{ type: 'text', text: 'hi' }] },
      {
        id: 'a',
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'think' },
          { type: 'tool-call', toolCallId: 't1', toolName: 'Read', args: {}, result: 'x' },
        ],
        status: { type: 'complete', reason: 'stop' },
      },
      ...rows(MESSAGE_TAIL_KEEP),
    ]
    const windowed = windowMessageContent(mixed, new Set())
    expect(contentLength(windowed[1]!)).toBe(0)
    expect(contentLength(windowed[2]!)).toBe(0)
    expect(windowed[0]).toBe(mixed[0])
    for (const message of windowed) {
      expect(() => fromThreadMessageLike(message, 'fallback', { type: 'complete', reason: 'unknown' })).not.toThrow()
    }
  })

  it('returns the input array untouched when nothing is stubbed', () => {
    const messages = rows(MESSAGE_TAIL_KEEP)
    expect(windowMessageContent(messages, new Set())).toBe(messages)
  })
})

describe('stubRowsKey', () => {
  it('lists exactly the stubbed indices', () => {
    const windowed = windowMessageContent(rows(20), new Set([2]))
    const expected = [0, 1, 3, 4, 5, 6, 7].join(',')
    expect(stubRowsKey(windowed)).toBe(expected)
    expect(stubRowsKey(rows(5))).toBe('')
  })
})

describe('mergeWantedRows', () => {
  it('only ever adds rows — a row once given content keeps it', () => {
    // Re-stubbing leaks in assistant-ui 0.12 (see mergeWantedRows), so a
    // row that scrolls out of the window must not lose its content.
    const first = mergeWantedRows(null, [1, 2])
    const second = mergeWantedRows(first, [5], 0)
    expect([...second].sort((a, b) => a - b)).toEqual([1, 2, 5])
    const windowed = windowMessageContent(rows(40), second)
    expect(contentLength(windowed[1]!)).toBeGreaterThan(0)
  })

  it('returns the held set itself when nothing is new, so no state is set', () => {
    const held = mergeWantedRows(null, [1, 2, 3])
    expect(mergeWantedRows(held, [2, 3])).toBe(held)
    expect(mergeWantedRows(held, [])).toBe(held)
  })
})

describe('mergeWantedRows chunks ahead', () => {
  // A 1 000-row history with the virtualizer's window at the bottom; a step
  // moves the window 3 rows (about a 400 px wheel step on 160 px rows).
  const count = 1000
  const width = 16
  const kept = (start: number, pinned?: ReadonlySet<number>) =>
    collectKeptRows({ count, range: { start, end: start + width }, pinned })
  const bottom = count - width
  const sorted = (set: ReadonlySet<number>) => [...set].sort((a, b) => a - b)
  const range = (from: number, to: number) =>
    Array.from({ length: to - from }, (_, i) => from + i)
  const expectSuperset = (next: ReadonlySet<number>, held: ReadonlySet<number>) => {
    for (const row of held) expect(next.has(row)).toBe(true)
  }

  it('the first publish takes no chunk, so opening a session stays cheap', () => {
    expect(sorted(mergeWantedRows(null, kept(bottom)))).toEqual(kept(bottom))
  })

  it('a first scroll step up materializes a whole chunk above the window', () => {
    const held = mergeWantedRows(null, kept(bottom))
    const start = bottom - 3
    const next = mergeWantedRows(held, kept(start))
    expectSuperset(next, held)
    expect(sorted(next)).toEqual(range(start - HISTORY_MATERIALIZE_CHUNK, count))
  })

  it('a step down from a jump materializes a whole chunk below the window', () => {
    // After a jump the held run sits mid-history; scrolling down grows it.
    const held = mergeWantedRows(null, [...range(400, 400 + width), ...kept(bottom)])
    const next = mergeWantedRows(held, [...range(403, 403 + width), ...kept(bottom)])
    expectSuperset(next, held)
    for (const row of range(416, 419 + HISTORY_MATERIALIZE_CHUNK)) expect(next.has(row)).toBe(true)
    expect(next.has(419 + HISTORY_MATERIALIZE_CHUNK)).toBe(false)
    expect(next.has(399)).toBe(false)
  })

  it('a jump to a far row materializes that row and its chunk at once', () => {
    const held = mergeWantedRows(null, kept(bottom))
    // A search jump pins its target; the window has not moved yet.
    const next = mergeWantedRows(held, kept(bottom, new Set([100])))
    expectSuperset(next, held)
    const half = Math.ceil(HISTORY_MATERIALIZE_CHUNK / 2)
    for (const row of range(100 - half, 101 + half)) expect(next.has(row)).toBe(true)
    expect(next.has(100 - half - 1)).toBe(false)
    expect(next.has(101 + half)).toBe(false)
  })

  it('a new streamed row materializes nothing from history', () => {
    const held = mergeWantedRows(null, kept(bottom))
    const grown = collectKeptRows({
      count: count + 1,
      range: { start: bottom + 1, end: bottom + 1 + width },
    })
    expect(sorted(mergeWantedRows(held, grown))).toEqual([...kept(bottom), count])
  })

  it('a first scroll into history changes state about once per chunk, not per step', () => {
    let held = mergeWantedRows(null, kept(bottom))
    let changes = 0
    for (let step = 1; step <= 40; step++) {
      const next = mergeWantedRows(held, kept(bottom - step * 3))
      expectSuperset(next, held)
      if (next !== held) changes++
      held = next
    }
    // 120 rows of travel; without chunks every one of the 40 steps changed it.
    expect(changes).toBeLessThanOrEqual(3)
    expect(held.has(bottom - 120)).toBe(true)
  })
})

describe('virtualizer materialization', () => {
  it('asks for the window, the tail and the pins', () => {
    expect(
      collectKeptRows({
        count: 30,
        range: { start: 2, end: 4 },
        pinned: new Set([9]),
      }),
    ).toEqual([2, 3, 9, ...Array.from({ length: MESSAGE_TAIL_KEEP }, (_, i) => 18 + i)])
  })

  it('renders a kept row that has no content yet as spacer, never as an empty row', () => {
    const count = 30
    const heights = Array.from({ length: count }, () => 100)
    const segments = buildMessageSegments({
      count,
      range: { start: 2, end: 4 },
      heights,
      materialized: index => index !== 3,
    })
    const rendered = segments.flatMap(s => (s.kind === 'row' ? [s.index] : []))
    expect(rendered).toContain(2)
    expect(rendered).not.toContain(3)
    // Scroll height is unchanged: row 3 is inside a spacer.
    const total = segments.reduce(
      (sum, s) => sum + (s.kind === 'spacer' ? s.height : heights[s.index]!),
      0,
    )
    expect(total).toBe(count * 100)
  })
})

describe('structural sharing', () => {
  it('hands back the previous object wherever nothing changed', () => {
    const previous = { a: [1, { b: 'x' }], c: { d: new Date(5) }, e: 'same' }
    const next = { a: [1, { b: 'x' }], c: { d: new Date(5) }, e: 'same' }
    expect(shareStructure(previous, next)).toBe(previous)
  })

  it('rebuilds only the path that changed', () => {
    const previous = { keep: { deep: [1, 2] }, change: { v: 1 } }
    const next = { keep: { deep: [1, 2] }, change: { v: 2 } }
    const shared = shareStructure(previous, next)
    expect(shared).not.toBe(previous)
    expect(shared.keep).toBe(previous.keep)
    expect(shared.change).toEqual({ v: 2 })
  })

  it('treats a dropped or added key as a change', () => {
    const two = { a: 1, b: 2 }
    expect(shareStructure(two, { a: 1 })).not.toBe(two)
    const one = { a: 1 }
    const grown = shareStructure(one, { a: 1, b: undefined })
    expect(grown).not.toBe(one)
    expect(Object.keys(grown)).toEqual(['a', 'b'])
  })

  it('keeps an own __proto__ key as data', () => {
    const next = JSON.parse('{"__proto__": {"x": 1}, "y": 2}') as Record<string, unknown>
    const shared = shareStructure({ y: 3 }, next) as Record<string, unknown>
    expect(Object.getPrototypeOf(shared)).toBe(Object.prototype)
    expect(Object.prototype.hasOwnProperty.call(shared, '__proto__')).toBe(true)
  })

  it('matches rows by id, so a row inserted above does not defeat sharing', () => {
    const previous = [row('a'), row('b')]
    const next = [row('new'), row('a'), row('b')]
    const shared = shareRowsById(previous, next)
    expect(shared[1]).toBe(previous[0])
    expect(shared[2]).toBe(previous[1])
    expect(shareRowsById(previous, [row('a'), row('b')])).toBe(previous)
  })

  it('makes a reconverted transcript reuse every unchanged row', () => {
    const user = (uuid: string, text: string): Message =>
      ({
        type: 'user',
        uuid,
        timestamp: '2026-10-01T00:00:00.000Z',
        message: { role: 'user', content: text },
      }) as Message
    const assistant = (uuid: string, text: string): Message =>
      ({
        type: 'assistant',
        uuid,
        timestamp: '2026-10-01T00:00:01.000Z',
        message: {
          id: `msg-${uuid}`,
          role: 'assistant',
          content: [{ type: 'text', text }],
        },
      }) as Message
    const turn1 = [user('u1', 'first'), assistant('a1', 'one'), user('u2', 'second'), assistant('a2', 'two')]
    const before = convertTranscriptToThreadMessages(turn1).messages
    // A turn boundary: the same messages plus a new turn, converted again.
    const after = convertTranscriptToThreadMessages([
      ...turn1,
      user('u3', 'third'),
      assistant('a3', 'three'),
    ]).messages
    // Conversion alone rebuilds every row ...
    expect(after[0]).not.toBe(before[0])
    expect(after[0]).toEqual(before[0])
    // ... sharing gives the unchanged ones back.
    const shared = shareRowsById(before, after)
    for (let i = 0; i < before.length; i++) expect(shared[i]).toBe(before[i])
    expect(shared).toHaveLength(after.length)
    expect(shared[shared.length - 1]).toBe(after[after.length - 1])
  })
})
