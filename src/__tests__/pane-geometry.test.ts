/**
 * Pixel rects for a pane tree (F-9): weights share the length, every child
 * keeps its minimum, gutters sit between, and the side region's minimum and
 * share are what the shell's cascade is told.
 */
import { describe, expect, it } from 'vitest'

import {
  nodeMinLength,
  resolvePaneRects,
  shareLength,
  sideRegionMetrics,
} from '@/browser/webview/layout/paneGeometry'
import { defaultPaneLayout, placePane } from '@/browser/webview/layout/paneLayout'

const diffThenTasks = () =>
  placePane(placePane(defaultPaneLayout(), 'diff', { weight: 3 }), 'tasks', { weight: 1 })

describe('shareLength', () => {
  it('shares by weight with gutters between', () => {
    expect(shareLength([{ weight: 1, min: 0 }, { weight: 3, min: 0 }], 408, 8)).toEqual([100, 300])
  })

  it('pins a child at its minimum and shares the rest', () => {
    expect(shareLength([{ weight: 1, min: 280 }, { weight: 1, min: 0 }], 400, 0)).toEqual([280, 120])
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

  it('a pane never draws narrower than its minimum', () => {
    const layout = placePane(defaultPaneLayout(), 'diff', { weight: 0.01 })
    const rects = resolvePaneRects(layout, { width: 900, height: 600, chatWidth: 700, gutter: 8 })
    expect(rects.get('diff')?.width).toBe(280)
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
    expect(column).toEqual({ minWidth: 280, share: 3 / 5, count: 1 })
    const browser = placePane(defaultPaneLayout(), 'browser', { weight: 3 })
    expect(sideRegionMetrics(browser).minWidth).toBe(480)
    expect(nodeMinLength(browser.root, 'row', 8)).toBe(360 + 8 + 480)
  })

  // The browser is a pane of the region, not a column subtracted first: its
  // 480 is the region's minimum when it is the widest child, its weight
  // counts like any pane's, and nothing in the metrics is browser-specific.
  it('a browser pane is one more pane of the region: its 480 minimum, its weight', () => {
    const browser = placePane(defaultPaneLayout(), 'browser', { weight: 3 })
    expect(sideRegionMetrics(browser)).toEqual({ minWidth: 480, share: 3 / 5, count: 1 })
    const browserThenTasks = placePane(browser, 'tasks', { weight: 1 })
    // A column: as wide as its widest child (the browser), the column's weight is the browser's.
    expect(sideRegionMetrics(browserThenTasks)).toEqual({ minWidth: 480, share: 3 / 5, count: 1 })
    expect(nodeMinLength(browserThenTasks.root.children[1], 'column', 8)).toBe(160 + 8 + 160)
    const rects = resolvePaneRects(browserThenTasks, { width: 1000, height: 600, chatWidth: 400, gutter: 8 })
    expect(rects.get('browser')).toEqual({ left: 408, top: 0, width: 592, height: 296 })
    expect(rects.get('tasks')).toEqual({ left: 408, top: 304, width: 592, height: 296 })
    // Beside a diff pane in the root row the minimum is both plus the gutter.
    const diffAndBrowser = { root: { ...browser.root, children: [...browser.root.children, { pane: 'diff' as const, weight: 3 }] } }
    expect(sideRegionMetrics(diffAndBrowser)).toEqual({ minWidth: 480 + 8 + 280, share: 6 / 8, count: 2 })
  })
})
