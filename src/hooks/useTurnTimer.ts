import { useMemo, useSyncExternalStore } from 'react'
import { durationLabel } from '../utils/humanize/durationLabel'

export type TurnTimerInput = {
  /** When the turn began (epoch ms). */
  since: number
  /** While true the label refreshes every `tickMs`. */
  live: boolean
  /** Refresh period while live; default one second. */
  tickMs?: number
  /** Total paused time (ms) to leave out of the label. */
  pausedMs?: number
  /** When set, the label is fixed at `until - since` instead of following the clock. */
  until?: number
}

/**
 * Elapsed time of the current turn as a short label ("12s", "1m 11s"), for the
 * running indicator. Never negative. The label is recomputed on each tick and
 * on every render; no timer runs while `live` is false.
 */
export function useTurnTimer({
  since,
  live,
  tickMs = 1000,
  pausedMs = 0,
  until,
}: TurnTimerInput): string {
  const subscribe = useMemo(
    () =>
      (onTick: () => void): (() => void) => {
        if (!live) return () => undefined
        const timer = setInterval(onTick, tickMs)
        return () => clearInterval(timer)
      },
    [live, tickMs],
  )
  const read = () =>
    durationLabel(Math.max(0, (until ?? Date.now()) - since - pausedMs))
  return useSyncExternalStore(subscribe, read, read)
}
