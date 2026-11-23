import { describe, expect, it } from 'vitest'
import { ProviderApiError, classifyProviderConnectivityIssue } from '../utils/providerConnectivity'

// A reply that opens with 200 and then fails mid-stream is judged by the
// status the stream carried, so a router can move the call on.
describe('a 2xx reply whose stream failed', () => {
  it('a streamed 502 is a service failure', () => {
    const issue = classifyProviderConnectivityIssue(
      new ProviderApiError('provider_error: HTTP 200: Streaming response failed: [502] error code: 502', { httpStatus: 200 }),
    )
    expect(issue).toMatchObject({ kind: 'service', retryable: true, status: 502 })
  })

  it('the same text without a typed status reads the streamed status too', () => {
    const issue = classifyProviderConnectivityIssue(new Error('HTTP 200: Streaming response failed: [503] error code: 503'))
    expect(issue).toMatchObject({ kind: 'service', status: 503 })
  })

  it('a streamed 429 is a rate limit', () => {
    const issue = classifyProviderConnectivityIssue(
      new ProviderApiError('provider_error: HTTP 200: Streaming response failed: [429] error code: 429', { httpStatus: 200 }),
    )
    expect(issue?.kind).toBe('rate_limit')
  })

  it('a 200 with no streamed status is unchanged', () => {
    expect(classifyProviderConnectivityIssue(new ProviderApiError('provider_error: HTTP 200: something odd', { httpStatus: 200 }))).toBeNull()
  })
})
