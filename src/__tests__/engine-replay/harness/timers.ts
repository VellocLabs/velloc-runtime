import type { TraceLoggerEntry } from '../../../engine/turn/modelTrace'
import { TraceRecorder } from './trace'

/**
 * Backoff without waiting. The retry ladder reports each decided delay on its
 * trace logger just before it waits; the clock records that delay and lets
 * exactly the one timer armed for it fire at once. Every other timer runs as
 * scheduled. `Math.random` is pinned so the ladder's jitter is decided the
 * same way on every run.
 */
export class RetryClock {
  private armed: number[] = []
  private realSetTimeout: typeof setTimeout | undefined
  private realRandom: (() => number) | undefined

  constructor(
    private readonly recorder: TraceRecorder,
    /** Runs when a retry is decided, before its wait (e.g. Stop during backoff). */
    private readonly onRetry?: () => void,
  ) {}

  readonly traceLogger = (entry: TraceLoggerEntry) => {
    const data = entry.data as { event?: unknown; delayMs?: unknown } | undefined
    if (data?.event !== 'providerRetry') return
    const delayMs = Number(data.delayMs)
    this.recorder.trace.retryDelays.push(delayMs)
    this.armed.push(delayMs)
    this.onRetry?.()
  }

  install(): void {
    if (this.realSetTimeout) return
    const real = globalThis.setTimeout
    this.realSetTimeout = real
    this.realRandom = Math.random
    Math.random = () => 0.5
    const armed = this.armed
    const patched = ((handler: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      const at = ms === undefined ? -1 : armed.indexOf(ms)
      if (at >= 0) {
        armed.splice(at, 1)
        return real(handler, 0, ...args)
      }
      return real(handler, ms, ...args)
    }) as typeof setTimeout
    globalThis.setTimeout = patched
  }

  uninstall(): void {
    if (this.realSetTimeout) globalThis.setTimeout = this.realSetTimeout
    if (this.realRandom) Math.random = this.realRandom
    this.realSetTimeout = undefined
    this.realRandom = undefined
  }
}
