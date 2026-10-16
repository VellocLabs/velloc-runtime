/**
 * Numeric layout limits for the Nexus shell's docked columns (F-9). A saved
 * `shift-sidebar-width` outside the sidebar bounds clamps into them on read. The
 * collapsed icon-rail width lives in AssistantUiThread.tsx beside `SidebarIconRail`.
 */

/**
 * Docked left sidebar (expanded) draggable width bounds, in CSS px (F-9).
 * Saved `shift-sidebar-width` values clamp into the range on read.
 */
export const SIDEBAR_MIN_WIDTH_PX = 220
export const SIDEBAR_MAX_WIDTH_PX = 360
export const SIDEBAR_DEFAULT_WIDTH_PX = 280

/**
 * Docked browser column: the placeholder the native `<main-contents-view>` is
 * position-synced onto. Minimum keeps the native view usable.
 */
export const WEBVIEW_AREA_MIN_WIDTH_PX = 480

/** Floor the conversation column keeps when the browser is docked. */
export const CHAT_COLUMN_MIN_WIDTH_PX = 360

/**
 * Right Panel — the managed utility-view container (Plan / Tasks / …) —
 * draggable width bounds in CSS px, for the normal (browser-hidden)
 * presentation.
 */
export const RIGHT_PANEL_MIN_WIDTH_PX = 280
export const RIGHT_PANEL_DEFAULT_WIDTH_PX = 442
export const RIGHT_PANEL_MAX_WIDTH_PX = 728

/**
 * Compact Right Panel bounds — used when the browser is docked alongside it,
 * so the conversation and browser keep usable widths. The
 * stored width is clamped to the UNION of the normal + compact ranges
 * ([compact-min, normal-max]); the active sub-range is applied at render via
 * `clampRightPanelWidthForContext`.
 */
export const RIGHT_PANEL_COMPACT_MIN_WIDTH_PX = 240
export const RIGHT_PANEL_COMPACT_MAX_WIDTH_PX = 360

/**
 * Vertical-split ratio (the top view's share of the panel height) bounds and
 * default, for two pinned views. Stored as a ratio because panel height
 * changes often; the derived split is null unless exactly two views are
 * pinned.
 */
export const RIGHT_PANEL_SPLIT_MIN_RATIO = 0.2
export const RIGHT_PANEL_SPLIT_MAX_RATIO = 0.8
export const RIGHT_PANEL_SPLIT_DEFAULT_RATIO = 0.65

/** Max simultaneously pinned (split-visible) right-panel views. */
export const RIGHT_PANEL_MAX_PINNED = 2

/** Px width of the collapsed icon-only sidebar rail. */
export const SIDEBAR_RAIL_WIDTH_PX = 56

/**
 * The chat never draws narrower than this (the composer's controls need it).
 * Every other region gives way first (`shellLayout`); only an area narrower
 * than this clips the chat.
 */
export const CHAT_CONTENT_MIN_WIDTH_PX = CHAT_COLUMN_MIN_WIDTH_PX

/**
 * Drawn chat width the session card stack needs to dock at the transcript's
 * top right: the transcript keeps the column it has in a bare minimum-width
 * chat (its 24px start padding plus 312) beside the stack's 315px reserve.
 */
export const STACK_DOCK_MIN_CHAT_PX = 651

/**
 * Fallback viewport width when `window.innerWidth` is unavailable (SSR / the
 * vitest node env). Mirrors the previous inline literal.
 */
export const FALLBACK_VIEWPORT_WIDTH_PX = 1280

/** Chat left uncovered beside the Right Panel's overlay, to press back into. */
export const RIGHT_PANEL_OVERLAY_CHAT_STRIP_PX = 48

/** Drawn width of a column splitter (`SidebarSplitter`, `w-1`). */
export const SPLITTER_WIDTH_PX = 4
