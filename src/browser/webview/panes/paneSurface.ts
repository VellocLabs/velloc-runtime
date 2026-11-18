/**
 * The one surface every side pane shows (F-9). The frame paints it and a
 * pane's body paints none of its own, so a theme's glass (F-25) frosts every
 * pane the same way: one translucent layer, one blur.
 */

/** The pane frame's ground and text color. */
export const PANE_SURFACE = 'bg-card text-card-foreground'

/** A pane body's root: fills the frame, column layout, no ground of its own. */
export const PANE_BODY = 'flex h-full min-h-0 flex-col'
