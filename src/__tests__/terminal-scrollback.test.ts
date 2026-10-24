/** The terminal scrollbar stays shown only while lines sit above the screen (F-31). */
import { describe, expect, it } from 'vitest'

import { hasScrollback } from '@/browser/webview/terminal/terminalScrollback'

describe('hasScrollback', () => {
  it('is true only for a normal buffer longer than the screen', () => {
    expect(hasScrollback({ type: 'normal', length: 24 }, 24)).toBe(false)
    expect(hasScrollback({ type: 'normal', length: 25 }, 24)).toBe(true)
  })

  it('is false for a full-screen program’s alternate buffer', () => {
    expect(hasScrollback({ type: 'alternate', length: 500 }, 24)).toBe(false)
  })
})
