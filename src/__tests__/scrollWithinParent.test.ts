import { describe, expect, it, vi } from 'vitest'
import { centerInScrollParent } from '../browser/webview/scrollWithinParent'

function rect(top: number, height: number): DOMRect {
  return { top, height, bottom: top + height } as DOMRect
}

describe('centerInScrollParent', () => {
  it('scrolls only the nearest scrollable ancestor, never the overflow-hidden shell', () => {
    vi.stubGlobal('getComputedStyle', (el: { overflowY: string }) => ({ overflowY: el.overflowY }))
    const shellScrollTo = vi.fn()
    const listScrollTo = vi.fn()
    const shell = { overflowY: 'hidden', scrollHeight: 900, clientHeight: 600, parentElement: null, scrollTo: shellScrollTo }
    const list = {
      overflowY: 'auto', scrollHeight: 2000, clientHeight: 400, scrollTop: 100,
      parentElement: shell, scrollTo: listScrollTo, getBoundingClientRect: () => rect(50, 400),
    }
    const row = { parentElement: list, getBoundingClientRect: () => rect(650, 100) }

    centerInScrollParent(row as unknown as HTMLElement)

    expect(shellScrollTo).not.toHaveBeenCalled()
    // 100 + (650 - 50) - (400 - 100) / 2
    expect(listScrollTo).toHaveBeenCalledWith({ top: 550, behavior: 'smooth' })
    vi.unstubAllGlobals()
  })

  it('does nothing when no ancestor scrolls', () => {
    vi.stubGlobal('getComputedStyle', () => ({ overflowY: 'visible' }))
    const row = { parentElement: { parentElement: null } }
    expect(() => centerInScrollParent(row as unknown as HTMLElement)).not.toThrow()
    vi.unstubAllGlobals()
  })
})
