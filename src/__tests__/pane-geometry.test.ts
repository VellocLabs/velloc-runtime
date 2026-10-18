/**
 * Pixel rects for a pane tree (F-9): weights share the length, every child
 * keeps its minimum while the minimums fit (in proportion to them when they
 * do not), gutters sit between, the side region's minimum and share are what
 * the shell's cascade is told, and a chat slot narrower than its content
 * leaves the content's end under the region.
 */
import { describe, expect, it } from 'vitest'

import {
  chatContentIn,
  nodeExtent,
  PANE_AREA_LAYER,
  nodeMinLength,
  resolveAreaGeometry,
  resolvePaneRects,
  shareLength,
  sideRegionMetrics,
} from '@/browser/webview/layout/paneGeometry'
import {
  defaultPaneLayout,
  placePane,
  type PaneLayout,
  type PaneLeaf,
} from '@/browser/webview/layout/paneLayout'

/** The chat, then `side` as root-row children. */
const rowOf = (...side: PaneLeaf[]): PaneLayout => ({
  root: { id: 'root', axis: 'row', weight: 1, children: [{ pane: 'chat', weight: 2 }, ...side] },
})

const diffThenTasks = () =>
  placePane(placePane(defaultPaneLayout(), 'diff', { weight: 3 }), 'tasks', { weight: 1 })

describe('shareLength', () => {
  it('shares by weight with gutters between', () => {
    expect(shareLength([{ weight: 1, min: 0 }, { weight: 3, min: 0 }], 408, 8)).toEqual([100, 300])
  })

  it('pins a child at its minimum and shares the rest', () => {
    expect(shareLength([{ weight: 1, min: 280 }, { weight: 1, min: 0 }], 400, 0)).toEqual([280, 120])
  })

  it('shares in proportion to the minimums when they do not fit', () => {
    expect(shareLength([{ weight: 5, min: 100 }, { weight: 1, min: 300 }], 208, 8)).toEqual([50, 150])
    expect(shareLength([{ weight: 1, min: 280 }, { weight: 1, min: 280 }], 400, 0)).toEqual([200, 200])
  })

  it('the last child absorbs the rounding', () => {
    const sizes = shareLength([{ weight: 1, min: 0 }, { weight: 1, min: 0 }, { weight: 1, min: 0 }], 100, 0)
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(100)
  })
})

describe('resolvePaneRects', () => {
  it('gives the chat its width and stacks the column below the right-most pane', () => {
    const rects = resolvePaneRects(diffThenTasks(), { width: 1008, height: 600, chatWidth: 500, gutter: 8 })
    expect(rects.get('chat')).toEqual({ left: 0, top: 0, width: 500, height: 600 })
    expect(rects.get('diff')).toEqual({ left: 508, top: 0, width: 500, height: 296 })
    expect(rects.get('tasks')).toEqual({ left: 508, top: 304, width: 500, height: 296 })
  })

  it('a pane never draws narrower than its minimum while the minimums fit', () => {
    const layout = rowOf({ pane: 'diff', weight: 0.01 }, { pane: 'files', weight: 3 })
    const rects = resolvePaneRects(layout, { width: 1000, height: 600, chatWidth: 300, gutter: 8 })
    expect(rects.get('diff')?.width).toBe(280)
    expect(rects.get('files')?.width).toBe(404)
  })

  it('a side width under the minimums shrinks every side child in proportion to its minimum', () => {
    const layout = rowOf({ pane: 'diff', weight: 3 }, { pane: 'browser', weight: 3 })
    // The side width 600 − 100 − 8 = 492 is under 280 + 8 + 480.
    const rects = resolvePaneRects(layout, { width: 600, height: 400, chatWidth: 100, gutter: 8 })
    expect(rects.get('chat')?.width).toBe(100)
    const diff = rects.get('diff')!.width
    const browser = rects.get('browser')!.width
    expect(diff + 8 + browser).toBe(492)
    expect(diff / browser).toBeCloseTo(280 / 480, 1)
  })

  it('lays out side children alone when the tree has no chat', () => {
    const side = { root: { ...diffThenTasks().root, children: diffThenTasks().root.children.slice(1) } }
    const rects = resolvePaneRects(side, { width: 300, height: 400, chatWidth: 0, gutter: 8 })
    expect(rects.get('chat')).toBeUndefined()
    expect(rects.get('diff')).toEqual({ left: 0, top: 0, width: 300, height: 196 })
    expect(rects.get('tasks')).toEqual({ left: 0, top: 204, width: 300, height: 196 })
  })
})

describe('sideRegionMetrics', () => {
  it('is empty for the chat alone', () => {
    expect(sideRegionMetrics(defaultPaneLayout())).toEqual({ minWidth: 0, share: 0, count: 0 })
  })

  it('a column is as wide as its widest child; the share is side weight over all', () => {
    const column = sideRegionMetrics(diffThenTasks())
    // The pane's 280 and the gutter at the area's edge.
    expect(column).toEqual({ minWidth: 288, share: 3 / 5, count: 1 })
    const browser = placePane(defaultPaneLayout(), 'browser', { weight: 3 })
    expect(sideRegionMetrics(browser).minWidth).toBe(488)
    // The chat's minimum in the row is its slot's.
    expect(nodeMinLength(browser.root, 'row', 8)).toBe(100 + 8 + 480)
  })

  // The browser is a pane of the region, not a column subtracted first: its
  // 480 is the region's minimum when it is the widest child, its weight
  // counts like any pane's, and nothing in the metrics is browser-specific.
  it('a browser pane is one more pane of the region: its 480 minimum, its weight', () => {
    const browser = placePane(defaultPaneLayout(), 'browser', { weight: 3 })
    expect(sideRegionMetrics(browser)).toEqual({ minWidth: 488, share: 3 / 5, count: 1 })
    const browserThenTasks = placePane(browser, 'tasks', { weight: 1 })
    // A column: as wide as its widest child (the browser), the column's weight is the browser's.
    expect(sideRegionMetrics(browserThenTasks)).toEqual({ minWidth: 488, share: 3 / 5, count: 1 })
    expect(nodeMinLength(browserThenTasks.root.children[1], 'column', 8)).toBe(160 + 8 + 160)
    const rects = resolvePaneRects(browserThenTasks, { width: 1000, height: 600, chatWidth: 400, gutter: 8 })
    expect(rects.get('browser')).toEqual({ left: 408, top: 0, width: 592, height: 296 })
    expect(rects.get('tasks')).toEqual({ left: 408, top: 304, width: 592, height: 296 })
    // Beside a diff pane in the root row the minimum is both plus the gutter.
    const diffAndBrowser = { root: { ...browser.root, children: [...browser.root.children, { pane: 'diff' as const, weight: 3 }] } }
    expect(sideRegionMetrics(diffAndBrowser)).toEqual({ minWidth: 480 + 8 + 280 + 8, share: 6 / 8, count: 2 })
  })
})

describe('resolveAreaGeometry', () => {
  const input = (over: Partial<Parameters<typeof resolveAreaGeometry>[0]>) => ({
    layout: diffThenTasks(),
    maximized: null,
    form: 'beside' as const,
    width: 1508,
    height: 600,
    chatWidth: 600,
    seatWidth: 0,
    gutter: 8,
    ...over,
  })

  it('beside: the chat, the seat, the panes in area px, and a separator in every gutter between siblings', () => {
    const geometry = resolveAreaGeometry(input({}))
    expect(geometry.chat).toEqual({ left: 0, top: 0, width: 600, height: 600 })
    expect(geometry.seat).toEqual({ left: 608, top: 0, width: 900, height: 600 })
    expect(geometry.panes.get('diff')).toEqual({ left: 608, top: 8, width: 892, height: 288 })
    expect(geometry.panes.get('tasks')).toEqual({ left: 608, top: 304, width: 892, height: 288 })
    expect(geometry.separators.map(s => [s.key, s.axis, s.rect])).toEqual([
      ['root:0', 'row', { left: 600, top: 0, width: 8, height: 600 }],
      ['g1:0', 'column', { left: 608, top: 296, width: 892, height: 8 }],
    ])
    // The chat|column separator's second flank is the column: its width, its widest child's minimum.
    // The chat flank's minimum is its slot's: a separator may push it to 100.
    expect(geometry.separators[0].first).toEqual({ length: 600, min: 100 })
    expect(geometry.separators[0].second).toEqual({ length: 892, min: 280 })
  })

  it('beside: a pane left of the chat is drawn there, inset at the edge, and the seat spans the panes', () => {
    const flanked = resolveAreaGeometry(
      input({
        layout: {
          root: {
            id: 'root',
            axis: 'row',
            weight: 1,
            children: [{ pane: 'tasks', weight: 1 }, { pane: 'chat', weight: 2 }, { pane: 'diff', weight: 3 }],
          },
        },
      }),
    )
    // The row is 1508 less a gutter at each edge; Tasks is held at its 280 minimum.
    expect(flanked.panes.get('tasks')).toEqual({ left: 8, top: 8, width: 280, height: 584 })
    expect(flanked.chat).toEqual({ left: 296, top: 0, width: 600, height: 600 })
    expect(flanked.panes.get('diff')).toEqual({ left: 904, top: 8, width: 596, height: 584 })
    expect(flanked.seat).toEqual({ left: 0, top: 0, width: 1508, height: 600 })
    expect(flanked.separators.map(s => [s.key, s.rect])).toEqual([
      ['root:0', { left: 288, top: 0, width: 8, height: 600 }],
      ['root:1', { left: 896, top: 0, width: 8, height: 600 }],
    ])
    const leftOnly = resolveAreaGeometry(
      input({
        layout: {
          root: { id: 'root', axis: 'row', weight: 1, children: [{ pane: 'tasks', weight: 1 }, { pane: 'chat', weight: 2 }] },
        },
      }),
    )
    expect(leftOnly.panes.get('tasks')).toEqual({ left: 8, top: 8, width: 892, height: 584 })
    expect(leftOnly.chat).toEqual({ left: 908, top: 0, width: 600, height: 600 })
    // The seat takes the edge gutter with the pane, as it does at the area's end.
    expect(leftOnly.seat).toEqual({ left: 0, top: 0, width: 900, height: 600 })
  })

  it('a column of leaves spans both for its extent', () => {
    const geometry = resolveAreaGeometry(input({}))
    const rects = new Map(geometry.panes)
    expect(nodeExtent(diffThenTasks().root.children[1], rects)).toEqual({ left: 608, top: 8, width: 892, height: 584 })
    expect(nodeExtent({ pane: 'plan', weight: 1 }, rects)).toBeNull()
  })

  it('beside: a slot as wide as the content leaves the chat uncovered', () => {
    const geometry = resolveAreaGeometry(input({}))
    expect(geometry.chatContent).toEqual(geometry.chat)
    expect(geometry.chatCovers).toEqual([])
  })

  it('beside: a slot under the content keeps the content at its start, its end covered under the region', () => {
    // 900 wide: the chat's slot 200, the column at 692 at the area's end.
    const geometry = resolveAreaGeometry(input({ width: 900, chatWidth: 200 }))
    expect(geometry.chat).toEqual({ left: 0, top: 0, width: 200, height: 600 })
    expect(geometry.chatContent).toEqual({ left: 0, top: 0, width: 360, height: 600 })
    expect(geometry.chatCovers).toEqual([{ left: 200, top: 0, width: 160, height: 600 }])
    // Nothing hidden: both panes keep their place and width beside the slot.
    expect(geometry.panes.get('diff')).toEqual({ left: 208, top: 8, width: 684, height: 288 })
    expect(geometry.panes.get('tasks')).toEqual({ left: 208, top: 304, width: 684, height: 288 })
    const content = geometry.chatContent!
    const diff = geometry.panes.get('diff')!
    expect(diff.left).toBeLessThan(content.left + content.width)
    // The region draws over the cover, the cover over the chat.
    expect(PANE_AREA_LAYER.region).toBeGreaterThan(PANE_AREA_LAYER.chatCover)
    expect(PANE_AREA_LAYER.chatCover).toBeGreaterThan(PANE_AREA_LAYER.chat)
  })

  it('the content moves back to end inside the area when the chat sits at the end', () => {
    const slot = { left: 700, top: 0, width: 200, height: 500 }
    expect(chatContentIn(slot, 360, 900)).toEqual({
      chatContent: { left: 540, top: 0, width: 360, height: 500 },
      chatCovers: [{ left: 540, top: 0, width: 160, height: 500 }],
    })
    // An area under the content clips it at the area's end: no cover past the edge.
    expect(chatContentIn({ left: 0, top: 0, width: 300, height: 500 }, 360, 300)).toEqual({
      chatContent: { left: 0, top: 0, width: 360, height: 500 },
      chatCovers: [],
    })
  })

  it('the chat alone narrower than its content keeps the content and is clipped by the area', () => {
    const geometry = resolveAreaGeometry(
      input({ layout: defaultPaneLayout(), form: 'none', width: 300 }),
    )
    expect(geometry.chat).toEqual({ left: 0, top: 0, width: 300, height: 600 })
    expect(geometry.chatContent).toEqual({ left: 0, top: 0, width: 360, height: 600 })
    expect(geometry.chatCovers).toEqual([])
  })

  it('no separator while a pane is expanded or the region is a seat over the chat', () => {
    const expanded = resolveAreaGeometry(input({ maximized: 'diff' }))
    expect(expanded.chat).toBeNull()
    expect(expanded.panes.get('diff')).toEqual({ left: 8, top: 8, width: 1492, height: 584 })
    expect(expanded.panes.has('tasks')).toBe(false)
    expect(expanded.separators).toEqual([])
    expect(expanded.chatContent).toBeNull()
    const float = resolveAreaGeometry(input({ form: 'float', seatWidth: 500 }))
    expect(float.chat).toEqual({ left: 0, top: 0, width: 1508, height: 600 })
    expect(float.chatContent).toEqual(float.chat)
    expect(float.seat).toEqual({ left: 1008, top: 0, width: 500, height: 600 })
    expect(float.panes.get('diff')).toEqual({ left: 1016, top: 8, width: 484, height: 288 })
    expect(float.separators).toEqual([])
    const chatOnly = resolveAreaGeometry(input({ layout: defaultPaneLayout(), form: 'none' }))
    expect(chatOnly.seat).toBeNull()
    expect(chatOnly.separators).toEqual([])
  })
})
