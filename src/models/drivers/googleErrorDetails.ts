/**
 * Contract: what the `details` of a Google API error body say about a failed
 * Google model request, beyond its message: the wait Google asks for
 * (`RetryInfo.retryDelay`), which quota ran out (`QuotaFailure`), and why a
 * key was refused (`ErrorInfo.reason`). Pure; a body that is not a Google
 * error envelope says nothing.
 *
 * Google answers a per-minute and a per-day quota with the same 429 and the
 * same message; only the quota id tells them apart. A daily quota resets at
 * midnight Pacific time.
 */
import type { DeclaredVerdict } from '../../utils/providerVerdict'

const DAY_MS = 24 * 60 * 60_000
const HOUR_MS = 60 * 60_000

/** `ErrorInfo.reason` values that mean the key itself is refused. */
const KEY_REFUSED = new Set(['API_KEY_INVALID', 'API_KEY_EXPIRED'])

export type GoogleErrorDetails = {
  /** Whole seconds Google asks the caller to wait (`RetryInfo`), rounded up. */
  retryDelaySeconds?: number
  verdict?: DeclaredVerdict
}

type Dict = Record<string, unknown>

const isDict = (value: unknown): value is Dict => typeof value === 'object' && value !== null && !Array.isArray(value)

function detailsOf(bodyText: string): Dict[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(bodyText)
  } catch {
    return []
  }
  const envelope = Array.isArray(parsed) ? parsed[0] : parsed
  const error = isDict(envelope) ? envelope.error : undefined
  const details = isDict(error) ? error.details : undefined
  return Array.isArray(details) ? details.filter(isDict) : []
}

const typeIs = (detail: Dict, name: string): boolean =>
  typeof detail['@type'] === 'string' && detail['@type'].endsWith(`google.rpc.${name}`)

/** "53s", "53.2s" → 54; anything else → undefined. */
function delaySeconds(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const match = /^(\d+(?:\.\d+)?)s$/.exec(value.trim())
  if (!match) return undefined
  const seconds = Math.ceil(Number(match[1]))
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined
}

/** Wall-clock hour in Los Angeles at `at`. */
function pacificClock(at: number): { hour: number; msSinceMidnight: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(at))
  const part = (type: string): number => Number(parts.find(p => p.type === type)?.value ?? 0)
  const hour = part('hour')
  return { hour, msSinceMidnight: ((hour * 60 + part('minute')) * 60 + part('second')) * 1000 + (at % 1000) }
}

/** The next midnight in Los Angeles after `now`, in epoch ms, across a daylight-saving change too. */
export function nextPacificMidnight(now: number): number {
  let next = now - pacificClock(now).msSinceMidnight + DAY_MS
  const { hour } = pacificClock(next)
  if (hour === 23) next += HOUR_MS
  else if (hour === 1) next -= HOUR_MS
  return next
}

export function readGoogleErrorDetails(bodyText: string, now: number): GoogleErrorDetails {
  const out: GoogleErrorDetails = {}
  const quotaIds: string[] = []
  for (const detail of detailsOf(bodyText)) {
    if (typeIs(detail, 'RetryInfo')) {
      const seconds = delaySeconds(detail.retryDelay)
      if (seconds !== undefined) out.retryDelaySeconds = seconds
    } else if (typeIs(detail, 'QuotaFailure') && Array.isArray(detail.violations)) {
      for (const violation of detail.violations) {
        if (isDict(violation) && typeof violation.quotaId === 'string') quotaIds.push(violation.quotaId)
      }
    } else if (typeIs(detail, 'ErrorInfo') && typeof detail.reason === 'string' && KEY_REFUSED.has(detail.reason)) {
      out.verdict = { kind: 'credentials', code: detail.reason }
    }
  }
  if (out.verdict) return out
  const daily = quotaIds.find(id => /PerDay/i.test(id))
  if (daily) {
    // Waiting the per-request delay does not help a daily quota: it holds until the reset.
    delete out.retryDelaySeconds
    out.verdict = { kind: 'quota', retryable: false, resetsAt: nextPacificMidnight(now), code: daily }
    return out
  }
  const perMinute = quotaIds.find(id => /PerMinute/i.test(id))
  if (perMinute) out.verdict = { kind: 'rate_limit', retryable: true, code: perMinute }
  return out
}
