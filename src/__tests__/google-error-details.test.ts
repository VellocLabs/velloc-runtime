import { describe, expect, it } from 'vitest'
import { nextPacificMidnight, readGoogleErrorDetails } from '../models/drivers/googleErrorDetails'
import { classifyProviderConnectivityIssue } from '../utils/providerConnectivity'

const NOW = Date.UTC(2026, 10, 22, 15, 30, 0)
const body = (details: unknown[]) => JSON.stringify({ error: { code: 429, message: 'x', status: 'RESOURCE_EXHAUSTED', details } })
const retry = (retryDelay: string) => ({ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay })
const quota = (...quotaIds: string[]) => ({
  '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
  violations: quotaIds.map(quotaId => ({ quotaId })),
})

describe('nextPacificMidnight', () => {
  it('is the next 00:00 in Los Angeles, standard and daylight time', () => {
    // A November day is standard time (UTC-8): midnight is 08:00 UTC.
    expect(nextPacificMidnight(NOW)).toBe(Date.UTC(2026, 10, 23, 8, 0, 0))
    // A July day is daylight time (UTC-7).
    expect(nextPacificMidnight(Date.UTC(2026, 6, 1, 12, 0, 0))).toBe(Date.UTC(2026, 6, 2, 7, 0, 0))
    // The day daylight time ends has 25 hours.
    expect(nextPacificMidnight(Date.UTC(2026, 10, 1, 8, 0, 0))).toBe(Date.UTC(2026, 10, 2, 8, 0, 0))
    // The day it starts has 23 hours.
    expect(nextPacificMidnight(Date.UTC(2026, 2, 8, 9, 0, 0))).toBe(Date.UTC(2026, 2, 9, 7, 0, 0))
  })
})

describe('readGoogleErrorDetails', () => {
  it('reads the wait, rounded up', () => {
    expect(readGoogleErrorDetails(body([retry('12.01s')]), NOW)).toEqual({ retryDelaySeconds: 13 })
    expect(readGoogleErrorDetails(body([retry('soon')]), NOW)).toEqual({})
  })

  it('a daily quota wins over a per-minute one in the same answer, and drops the short delay', () => {
    const out = readGoogleErrorDetails(body([quota('GenerateRequestsPerMinute-FreeTier', 'GenerateRequestsPerDay-FreeTier'), retry('5s')]), NOW)
    expect(out).toEqual({
      verdict: { kind: 'quota', retryable: false, resetsAt: Date.UTC(2026, 10, 23, 8, 0, 0), code: 'GenerateRequestsPerDay-FreeTier' },
    })
  })

  it('a per-minute quota is a rate limit that a wait clears', () => {
    expect(readGoogleErrorDetails(body([quota('GenerateContentInputTokensPerModelPerMinute-FreeTier'), retry('20s')]), NOW)).toEqual({
      retryDelaySeconds: 20,
      verdict: { kind: 'rate_limit', retryable: true, code: 'GenerateContentInputTokensPerModelPerMinute-FreeTier' },
    })
  })

  it('an invalid or expired key is refused credentials; other reasons say nothing', () => {
    const info = (reason: string) => ({ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason })
    expect(readGoogleErrorDetails(body([info('API_KEY_EXPIRED')]), NOW).verdict).toEqual({ kind: 'credentials', code: 'API_KEY_EXPIRED' })
    expect(readGoogleErrorDetails(body([info('API_KEY_INVALID')]), NOW).verdict).toEqual({ kind: 'credentials', code: 'API_KEY_INVALID' })
    expect(readGoogleErrorDetails(body([info('RATE_LIMIT_EXCEEDED')]), NOW)).toEqual({})
  })

  it('a body that is not a Google envelope says nothing; the array form is read', () => {
    for (const text of ['', '<html>', '[]', '{"error":"no"}', '{"error":{"details":"no"}}']) {
      expect(readGoogleErrorDetails(text, NOW)).toEqual({})
    }
    expect(readGoogleErrorDetails(JSON.stringify([{ error: { details: [retry('3s')] } }]), NOW)).toEqual({ retryDelaySeconds: 3 })
  })
})

describe('refused Google keys without details', () => {
  it.each([
    'HTTP 400: API key not valid. Please pass a valid API key.',
    'HTTP 400: API key expired. Please renew the API key.',
  ])('%s is credentials, so a router moves on and the model is held', message => {
    expect(classifyProviderConnectivityIssue(new Error(message))?.kind).toBe('credentials')
  })
})
