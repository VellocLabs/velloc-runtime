// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import {
  applyClippedTooltip,
  clippedTooltip,
} from '../browser/webview/titleOverflow'

/**
 * The sidebar session row's "full title on hover, but only when it doesn't
 * fit". happy-dom does no layout — every element reports `scrollWidth` and
 * `clientWidth` as 0 — so the decision is taken over two plain numbers and
 * tested here; the real geometry is covered by the e2e hover case.
 */

const TITLE = 'A session title far too long for a 256px sidebar row'

describe('clippedTooltip', () => {
  it('returns the text when the content is wider than the box', () => {
    expect(clippedTooltip({ scrollWidth: 420, clientWidth: 180 }, TITLE)).toBe(
      TITLE,
    )
  })

  it('returns null when the text fits', () => {
    expect(clippedTooltip({ scrollWidth: 120, clientWidth: 180 }, TITLE)).toBe(
      null,
    )
    expect(clippedTooltip({ scrollWidth: 180, clientWidth: 180 }, TITLE)).toBe(
      null,
    )
  })

  it('tolerates a 1px rounding overshoot', () => {
    // Fractional layout rounded to integers — not a real clip.
    expect(clippedTooltip({ scrollWidth: 181, clientWidth: 180 }, TITLE)).toBe(
      null,
    )
    expect(clippedTooltip({ scrollWidth: 182, clientWidth: 180 }, TITLE)).toBe(
      TITLE,
    )
  })

  it('returns null with nothing to measure or nothing to show', () => {
    expect(clippedTooltip(null, TITLE)).toBe(null)
    expect(clippedTooltip(undefined, TITLE)).toBe(null)
    expect(clippedTooltip({ scrollWidth: 420, clientWidth: 180 }, '')).toBe(null)
  })
})

describe('applyClippedTooltip', () => {
  it('sets the title attribute when clipped', () => {
    const host = document.createElement('button')
    applyClippedTooltip(host, { scrollWidth: 420, clientWidth: 180 }, TITLE)
    expect(host.getAttribute('title')).toBe(TITLE)
  })

  it('removes a stale tooltip once the text fits again', () => {
    // The row narrows while hovered (it reserves space for ⋯) and widens back,
    // and a rename can shorten the title in place — a tooltip left behind would
    // duplicate text that is fully visible.
    const host = document.createElement('button')
    applyClippedTooltip(host, { scrollWidth: 420, clientWidth: 180 }, TITLE)
    applyClippedTooltip(host, { scrollWidth: 120, clientWidth: 180 }, 'Short')
    expect(host.hasAttribute('title')).toBe(false)
  })

  it('leaves no tooltip when there is nothing to measure', () => {
    const host = document.createElement('button')
    applyClippedTooltip(host, null, TITLE)
    expect(host.hasAttribute('title')).toBe(false)
  })
})
