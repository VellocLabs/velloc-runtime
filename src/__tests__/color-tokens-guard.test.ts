import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Colour-token guard: no raw palette colours (Tailwind hues, hex literals) in app source; every colour comes from
 * the light/dark tokens in `src/styles/globals.css`. The allowlist is for code that owns its own palette.
 */

const SRC = join(__dirname, '..')

/** Files that may carry raw colours, and why. */
const ALLOWLIST: Record<string, string> = {
  'styles/globals.css': 'the token definitions themselves',
  'utils/traceOverlay.ts':
    'self-contained vanilla-DOM debug overlay, lazy-loaded only behind the trace flag; owns its palette by design',
  'browser/webview/terminal/xtermTheme.ts':
    'the 16 ANSI colours a terminal program names by number, plus the fallbacks used when a token does not resolve; the screen, cursor and selection colours come from the tokens.',
  'browser/webview/settings/appearanceOptions.ts':
    'theme-colour SEEDS, not painted UI: each hex is a value sent to the host, which resolves it through the Chrome colour pipeline. The swatch paints its own seed on purpose — it is the colour being chosen, so it must NOT follow the theme.',
}

/** Any utility prefix (`text-`, `border-l-`, `ring-offset-`, `via-`, …)
 *  followed by a palette hue and a numeric stop. */
const RAW_TAILWIND_HUE =
  /(?<![\w/])[a-z]+(?:-[a-z]+)*-(?:zinc|gray|slate|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}(?:\/\d+)?\b/g

/** Literal colours: 3/4/6/8-digit hex and `rgb()` / `rgba()` / `hsl()` /
 *  `hsla()` with numeric channels. `oklch()` / `color-mix()` are allowed —
 *  they are how the token layer itself is written and how inline styles
 *  derive from it. */
const RAW_COLOR_LITERAL =
  /#[0-9a-fA-F]{3,4}\b|#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?\b|\b(?:rgba?|hsla?)\(/g

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue
      walk(full, out)
    } else if (/\.(?:tsx?|css)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(full)
    }
  }
  return out
}

function offenders(pattern: RegExp): string[] {
  const hits: string[] = []
  for (const file of walk(SRC)) {
    const rel = relative(SRC, file).replace(/\\/g, '/')
    if (rel in ALLOWLIST) continue
    const text = readFileSync(file, 'utf8')
    const lines = text.split('\n')
    lines.forEach((line, i) => {
      const found = line.match(pattern)
      if (found) hits.push(`${rel}:${i + 1}: ${found.join(' ')}`)
    })
  }
  return hits
}

describe('colour tokens guard', () => {
  it('app source uses no raw Tailwind palette hue', () => {
    expect(offenders(RAW_TAILWIND_HUE)).toEqual([])
  })

  it('app source uses no hex / rgb / hsl colour literal', () => {
    expect(offenders(RAW_COLOR_LITERAL)).toEqual([])
  })

  it('every semantic token is defined for both themes and mapped for Tailwind', () => {
    const css = readFileSync(join(SRC, 'styles/globals.css'), 'utf8')
    const light = css.slice(css.indexOf('\n:root {'), css.indexOf('\n.dark {'))
    const dark = css.slice(css.indexOf('\n.dark {'), css.indexOf('\n@layer base'))
    const theme = css.slice(css.indexOf('@theme inline {'), css.indexOf('\n:root {'))
    for (const token of [
      'success',
      'success-emphasis',
      'warning',
      'warning-emphasis',
      'info',
      'info-emphasis',
      'diff-added',
      'diff-removed',
      'diff-added-bg',
      'diff-removed-bg',
      'destructive',
    ]) {
      expect(light, `light --${token}`).toMatch(new RegExp(`^  --${token}: `, 'm'))
      expect(dark, `dark --${token}`).toMatch(new RegExp(`^  --${token}: `, 'm'))
      expect(theme, `@theme --color-${token}`).toContain(
        `--color-${token}: var(--${token});`,
      )
    }
  })

  /**
   * A `--color-<name>` entry in `@theme` makes `text-<name>` a colour utility, so a colour token named after a
   * font-size step (`--color-base`) silently redefines that size. Only the compiled CSS shows it.
   */
  it('no colour token shadows a Tailwind font-size utility', () => {
    const css = readFileSync(join(SRC, 'styles/globals.css'), 'utf8')
    const theme = css.slice(css.indexOf('@theme inline {'), css.indexOf('\n:root {'))
    const FONT_SIZE_STEPS = [
      'xs', 'sm', 'base', 'lg', 'xl',
      '2xl', '3xl', '4xl', '5xl', '6xl', '7xl', '8xl', '9xl',
    ]
    const shadowed = FONT_SIZE_STEPS.filter((step) =>
      new RegExp(`^\\s*--color-${step}:`, 'm').test(theme),
    )
    expect(shadowed, 'rename the token (e.g. --color-base-surface)').toEqual([])
  })

  it('the allowlist only names files that still exist', () => {
    for (const rel of Object.keys(ALLOWLIST)) {
      expect(() => statSync(join(SRC, rel)), rel).not.toThrow()
    }
  })
})
