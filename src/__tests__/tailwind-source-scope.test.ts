import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * Tripwire, not a proof: nothing under `deploy/` may influence the bundle (a BUILD property, proved by two vite
 * builds with a planted file between them). This stops the directive from being deleted silently.
 */
describe('tailwind source scope', () => {
  it('keeps deploy/ out of the Tailwind source scan', () => {
    const css = readFileSync(
      join(__dirname, '..', 'styles', 'globals.css'), 'utf8')

    expect(
      css,
      'globals.css must keep `@source not "../../deploy"`. Tailwind v4 scans ' +
      'from the project root and only skips what .gitignore skips, so without ' +
      'this it harvests class names from deploy/root-index.html — a landing ' +
      'page the guest never loads — into the app bundle. It also keeps the ' +
      'directory closed against anything build-shaped landing there later. ' +
      'See the comment above the directive.',
    ).toMatch(/^@source\s+not\s+["']\.\.\/\.\.\/deploy["']\s*;/m)
  })

  it('still imports tailwind (the directive is useless on its own)', () => {
    const css = readFileSync(
      join(__dirname, '..', 'styles', 'globals.css'), 'utf8')
    expect(css).toMatch(/^@import\s+["']tailwindcss["']\s*;/m)
  })
})

/** Top-level statements in source order, comments stripped. */
function topLevelStatements(css: string): string[] {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, ' ')
  const statements: string[] = []
  let depth = 0
  let start = 0
  let quote: string | null = null

  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'") quote = c
    else if (c === '{') depth++
    else if (c === '}' && --depth === 0) {
      statements.push(src.slice(start, i + 1))
      start = i + 1
    } else if (c === ';' && depth === 0) {
      statements.push(src.slice(start, i + 1))
      start = i + 1
    }
  }
  return statements.map((s) => s.trim()).filter(Boolean)
}

/**
 * CSS allows `@import` only in the prologue — before every statement other
 * than `@charset` and a blockless `@layer`. Tailwind's own at-rules (`@source`,
 * `@custom-variant`, `@theme`) are not part of that grammar, so a standard
 * parser counts them as ordinary statements and everything after them is out
 * of the prologue.
 */
function classify(statement: string): 'import' | 'prologue' | 'other' {
  if (/^@import\b/.test(statement)) return 'import'
  if (/^@charset\b/.test(statement)) return 'prologue'
  if (/^@layer\b/.test(statement) && !statement.includes('{')) return 'prologue'
  return 'other'
}

/**
 * `@import "tw-animate-css"` must precede every other statement, or postcss-import leaves it un-inlined and the
 * animation utilities never reach the bundle; Tailwind does not care where `@source` appears.
 */
describe('globals.css @import prologue', () => {
  it('places every @import before any non-prologue statement', () => {
    const css = readFileSync(
      join(__dirname, '..', 'styles', 'globals.css'), 'utf8')

    const statements = topLevelStatements(css)
    const firstOther = statements.findIndex((s) => classify(s) === 'other')
    const misplaced =
      firstOther === -1
        ? []
        : statements.slice(firstOther).filter((s) => classify(s) === 'import')

    expect(
      misplaced,
      'every @import in globals.css must come before the first statement ' +
      'that is not @charset or a blockless @layer — CSS discards imports ' +
      'outside the prologue, and Vite\'s postcss-import refuses to inline ' +
      `them ("@import must precede all other statements"). First blocking ` +
      `statement: \`${statements[firstOther]}\`. Move the @import up rather ` +
      'than moving that statement down.',
    ).toEqual([])
  })

  it('imports tw-animate-css, which supplies the animate-* utilities', () => {
    const css = readFileSync(
      join(__dirname, '..', 'styles', 'globals.css'), 'utf8')
    expect(css).toMatch(/^@import\s+["']tw-animate-css["']\s*;/m)
  })
})
