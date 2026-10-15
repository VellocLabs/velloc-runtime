import { describe, expect, it } from 'vitest'

import {
  ESTIMATED_MESSAGE_HEIGHT_PX,
  MAX_PINNED_ROWS,
  MESSAGE_TAIL_KEEP,
  MIN_MESSAGE_OVERSCAN_PX,
  buildMessageSegments,
  computeOffsets,
  computeVisibleRange,
  overscanPxForViewport,
  pinMessageRow,
  rangesEqual,
  type VirtualSegment,
} from '../browser/webview/messageVirtualization'

/**
 * Guards for the conversation list's virtualization geometry.
 *
 * The list is only allowed to skip rendering work if the *result* is
 * indistinguishable from rendering everything: same total scroll height, same
 * rows mounted wherever mounting is observable. Those are the invariants here.
 */

const uniformHeights = (count: number, height = 100): number[] =>
  Array.from({ length: count }, () => height)

const totalHeight = (segments: readonly VirtualSegment[]): number =>
  segments.reduce(
    (sum, segment) =>
      sum + (segment.kind === 'spacer' ? segment.height : segment.frozenHeight),
    0,
  )

const mountedIndices = (segments: readonly VirtualSegment[]): number[] =>
  segments.flatMap(segment => (segment.kind === 'row' ? [segment.index] : []))

describe('computeOffsets', () => {
  it('returns prefix sums with a trailing total', () => {
    expect(computeOffsets([10, 20, 30])).toEqual([0, 10, 30, 60])
  })

  it('returns just the zero origin for an empty list', () => {
    expect(computeOffsets([])).toEqual([0])
  })
})

describe('overscanPxForViewport', () => {
  it('scales with the viewport but never drops below the floor', () => {
    expect(overscanPxForViewport(2000)).toBe(3000)
    expect(overscanPxForViewport(100)).toBe(MIN_MESSAGE_OVERSCAN_PX)
  })

  it('falls back to the floor for an unmeasured viewport', () => {
    expect(overscanPxForViewport(0)).toBe(MIN_MESSAGE_OVERSCAN_PX)
    expect(overscanPxForViewport(Number.NaN)).toBe(MIN_MESSAGE_OVERSCAN_PX)
  })
})

describe('computeVisibleRange', () => {
  const count = 100
  const offsets = computeOffsets(uniformHeights(count))

  it('covers the viewport plus the overscan band on both sides', () => {
    const range = computeVisibleRange({
      offsets,
      count,
      scrollTop: 5000,
      clientHeight: 500,
      overscanPx: 1000,
    })
    // Band is [4000, 6500): rows 40..64 (row i spans [100i, 100i+100)).
    expect(range.start).toBe(40)
    expect(range.end).toBe(65)
  })

  it('clamps to the list at the top and the bottom', () => {
    expect(
      computeVisibleRange({
        offsets,
        count,
        scrollTop: 0,
        clientHeight: 500,
        overscanPx: 1000,
      }).start,
    ).toBe(0)
    expect(
      computeVisibleRange({
        offsets,
        count,
        scrollTop: 9500,
        clientHeight: 500,
        overscanPx: 1000,
      }).end,
    ).toBe(count)
  })

  it('never returns an empty window for a non-empty list', () => {
    const range = computeVisibleRange({
      offsets,
      count,
      scrollTop: 0,
      clientHeight: 0,
      overscanPx: 0,
    })
    expect(range.end).toBeGreaterThan(range.start)
  })

  it('is empty only when the list is', () => {
    expect(
      computeVisibleRange({
        offsets: [0],
        count: 0,
        scrollTop: 0,
        clientHeight: 500,
        overscanPx: 1000,
      }),
    ).toEqual({ start: 0, end: 0 })
  })
})

describe('rangesEqual', () => {
  it('compares both edges', () => {
    expect(rangesEqual({ start: 1, end: 2 }, { start: 1, end: 2 })).toBe(true)
    expect(rangesEqual({ start: 1, end: 2 }, { start: 1, end: 3 })).toBe(false)
  })
})

describe('buildMessageSegments', () => {
  it('renders EVERY row of a short transcript — nothing is virtualized', () => {
    // The behavioral contract that keeps short sessions (and every existing
    // spec) byte-identical: at or below the tail-keep count, the keep rule
    // alone already covers the whole list.
    const count = MESSAGE_TAIL_KEEP
    const segments = buildMessageSegments({
      count,
      range: { start: count - 1, end: count },
      heights: uniformHeights(count),
    })
    expect(segments.every(segment => segment.kind === 'row')).toBe(true)
    expect(mountedIndices(segments)).toEqual(
      Array.from({ length: count }, (_, i) => i),
    )
  })

  it('collapses a contiguous culled run into one exactly-sized spacer', () => {
    const count = 100
    const heights = uniformHeights(count)
    const segments = buildMessageSegments({
      count,
      range: { start: 40, end: 50 },
      heights,
    })
    const spacers = segments.filter(s => s.kind === 'spacer')
    // One run before the window, one between it and the kept tail (which
    // starts at count - MESSAGE_TAIL_KEEP). Each is a single div, not one per
    // skipped row, and each is exactly the sum of the heights it replaces.
    const tailStart = count - MESSAGE_TAIL_KEEP
    expect(spacers).toHaveLength(2)
    expect(spacers[0]).toMatchObject({ from: 0, to: 40, height: 4000 })
    expect(spacers[1]).toMatchObject({
      from: 50,
      to: tailStart,
      height: (tailStart - 50) * 100,
    })
  })

  it('preserves total scroll height exactly', () => {
    const heights = Array.from({ length: 200 }, (_, i) => 40 + (i % 7) * 13)
    const segments = buildMessageSegments({
      count: heights.length,
      range: { start: 90, end: 110 },
      heights,
      pinned: new Set([3, 42]),
    })
    const expected = heights.reduce((sum, height) => sum + height, 0)
    expect(totalHeight(segments)).toBe(expected)
  })

  it('keeps the tail mounted (dormant) when the window is far above it', () => {
    const count = 100
    const segments = buildMessageSegments({
      count,
      range: { start: 0, end: 5 },
      heights: uniformHeights(count),
      measured: Array.from({ length: count }, () => true),
    })
    const tail = Array.from(
      { length: MESSAGE_TAIL_KEEP },
      (_, i) => count - MESSAGE_TAIL_KEEP + i,
    )
    expect(mountedIndices(segments)).toEqual([0, 1, 2, 3, 4, ...tail])
    for (const segment of segments) {
      if (segment.kind !== 'row') continue
      // In-window rows render normally; the kept tail renders occluded.
      expect(segment.dormant).toBe(segment.index >= 5)
    }
  })

  it('never occludes a row that has not been measured', () => {
    // A dormant row is sized by its frozen height, so occluding one whose
    // height is still the estimate would pin it open at the guess with no way
    // to correct itself. Such a row renders in full until it reports a size.
    const count = 100
    const measured = Array.from({ length: count }, (_, i) => i % 2 === 0)
    const segments = buildMessageSegments({
      count,
      range: { start: 0, end: 5 },
      heights: uniformHeights(count),
      measured,
    })
    for (const segment of segments) {
      if (segment.kind !== 'row') continue
      if (segment.dormant) expect(measured[segment.index]).toBe(true)
      expect(segment.restored).toBe(measured[segment.index])
    }
    // The odd tail rows are still mounted — just not occluded.
    expect(mountedIndices(segments)).toContain(count - 1)
  })

  it('keeps a pinned row mounted and splits the spacer around it', () => {
    const count = 100
    const segments = buildMessageSegments({
      count,
      range: { start: 60, end: 70 },
      heights: uniformHeights(count),
      pinned: new Set([20]),
    })
    expect(mountedIndices(segments)).toContain(20)
    const spacers = segments.filter(s => s.kind === 'spacer')
    expect(spacers.map(s => [s.from, s.to])).toEqual([
      [0, 20],
      [21, 60],
      [70, count - MESSAGE_TAIL_KEEP],
    ])
    // Still exact after the split.
    expect(totalHeight(segments)).toBe(count * 100)
  })

  it('uses the estimate for rows that were never measured', () => {
    const heights: number[] = []
    heights.length = 60
    const segments = buildMessageSegments({
      count: 60,
      range: { start: 55, end: 60 },
      heights,
    })
    const spacer = segments.find(s => s.kind === 'spacer')
    expect(spacer).toMatchObject({
      from: 0,
      to: 48,
      height: 48 * ESTIMATED_MESSAGE_HEIGHT_PX,
    })
  })

  it('renders nothing for an empty transcript', () => {
    expect(
      buildMessageSegments({ count: 0, range: { start: 0, end: 0 }, heights: [] }),
    ).toEqual([])
  })
})

describe('pinMessageRow', () => {
  it('reports whether the set changed', () => {
    const pinned = new Set<number>()
    expect(pinMessageRow(pinned, 4)).toBe(true)
    expect(pinMessageRow(pinned, 4)).toBe(false)
    expect(pinned.has(4)).toBe(true)
  })

  it('evicts the oldest pin past the cap', () => {
    const pinned = new Set<number>()
    for (let i = 0; i < MAX_PINNED_ROWS + 3; i++) pinMessageRow(pinned, i)
    expect(pinned.size).toBe(MAX_PINNED_ROWS)
    expect(pinned.has(0)).toBe(false)
    expect(pinned.has(2)).toBe(false)
    expect(pinned.has(3)).toBe(true)
    expect(pinned.has(MAX_PINNED_ROWS + 2)).toBe(true)
  })
})
