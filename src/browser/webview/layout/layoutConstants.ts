/**
 * Numeric layout limits for the Nexus shell's sidebar, chat and panes (F-9).
 * A saved `shift-sidebar-width` outside the sidebar bounds clamps into them on
 * read. The collapsed icon-rail width lives in AssistantUiThread.tsx beside
 * `SidebarIconRail`.
 */

/**
 * Docked left sidebar (expanded) draggable width bounds, in CSS px (F-9).
 * Saved `shift-sidebar-width` values clamp into the range on read.
 */
export const SIDEBAR_MIN_WIDTH_PX = 220
export const SIDEBAR_MAX_WIDTH_PX = 360
export const SIDEBAR_DEFAULT_WIDTH_PX = 280

/**
 * The browser pane: its body is the placeholder the native
 * `<main-contents-view>` is position-synced onto. Minimum keeps the native
 * view usable.
 */
export const WEBVIEW_AREA_MIN_WIDTH_PX = 480

/** A side pane other than the browser never draws narrower than this. */
export const RIGHT_PANEL_MIN_WIDTH_PX = 280

/** A side pane never draws shorter than this. */
export const PANE_MIN_HEIGHT_PX = 160

/** Gap between pane cards, and between a card and the area's edge. */
export const PANE_GUTTER_PX = 8

/** A pane separator's pointer hit area across the gutter it sits in. */
export const PANE_SEPARATOR_HIT_PX = 12

/** How far an arrow key moves a pane separator (Shift doubles it). */
export const PANE_RESIZE_STEP_PX = 16

/** Pointer travel from a pane handle before a drag of the pane begins. */
export const PANE_DRAG_THRESHOLD_PX = 6

/** The strip at the area's left and right edge a pane can be dropped on. */
export const PANE_DROP_EDGE_PX = 24

/** The share of a pane card, per side, that drops a pane beside it. */
export const PANE_DROP_WRAP_SHARE = 0.25

/** The width the drop indicator gives a gutter a pane would be inserted at. */
export const PANE_DROP_INSERT_PX = 24

/** A pane card's header row. */
export const PANE_HEADER_HEIGHT_PX = 36

/** Px width of the collapsed icon-only sidebar rail. */
export const SIDEBAR_RAIL_WIDTH_PX = 56

/**
 * The chat never draws narrower than this (the composer's controls need it).
 * Every other region gives way first (`shellLayout`); only an area narrower
 * than this clips the chat.
 */
export const CHAT_CONTENT_MIN_WIDTH_PX = 360

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

/** Chat left uncovered beside the side region's overlay, to press back into. */
export const RIGHT_PANEL_OVERLAY_CHAT_STRIP_PX = 48

/** Drawn width of a column splitter (`SidebarSplitter`, `w-1`). */
export const SPLITTER_WIDTH_PX = 4

/** Spare width beside the transcript the agent-opened pane float needs. */
export const RIGHT_PANEL_FLOAT_MIN_WIDTH_PX = 280
