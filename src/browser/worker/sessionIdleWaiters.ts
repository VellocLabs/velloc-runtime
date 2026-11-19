/**
 * Waits for a session's turn to end (F-35). `wait` settles at once when the
 * session runs no turn (or is not held), else at the first status change that
 * finds it idle and still idle a task later, once a turn queued behind the
 * last one has had its chance to start; it rejects with the signal's reason
 * when `signal` aborts. A slow check backs the status path up, for a session
 * closed while it waits.
 */
export class SessionIdleWaiters {
  private readonly waiting = new Map<string, Set<() => void>>()
  private backstop: ReturnType<typeof setInterval> | null = null

  constructor(
    /** Whether `sessionId` runs a turn now; false for a session not held. */
    private readonly busy: (sessionId: string) => boolean,
    private readonly backstopMs = 2000,
  ) {}

  wait(sessionId: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortReason(signal))
    if (!this.busy(sessionId)) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      const set = this.waiting.get(sessionId) ?? new Set<() => void>()
      this.waiting.set(sessionId, set)
      const cleanup = () => {
        set.delete(done)
        if (set.size === 0 && this.waiting.get(sessionId) === set) this.waiting.delete(sessionId)
        signal?.removeEventListener('abort', onAbort)
        if (this.waiting.size === 0 && this.backstop !== null) {
          clearInterval(this.backstop)
          this.backstop = null
        }
      }
      const done = () => {
        cleanup()
        resolve()
      }
      const onAbort = () => {
        cleanup()
        reject(abortReason(signal!))
      }
      set.add(done)
      signal?.addEventListener('abort', onAbort, { once: true })
      this.backstop ??= setInterval(() => {
        for (const id of [...this.waiting.keys()]) this.check(id)
      }, this.backstopMs)
    })
  }

  /** The session's status changed: its waiters go on when it is idle now and a task later. */
  check(sessionId: string): void {
    if (!this.waiting.has(sessionId) || this.busy(sessionId)) return
    setTimeout(() => {
      const set = this.waiting.get(sessionId)
      if (!set || this.busy(sessionId)) return
      for (const done of [...set]) done()
    }, 0)
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('aborted', 'AbortError')
}
