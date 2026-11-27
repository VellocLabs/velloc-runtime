/**
 * Contract: when a driver stream's response arrived, for the usage log
 * (F-27). Measured on the decoded events, before tool-call arguments are
 * buffered into whole calls, so the same definition holds for every provider.
 *
 * - `queuedMs`: time spent waiting for the provider's concurrency slot.
 * - `firstContentAt`: wall-clock time of the first text, reasoning or
 *   tool-call event; absent when the stream carried none.
 * - `maxGapMs`: the longest wait between two content events, or between the
 *   last one and the stream's end; absent with `firstContentAt`.
 */
import type { DriverStreamEvent } from './driverTypes'
import { isContentEvent } from './providerClassify'

export type StreamTimings = {
  queuedMs: number
  firstContentAt?: number
  maxGapMs?: number
}

function isContent(event: DriverStreamEvent): boolean {
  if (event.type === 'text_delta' || event.type === 'reasoning_delta') return event.text.length > 0
  return isContentEvent(event)
}

/** One stream's timings; `now` is injectable for tests. */
export class StreamTimingTracker {
  private queuedMs = 0
  private firstContentAt: number | undefined
  private lastContentAt = 0
  private maxGapMs = 0
  private ended = false

  constructor(private readonly now: () => number = Date.now) {}

  /** Adds a wait for a concurrency slot. */
  queuedFor(ms: number): void {
    if (ms > 0) this.queuedMs += ms
  }

  note(events: readonly DriverStreamEvent[]): void {
    if (this.ended) return
    for (const event of events) {
      const terminal = event.type === 'finish' || event.type === 'error'
      if (!terminal && !isContent(event)) continue
      const at = this.now()
      if (this.firstContentAt === undefined) {
        if (!terminal) this.firstContentAt = this.lastContentAt = at
      } else {
        this.maxGapMs = Math.max(this.maxGapMs, at - this.lastContentAt)
        this.lastContentAt = at
      }
      if (terminal) this.ended = true
    }
  }

  /** The stream ended, however it ended: the wait since the last content is a gap. */
  end(): void {
    if (this.ended) return
    this.ended = true
    if (this.firstContentAt !== undefined) this.maxGapMs = Math.max(this.maxGapMs, this.now() - this.lastContentAt)
  }

  timings(): StreamTimings {
    return {
      queuedMs: this.queuedMs,
      ...(this.firstContentAt !== undefined ? { firstContentAt: this.firstContentAt, maxGapMs: this.maxGapMs } : {}),
    }
  }
}

/** A send's timings as the usage log stores them, relative to the send's start. */
export type TimingColumns = { firstContentMs?: number; maxGapMs?: number; queuedMs?: number }

export function timingColumns(startedMs: number, timings: StreamTimings | undefined): TimingColumns {
  if (!timings) return {}
  return {
    queuedMs: timings.queuedMs,
    ...(timings.firstContentAt !== undefined ? { firstContentMs: Math.max(0, timings.firstContentAt - startedMs) } : {}),
    ...(timings.maxGapMs !== undefined ? { maxGapMs: timings.maxGapMs } : {}),
  }
}

/** Timings kept for streams whose reader has not taken them; past it the oldest go. */
export const STREAM_TIMINGS_MAX = 512

const published = new Map<string, StreamTimings>()

export function publishStreamTimings(streamId: string, timings: StreamTimings): void {
  published.delete(streamId)
  published.set(streamId, timings)
  if (published.size > STREAM_TIMINGS_MAX) published.delete(published.keys().next().value as string)
}

/** The stream's timings, once: they are forgotten as they are taken. */
export function takeStreamTimings(streamId: string): StreamTimings | undefined {
  const timings = published.get(streamId)
  published.delete(streamId)
  return timings
}

/** Test hook. */
export function resetStreamTimings(): void {
  published.clear()
}
