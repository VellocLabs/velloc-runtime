import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * The guest's fonts are self-hosted (@fontsource-variable/geist{,-mono}, emitted as content-hashed /assets/): no
 * external font origin on the critical path, where a slow hosted stylesheet blocks first paint.
 */
describe('guest fonts are self-hosted', () => {
  const root = join(__dirname, '..', '..')
  const html = readFileSync(join(root, 'index.html'), 'utf8')
  const globals = readFileSync(join(root, 'src', 'styles', 'globals.css'), 'utf8')

  it('index.html references no external font origin', () => {
    expect(
      html,
      'index.html must not load fonts from fonts.googleapis.com — the ' +
        'stylesheet is render-blocking with 24 h freshness, so first paint ' +
        'stalls on Google reachability. Fonts are self-hosted via ' +
        '@fontsource-variable imported in src/glic/main.tsx.',
    ).not.toMatch(/fonts\.googleapis\.com|fonts\.gstatic\.com/)
  })

  it('index.html carries no preconnect hints (nothing external is on the critical path)', () => {
    expect(html).not.toMatch(/rel="preconnect"/)
  })

  it('index.html font vars use the self-hosted variable family names', () => {
    expect(html).toContain("'Geist Variable'")
    expect(html).toContain("'Geist Mono Variable'")
  })

  it('the entry imports both fontsource packages TS-side, not via css @import', () => {
    // The Tailwind v4 pipeline inlines css @imports WITHOUT rebasing their
    // relative url(./files/…) font references — verified on a real build:
    // the urls survived verbatim into dist css and no woff2 was emitted, so
    // every font silently 404'd at runtime. A TS-side import goes through
    // Vite's own css handling, which rebases and emits the woff2s as
    // content-hashed assets. Both families must be present — sans without
    // mono would silently fall back to system monospace in code blocks.
    const entry = readFileSync(join(root, 'src', 'glic', 'main.tsx'), 'utf8')
    expect(entry).toMatch(/import '@fontsource-variable\/geist'/)
    expect(entry).toMatch(/import '@fontsource-variable\/geist-mono'/)
    expect(
      globals,
      'globals.css must NOT css-@import the fontsource packages — the ' +
        'Tailwind v4 import pipeline ships their @font-face urls unrebased',
    ).not.toMatch(/@import "@fontsource-variable/)
  })

  it('the font packages actually resolve (deps not dropped)', () => {
    for (const pkg of [
      '@fontsource-variable/geist',
      '@fontsource-variable/geist-mono',
    ]) {
      expect(
        existsSync(join(root, 'node_modules', pkg, 'index.css')),
        `${pkg} must be installed — src/glic/main.tsx imports it`,
      ).toBe(true)
    }
  })
})
