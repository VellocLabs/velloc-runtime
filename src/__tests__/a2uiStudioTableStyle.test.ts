import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { STUDIO_OVERLAY_MARK } from '../browser/webview/a2ui/studio/StudioSurfaceHost'

const css = readFileSync(join(__dirname, '../browser/webview/a2ui/studio/studio.css'), 'utf8')

/** The selector lists of the rules that style the engine's table. */
function tableRules(): string[][] {
  return [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{[^}]*\}/g)]
    .map(match => match[1].split(',').map(selector => selector.trim()).filter(Boolean))
    .filter(selectors => selectors.some(selector => selector.includes('.a2ui-std-')))
}

describe('studio table style', () => {
  it('frames the table, insets every column and runs the dividers to the frame', () => {
    const rules = css.slice(css.indexOf('.a2-surface-host .a2ui-std-table-wrap'))
    expect(rules).toMatch(/\.a2ui-std-table-wrap[^{]*\{[^}]*border: 1px solid var\(--a2-line\)/)
    expect(rules).toMatch(/\.a2ui-std-cell:first-child[^{]*\{[^}]*padding: 8px 16px/)
    expect(rules).toMatch(/\.a2ui-std-cell\[data-divider\][^{]*\{[^}]*border-bottom: 1px solid var\(--a2-line\)/)
  })

  it('reaches a dialog drawn outside the surface through the overlay mark, and nothing else', () => {
    const rules = tableRules()
    expect(rules.length).toBeGreaterThan(0)
    for (const selectors of rules) {
      for (const selector of selectors) {
        expect(selector.startsWith('.a2-surface-host ') || selector.startsWith(`.a2ui-surface[style*="${STUDIO_OVERLAY_MARK}"] `)).toBe(true)
      }
      const inSurface = selectors.filter(selector => selector.startsWith('.a2-surface-host ')).map(s => s.slice('.a2-surface-host '.length))
      const inOverlay = selectors.filter(selector => !selector.startsWith('.a2-surface-host ')).map(s => s.slice(s.indexOf('] ') + 2))
      expect(inOverlay).toEqual(inSurface)
    }
  })

  it('studio surfaces and their overlays take the host primary colour over the vendored one', () => {
    const plain = css.replace(/\/\*[\s\S]*?\*\//g, '')
    expect(plain).toMatch(/:root\s*\{[^}]*--velloc-host-primary: var\(--primary\)/)
    const rule = plain.match(/:root \.a2-surface-host\.a2-surface-host,\s*:root body > \.a2ui-surface\.a2ui-surface\s*\{([^}]*)\}/)
    expect(rule?.[1]).toMatch(/--primary: var\(--velloc-host-primary\)/)
    expect(rule?.[1]).toMatch(/--a2-accent: var\(--velloc-host-primary\)/)
  })

  it('the tab strip never scrolls down, so no vertical scrollbar shows beside the tabs', () => {
    const plain = css.replace(/\/\*[\s\S]*?\*\//g, '')
    const rule = plain.match(/\.a2-surface-host \[data-a2ui-tabs\] > \[role="tablist"\]\s*\{([^}]*)\}/)
    expect(rule?.[1]).toMatch(/overflow-y: hidden/)
  })
})
