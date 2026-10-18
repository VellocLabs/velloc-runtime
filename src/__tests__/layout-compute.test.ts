import { describe, expect, it } from 'vitest'

import {
  CHAT_COLUMN_MIN_WIDTH_PX,
  FALLBACK_VIEWPORT_WIDTH_PX,
  SIDEBAR_DEFAULT_WIDTH_PX,
  SIDEBAR_MAX_WIDTH_PX,
  SIDEBAR_MIN_WIDTH_PX,
  WEBVIEW_AREA_MIN_WIDTH_PX,
} from '@/browser/webview/layout/layoutConstants'
import {
  clampSidebarWidth,
  clampWebviewAreaWidth,
  readViewportWidth,
  webviewAreaMaxWidth,
} from '@/browser/webview/layout/computeLayout'

// P0 (F-9): lock the pure width math that was
// extracted verbatim from MultiSessionShell so future layout work can't change
// the docked-column behavior without a failing test.

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

describe('webviewAreaMaxWidth', () => {
  it('is the viewport minus the conversation floor on a wide viewport', () => {
    expect(webviewAreaMaxWidth(1600)).toBe(1600 - CHAT_COLUMN_MIN_WIDTH_PX)
  })

  it('never drops below the area minimum on a narrow viewport', () => {
    // 800 - 360 = 440 < 480 → floored to the area minimum.
    expect(webviewAreaMaxWidth(800)).toBe(WEBVIEW_AREA_MIN_WIDTH_PX)
  })

  it('rounds the result', () => {
    expect(webviewAreaMaxWidth(1600.6)).toBe(Math.round(1600.6 - CHAT_COLUMN_MIN_WIDTH_PX))
  })
})

describe('clampWebviewAreaWidth', () => {
  it('floors below the area minimum', () => {
    expect(clampWebviewAreaWidth(100, 1600)).toBe(WEBVIEW_AREA_MIN_WIDTH_PX)
  })

  it('caps at viewport minus the conversation floor', () => {
    expect(clampWebviewAreaWidth(5_000, 1600)).toBe(
      1600 - CHAT_COLUMN_MIN_WIDTH_PX,
    )
  })

  it('passes through and rounds an in-range width', () => {
    expect(clampWebviewAreaWidth(700, 1600)).toBe(700)
    expect(clampWebviewAreaWidth(700.4, 1600)).toBe(700)
  })
})

describe('readViewportWidth', () => {
  it('returns the fixed fallback when window is unavailable (node env)', () => {
    expect(typeof window).toBe('undefined')
    expect(readViewportWidth()).toBe(FALLBACK_VIEWPORT_WIDTH_PX)
  })
})
