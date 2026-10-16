/**
 * Pure width math for the Nexus shell's docked columns (F-9). `readViewportWidth`
 * is the only function here that touches `window`; pass its result into the helpers.
 */
import {
  CHAT_COLUMN_MIN_WIDTH_PX,
  FALLBACK_VIEWPORT_WIDTH_PX,
  RIGHT_PANEL_COMPACT_MAX_WIDTH_PX,
  RIGHT_PANEL_COMPACT_MIN_WIDTH_PX,
  RIGHT_PANEL_MIN_WIDTH_PX,
  RIGHT_PANEL_SPLIT_DEFAULT_RATIO,
  RIGHT_PANEL_SPLIT_MAX_RATIO,
  RIGHT_PANEL_SPLIT_MIN_RATIO,
  SIDEBAR_MAX_WIDTH_PX,
  SIDEBAR_MIN_WIDTH_PX,
  WEBVIEW_AREA_MIN_WIDTH_PX,
} from './layoutConstants'

/** Clamp + round an expanded-sidebar width into its draggable bounds. Pure. */
export function clampSidebarWidth(width: number): number {
  return Math.round(
    Math.min(Math.max(width, SIDEBAR_MIN_WIDTH_PX), SIDEBAR_MAX_WIDTH_PX),
  )
}

/**
 * Largest the docked browser area may grow to for a given viewport: the
 * viewport minus the conversation's floor, never below the area's own minimum
 * (so a tiny viewport still yields a usable value — matches the previous
 * inline behavior exactly). Pure.
 */
export function webviewAreaMaxWidth(paneWidthPx: number): number {
  return Math.max(
    WEBVIEW_AREA_MIN_WIDTH_PX,
    Math.round(paneWidthPx - CHAT_COLUMN_MIN_WIDTH_PX),
  )
}

/** Clamp + round a docked-browser width into [min, max] for a viewport. Pure. */
export function clampWebviewAreaWidth(
  width: number,
  paneWidthPx: number,
): number {
  return Math.round(
    Math.min(
      Math.max(width, WEBVIEW_AREA_MIN_WIDTH_PX),
      webviewAreaMaxWidth(paneWidthPx),
    ),
  )
}

/**
 * The Right Panel's width bounds for the current context: compact when the
 * browser is docked alongside it, otherwise only a minimum (the chat's own
 * minimum caps it in `shellLayout`). Pure.
 */
export function rightPanelWidthBounds(browserDocked: boolean): { min: number; max: number } {
  return browserDocked
    ? { min: RIGHT_PANEL_COMPACT_MIN_WIDTH_PX, max: RIGHT_PANEL_COMPACT_MAX_WIDTH_PX }
    : { min: RIGHT_PANEL_MIN_WIDTH_PX, max: Number.POSITIVE_INFINITY }
}

/**
 * Clamp a vertical-split ratio into its bounds; non-finite input falls back to
 * the default. Pure.
 */
export function clampRightPanelSplitRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return RIGHT_PANEL_SPLIT_DEFAULT_RATIO
  return Math.min(
    Math.max(ratio, RIGHT_PANEL_SPLIT_MIN_RATIO),
    RIGHT_PANEL_SPLIT_MAX_RATIO,
  )
}

/**
 * Current viewport width, or a fixed fallback when `window` is unavailable
 * (SSR / tests). The only non-pure function in this module — mirrors the
 * previous inline guard exactly.
 */
export function readViewportWidth(): number {
  return typeof window !== 'undefined' && Number.isFinite(window.innerWidth)
    ? window.innerWidth
    : FALLBACK_VIEWPORT_WIDTH_PX
}
