/**
 * The one own-time clock, shared by the isolated-worker kernel's execution
 * timeout and a mod hook's budget. Its kernel-shaped behaviour is also pinned
 * through `run-js-broker.test.ts`; this is the class by itself.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PausableDeadline } from '../browser/workerKernel/pausableDeadline'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

function make() {
  let expired = 0
  const clock = new PausableDeadline(() => {
    expired += 1
  })
  return { clock, expired: () => expired }
}

describe('PausableDeadline', () => {
  it('expires once, after its budget of running time', () => {
    const { clock, expired } = make()
    clock.start(100)
    vi.advanceTimersByTime(99)
    expect(expired()).toBe(0)
    vi.advanceTimersByTime(1)
    expect(expired()).toBe(1)
    vi.advanceTimersByTime(1_000)
    expect(expired()).toBe(1)
  })

  it('does not count time spent paused', () => {
    const { clock, expired } = make()
    clock.start(100)
    vi.advanceTimersByTime(60)
    clock.pause()
    vi.advanceTimersByTime(10_000)
    expect(expired()).toBe(0)
    expect(clock.remainingMs()).toBe(40)
    clock.resume()
    vi.advanceTimersByTime(39)
    expect(expired()).toBe(0)
    vi.advanceTimersByTime(1)
    expect(expired()).toBe(1)
  })

  it('pauses are depth-counted: it resumes only when the last wait ends', () => {
    const { clock, expired } = make()
    clock.start(50)
    clock.pause()
    clock.pause()
    clock.resume()
    vi.advanceTimersByTime(1_000)
    expect(expired()).toBe(0)
    clock.resume()
    vi.advanceTimersByTime(50)
    expect(expired()).toBe(1)
  })

  it('a start while paused holds the whole budget until the resume', () => {
    const { clock, expired } = make()
    clock.pause()
    clock.start(100)
    vi.advanceTimersByTime(5_000)
    expect(expired()).toBe(0)
    expect(clock.remainingMs()).toBe(100)
    clock.resume()
    vi.advanceTimersByTime(100)
    expect(expired()).toBe(1)
  })

  it('a second start is ignored; a resume without a pause is ignored', () => {
    const { clock, expired } = make()
    clock.start(100)
    clock.start(10)
    clock.resume()
    vi.advanceTimersByTime(50)
    expect(expired()).toBe(0)
    vi.advanceTimersByTime(50)
    expect(expired()).toBe(1)
  })

  it('stop means no expiry — now, or after a later resume', () => {
    const { clock, expired } = make()
    clock.start(100)
    clock.pause()
    clock.stop()
    clock.resume()
    vi.advanceTimersByTime(10_000)
    expect(expired()).toBe(0)
    const second = make()
    second.clock.start(100)
    second.clock.stop()
    vi.advanceTimersByTime(10_000)
    expect(second.expired()).toBe(0)
    // And a start after stop arms nothing.
    const third = make()
    third.clock.stop()
    third.clock.start(10)
    vi.advanceTimersByTime(100)
    expect(third.expired()).toBe(0)
  })

  it('whilePaused pauses for exactly the work, whether it resolves or rejects', async () => {
    const { clock, expired } = make()
    clock.start(100)
    const slow = clock.whilePaused(() => new Promise(resolve => setTimeout(resolve, 5_000)))
    await vi.advanceTimersByTimeAsync(5_000)
    await slow
    expect(expired()).toBe(0)
    const failing = clock.whilePaused(
      () => new Promise((_, reject) => setTimeout(() => reject(new Error('no')), 5_000)),
    )
    failing.catch(() => {})
    await vi.advanceTimersByTimeAsync(5_000)
    await expect(failing).rejects.toThrow('no')
    expect(expired()).toBe(0)
    vi.advanceTimersByTime(100)
    expect(expired()).toBe(1)
  })

  it('reads what is left: the budget counted down while running, held while paused', () => {
    const { clock } = make()
    expect(clock.remainingMs()).toBe(0)
    clock.start(100)
    vi.advanceTimersByTime(30)
    expect(clock.remainingMs()).toBe(70)
    clock.pause()
    vi.advanceTimersByTime(500)
    expect(clock.remainingMs()).toBe(70)
    clock.resume()
    vi.advanceTimersByTime(70)
    expect(clock.remainingMs()).toBe(0)
  })
})
