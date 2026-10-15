/**
 * How many welcome-page prompt-starter chips fit (six, four or two). Computed in JS so
 * the hidden chips leave the DOM, rather than relying on CSS `nth-[…]` variant order.
 */

/** Below this container width the grid is a single column (`@md` in Tailwind). */
export const TWO_COLUMN_MIN_WIDTH = 448

/** One chip row: the chip itself (title + description, `py-3`) plus the grid gap. */
export const SUGGESTION_ROW_HEIGHT = 76

/**
 * Everything in the panel that is NOT the chip grid: the greeting and its gap,
 * the composer, the thread header, the browser's own chrome, and the viewport
 * padding. Subtracted from the window height to get the grid's budget.
 */
export const SUGGESTION_CHROME_HEIGHT = 384

/** Three rows of two — the full six-chip set. */
export const MAX_SUGGESTION_ROWS = 3

export type SuggestionFitParams = {
  /** Measured inline size of the welcome root, in CSS px. */
  rootInlinePx: number
  /** Window (viewport) height in CSS px — a content-independent height proxy. */
  windowHeight: number
  /** How many suggestions the template actually ships. */
  total: number
}

/**
 * The number of chips to render: always **2, 4, or 6** (or `total`, when the
 * template ships fewer than two). A ragged final row reads as a rendering bug
 * and a single lone chip reads as a broken empty state, so the count is snapped
 * down to an even number rather than exactly filling the grid.
 */
export function visibleSuggestionCount(params: SuggestionFitParams): number {
  const { rootInlinePx, windowHeight, total } = params
  if (total <= 2) return Math.max(0, total)

  const columns = rootInlinePx >= TWO_COLUMN_MIN_WIDTH ? 2 : 1
  const budget = windowHeight - SUGGESTION_CHROME_HEIGHT
  const rows = Math.min(
    MAX_SUGGESTION_ROWS,
    Math.max(1, Math.floor(budget / SUGGESTION_ROW_HEIGHT)),
  )

  const fits = Math.min(total, columns * rows)
  // Snap down to an even count, and never below the two-chip floor.
  return Math.max(2, fits - (fits % 2))
}
