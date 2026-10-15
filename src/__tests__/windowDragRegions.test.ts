import { describe, expect, it } from 'vitest'

import { computeRegions } from '../browser/webview/topbar/useWindowDragRegions'

// Regression guard for the iframe-topbar window-drag fix: the React topbar is
// inside the <webview>, so `-webkit-app-region` can't drag the host window.
// computeRegions() turns the bar + its `data-app-region="no-drag"` controls
// into the rect map sent to the host (ui.setWindowDragRegions), which C++ ORs
// into IsInWebUIDragRegion. These tests pin that mapping: bar is draggable,
// controls subtract, coords round, zero-size elements drop out.

type Rect = { left: number; top: number; width: number; height: number }

function fakeEl(rect: Rect): Element {
  return { getBoundingClientRect: () => rect } as unknown as Element
}

function fakeHeader(rect: Rect, noDrag: Element[]): HTMLElement {
  return {
    getBoundingClientRect: () => rect,
    querySelectorAll: () => noDrag,
  } as unknown as HTMLElement
}

describe('computeRegions', () => {
  it('emits the bar as draggable and each control as a no-drag hole', () => {
    const header = fakeHeader({ left: 0, top: 0, width: 1000, height: 44 }, [
      fakeEl({ left: 8, top: 6, width: 180, height: 32 }), // model pill (left)
      fakeEl({ left: 940, top: 6, width: 32, height: 32 }), // open-browser (right)
    ])

    expect(computeRegions(header)).toEqual([
      { x: 0, y: 0, width: 1000, height: 44, draggable: true },
      { x: 8, y: 6, width: 180, height: 32, draggable: false },
      { x: 940, y: 6, width: 32, height: 32, draggable: false },
    ])
  })

  it('rounds sub-pixel rects to integers', () => {
    const header = fakeHeader({ left: 0.4, top: 0.6, width: 999.5, height: 44 }, [
      fakeEl({ left: 7.5, top: 5.9, width: 180.2, height: 31.6 }),
    ])

    expect(computeRegions(header)).toEqual([
      { x: 0, y: 1, width: 1000, height: 44, draggable: true },
      { x: 8, y: 6, width: 180, height: 32, draggable: false },
    ])
  })

  it('returns nothing when the bar has no size (not yet laid out)', () => {
    const header = fakeHeader({ left: 0, top: 0, width: 0, height: 0 }, [
      fakeEl({ left: 8, top: 6, width: 180, height: 32 }),
    ])
    expect(computeRegions(header)).toEqual([])
  })

  it('skips zero-size controls but keeps the bar', () => {
    const header = fakeHeader({ left: 0, top: 0, width: 800, height: 44 }, [
      fakeEl({ left: 8, top: 6, width: 0, height: 0 }), // collapsed/hidden control
      fakeEl({ left: 760, top: 6, width: 32, height: 32 }),
    ])
    expect(computeRegions(header)).toEqual([
      { x: 0, y: 0, width: 800, height: 44, draggable: true },
      { x: 760, y: 6, width: 32, height: 32, draggable: false },
    ])
  })
})
