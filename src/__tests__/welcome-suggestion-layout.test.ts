// The welcome pages ship six prompt-starter chips, which only fit a roomy
// panel. `visibleSuggestionCount` truncates the list to 6 / 4 / 2 so the grid
// never overflows the viewport scroller (where the bottom row hides under the
// pinned composer). See `components/assistant-ui/welcomeSuggestionLayout.ts`.

import { describe, expect, it } from 'vitest'
import {
  MAX_SUGGESTION_ROWS,
  SUGGESTION_CHROME_HEIGHT,
  SUGGESTION_ROW_HEIGHT,
  TWO_COLUMN_MIN_WIDTH,
  visibleSuggestionCount,
} from '../components/assistant-ui/welcomeSuggestionLayout'

/** Window height that leaves room for exactly `rows` chip rows. */
function heightForRows(rows: number): number {
  return SUGGESTION_CHROME_HEIGHT + rows * SUGGESTION_ROW_HEIGHT
}

const WIDE = TWO_COLUMN_MIN_WIDTH
const NARROW = TWO_COLUMN_MIN_WIDTH - 1

describe('visibleSuggestionCount', () => {
  it('shows all six chips in a wide, tall panel', () => {
    expect(
      visibleSuggestionCount({
        rootInlinePx: 900,
        windowHeight: heightForRows(MAX_SUGGESTION_ROWS),
        total: 6,
      }),
    ).toBe(6)
  })

  it('drops to four chips when only two rows fit, and two when only one does', () => {
    expect(
      visibleSuggestionCount({
        rootInlinePx: WIDE,
        windowHeight: heightForRows(2),
        total: 6,
      }),
    ).toBe(4)
    expect(
      visibleSuggestionCount({
        rootInlinePx: WIDE,
        windowHeight: heightForRows(1),
        total: 6,
      }),
    ).toBe(2)
  })

  it('never renders a ragged final row — the count is always even', () => {
    // A single column with three rows of vertical room fits 3 chips, but 3 is
    // odd: rendering it would leave the grid visually lopsided once the panel
    // widens back to two columns mid-resize. Snap down to 2.
    expect(
      visibleSuggestionCount({
        rootInlinePx: NARROW,
        windowHeight: heightForRows(MAX_SUGGESTION_ROWS),
        total: 6,
      }),
    ).toBe(2)
    for (const windowHeight of [0, 300, 600, 900, 1400]) {
      for (const rootInlinePx of [0, 320, 447, 448, 700, 1200]) {
        const count = visibleSuggestionCount({ rootInlinePx, windowHeight, total: 6 })
        expect([2, 4, 6], `${rootInlinePx}x${windowHeight}`).toContain(count)
      }
    }
  })

  it('holds the two-chip floor for a panel with no room at all', () => {
    // Zero/negative budget (a very short window, or the pre-measurement frame
    // where width is still 0) must still render something — an empty welcome
    // page reads as a broken session, not as a tight fit.
    expect(
      visibleSuggestionCount({ rootInlinePx: 0, windowHeight: 0, total: 6 }),
    ).toBe(2)
    expect(
      visibleSuggestionCount({ rootInlinePx: 1200, windowHeight: 100, total: 6 }),
    ).toBe(2)
  })

  it('never invents chips a template does not ship', () => {
    expect(
      visibleSuggestionCount({ rootInlinePx: 1200, windowHeight: 2000, total: 4 }),
    ).toBe(4)
    expect(
      visibleSuggestionCount({ rootInlinePx: 1200, windowHeight: 2000, total: 2 }),
    ).toBe(2)
    expect(
      visibleSuggestionCount({ rootInlinePx: 1200, windowHeight: 2000, total: 1 }),
    ).toBe(1)
    expect(
      visibleSuggestionCount({ rootInlinePx: 1200, windowHeight: 2000, total: 0 }),
    ).toBe(0)
  })

  it('is monotonic — more space never shows fewer chips', () => {
    let previous = 0
    for (const rows of [0, 1, 2, 3, 4, 8]) {
      const count = visibleSuggestionCount({
        rootInlinePx: 1200,
        windowHeight: heightForRows(rows),
        total: 6,
      })
      expect(count, `rows=${rows}`).toBeGreaterThanOrEqual(previous)
      previous = count
    }
  })
})
