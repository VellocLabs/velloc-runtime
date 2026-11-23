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

  it('a marked status after the 200 is read', () => {
    const issue = classifyProviderConnectivityIssue(
      new ProviderApiError('provider_error: HTTP 200: upstream status 503', { httpStatus: 200 }),
    )
    expect(issue).toMatchObject({ kind: 'service', status: 503 })
  })

  it('a 200 with no streamed status is unchanged', () => {
    expect(classifyProviderConnectivityIssue(new ProviderApiError('provider_error: HTTP 200: something odd', { httpStatus: 200 }))).toBeNull()
  })

  it.each([
    'HTTP 200: model nova-500-turbo failed',
    'HTTP 200: used 4290 tokens',
    'HTTP 200: connect ECONNREFUSED 127.0.0.1:5003',
    'HTTP 200: overloaded after 502 ms',
    "HTTP 200: Invalid 'input[503].content': string too long",
    'HTTP 200: messages[429] has no content',
    'HTTP 200: nova-2024-08-06 [400 tokens]',
    'HTTP 200: rows[1][401] is empty',
  ])('a number that is not a status leaves the verdict alone: %s', text => {
    const issue = classifyProviderConnectivityIssue(new ProviderApiError(`provider_error: ${text}`, { httpStatus: 200 }))
    expect(issue?.status ?? 200).toBe(200)
  })
})

describe('a reply that did not open with 2xx', () => {
  it('keeps its own status whatever the text quotes', () => {
    const issue = classifyProviderConnectivityIssue(
      new ProviderApiError('provider_error: HTTP 401: invalid key [502]', { httpStatus: 401 }),
    )
    expect(issue).toMatchObject({ kind: 'credentials', status: 401 })
  })

  it('a server error is still judged by its own status', () => {
    const issue = classifyProviderConnectivityIssue(
      new ProviderApiError('provider_error: HTTP 503: busy [429]', { httpStatus: 503 }),
    )
    expect(issue).toMatchObject({ kind: 'service', status: 503 })
  })
})
