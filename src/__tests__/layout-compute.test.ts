import { describe, expect, it } from 'vitest'

import {
  FALLBACK_VIEWPORT_WIDTH_PX,
  SIDEBAR_DEFAULT_WIDTH_PX,
  SIDEBAR_MAX_WIDTH_PX,
  SIDEBAR_MIN_WIDTH_PX,
} from '@/browser/webview/layout/layoutConstants'
import {
  clampSidebarWidth,
  readViewportWidth,
} from '@/browser/webview/layout/computeLayout'

// P0 (F-9): lock the pure sidebar width math extracted from MultiSessionShell.

describe('clampSidebarWidth', () => {
  it('floors below the minimum', () => {
    expect(clampSidebarWidth(0)).toBe(SIDEBAR_MIN_WIDTH_PX)
    expect(clampSidebarWidth(100)).toBe(SIDEBAR_MIN_WIDTH_PX)
  })

  it('caps above the maximum', () => {
    expect(clampSidebarWidth(10_000)).toBe(SIDEBAR_MAX_WIDTH_PX)
  })

  it('passes through and rounds in-range widths', () => {
    expect(clampSidebarWidth(SIDEBAR_DEFAULT_WIDTH_PX)).toBe(
      SIDEBAR_DEFAULT_WIDTH_PX,
    )
    expect(clampSidebarWidth(300.4)).toBe(300)
    expect(clampSidebarWidth(299.6)).toBe(300)
  })
})

describe('readViewportWidth', () => {
  it('returns the fixed fallback when window is unavailable (node env)', () => {
    expect(typeof window).toBe('undefined')
    expect(readViewportWidth()).toBe(FALLBACK_VIEWPORT_WIDTH_PX)
  })
})
