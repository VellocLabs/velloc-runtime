import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { CUSTOM_FONT_SIZE_NAMES, cn } from '../lib/utils'

/**
 * `cn()` must treat the type-scale utilities as font sizes, not colours, or tailwind-merge drops `text-caption`
 * before a colour, or the colour before a size (`text-muted-foreground text-body`).
 */
describe('cn keeps the custom font-size utilities', () => {
  it('a size followed by a colour keeps both', () => {
    expect(cn('text-caption text-muted-foreground/70')).toBe(
      'text-caption text-muted-foreground/70',
    )
  })

  it('a colour followed by a size keeps both', () => {
    expect(cn('text-muted-foreground text-body')).toBe('text-muted-foreground text-body')
  })

  it('a custom size conflicts with the built-in scale, last one wins', () => {
    expect(cn('text-sm text-body')).toBe('text-body')
    expect(cn('text-body text-sm')).toBe('text-sm')
    expect(cn('text-prose text-caption')).toBe('text-caption')
  })

  it('every name is registered, in both directions', () => {
    for (const name of CUSTOM_FONT_SIZE_NAMES) {
      expect(cn(`text-${name} text-primary`)).toBe(`text-${name} text-primary`)
      expect(cn(`text-primary text-${name}`)).toBe(`text-primary text-${name}`)
    }
  })

  it('lists exactly the `--text-<name>` sizes declared in globals.css', () => {
    const css = readFileSync(join(__dirname, '..', 'styles', 'globals.css'), 'utf8')
    const declared = new Set(
      [...css.matchAll(/^\s*--text-([a-z]+):\s*var\(--nx-/gm)].map((m) => m[1]!),
    )
    expect([...declared].sort()).toEqual([...CUSTOM_FONT_SIZE_NAMES].sort())
  })
})
