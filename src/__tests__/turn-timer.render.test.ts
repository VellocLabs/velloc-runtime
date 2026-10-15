// @vitest-environment happy-dom
/**
 * The running indicator's elapsed-turn label: "12s" / "1m 11s", ticking while
 * the turn is live and frozen at its final value once the turn has an end.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { useTurnTimer, type TurnTimerInput as TimerInput } from '../hooks/useTurnTimer'

const T0 = 1_700_000_000_000

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('useTurnTimer', () => {
  it('ticks once per second while live', () => {
    const { result } = renderHook(() => useTurnTimer({ since: T0, live: true }))
    expect(result.current).toBe('0s')
    act(() => {
      vi.advanceTimersByTime(12_000)
    })
    expect(result.current).toBe('12s')
    act(() => {
      vi.advanceTimersByTime(59_000)
    })
    expect(result.current).toBe('1m 11s')
  })

  it('honours a custom tick interval', () => {
    const { result } = renderHook(() =>
      useTurnTimer({ since: T0, live: true, tickMs: 5000 }),
    )
    act(() => {
      vi.advanceTimersByTime(4000)
    })
    expect(result.current).toBe('0s')
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(result.current).toBe('5s')
  })

  it('does not tick when not live', () => {
    const { result } = renderHook(() => useTurnTimer({ since: T0, live: false }))
    act(() => {
      vi.advanceTimersByTime(30_000)
    })
    expect(result.current).toBe('0s')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('freezes at the end time', () => {
    const { result } = renderHook(() =>
      useTurnTimer({ since: T0, live: true, until: T0 + 71_000 }),
    )
    expect(result.current).toBe('1m 11s')
    act(() => {
      vi.advanceTimersByTime(10_000)
    })
    expect(result.current).toBe('1m 11s')
  })

  it('subtracts paused time and never goes negative', () => {
    const paused = renderHook(() =>
      useTurnTimer({ since: T0 - 20_000, live: false, pausedMs: 8000 }),
    )
    expect(paused.result.current).toBe('12s')
    const future = renderHook(() => useTurnTimer({ since: T0 + 5000, live: false }))
    expect(future.result.current).toBe('0s')
  })

  it('stops its interval when the turn stops being live', () => {
    const { result, rerender } = renderHook(
      (props: TimerInput) => useTurnTimer(props),
      { initialProps: { since: T0, live: true } as TimerInput },
    )
    act(() => {
      vi.advanceTimersByTime(3000)
    })
    expect(result.current).toBe('3s')
    rerender({ since: T0, live: false, until: T0 + 3000 })
    expect(vi.getTimerCount()).toBe(0)
    expect(result.current).toBe('3s')
  })
})
