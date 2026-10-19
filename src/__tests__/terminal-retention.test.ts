/** When a terminal view keeps its emulator while out of sight (F-31). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { measureViewSight, ViewRetention } from '@/browser/webview/terminal/terminalRetention'

const DELAYS = { paneHidden: 2_000, pageHidden: 30_000 }

function retention() {
  const changes: boolean[] = []
  const r = new ViewRetention({ onChange: live => changes.push(live), delays: DELAYS })
  return { r, changes }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('ViewRetention', () => {
  it('starts live and releases once out of sight for the delay', () => {
    const { r, changes } = retention()
    expect(r.live).toBe(true)
    r.update('paneHidden')
    vi.advanceTimersByTime(DELAYS.paneHidden - 1)
    expect(changes).toEqual([])
    vi.advanceTimersByTime(1)
    expect(changes).toEqual([false])
    expect(r.live).toBe(false)
  })

  it('a hidden page waits longer than a hidden pane', () => {
    const { r, changes } = retention()
    r.update('pageHidden')
    vi.advanceTimersByTime(DELAYS.paneHidden)
    expect(changes).toEqual([])
    vi.advanceTimersByTime(DELAYS.pageHidden - DELAYS.paneHidden)
    expect(changes).toEqual([false])
  })

  it('shown again before the delay keeps the emulator', () => {
    const { r, changes } = retention()
    r.update('paneHidden')
    vi.advanceTimersByTime(DELAYS.paneHidden - 1)
    r.update('shown')
    vi.advanceTimersByTime(DELAYS.pageHidden * 2)
    expect(changes).toEqual([])
  })

  it('shown after a release builds it again at once', () => {
    const { r, changes } = retention()
    r.update('paneHidden')
    vi.advanceTimersByTime(DELAYS.paneHidden)
    r.update('shown')
    expect(changes).toEqual([false, true])
    expect(r.live).toBe(true)
  })

  it('time out of sight counts across a change of where it is hidden', () => {
    const { r, changes } = retention()
    r.update('pageHidden')
    vi.advanceTimersByTime(DELAYS.paneHidden - 500)
    r.update('paneHidden')
    vi.advanceTimersByTime(499)
    expect(changes).toEqual([])
    vi.advanceTimersByTime(1)
    expect(changes).toEqual([false])
  })

  it('repeated measures of the same sight do not restart the wait', () => {
    const { r, changes } = retention()
    for (let i = 0; i < 4; i++) {
      r.update('paneHidden')
      vi.advanceTimersByTime(DELAYS.paneHidden / 4)
    }
    expect(changes).toEqual([false])
  })

  it('dispose drops a pending release', () => {
    const { r, changes } = retention()
    r.update('paneHidden')
    r.dispose()
    vi.advanceTimersByTime(DELAYS.pageHidden)
    expect(changes).toEqual([])
  })
})

describe('measureViewSight', () => {
  const element = (rects: number, width: number, height: number) =>
    ({ getClientRects: () => ({ length: rects }), clientWidth: width, clientHeight: height }) as unknown as HTMLElement

  it('an element with no box is a hidden pane, whatever the page', () => {
    vi.stubGlobal('document', { visibilityState: 'hidden' })
    expect(measureViewSight(element(0, 0, 0))).toBe('paneHidden')
    vi.stubGlobal('document', { visibilityState: 'visible' })
    expect(measureViewSight(element(1, 0, 300))).toBe('paneHidden')
  })

  it('a laid-out element is shown unless the page is hidden', () => {
    vi.stubGlobal('document', { visibilityState: 'visible' })
    expect(measureViewSight(element(1, 400, 300))).toBe('shown')
    vi.stubGlobal('document', { visibilityState: 'hidden' })
    expect(measureViewSight(element(1, 400, 300))).toBe('pageHidden')
  })
})
