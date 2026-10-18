/**
 * Resizing at a separator (F-9): the two flanking weights move and nothing
 * else, each flank keeps its minimum (a group's is its children's), a run that
 * moves nothing returns the same layout, and the committed weights draw the
 * separator where it was released — beside the chat too, where the cascade
 * draws the chat from the region's share. The root row's panes hand their
 * weight to their kind; a column's do not.
 */
import { describe, expect, it } from 'vitest'

import { resolveAreaGeometry, sideRegionMetrics, type AreaGeometryInput } from '@/browser/webview/layout/paneGeometry'
import {
  defaultPaneLayout,
  placePane,
  type PaneLayout,
} from '@/browser/webview/layout/paneLayout'
import {
  clampResizeDelta,
  resizeFlankWeights,
  resizeLayoutAt,
  rootPaneWeightsByKind,
} from '@/browser/webview/layout/paneResize'

const AREA = 1508
const PANEL_ROOM = AREA - 8

function area(layout: PaneLayout, chatWidth: number): AreaGeometryInput {
  return { layout, maximized: null, form: 'beside', width: AREA, height: 600, chatWidth, seatWidth: 0, gutter: 8 }
}

/** The chat width the shell's cascade draws for `layout` in this area. */
function cascadeChat(layout: PaneLayout): number {
  return PANEL_ROOM - Math.round(sideRegionMetrics(layout, 8).share * PANEL_ROOM)
}

const chatDiff = () => placePane(defaultPaneLayout(), 'diff', { weight: 3 })
const chatColumn = () => placePane(chatDiff(), 'tasks', { weight: 1 })
const threeInRow = (): PaneLayout => ({
  root: {
    id: 'root',
    axis: 'row',
    weight: 1,
    children: [
      { pane: 'chat', weight: 2 },
      { pane: 'diff', weight: 3 },
      { pane: 'tasks', weight: 2 },
    ],
  },
})

describe('clampResizeDelta', () => {
  it('moves freely between the minimums and stops at each', () => {
    const first = { length: 600, min: 360 }
    const second = { length: 892, min: 280 }
    expect(clampResizeDelta(first, second, 100)).toBe(100)
    expect(clampResizeDelta(first, second, -100)).toBe(-100)
    expect(clampResizeDelta(first, second, -1000)).toBe(-240)
    expect(clampResizeDelta(first, second, 1000)).toBe(612)
    expect(clampResizeDelta(first, second, 0.3)).toBe(0)
    expect(clampResizeDelta(first, second, Number.NaN)).toBe(0)
  })

  it('a flank already under its minimum cannot lose more', () => {
    expect(clampResizeDelta({ length: 300, min: 360 }, { length: 500, min: 280 }, -50)).toBe(0)
    expect(clampResizeDelta({ length: 500, min: 280 }, { length: 100, min: 160 }, 50)).toBe(0)
  })
})

describe('resizeFlankWeights', () => {
  it('shares the pair sum by the new lengths, and keeps the weights when nothing moves', () => {
    const first = { length: 288, min: 160, weight: 1 }
    const second = { length: 288, min: 160, weight: 1 }
    const moved = resizeFlankWeights(first, second, 100)
    expect(moved.first).toBeCloseTo((2 * 388) / 576, 9)
    expect(moved.second).toBeCloseTo((2 * 188) / 576, 9)
    expect(resizeFlankWeights(first, second, 0)).toEqual({ first: 1, second: 1 })
  })
})

describe('resizeLayoutAt', () => {
  it('beside the chat: the cascade then draws the chat where the separator was released', () => {
    const layout = chatDiff()
    const geometry = resolveAreaGeometry(area(layout, 600))
    const separator = geometry.separators[0]
    expect(separator.first).toEqual({ length: 600, min: 360 })
    expect(separator.second).toEqual({ length: 892, min: 280 })

    const next = resizeLayoutAt(layout, separator, 100, { areaWidth: AREA, gutter: 8 })
    expect(next).not.toBe(layout)
    // Only the two flanks changed, and their sum is kept.
    const [chat, diff] = next.root.children
    expect(chat.weight + diff.weight).toBeCloseTo(5, 9)
    expect(cascadeChat(next)).toBe(700)
    const drawn = resolveAreaGeometry(area(next, 700))
    expect(drawn.panes.get('diff')).toEqual({ left: 708, top: 8, width: 792, height: 584 })
    expect(drawn.separators[0].rect).toEqual({ left: 700, top: 0, width: 8, height: 600 })
  })

  it('clamps at the chat minimum and at the pane minimum', () => {
    const layout = chatDiff()
    const separator = resolveAreaGeometry(area(layout, 600)).separators[0]
    const narrowChat = resizeLayoutAt(layout, separator, -1000, { areaWidth: AREA })
    expect(cascadeChat(narrowChat)).toBe(360)
    const narrowDiff = resizeLayoutAt(layout, separator, 1000, { areaWidth: AREA })
    expect(cascadeChat(narrowDiff)).toBe(1212)
    expect(resolveAreaGeometry(area(narrowDiff, 1212)).panes.get('diff')?.width).toBe(280)
  })

  it("a group's minimum along the axis is its children's: a column with the browser stops at 480", () => {
    const layout = placePane(placePane(defaultPaneLayout(), 'browser', { weight: 3 }), 'tasks', { weight: 1 })
    const separator = resolveAreaGeometry(area(layout, 600)).separators[0]
    expect(separator.second).toEqual({ length: 892, min: 480 })
    const next = resizeLayoutAt(layout, separator, 1000, { areaWidth: AREA })
    expect(cascadeChat(next)).toBe(1012)
    expect(resolveAreaGeometry(area(next, 1012)).panes.get('browser')?.width).toBe(480)
  })

  it('inside a column: the two heights move, clamped at 160, the chat untouched', () => {
    const layout = chatColumn()
    const geometry = resolveAreaGeometry(area(layout, 600))
    const separator = geometry.separators.find(s => s.axis === 'column')!
    expect(separator.key).toBe('g1:0')
    expect(separator.rect).toEqual({ left: 608, top: 296, width: 892, height: 8 })
    expect(separator.first).toEqual({ length: 288, min: 160 })
    expect(separator.second).toEqual({ length: 288, min: 160 })

    const next = resizeLayoutAt(layout, separator, 100, { areaWidth: AREA })
    expect(next.root.children[0]).toBe(layout.root.children[0])
    expect(sideRegionMetrics(next, 8)).toEqual(sideRegionMetrics(layout, 8))
    const drawn = resolveAreaGeometry(area(next, 600))
    expect(drawn.panes.get('diff')?.height).toBe(388)
    expect(drawn.panes.get('tasks')?.height).toBe(188)
    expect(drawn.separators.find(s => s.axis === 'column')?.rect.top).toBe(396)

    const clamped = resizeLayoutAt(layout, separator, 1000, { areaWidth: AREA })
    expect(resolveAreaGeometry(area(clamped, 600)).panes.get('tasks')?.height).toBe(160)
  })

  it('beside the chat with other root children: those keep their px, the neighbour takes the delta', () => {
    const layout = threeInRow()
    const chatWidth = cascadeChat(layout)
    expect(chatWidth).toBe(429)
    const geometry = resolveAreaGeometry(area(layout, chatWidth))
    const diffWidth = geometry.panes.get('diff')!.width
    const tasksWidth = geometry.panes.get('tasks')!.width
    expect([diffWidth, tasksWidth]).toEqual([633, 422])
    const [chatSep, innerSep] = geometry.separators
    expect(chatSep.key).toBe('root:0')
    expect(innerSep.key).toBe('root:1')

    const next = resizeLayoutAt(layout, chatSep, 100, { areaWidth: AREA })
    expect(next.root.children[2]).toBe(layout.root.children[2])
    expect(cascadeChat(next)).toBe(chatWidth + 100)
    const drawn = resolveAreaGeometry(area(next, chatWidth + 100))
    expect(drawn.panes.get('diff')?.width).toBe(diffWidth - 100)
    expect(drawn.panes.get('tasks')?.width).toBe(tasksWidth)

    // Between two side children the region keeps its width.
    const inner = resizeLayoutAt(layout, innerSep, -100, { areaWidth: AREA })
    expect(inner.root.children[0]).toBe(layout.root.children[0])
    expect(cascadeChat(inner)).toBe(chatWidth)
    const drawnInner = resolveAreaGeometry(area(inner, chatWidth))
    expect(drawnInner.panes.get('diff')?.width).toBe(diffWidth - 100)
    expect(drawnInner.panes.get('tasks')?.width).toBe(tasksWidth + 100)
  })

  it('returns the same layout when nothing moves', () => {
    const layout = chatDiff()
    const separator = resolveAreaGeometry(area(layout, 600)).separators[0]
    expect(resizeLayoutAt(layout, separator, 0, { areaWidth: AREA })).toBe(layout)
    expect(resizeLayoutAt(layout, separator, 0.4, { areaWidth: AREA })).toBe(layout)
    const atMin = resizeLayoutAt(layout, separator, -1000, { areaWidth: AREA })
    const atMinSep = resolveAreaGeometry(area(atMin, 360)).separators[0]
    expect(resizeLayoutAt(atMin, atMinSep, -50, { areaWidth: AREA })).toBe(atMin)
    expect(resizeLayoutAt(layout, { ...separator, groupId: 'nope' }, 50, { areaWidth: AREA })).toBe(layout)
  })
})

describe('rootPaneWeightsByKind', () => {
  it('a pane in the root row writes weight × 2 / chat; a column child writes nothing', () => {
    expect(rootPaneWeightsByKind(defaultPaneLayout())).toEqual({})
    expect(rootPaneWeightsByKind(threeInRow())).toEqual({ diff: 3, tasks: 2 })
    const resized: PaneLayout = {
      root: { id: 'root', axis: 'row', weight: 1, children: [{ pane: 'chat', weight: 2.4 }, { pane: 'diff', weight: 2.6 }] },
    }
    expect(rootPaneWeightsByKind(resized).diff).toBeCloseTo((2.6 * 2) / 2.4, 9)
    expect(rootPaneWeightsByKind(chatColumn())).toEqual({})
  })
})
