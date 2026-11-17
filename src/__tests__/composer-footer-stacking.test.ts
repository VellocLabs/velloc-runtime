import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { IN_FLOW_WITHOUT_HOVER } from '../components/assistant-ui/touch-reveal'

// The composer footer (permission / plan / question cards, send, stop) is sticky over
// the transcript, so a row's overlay scrolling beneath it must paint below it and leave
// it the taps. jsdom has no hit-testing: the stacking is read from the class lists.
const read = (file: string) =>
  readFileSync(resolve(__dirname, '../components/assistant-ui', file), 'utf8')

function classesOf(source: string, marker: string): string[] {
  const at = source.indexOf(marker)
  expect(at, marker).toBeGreaterThan(-1)
  const end = source.indexOf('"', at)
  const start = source.lastIndexOf('"', at) + 1
  return source.slice(start, end).split(/\s+/)
}

/** Base z-index of a class list; `auto` when none is set. */
function zOf(classes: string[]): number | 'auto' {
  const z = classes.filter((c) => /^-?z-\d+$/.test(c))
  expect(z.length).toBeLessThanOrEqual(1)
  if (z.length === 0) return 'auto'
  const n = Number(z[0]!.replace(/^-?z-/, ''))
  return z[0]!.startsWith('-') ? -n : n
}

describe('composer footer stacking', () => {
  const footer = classesOf(read('thread.tsx'), 'aui-thread-viewport-footer sticky')
  const footerZ = zOf(footer)

  it('the footer is its own positioned layer', () => {
    expect(footer).toContain('sticky')
    expect(footerZ).not.toBe('auto')
  })

  // Equal z with the footer later in the tree still puts the footer on top.
  const overlays: Array<[string, string, string]> = [
    ['user action bar', 'user-message.tsx', 'aui-user-action-bar-wrapper'],
    ['user inject remove', 'user-message.tsx', 'absolute -top-2 -left-2'],
    ['assistant action bar', 'reply-row.tsx', 'aui-assistant-message-footer absolute'],
  ]
  for (const [name, file, marker] of overlays) {
    it(`a row's ${name} never stacks above the footer`, () => {
      const z = zOf(classesOf(read(file), marker))
      if (z !== 'auto') expect(z).toBeLessThanOrEqual(footerZ as number)
    })
  }

  it('an action bar placed in flow on a touch screen drops its overlay z-index', () => {
    expect(IN_FLOW_WITHOUT_HOVER.split(' ')).toContain('[@media(hover:none)]:z-auto')
  })
})
