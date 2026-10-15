/**
 * Deterministic fake clock for testing timers without real delays.
 * Replaces setTimeout/setInterval/clearTimeout/clearInterval with
 * manual advance semantics.
 */

type TimerEntry = {
  id: number
  callback: () => void
  fireAt: number
  interval?: number
}

export class FakeClock {
  private currentTime = 0
  private nextId = 1
  private timers = new Map<number, TimerEntry>()

  now(): number {
    return this.currentTime
  }

  setTimeout(callback: () => void, delayMs: number): number {
    const id = this.nextId++
    this.timers.set(id, {
      id,
      callback,
      fireAt: this.currentTime + delayMs,
    })
    return id
  }

  clearTimeout(handle: number): void {
    this.timers.delete(handle)
  }

  setInterval(callback: () => void, delayMs: number): number {
    const id = this.nextId++
    this.timers.set(id, {
      id,
      callback,
      fireAt: this.currentTime + delayMs,
      interval: delayMs,
    })
    return id
  }

  clearInterval(handle: number): void {
    this.timers.delete(handle)
  }

  /**
   * Advance time by `ms` milliseconds, firing any timers whose deadline
   * is reached (in chronological order). Interval timers re-arm.
   */
  advanceBy(ms: number): void {
    const target = this.currentTime + ms

    while (true) {
      // Find the earliest timer that fires at or before `target`.
      let earliest: TimerEntry | null = null
      for (const entry of this.timers.values()) {
        if (entry.fireAt <= target) {
          if (!earliest || entry.fireAt < earliest.fireAt) {
            earliest = entry
          }
        }
      }

      if (!earliest) break

      this.currentTime = earliest.fireAt

      if (earliest.interval !== undefined) {
        // Re-arm interval timer.
        earliest.fireAt = this.currentTime + earliest.interval
        earliest.callback()
      } else {
        this.timers.delete(earliest.id)
        earliest.callback()
      }
    }

    this.currentTime = target
  }

  /** Number of pending timers (for assertions). */
  get pendingCount(): number {
    return this.timers.size
  }

  /** Whether a specific timer id is still pending. */
  hasTimer(id: number): boolean {
    return this.timers.has(id)
  }
}
