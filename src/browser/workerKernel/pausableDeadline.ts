/**
 * Contract: a deadline on code's own time, paused while it waits on others. Used
 * by the kernel's execution clock (paused per nested call) and a mod hook's
 * budget (paused during `next(e)` or a `$` call). Pauses are depth-counted, so
 * concurrent waits resume only when the last returns; a `start` while paused is
 * held and armed by the resume that brings the depth to zero.
 */
export class PausableDeadline {
  private timer: ReturnType<typeof setTimeout> | null = null
  private deadline = 0
  private depth = 0
  private remaining = 0
  private started = false
  private stopped = false

  constructor(private readonly onExpire: () => void) {}

  /** Begin counting `ms` of own time. Idempotent: a second start is ignored. */
  start(ms: number): void {
    if (this.started || this.stopped) return
    this.started = true
    if (this.depth === 0) this.arm(ms)
    else this.remaining = ms
  }

  /** A wait began: stop the clock (if it is running) and count the wait. */
  pause(): void {
    if (this.depth === 0 && this.timer) {
      clearTimeout(this.timer)
      this.timer = null
      this.remaining = Math.max(0, this.deadline - Date.now())
    }
    this.depth += 1
  }

  /** A wait ended: when it was the last one, run the clock again with what was
   *  left. A resume without a matching pause is ignored. */
  resume(): void {
    if (this.depth === 0) return
    this.depth -= 1
    if (
      this.depth === 0 &&
      this.started &&
      !this.stopped &&
      this.timer === null
    ) {
      this.arm(this.remaining)
    }
  }

  /** Run `work` with the clock paused for its duration. */
  async whilePaused<T>(work: () => Promise<T>): Promise<T> {
    this.pause()
    try {
      return await work()
    } finally {
      this.resume()
    }
  }

  /** No further expiry, now or after a later resume. Idempotent. */
  stop(): void {
    this.stopped = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  /** What is left of the budget now, never below 0; the whole budget before
   *  `start` is not known here, so this reads 0 until then. */
  remainingMs(): number {
    if (!this.started) return 0
    if (this.timer) return Math.max(0, this.deadline - Date.now())
    return Math.max(0, this.remaining)
  }

  private arm(ms: number): void {
    this.deadline = Date.now() + ms
    this.timer = setTimeout(() => {
      this.timer = null
      this.remaining = 0
      if (!this.stopped) this.onExpire()
    }, ms)
  }
}
