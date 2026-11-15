import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Layout spacing of the strip under the composer (folder chip, model, context
// ring). jsdom has no layout, so the spacing is read from the class lists:
// footer gap + strip top margin, and footer bottom padding + strip bottom
// margin, must each come to 3px at both breakpoints.
const source = readFileSync(
  resolve(__dirname, '../components/assistant-ui/thread.tsx'),
  'utf8',
)

function classesOf(marker: string): string[] {
  const at = source.indexOf(marker)
  expect(at).toBeGreaterThan(-1)
  const open = source.lastIndexOf('<', at)
  const tag = source.slice(open, source.indexOf('>', at))
  const m = /className="([^"]+)"/.exec(tag)
  expect(m).not.toBeNull()
  return m![1]!.split(/\s+/)
}

const SPACING = 4
// `value` is what follows the utility prefix, e.g. "1.5", "-[5px]".
function px(value: string | undefined): number {
  if (value === undefined) return 0
  const neg = value.startsWith('-')
  const raw = neg ? value.slice(1) : value
  const arbitrary = /^\[(\d+(?:\.\d+)?)px\]$/.exec(raw)
  const n = arbitrary ? Number(arbitrary[1]) : Number(raw) * SPACING
  return neg ? -n : n
}
function pick(list: string[], prefix: string, md: boolean): string | undefined {
  const base = list.find((c) => !c.includes(':') && c.replace(/^-/, '').startsWith(prefix))
  const wide = list.find((c) => c.startsWith('md:') && c.slice(3).replace(/^-/, '').startsWith(prefix))
  const chosen = md && wide ? wide.slice(3) : base
  return chosen?.replace(new RegExp(`^(-?)${prefix}`), '$1')
}

describe('composer bottom strip', () => {
  const footer = classesOf('aui-thread-viewport-footer sticky')
  const strip = classesOf('data-slot="composer-bottom-strip"')

  for (const md of [false, true]) {
    it(`sits 3px below the composer and 3px above the window edge (${md ? 'md' : 'narrow'})`, () => {
      const gap = px(pick(footer, 'gap-', md))
      const padBottom = px(pick(footer, 'pb-', md))
      const top = px(pick(strip, 'mt-', md))
      const bottom = px(pick(strip, 'mb-', md))
      expect(gap + top).toBe(3)
      expect(padBottom + bottom).toBe(3)
    })
  }
})
