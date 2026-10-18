/**
 * The root row rebalanced once after a pane opens (F-9): every side child at
 * least its minimum, the chat's slot 360 when that fits (else 100), the
 * opened pane giving way before the others, the chat's weight kept, the same
 * reference when nothing must change.
 */
import { describe, expect, it } from 'vitest'

import { fitRootRowAfterOpen } from '@/browser/webview/layout/paneFit'
import { resolveAreaGeometry, sideRegionMetrics } from '@/browser/webview/layout/paneGeometry'
import type { PaneLayout, PaneNode } from '@/browser/webview/layout/paneLayout'

const row = (...children: PaneNode[]): PaneLayout => ({
  root: { id: 'root', axis: 'row', weight: 1, children },
})
const chat = (weight = 2): PaneNode => ({ pane: 'chat', weight })

/** The chat slot and each pane's width as the shell and the geometry draw `layout` in `rowWidth`. */
function drawn(layout: PaneLayout, rowWidth: number) {
  const share = sideRegionMetrics(layout, 8).share
  const chatWidth = rowWidth - Math.round(share * rowWidth)
  // The area is the row plus the gap between the chat and the region.
  const g = resolveAreaGeometry({
    layout, maximized: null, form: 'beside', width: rowWidth + 8, height: 600, chatWidth, seatWidth: 0, gutter: 8,
  })
  return { chat: g.chat!.width, panes: Object.fromEntries([...g.panes].map(([k, r]) => [k, r.width])) }
}

describe('fitRootRowAfterOpen', () => {
  it('leaves a row that already fits as it is (same reference)', () => {
    const layout = row(chat(), { pane: 'tasks', weight: 1 })
    expect(fitRootRowAfterOpen(layout, 'tasks', { rowWidth: 1500 })).toBe(layout)
    const wide = row(chat(), { pane: 'diff', weight: 3 })
    expect(fitRootRowAfterOpen(wide, 'diff', { rowWidth: 1000 })).toBe(wide)
  })

  it('narrows the opened pane so the chat slot keeps 360, keeping the chat weight', () => {
    const layout = row(chat(), { pane: 'diff', weight: 3 })
    expect(drawn(layout, 800).chat).toBe(320)
    const fitted = fitRootRowAfterOpen(layout, 'diff', { rowWidth: 800 })
    expect(fitted.root.children[0].weight).toBe(2)
    const after = drawn(fitted, 800)
    expect(after.chat).toBe(360)
    expect(after.panes.diff).toBe(800 - 8 - 360)
  })

  it('takes from the other panes only once the opened one is at its minimum', () => {
    // Tasks just opened beside Diff at 1000: Tasks is raised to 280, Diff gives the chat its 360.
    const layout = row(chat(), { pane: 'diff', weight: 3 }, { pane: 'tasks', weight: 1 })
    const fitted = fitRootRowAfterOpen(layout, 'tasks', { rowWidth: 1000 })
    const after = drawn(fitted, 1000)
    expect(after.chat).toBe(360)
    expect(after.panes.tasks).toBe(280)
    expect(after.panes.diff).toBe(1000 - 16 - 360 - 280)
    // Diff just opened beside Tasks: Diff gives way first, Tasks keeps its 280.
    const diffNew = row(chat(), { pane: 'tasks', weight: 1 }, { pane: 'diff', weight: 3 })
    const fittedNew = drawn(fitRootRowAfterOpen(diffNew, 'diff', { rowWidth: 1000 }), 1000)
    expect(fittedNew).toEqual({ chat: 360, panes: { tasks: 280, diff: 344 } })
  })

  it('a column counts as the opened pane when the pane joined it', () => {
    const layout = row(chat(), {
      id: 'g1', axis: 'column', weight: 3, children: [{ pane: 'diff', weight: 1 }, { pane: 'browser', weight: 1 }],
    })
    // The browser's 480 is the column's minimum; at 900 the chat keeps 360 beside it.
    const after = drawn(fitRootRowAfterOpen(layout, 'browser', { rowWidth: 900 }), 900)
    expect(after.chat).toBe(360)
    expect(after.panes.browser).toBe(900 - 8 - 360)
  })

  it('without room for 360 the panes sit at their minimums and the slot takes the rest', () => {
    const layout = row(chat(), { pane: 'diff', weight: 0.5 })
    // At 600 a 280 Diff leaves 312: the slot keeps it (at least 100).
    const after = drawn(fitRootRowAfterOpen(layout, 'diff', { rowWidth: 600 }), 600)
    expect(after).toEqual({ chat: 312, panes: { diff: 280 } })
    // A slot already over 100 with every pane at its minimum is left alone.
    const fine = row(chat(), { pane: 'diff', weight: 3 })
    expect(fitRootRowAfterOpen(fine, 'diff', { rowWidth: 600 })).toBe(fine)
  })

  it('changes nothing when even the slot minimum does not fit, or the pane is absent', () => {
    const layout = row(chat(), { pane: 'diff', weight: 3 }, { pane: 'tasks', weight: 1 })
    expect(fitRootRowAfterOpen(layout, 'tasks', { rowWidth: 600 })).toBe(layout)
    expect(fitRootRowAfterOpen(layout, 'plan', { rowWidth: 800 })).toBe(layout)
    expect(fitRootRowAfterOpen(layout, 'tasks', { rowWidth: 0 })).toBe(layout)
  })
})
