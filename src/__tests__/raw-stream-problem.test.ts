import { describe, expect, it } from 'vitest'
import { rawStreamProblemOf, rawStreamProblemSummaryKey } from '../utils/rawStreamProblem'
import { retryReasonText } from '../components/assistant-ui/running-indicator'
import { createTranslate } from '../browser/webview/i18n'
import { OAUTH_SIGN_IN_MESSAGE } from '../models/drivers/driverStreamHost'

const t = createTranslate('en')

describe('rawStreamProblemOf', () => {
  it.each([
    ['EGRESS_UNSUPPORTED: this Velloc cannot send a request through a proxy; the request was not sent', 'egress_unsupported'],
    ['EGRESS_INVALID: the proxy "pool" carries https requests only; the request was not sent', 'egress_invalid'],
    ['EGRESS_UNAVAILABLE: Too many different proxies are carrying requests.', 'egress_unavailable'],
    ['EGRESS_BLOCKED: Refused by the egress policy: example.com resolved to 10.0.0.5, a private network address.', 'egress_blocked'],
    ['TARGET_NOT_ALLOWED: Target host is outside the provider\'s domain.', 'target_not_allowed'],
    ['TOO_MANY_STREAMS: too many open streams', 'too_many_streams'],
    ['RESPONSE_TOO_LARGE: Response exceeded the 1048576-byte cap.', 'response_too_large'],
    ['PROTOCOL: rawStreamRead answered without `done`.', 'protocol'],
    ['Stream network error: Request failed: net::ERR_CONNECTION_RESET', 'network'],
    ['NETWORK_ERROR: Request failed: net::ERR_CONNECTION_RESET', 'network'],
    ['TIMEOUT: Stream was idle for 90000ms.', 'timeout'],
    ['CANCELLED: Stream was cancelled.', 'cancelled'],
    ['Sign in to this provider in Settings to continue', 'sign_in_required'],
  ])('recognises %s', (detail, problem) => {
    expect(rawStreamProblemOf(detail)).toBe(problem)
  })

  it('recognises the code behind the wire prefix the detail is stored with', () => {
    expect(rawStreamProblemOf('provider_error: EGRESS_BLOCKED: refused, address is private')).toBe(
      'egress_blocked',
    )
    expect(rawStreamProblemOf('provider_error: PROTOCOL: rawStreamRead answered without `done`')).toBe(
      'protocol',
    )
    expect(
      rawStreamProblemOf(
        'Provider connection failed after 3 attempts (Provider connection failed). Last error: EGRESS_INVALID: the proxy "pool" carries https requests only',
      ),
    ).toBe('egress_invalid')
  })

  it('recognises the sign-in sentence the host stores', () => {
    expect(rawStreamProblemOf(OAUTH_SIGN_IN_MESSAGE)).toBe('sign_in_required')
  })

  it('leaves other provider errors to their own classification', () => {
    expect(rawStreamProblemOf('HTTP 400: invalid request')).toBeUndefined()
    expect(rawStreamProblemOf('EGRESS_SOMETHING: not a transport code')).toBeUndefined()
    expect(rawStreamProblemOf('')).toBeUndefined()
  })

  it('maps every problem to a catalog key that resolves', () => {
    for (const detail of [
      'EGRESS_UNSUPPORTED: x',
      'EGRESS_INVALID: x',
      'EGRESS_UNAVAILABLE: x',
      'EGRESS_BLOCKED: x',
      'TARGET_NOT_ALLOWED: x',
      'TOO_MANY_STREAMS: x',
      'RESPONSE_TOO_LARGE: x',
      'PROTOCOL: x',
      'Stream network error: x',
      'TIMEOUT: x',
      'CANCELLED: x',
      'Sign in to this provider in Settings to continue',
    ]) {
      const key = rawStreamProblemSummaryKey(rawStreamProblemOf(detail)!)
      expect(t(key)).not.toBe(key)
    }
  })
})

describe('retryReasonText', () => {
  it('shows a raw-stream refusal in the reader language, not the transport English', () => {
    const zh = createTranslate('zh')
    const text = retryReasonText(zh, {
      remainingSeconds: 3,
      attempt: 1,
      maxRetries: 10,
      errorTitleKey: 'providerIssue.configuration.title',
      errorDetail:
        'EGRESS_UNSUPPORTED: this Velloc cannot send a request through a proxy; the request was not sent',
    })
    expect(text).toContain('此服务商通过其声明的代理发送请求')
    expect(text).not.toContain('cannot send a request')
  })

  it('shows the whole catalog sentence, not a truncated one', () => {
    const text = retryReasonText(t, {
      remainingSeconds: 3,
      attempt: 1,
      maxRetries: 10,
      errorDetail:
        'EGRESS_INVALID: the proxy "pool" carries https requests only; the request was not sent',
    })
    expect(text).toContain(t('providerIssue.rawStream.egressInvalid.summary'))
    expect(text).not.toContain('…')
  })

  it('still shows an unfamiliar provider detail as-is', () => {
    expect(
      retryReasonText(t, {
        remainingSeconds: 1,
        attempt: 1,
        maxRetries: 10,
        errorKind: 'rate_limit',
        errorDetail: 'HTTP 429: too many requests',
      }),
    ).toBe('provider rate limit · HTTP 429: too many requests')
  })
})
