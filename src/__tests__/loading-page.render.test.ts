import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { NexusLoadingPage } from '../components/assistant-ui/loading-page'

/**
 * The full-panel conversation loading page — a fast monochrome arc spinner
 * (900ms rotation), sized for the sub-second session switch it mostly covers.
 * It replaced the slow gooey-metaball field. Strictly monochrome (currentColor
 * strokes, separation by opacity), with a caller-supplied "Loading…" label.
 * These guard its DOM contract (`tsc`/`build` never render it).
 */
describe('NexusLoadingPage render', () => {
  it('renders the track + rotating arc and the label, with no hardcoded color', () => {
    const html = renderToStaticMarkup(
      createElement(NexusLoadingPage, { label: 'Loading…' }),
    )
    // The two rings the globals.css rules target.
    expect(html).toContain('nexus-loadpage-track')
    expect(html).toContain('nexus-loadpage-arc')
    // The old slow metaball field is gone — no blob keyframe hooks remain.
    expect(html).not.toMatch(/nexus-loadpage-b\d/)
    expect(html).not.toContain('filter')
    // Monochrome: every stroke is currentColor and nothing hardcodes a hex.
    expect(html).toContain('stroke="currentColor"')
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,6}/)
    // …and that currentColor resolves to the ACCENT (`--primary`, what the
    // composer's Send button is filled with and what the Appearance swatch
    // rewrites), not to the near-black inherited foreground. On the <svg>, so
    // the label below it keeps the caller's text colour.
    expect(html).toContain('class="nexus-loadpage-stage text-primary"')
    expect(html).not.toMatch(/class="nexus-loadpage-label[^"]*text-primary/)
    // The caller-supplied label is shown and names the live region.
    expect(html).toContain('Loading…')
    expect(html).toContain('role="status"')
    expect(html).toContain('aria-label="Loading…"')
  })

  it('renders the label the caller passes (i18n-driven)', () => {
    const html = renderToStaticMarkup(
      createElement(NexusLoadingPage, { label: 'Chargement…' }),
    )
    expect(html).toContain('Chargement…')
    expect(html).toContain('aria-label="Chargement…"')
  })

  // The point of the redesign: a session switch is sub-second, so one full
  // rotation has to complete inside it. A slow loop reads as a frozen frame.
  it('spins fast enough to complete a cycle within a session switch', () => {
    const css = readFileSync(
      new URL('../styles/globals.css', import.meta.url),
      'utf-8',
    )
    const rule = /\.nexus-loadpage-arc\s*\{[^}]*animation:\s*nexus-load-spin\s+(\d+)ms/.exec(css)
    expect(rule, 'globals.css must animate .nexus-loadpage-arc with nexus-load-spin').not.toBeNull()
    expect(Number(rule![1])).toBeLessThanOrEqual(1000)
  })
})
