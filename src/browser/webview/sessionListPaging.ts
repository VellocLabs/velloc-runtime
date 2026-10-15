/**
 * Incremental reveal for a sidebar session list ("Show N more"): a page per click with no upper bound,
 * in component state only, so a reload starts at one page.
 */

/** Rows shown initially, and added per "Show more" click. */
export const SESSION_PAGE_SIZE = 20

/**
 * How many rows the next click reveals — the page size, clamped to what is
 * actually left, so the label never promises more than it delivers (the last
 * click on a 27-row list reads "Show 7 more", not "Show 20 more").
 *
 * Returns 0 when nothing remains; the caller renders no button.
 */
export function nextPageCount(total: number, shownSoFar: number): number {
  const remaining = total - shownSoFar
  if (remaining <= 0) return 0
  return Math.min(SESSION_PAGE_SIZE, remaining)
}

/**
 * The visible count after revealing one more page. Clamped to `total` so the
 * count can never run past the list.
 */
export function revealNextPage(total: number, shownSoFar: number): number {
  return Math.min(total, shownSoFar + SESSION_PAGE_SIZE)
}

/**
 * The visible count needed for `index` to be on screen, rounded up to a whole page and never below
 * `shownSoFar`; `index < 0` leaves it untouched.
 */
export function countIncluding(shownSoFar: number, index: number): number {
  if (index < 0) return shownSoFar
  const needed = (Math.floor(index / SESSION_PAGE_SIZE) + 1) * SESSION_PAGE_SIZE
  return Math.max(shownSoFar, needed)
}
