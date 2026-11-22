/**
 * Contract: what a chat-completions gateway's error says beyond its
 * message: when its own rate limit resets (`X-RateLimit-Reset`, as a header
 * or copied into `error.metadata.headers`), whether that limit is a daily one,
 * and the upstream provider's own text (`error.metadata.raw`) behind a bare
 * "Provider returned error". Pure; a body or header it does not recognize
 * says nothing.
 *
 * Seen on OpenRouter. A free-model limit is the account's, shared by every
 * free model, and its daily one resets at midnight UTC: the reset time is
 * then hours away, and waiting a minute and asking again cannot help.
 */
import type { DeclaredVerdict } from '../../utils/providerVerdict'

/** A reset further off than this is a used-up allowance, not a throttle. */
export const GATEWAY_QUOTA_AFTER_MS = 5 * 60_000
/** The longest upstream text carried into the message. */
export const UPSTREAM_TEXT_MAX = 300

/** Epoch ms in 2001..2286: what tells an epoch in ms from one in seconds. */
const EPOCH_MS_MIN = 1e12
const EPOCH_S_MIN = 1e9

export type GatewayErrorDetails = {
  /** Whole seconds until the gateway's limit resets, when it is near. */
  retryAfterSeconds?: number
  verdict?: DeclaredVerdict
  /** The upstream provider's text, to follow the gateway's message. */
  upstream?: string
}

type Dict = Record<string, unknown>

const isDict = (value: unknown): value is Dict => typeof value === 'object' && value !== null && !Array.isArray(value)

function errorOf(bodyText: string): Dict | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(bodyText)
  } catch {
    return undefined
  }
  return isDict(parsed) && isDict(parsed.error) ? parsed.error : undefined
}

function headerIn(headers: unknown, name: string): string | undefined {
  if (!isDict(headers)) return undefined
  const lower = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower && (typeof value === 'string' || typeof value === 'number')) return String(value)
  }
  return undefined
}

/** An absolute reset time from an epoch in ms or seconds; a small number (a count of seconds, a date) is not read. */
function resetAt(raw: string | undefined): number | undefined {
  if (raw === undefined || !/^\s*\d+(\.\d+)?\s*$/.test(raw)) return undefined
  const value = Number(raw)
  if (value >= EPOCH_MS_MIN) return value
  if (value >= EPOCH_S_MIN) return value * 1000
  return undefined
}

export function readGatewayErrorDetails(
  status: number,
  headers: Record<string, string>,
  bodyText: string,
  now: number,
): GatewayErrorDetails {
  const out: GatewayErrorDetails = {}
  const error = errorOf(bodyText)
  const metadata = isDict(error?.metadata) ? error.metadata : undefined
  const raw = metadata?.raw
  if (typeof raw === 'string' && raw.trim() !== '') {
    const text = raw.trim().replace(/\s+/g, ' ')
    out.upstream = text.length > UPSTREAM_TEXT_MAX ? `${text.slice(0, UPSTREAM_TEXT_MAX - 1)}…` : text
  }
  if (status !== 429) return out
  const reset = resetAt(headerIn(headers, 'X-RateLimit-Reset') ?? headerIn(metadata?.headers, 'X-RateLimit-Reset'))
  if (reset === undefined || reset <= now) return out
  const message = typeof error?.message === 'string' ? error.message : ''
  const daily = /per[-_ ]?day\b/i.test(message)
  if (daily || reset - now > GATEWAY_QUOTA_AFTER_MS) {
    out.verdict = { kind: 'quota', retryable: false, resetsAt: reset }
  } else {
    out.retryAfterSeconds = Math.ceil((reset - now) / 1000)
  }
  return out
}
