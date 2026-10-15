import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Pre-paint theme contract of index.html (no white frame before the `dark` class lands): an inline blocking
 * <script> adds `dark` from the media query; `<meta name="color-scheme" content="light dark">`; and an inline
 * `html { background: light-dark(…) }` with the light and dark `--background` tokens.
 */
describe('guest pre-paint theme', () => {
  const root = join(__dirname, '..', '..')
  const html = readFileSync(join(root, 'index.html'), 'utf8')
  const globals = readFileSync(join(root, 'src', 'styles', 'globals.css'), 'utf8')

  it('sets html.dark from the media query in a blocking inline script before <body>', () => {
    const head = html.slice(0, html.indexOf('<body'))
    const script = head.match(/<script>([\s\S]*?)<\/script>/)
    expect(script, 'an inline (non-module, non-deferred) <script> in <head>').not.toBeNull()
    expect(script![1]).toMatch(/matchMedia\(['"]\(prefers-color-scheme: dark\)['"]\)\.matches/)
    expect(script![1]).toMatch(/documentElement\.classList\.add\(['"]dark['"]\)/)
  })

  it('declares both colour schemes to the UA', () => {
    expect(html).toMatch(/<meta name="color-scheme" content="light dark"\s*\/?>/)
  })

  it('paints the html ground with the two --toolbar token values before the stylesheet', () => {
    const ground = html.match(/html\s*\{[^}]*background:\s*light-dark\(([^,]+),\s*([^)]+)\)/)
    expect(ground, 'html { background: light-dark(light, dark) }').not.toBeNull()
    const [, light, dark] = ground!
    // The intermediate ground is Chrome's toolbar colour, matching what the
    // host paints around the webview: light white, dark #3c3c3c
    // (= oklch(0.356 0 0), the --toolbar fallback). Compare against
    // globals.css so the two cannot drift apart silently.
    expect(light.trim().toLowerCase()).toBe('#ffffff')
    expect(globals).toMatch(/^:root \{[\s\S]*?^  --toolbar: oklch\(1 0 0\);/m)
    expect(dark.trim().toLowerCase()).toBe('#3c3c3c')
    expect(globals).toMatch(/^\.dark \{[\s\S]*?^  --toolbar: oklch\(0\.356 0 0\);/m)
  })

  it('dark text is Chrome neutral-90, not white', () => {
    // The whole point of the retune: #e3e3e3 (oklch 0.916) on #1f1f1f, ~12:1,
    // instead of the stock 0.985-on-0.141 that glared next to the browser.
    expect(globals).toMatch(/^\.dark \{[\s\S]*?^  --foreground: oklch\(0\.916 0 0\);/m)
    expect(globals).not.toMatch(/^\.dark \{[\s\S]*?^  --foreground: oklch\(0\.985 0 0\);/m)
  })
})
