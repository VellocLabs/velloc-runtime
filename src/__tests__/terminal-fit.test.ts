/** When the emulator re-fits its host (F-31): observer notices, renders, the debounce. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FitScheduler, type HostBox } from '@/browser/webview/terminal/terminalFit'

const DEBOUNCE_MS = 100

function scheduler(initial: HostBox = { width: 400, height: 300 }) {
  let box = initial
  const fit = vi.fn()
  const measure = vi.fn(() => box)
  const s = new FitScheduler({ measure, fit, debounceMs: DEBOUNCE_MS })
  return { s, fit, measure, resize: (next: HostBox) => (box = next) }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('FitScheduler', () => {
  it('observer notices are debounced into one fit', () => {
    const { s, fit } = scheduler()
    s.observed()
    vi.advanceTimersByTime(DEBOUNCE_MS - 1)
    s.observed()
    s.observed()
    vi.advanceTimersByTime(DEBOUNCE_MS - 1)
    expect(fit).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(fit).toHaveBeenCalledTimes(1)
  })

  it('a render with the box last fitted schedules nothing', () => {
    const { s, fit } = scheduler()
    s.fitNow()
    expect(fit).toHaveBeenCalledTimes(1)
    expect(s.rendered()).toBe(false)
    vi.advanceTimersByTime(DEBOUNCE_MS * 2)
    expect(fit).toHaveBeenCalledTimes(1)
  })

  it('a render with a changed box refits without any observer notice', () => {
    const { s, fit, resize } = scheduler()
    s.fitNow()
    resize({ width: 900, height: 300 })
    expect(s.rendered()).toBe(true)
    expect(fit).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(DEBOUNCE_MS)
    expect(fit).toHaveBeenCalledTimes(2)
    // The fit recorded the new box: the next render is quiet.
    expect(s.rendered()).toBe(false)
  })

  it('a render before any fit schedules one', () => {
    const { s, fit } = scheduler()
    expect(s.rendered()).toBe(true)
    vi.advanceTimersByTime(DEBOUNCE_MS)
    expect(fit).toHaveBeenCalledTimes(1)
  })

  it('a box that changes and changes back before the fit still fits once', () => {
    const { s, fit, resize } = scheduler()
    s.fitNow()
    resize({ width: 900, height: 300 })
    s.rendered()
    resize({ width: 400, height: 300 })
    s.rendered()
    vi.advanceTimersByTime(DEBOUNCE_MS)
    expect(fit).toHaveBeenCalledTimes(2)
    expect(s.rendered()).toBe(false)
  })

  it('fitNow drops the pending fit and fits at once', () => {
    const { s, fit } = scheduler()
    s.observed()
    s.fitNow()
    expect(fit).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(DEBOUNCE_MS * 2)
    expect(fit).toHaveBeenCalledTimes(1)
  })

  it('dispose cancels the pending fit and ignores later triggers', () => {
    const { s, fit, resize } = scheduler()
    s.observed()
    s.dispose()
    vi.advanceTimersByTime(DEBOUNCE_MS * 2)
    resize({ width: 1, height: 1 })
    expect(s.rendered()).toBe(false)
    s.observed()
    s.fitNow()
    vi.advanceTimersByTime(DEBOUNCE_MS * 2)
    expect(fit).not.toHaveBeenCalled()
  })
})
