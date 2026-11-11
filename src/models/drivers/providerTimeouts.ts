/**
 * The stream timeouts a provider declares, and the watchdog that enforces
 * them on one send (F-27).
 *
 * Contract: `firstByteMs` and `idleMs` count bytes, so a keep-alive that
 * decodes to nothing keeps a stream alive; `firstContentMs` and `stallMs`
 * count decoded content only and are off unless stated. `resolveStreamTimeouts`
 * returns undefined when nothing is stated anywhere: the caller then sends
 * under the platform's single idle limit. `StreamWatchdog` fires at most
 * once, with the name of the threshold that ran out.
 *
 * Security: the figures are plugin input. Each is held to
 * `STREAM_TIMEOUT_CEILING_MS`, and a content threshold that is on is never
 * below `CONTENT_TIMEOUT_FLOOR_MS`, wherever it was stated.
 */
import type { VerdictAnomaly } from '../../utils/providerVerdict'

export const TIMEOUT_KEYS = ['firstByteMs', 'idleMs', 'firstContentMs', 'stallMs'] as const
export type TimeoutKey = (typeof TIMEOUT_KEYS)[number]

/** Thresholds in ms. An absent one is the platform's; 0 turns a content threshold off. */
export type ProviderTimeouts = Partial<Record<TimeoutKey, number>>

/** A manifest's `policy.timeouts`: the provider's thresholds, and a table of
 *  its own under the id of each wire format that has one. */
export type DeclaredTimeouts = ProviderTimeouts & { [format: string]: number | ProviderTimeouts | undefined }

export const STREAM_TIMEOUT_CEILING_MS = 300_000
export const CONTENT_TIMEOUT_FLOOR_MS = 60_000
export const DEFAULT_IDLE_TIMEOUT_MS = 90_000

/** What one send runs under. A content threshold of 0 is off. */
export type StreamTimeouts = Record<TimeoutKey, number>

const isContentKey = (key: TimeoutKey): boolean => key === 'firstContentMs' || key === 'stallMs'

function usable(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/** One threshold within the platform's bounds; undefined when it states nothing. */
export function clampTimeout(key: TimeoutKey, value: unknown): number | undefined {
  if (!usable(value)) return undefined
  const ms = Math.min(Math.floor(value), STREAM_TIMEOUT_CEILING_MS)
  if (isContentKey(key)) return ms === 0 ? 0 : Math.max(ms, CONTENT_TIMEOUT_FLOOR_MS)
  // A byte threshold cannot be turned off.
  return ms === 0 ? undefined : ms
}

/** The stated thresholds, each within bounds. */
export function clampTimeouts(raw: ProviderTimeouts | undefined): ProviderTimeouts {
  const out: ProviderTimeouts = {}
  if (!raw) return out
  for (const key of TIMEOUT_KEYS) {
    const ms = clampTimeout(key, raw[key])
    if (ms !== undefined) out[key] = ms
  }
  return out
}

export type TimeoutSources = {
  /** The manifest's `policy.timeouts`. */
  declared?: DeclaredTimeouts
  /** The wire format of the request. */
  format: string
  /** What the provider's `request` hook answered for this request. */
  request?: ProviderTimeouts
  /** The request hook's `idleTimeoutMs`: the same thing as `request.idleMs`. */
  requestIdleMs?: number
  /** The idle timeout of the provider's own spec, when it has one. */
  specIdleMs?: number
}

const hasAny = (timeouts: ProviderTimeouts | undefined): boolean =>
  timeouts !== undefined && TIMEOUT_KEYS.some(key => timeouts[key] !== undefined)

/**
 * The thresholds of one send: the request's, over the manifest's for the
 * format, over the manifest's, over the platform's. Undefined when neither
 * the manifest nor the request states any.
 */
export function resolveStreamTimeouts(sources: TimeoutSources): StreamTimeouts | undefined {
  const { declared } = sources
  const own = declared?.[sources.format]
  const perFormat = typeof own === 'object' ? own : undefined
  const request: ProviderTimeouts = {
    ...(sources.requestIdleMs !== undefined ? { idleMs: sources.requestIdleMs } : {}),
    ...sources.request,
  }
  if (!hasAny(declared) && !hasAny(perFormat) && !hasAny(request)) return undefined
  const stated: ProviderTimeouts = {
    ...clampTimeouts(declared),
    ...clampTimeouts(perFormat),
    ...clampTimeouts(request),
  }
  const idleMs = stated.idleMs ?? Math.min(sources.specIdleMs ?? DEFAULT_IDLE_TIMEOUT_MS, DEFAULT_IDLE_TIMEOUT_MS)
  return {
    idleMs,
    firstByteMs: stated.firstByteMs ?? idleMs,
    firstContentMs: stated.firstContentMs ?? 0,
    stallMs: stated.stallMs ?? 0,
  }
}

/** The idle deadline the host is given: it has one timer for the wait for
 *  the response and the gaps between bytes, so it gets the longer of the two. */
export function hostIdleTimeoutMs(timeouts: StreamTimeouts): number {
  return Math.max(timeouts.firstByteMs, timeouts.idleMs)
}

export type TimeoutAnomaly = Extract<
  VerdictAnomaly,
  'first_byte_timeout' | 'idle_timeout' | 'first_content_timeout' | 'stall_timeout'
>

export type StreamExpiry = { anomaly: TimeoutAnomaly; afterMs: number }

type Timer = ReturnType<typeof setTimeout>

/** The four timers of one send. */
export class StreamWatchdog {
  private firstByte: Timer | undefined
  private idle: Timer | undefined
  private firstContent: Timer | undefined
  private stall: Timer | undefined
  private over = false
  private sawContent = false

  constructor(
    private readonly timeouts: StreamTimeouts,
    private readonly onExpire: (expiry: StreamExpiry) => void,
  ) {}

  /** The request is about to go out. */
  start(): void {
    this.firstByte = this.arm('first_byte_timeout', this.timeouts.firstByteMs)
    if (this.timeouts.firstContentMs > 0) {
      this.firstContent = this.arm('first_content_timeout', this.timeouts.firstContentMs)
    }
  }

  /** The response head arrived. */
  head(): void {
    if (this.over) return
    clearTimeout(this.firstByte)
    this.firstByte = undefined
    this.bytes()
  }

  /** Response bytes arrived, whatever they decode to. */
  bytes(): void {
    if (this.over) return
    clearTimeout(this.idle)
    this.idle = this.arm('idle_timeout', this.timeouts.idleMs)
  }

  /** A decoded event carried content. */
  content(): void {
    if (this.over) return
    if (!this.sawContent) {
      this.sawContent = true
      clearTimeout(this.firstContent)
      this.firstContent = undefined
    }
    if (this.timeouts.stallMs > 0) {
      clearTimeout(this.stall)
      this.stall = this.arm('stall_timeout', this.timeouts.stallMs)
    }
  }

  /** Whether the send is still watched: false once it is over. */
  get live(): boolean {
    return !this.over
  }

  /** The send is over; nothing fires after this. */
  stop(): void {
    this.over = true
    clearTimeout(this.firstByte)
    clearTimeout(this.idle)
    clearTimeout(this.firstContent)
    clearTimeout(this.stall)
  }

  private arm(anomaly: TimeoutAnomaly, afterMs: number): Timer {
    return setTimeout(() => {
      if (this.over) return
      this.stop()
      this.onExpire({ anomaly, afterMs })
    }, afterMs)
  }
}

const seconds = (ms: number): string => `${Math.round(ms / 100) / 10} s`

/** The error text of a timeout. The classifier reads it as a network failure. */
export function timeoutMessage(expiry: StreamExpiry): string {
  const after = seconds(expiry.afterMs)
  switch (expiry.anomaly) {
    case 'first_byte_timeout':
      return `Stream network error: timed out, no response from the provider within ${after}`
    case 'idle_timeout':
      return `Stream network error: timed out, the provider sent nothing for ${after}`
    case 'first_content_timeout':
      return `Stream network error: timed out, the provider sent no content within ${after}`
    case 'stall_timeout':
      return `Stream network error: timed out, the provider sent no content for ${after}`
  }
}
