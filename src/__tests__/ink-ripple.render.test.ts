import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { InkRipple } from '../components/assistant-ui/ink-ripple'

/**
 * The session-list busy indicator ("ink drop ripple") replaced the spinning
 * Loader2 (and, before it, the Mercury Droplet). Three concentric currentColor
 * circles, no filter — strictly monochrome, animated purely via CSS keyframes on
 * staggered delays. These guard its DOM contract (`tsc`/`build` never render it).
 */
describe('InkRipple render', () => {
  it('renders three ripple circles with no SVG filter and no hardcoded color', () => {
    const html = renderToStaticMarkup(createElement(InkRipple))
    expect(html).toContain('nexus-ripple')
    // Three concentric ripple elements (the staggered copies of one keyframe).
    expect((html.match(/<i\b/g) ?? []).length).toBe(3)
    // No SVG / goo filter — this is the pure-CSS ripple.
    expect(html).not.toContain('<svg')
    expect(html).not.toContain('feGaussianBlur')
    // Monochrome: no hardcoded hue (currentColor comes from CSS + the caller's
    // text-* class).
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,6}/)
    // Decorative echo of the row's running state.
    expect(html).toContain('aria-hidden="true"')
  })

  it('forwards className and data-* props onto the outer element', () => {
    const html = renderToStaticMarkup(
      createElement(InkRipple, {
        className: 'text-primary shrink-0',
        'data-slot': 'session-row-running-icon',
      } as Record<string, unknown>),
    )
    expect(html).toContain('text-primary')
    expect(html).toContain('shrink-0')
    expect(html).toContain('data-slot="session-row-running-icon"')
  })
})
