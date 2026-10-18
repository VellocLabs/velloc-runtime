/**
 * Pure width math for the Nexus shell's sidebar (F-9). `readViewportWidth`
 * is the only function here that touches `window`; pass its result into the helpers.
 */
import {
  FALLBACK_VIEWPORT_WIDTH_PX,
  SIDEBAR_MAX_WIDTH_PX,
  SIDEBAR_MIN_WIDTH_PX,
} from './layoutConstants'

/** Clamp + round an expanded-sidebar width into its draggable bounds. Pure. */
export function clampSidebarWidth(width: number): number {
  return Math.round(
    Math.min(Math.max(width, SIDEBAR_MIN_WIDTH_PX), SIDEBAR_MAX_WIDTH_PX),
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
