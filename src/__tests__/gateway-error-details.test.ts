import { describe, expect, it } from 'vitest'
import { GATEWAY_QUOTA_AFTER_MS, UPSTREAM_TEXT_MAX, readGatewayErrorDetails } from '../models/drivers/gatewayErrorDetails'
import { openaiChatDriver } from '../models/drivers/openaiChatDriver'
import { ProviderApiError, classifyProviderConnectivityIssue } from '../utils/providerConnectivity'
import { VERDICT_QUOTA_RESET_CEILING_MS, type DeclaredVerdict } from '../utils/providerVerdict'

const NOW = Date.UTC(2026, 10, 22, 16, 30, 0)
const MIDNIGHT_UTC = Date.UTC(2026, 10, 23)

const limited = (message: string, reset: number | string, where: 'body' | 'header' = 'body') => {
  const headers = { 'X-RateLimit-Limit': '50', 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': String(reset) }
  return {
    headers: where === 'header' ? headers : {},
    bodyText: JSON.stringify({ error: { code: 429, message, metadata: where === 'body' ? { headers, provider_name: null } : {} } }),
  }
}

describe('readGatewayErrorDetails', () => {
  it('a free-model daily limit is a used-up quota until its reset, whether the reset rides the body or a header', () => {
    for (const where of ['body', 'header'] as const) {
      const { headers, bodyText } = limited('Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day', MIDNIGHT_UTC, where)
      expect(readGatewayErrorDetails(429, headers, bodyText, NOW)).toEqual({
        verdict: { kind: 'quota', retryable: false, resetsAt: MIDNIGHT_UTC },
      })
    }
  })

  it('a per-minute limit is a wait until its reset, rounded up to whole seconds', () => {
    const { headers, bodyText } = limited('Rate limit exceeded: free-models-per-min.', NOW + 12_300)
    expect(readGatewayErrorDetails(429, headers, bodyText, NOW)).toEqual({ retryAfterSeconds: 13 })
  })

  it('a reset hours away is a used-up allowance even when the message does not name the day', () => {
    const { headers, bodyText } = limited('Rate limit exceeded', NOW + GATEWAY_QUOTA_AFTER_MS + 1)
    expect(readGatewayErrorDetails(429, headers, bodyText, NOW).verdict?.kind).toBe('quota')
  })

  it('a reset past the platform ceiling is recorded as a quota without an invented recovery time', () => {
    const { headers, bodyText } = limited('Rate limit exceeded', NOW + VERDICT_QUOTA_RESET_CEILING_MS + 1)
    expect(readGatewayErrorDetails(429, headers, bodyText, NOW).verdict).toEqual({
      kind: 'quota',
      retryable: false,
    })
    const near = limited('Rate limit exceeded', NOW + VERDICT_QUOTA_RESET_CEILING_MS)
    expect(readGatewayErrorDetails(429, near.headers, near.bodyText, NOW).verdict?.resetsAt).toBe(NOW + VERDICT_QUOTA_RESET_CEILING_MS)
  })

  it('reads an epoch in seconds; a count of seconds, a date or a past reset says nothing', () => {
    const inSeconds = limited('Rate limit exceeded', String((NOW + 30_000) / 1000))
    expect(readGatewayErrorDetails(429, inSeconds.headers, inSeconds.bodyText, NOW)).toEqual({ retryAfterSeconds: 30 })
    for (const reset of ['60', 'Wed, 21 Oct 2026 07:28:00 GMT', String(NOW - 1)]) {
      const { headers, bodyText } = limited('Rate limit exceeded', reset)
      expect(readGatewayErrorDetails(429, headers, bodyText, NOW)).toEqual({})
    }
  })

  it('the reset of another status is not read; the upstream text of any status is', () => {
    const { headers, bodyText } = limited('Rate limit exceeded', MIDNIGHT_UTC)
    expect(readGatewayErrorDetails(503, headers, bodyText, NOW)).toEqual({})
    const upstream = JSON.stringify({
      error: { code: 429, message: 'Provider returned error', metadata: { raw: 'm is temporarily rate-limited upstream.\nPlease retry shortly.', provider_name: 'P' } },
    })
    expect(readGatewayErrorDetails(429, {}, upstream, NOW)).toEqual({ upstream: 'm is temporarily rate-limited upstream. Please retry shortly.' })
    const long = JSON.stringify({ error: { message: 'Provider returned error', metadata: { raw: 'x'.repeat(1000) } } })
    expect(readGatewayErrorDetails(502, {}, long, NOW).upstream).toHaveLength(UPSTREAM_TEXT_MAX)
  })

  it('a body that is not an error envelope says nothing', () => {
    for (const text of ['', '<html>', '[]', '{"error":"no"}', '{"error":{"metadata":"no"}}']) {
      expect(readGatewayErrorDetails(429, {}, text, NOW)).toEqual({})
    }
  })
})

describe('openaiChatDriver.errorFromResponse with gateway details', () => {
  const err = (status: number, bodyText: string, headers: Record<string, string> = {}) =>
    openaiChatDriver.errorFromResponse({ status, statusText: 'x', headers, bodyText })

  it('a daily free-model limit carries a quota verdict with the reset', () => {
    const reset = Date.now() + 6 * 3_600_000
    const { headers, bodyText } = limited('Rate limit exceeded: free-models-per-day.', reset)
    expect(err(429, bodyText, headers)).toEqual({
      type: 'error',
      message: 'HTTP 429: Rate limit exceeded: free-models-per-day.',
      httpStatus: 429,
      verdict: { kind: 'quota', retryable: false, resetsAt: reset },
    })
  })

  it('a near reset becomes the wait; a Retry-After header wins over it', () => {
    const { headers, bodyText } = limited('Rate limit exceeded: free-models-per-min.', Date.now() + 20_000)
    expect(err(429, bodyText, headers)).toMatchObject({ retryAfterSeconds: expect.any(Number) })
    expect((err(429, bodyText, headers) as { retryAfterSeconds: number }).retryAfterSeconds).toBeLessThanOrEqual(20)
    expect(err(429, bodyText, { ...headers, 'Retry-After': '5' })).toMatchObject({ retryAfterSeconds: 5 })
  })

  it('the classifier takes the daily limit as a quota that resets when the gateway said, not a rate limit', () => {
    const reset = Date.now() + 6 * 3_600_000
    const { headers, bodyText } = limited('Rate limit exceeded: free-models-per-day.', reset)
    const event = err(429, bodyText, headers) as { message: string; httpStatus: number; verdict: DeclaredVerdict }
    const issue = classifyProviderConnectivityIssue(new ProviderApiError(event.message, { httpStatus: event.httpStatus, declared: event.verdict }))
    expect(issue).toMatchObject({ kind: 'quota', retryable: false, resetsAt: reset })
  })

  it('the upstream provider text follows the gateway message', () => {
    const body = JSON.stringify({ error: { code: 429, message: 'Provider returned error', metadata: { raw: 'm is temporarily rate-limited upstream.', provider_name: 'P' } } })
    expect(err(429, body).message).toBe('HTTP 429: Provider returned error: m is temporarily rate-limited upstream.')
  })
})
