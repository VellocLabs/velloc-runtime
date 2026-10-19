import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { rewriteXtermHeadless, XTERM_HEADLESS_ESM } from '../../vite/xtermHeadlessWorkerPlugin'

describe('xtermHeadlessWorkerPlugin', () => {
  it('the installed ES build reads no window once rewritten', () => {
    const rewritten = rewriteXtermHeadless(readFileSync(XTERM_HEADLESS_ESM, 'utf8'))
    expect(rewritten).not.toMatch(/\bwindow\b/)
    expect(rewritten).toContain('"requestIdleCallback"in globalThis')
  })

  it('fails loudly when the check is missing or repeated', () => {
    expect(() => rewriteXtermHeadless('export const x = 1')).toThrow(/found it 0 times/)
    const twice = '"requestIdleCallback"in window;"requestIdleCallback"in window'
    expect(() => rewriteXtermHeadless(twice)).toThrow(/found it 2 times/)
  })
})
