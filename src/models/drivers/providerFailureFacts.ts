/**
 * Puts a provider's declared error rules to the failures the stream host sees.
 *
 * Contract: `declaredFailure` returns the events unchanged unless one is an
 * error and a rule matches the response it came from; then that event carries
 * the rule's verdict. A provider without rules costs nothing.
 */
import type { VerdictAnomaly } from '../../utils/providerVerdict'
import type { DriverStreamEvent } from './driverTypes'
import {
  ERROR_RULE_BODY_WINDOW_BYTES,
  headerValue,
  isEventStreamResponse,
  matchErrorRule,
  type ProviderErrorRule,
} from './providerPolicy'

/** The first bytes of a streamed body, kept for `bodyContains`. */
export class ResponseHead {
  private readonly parts: Uint8Array[] = []
  private size = 0

  add(bytes: Uint8Array): void {
    const room = ERROR_RULE_BODY_WINDOW_BYTES - this.size
    if (room <= 0) return
    const part = bytes.length > room ? bytes.subarray(0, room) : bytes
    // Copied: the transport may reuse its buffer.
    this.parts.push(part.slice())
    this.size += part.length
  }

  text(): string {
    const all = new Uint8Array(this.size)
    let at = 0
    for (const part of this.parts) {
      all.set(part, at)
      at += part.length
    }
    return new TextDecoder('utf-8', { fatal: false }).decode(all)
  }
}

export type FailureSource = {
  /** Absent when the failure came before any response. */
  response?: { status: number; headers: Readonly<Record<string, string>> }
  bodyText: string
  model: string
  /** The response opened as a stream and failed inside it. */
  inStream?: boolean
  /** What the failure is when it is not an HTTP error status or an error the
   *  stream itself carried: a timeout, a reply that ended oddly. */
  anomaly?: VerdictAnomaly
}

const NO_HEADERS: Readonly<Record<string, string>> = {}

function isJsonDocument(headers: Readonly<Record<string, string>>): boolean {
  return (headerValue(headers, 'content-type') ?? '').toLowerCase().includes('json')
}

export function declaredFailure(
  rules: readonly ProviderErrorRule[] | undefined,
  events: DriverStreamEvent[],
  source: FailureSource,
): DriverStreamEvent[] {
  if (!rules || rules.length === 0 || !events.some(event => event.type === 'error')) return events
  const { response, inStream } = source
  const headers = response?.headers ?? NO_HEADERS
  const anomaly: VerdictAnomaly | undefined = source.anomaly ?? (inStream ? 'in_body_error' : undefined)
  const verdict = matchErrorRule(rules, {
    ...(response ? { status: response.status } : {}),
    headers,
    bodyText: source.bodyText,
    // A body that opened as a stream is one JSON document only when the
    // response says so; a refused request's body is one unless it is an
    // event stream.
    streamed: inStream ? !isJsonDocument(headers) : isEventStreamResponse(headers),
    ...(anomaly !== undefined ? { anomaly } : {}),
    model: source.model,
  })
  if (!verdict) return events
  return events.map(event => (event.type === 'error' ? { ...event, verdict } : event))
}
