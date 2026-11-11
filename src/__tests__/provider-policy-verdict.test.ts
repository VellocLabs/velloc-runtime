/**
 * A provider's declared policy (F-27): the error rules it states, the limits
 * the platform puts on what a rule says, the retry ladder under a declared
 * retry policy, and the manifest validation of the `policy` block.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserBridgeTransport } from '../browser/bridge/browserBridgeProtocol'
import '../models/drivers/builtinDrivers'
import { DriverStreamHost } from '../models/drivers/driverStreamHost'
import { createModelProvider } from '../models/drivers/modelProvider'
import { registerProviderDriver } from '../models/drivers/driverRegistry'
import type { DriverStreamEvent, ProviderDriver } from '../models/drivers/driverTypes'
import {
  ERROR_RULE_BODY_WINDOW_BYTES,
  matchErrorRule,
  type ProviderErrorRule,
  type ProviderFailureFacts,
  type ProviderPolicy,
} from '../models/drivers/providerPolicy'
import { registerProviderRequestSeam, resetProviderRequestSeams } from '../models/drivers/providerRequestSeam'
import { checkPluginDescriptor } from '../pluginHost/manifestValidator'
import { USER_MODEL_FORMATS } from '../config/nexusModelConfig/userModels'
import { assembleTurnDependencies } from '../engine/turn/turnDependencies'
import {
  DECLARED_RETRY_TOTAL_WAIT_MS,
  classifyModelFailure,
  decideRetry,
  retriesAllowed,
  type DeclaredRetryPolicy,
} from '../engine/turn/retryLadder'
import {
  PROVIDER_CONNECTIVITY_MAX_RETRIES,
  ProviderApiError,
  classifyProviderConnectivityIssue,
  getProviderConnectivityRetryDelayMs,
} from '../utils/providerConnectivity'
import {
  VERDICT_MESSAGE_MAX_LENGTH,
  VERDICT_QUOTA_RESET_CEILING_MS,
  VERDICT_RESET_CEILING_MS,
  type DeclaredVerdict,
} from '../utils/providerVerdict'
import {
  DefaultRuntimeConfig,
  NoopPlatformCapabilities,
  createEmptyAppState,
  createNoopToolUseContext,
} from '../runtime/testing/noopAdapters'
import type { Message } from '../runtime/RuntimeTypes'
import { withProviderApiErrorMetadata } from '../browser/webview/assistantUiAdapterMessage'
import { providerDeclaredMessage } from '../components/assistant-ui/composer-logic'

const NOW = 1_800_000_000_000

function facts(over: Partial<ProviderFailureFacts> = {}): ProviderFailureFacts {
  return { status: 403, headers: {}, bodyText: '', streamed: false, model: 'big-1', ...over }
}

const rule = (match: ProviderErrorRule['match'], over: Partial<ProviderErrorRule> = {}): ProviderErrorRule => ({
  match,
  kind: 'provider_policy',
  ...over,
})

describe('policy.errors: matching', () => {
  it('no rules and an empty list leave the failure to the platform', () => {
    expect(matchErrorRule(undefined, facts())).toBeUndefined()
    expect(matchErrorRule([], facts())).toBeUndefined()
  })

  it('status: one code, or an inclusive range', () => {
    expect(matchErrorRule([rule({ status: 403 })], facts())).toMatchObject({ kind: 'provider_policy' })
    expect(matchErrorRule([rule({ status: 404 })], facts())).toBeUndefined()
    const range = [rule({ status: { from: 500, to: 599 } })]
    expect(matchErrorRule(range, facts({ status: 500 }))).toBeDefined()
    expect(matchErrorRule(range, facts({ status: 599 }))).toBeDefined()
    expect(matchErrorRule(range, facts({ status: 499 }))).toBeUndefined()
    expect(matchErrorRule(range, facts({ status: undefined }))).toBeUndefined()
  })

  it('bodyContains: a literal, case-sensitive substring of the first 8 KiB', () => {
    const rules = [rule({ bodyContains: 'FreeTierError' })]
    expect(matchErrorRule(rules, facts({ bodyText: '{"type":"FreeTierError"}' }))).toBeDefined()
    expect(matchErrorRule(rules, facts({ bodyText: '{"type":"freetiererror"}' }))).toBeUndefined()
    const pad = 'x'.repeat(ERROR_RULE_BODY_WINDOW_BYTES)
    expect(matchErrorRule(rules, facts({ bodyText: `${pad}FreeTierError` }))).toBeUndefined()
    expect(matchErrorRule(rules, facts({ bodyText: `${pad.slice(13)}FreeTierError` }))).toBeDefined()
    // It also reads a streamed body.
    expect(matchErrorRule(rules, facts({ streamed: true, bodyText: 'data: {"e":"FreeTierError"}\n\n' }))).toBeDefined()
  })

  it('bodyContains takes its text literally: pattern characters mean themselves', () => {
    const rules = [rule({ bodyContains: 'a.*b' })]
    expect(matchErrorRule(rules, facts({ bodyText: 'axxb' }))).toBeUndefined()
    expect(matchErrorRule(rules, facts({ bodyText: 'a.*b' }))).toBeDefined()
  })

  it('bodyPointer: the value is present and not empty, in a JSON document only', () => {
    const rules = [rule({ bodyPointer: '/info/error' })]
    expect(matchErrorRule(rules, facts({ bodyText: '{"info":{"error":"boom"}}' }))).toBeDefined()
    expect(matchErrorRule(rules, facts({ bodyText: '{"info":{"error":0}}' }))).toBeDefined()
    for (const empty of ['{"info":{"error":""}}', '{"info":{"error":null}}', '{"info":{"error":{}}}', '{"info":{}}', 'not json']) {
      expect(matchErrorRule(rules, facts({ bodyText: empty }))).toBeUndefined()
    }
    expect(matchErrorRule([rule({ bodyPointer: '/a~1b/0' })], facts({ bodyText: '{"a/b":["x"]}' }))).toBeDefined()
  })

  it('bodyPointer never holds for an event-stream body, and does not throw', () => {
    const rules = [rule({ status: 200, bodyPointer: '/info/error' })]
    const sse = facts({ status: 200, streamed: true, bodyText: '{"info":{"error":"boom"}}' })
    expect(matchErrorRule(rules, sse)).toBeUndefined()
  })

  it('headerPresent ignores case; anomaly and model compare exactly', () => {
    expect(matchErrorRule([rule({ headerPresent: 'x-quota-reset' })], facts({ headers: { 'X-Quota-Reset': '1' } }))).toBeDefined()
    expect(matchErrorRule([rule({ headerPresent: 'x-quota-reset' })], facts())).toBeUndefined()
    expect(matchErrorRule([rule({ anomaly: 'in_body_error' })], facts({ anomaly: 'in_body_error' }))).toMatchObject({ anomaly: 'in_body_error' })
    expect(matchErrorRule([rule({ anomaly: 'in_body_error' })], facts())).toBeUndefined()
    expect(matchErrorRule([rule({ model: 'big-' })], facts())).toBeDefined()
    expect(matchErrorRule([rule({ model: 'Big-' })], facts())).toBeUndefined()
    expect(matchErrorRule([rule({ model: 'g-1' })], facts())).toBeUndefined()
  })

  it('every stated condition must hold, and the first matching rule wins', () => {
    const rules = [
      rule({ status: 403, bodyContains: 'RegionError' }, { code: 'region_blocked' }),
      rule({ status: 403 }, { code: 'first' }),
      rule({ status: 403 }, { code: 'second' }),
    ]
    expect(matchErrorRule(rules, facts({ bodyText: 'RegionError' }))?.code).toBe('region_blocked')
    expect(matchErrorRule(rules, facts({ bodyText: 'other' }))?.code).toBe('first')
  })

  it('resetsAtFrom reads a header or a pointer in the stated unit', () => {
    const at = (resetsAtFrom: ProviderErrorRule['resetsAtFrom'], over: Partial<ProviderFailureFacts>) =>
      matchErrorRule([rule({ status: 429 }, { kind: 'quota', resetsAtFrom })], facts({ status: 429, ...over }), NOW)?.resetsAt
    expect(at({ header: 'x-reset', unit: 'epoch-seconds' }, { headers: { 'X-Reset': '1800000600' } })).toBe(1_800_000_600_000)
    expect(at({ header: 'x-reset', unit: 'epoch-ms' }, { headers: { 'x-reset': '1800000600123' } })).toBe(1_800_000_600_123)
    expect(at({ header: 'x-reset', unit: 'delta-seconds' }, { headers: { 'x-reset': '90' } })).toBe(NOW + 90_000)
    expect(at({ header: 'x-reset', unit: 'http-date' }, { headers: { 'x-reset': 'Wed, 21 Oct 2037 07:28:00 GMT' } }))
      .toBe(Date.parse('Wed, 21 Oct 2037 07:28:00 GMT'))
    expect(at({ pointer: '/reset', unit: 'epoch-seconds' }, { bodyText: '{"reset":1800000600}' })).toBe(1_800_000_600_000)
    // Not in the stated unit, absent, or a pointer into a stream: no recovery time.
    expect(at({ header: 'x-reset', unit: 'epoch-seconds' }, { headers: { 'x-reset': 'soon' } })).toBeUndefined()
    expect(at({ header: 'x-reset', unit: 'epoch-seconds' }, {})).toBeUndefined()
    expect(at({ pointer: '/reset', unit: 'epoch-seconds' }, { streamed: true, bodyText: '{"reset":1800000600}' })).toBeUndefined()
  })
})

const declaredError = (message: string, status: number | undefined, declared: DeclaredVerdict, retryAfterMs?: number) =>
  new ProviderApiError(message, {
    ...(status !== undefined ? { httpStatus: status } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    declared,
  })

describe('the verdict: a declared rule over the platform classification, then the limits', () => {
  it('a rule changes the kind and brings that kind\'s wording, scope and retryability', () => {
    const issue = classifyProviderConnectivityIssue(
      declaredError('HTTP 403 FreeTierError', 403, {
        kind: 'provider_policy',
        scope: 'model',
        retryable: false,
        code: 'free_tier_restricted',
        message: { en: 'Not on the free tier.' },
      }),
      NOW,
    )
    expect(issue).toMatchObject({
      kind: 'provider_policy',
      error: 'invalid_request',
      titleKey: 'providerIssue.providerPolicy.title',
      summaryKey: 'providerIssue.providerPolicy.summary',
      retryable: false,
      settingsRecommended: false,
      scope: 'model',
      status: 403,
      code: 'free_tier_restricted',
      message: { en: 'Not on the free tier.' },
      detail: 'HTTP 403 FreeTierError',
    })
  })

  it('a rule gives a verdict to a failure the platform does not recognise', () => {
    const issue = classifyProviderConnectivityIssue(declaredError('odd reply', 200, { kind: 'service', anomaly: 'in_body_error' }), NOW)
    expect(issue).toMatchObject({ kind: 'service', retryable: true, scope: 'provider', anomaly: 'in_body_error', detail: 'odd reply' })
    expect(classifyProviderConnectivityIssue(new ProviderApiError('odd reply', { httpStatus: 200 }), NOW)).toBeNull()
  })

  it('a rule that keeps the platform\'s kind keeps its wording and retry limit', () => {
    const issue = classifyProviderConnectivityIssue(declaredError('HTTP 429 slow down', 429, { kind: 'rate_limit', scope: 'model' }), NOW)
    expect(issue).toMatchObject({ kind: 'rate_limit', titleKey: 'providerIssue.rateLimit.title', retryable: true, scope: 'model' })
  })

  it('credentials and configuration are never retryable, whatever the rule says', () => {
    for (const kind of ['credentials', 'configuration'] as const) {
      const issue = classifyProviderConnectivityIssue(declaredError('HTTP 500 boom', 500, { kind, retryable: true }), NOW)
      expect(issue).toMatchObject({ kind, retryable: false })
    }
    // A rule that keeps the platform's retryable 401 as credentials loses the retry too.
    expect(classifyProviderConnectivityIssue(declaredError('HTTP 401', 401, { kind: 'credentials' }), NOW)?.retryable).toBe(false)
  })

  it('resetsAt is capped per kind', () => {
    const far = NOW + 400 * 24 * 60 * 60 * 1000
    const resetOf = (kind: DeclaredVerdict['kind'], retryAfterMs?: number) =>
      classifyProviderConnectivityIssue(declaredError('HTTP 418 teapot', 418, { kind, resetsAt: far }, retryAfterMs), NOW)?.resetsAt
    expect(resetOf('quota')).toBe(NOW + VERDICT_QUOTA_RESET_CEILING_MS)
    expect(resetOf('rate_limit')).toBe(NOW + VERDICT_RESET_CEILING_MS)
    // A rate limit may wait as long as the response's own directive when that is longer.
    expect(resetOf('rate_limit', 2 * VERDICT_RESET_CEILING_MS)).toBe(NOW + 2 * VERDICT_RESET_CEILING_MS)
    expect(resetOf('service')).toBe(NOW + VERDICT_RESET_CEILING_MS)
    expect(resetOf('provider_policy')).toBe(NOW + VERDICT_RESET_CEILING_MS)
    expect(resetOf('model_unavailable')).toBe(NOW + VERDICT_RESET_CEILING_MS)
    expect(resetOf('network')).toBe(NOW + VERDICT_RESET_CEILING_MS)
    expect(resetOf('billing')).toBeUndefined()
    expect(resetOf('credentials')).toBeUndefined()
    // A time inside the ceiling is kept as stated.
    expect(classifyProviderConnectivityIssue(declaredError('x', 429, { kind: 'quota', resetsAt: NOW + 5000 }), NOW)?.resetsAt).toBe(NOW + 5000)
  })

  it('a long message is cut, in every locale', () => {
    const long = 'm'.repeat(VERDICT_MESSAGE_MAX_LENGTH + 50)
    const issue = classifyProviderConnectivityIssue(
      declaredError('HTTP 403', 403, { kind: 'provider_policy', message: { en: long, 'zh-CN': long } }),
      NOW,
    )
    const message = issue?.message as Record<string, string>
    expect(message.en).toHaveLength(VERDICT_MESSAGE_MAX_LENGTH)
    expect(message['zh-CN']).toHaveLength(VERDICT_MESSAGE_MAX_LENGTH)
    expect(message.en.endsWith('…')).toBe(true)
  })

  it('a malformed declared part on the carrier is dropped', () => {
    const carrier = Object.assign(new Error('HTTP 503 down'), { httpStatus: 503, declared: { kind: 'made_up', retryable: false } })
    expect(classifyProviderConnectivityIssue(carrier, NOW)).toMatchObject({ kind: 'service', retryable: true })
  })

  it('the platform fills a scope for each of its own classifications', () => {
    const scopeOf = (error: unknown) => classifyProviderConnectivityIssue(error)?.scope
    expect(scopeOf(new ProviderApiError('HTTP 401', { httpStatus: 401 }))).toBe('key')
    expect(scopeOf(new ProviderApiError('HTTP 402', { httpStatus: 402 }))).toBe('account')
    expect(scopeOf(new ProviderApiError('HTTP 429', { httpStatus: 429 }))).toBe('key')
    expect(scopeOf(new ProviderApiError('HTTP 503', { httpStatus: 503 }))).toBe('provider')
    expect(scopeOf(new Error('Stream network error: Request failed'))).toBe('provider')
    expect(scopeOf(new ProviderApiError('HTTP 400 bad request', { httpStatus: 400 }))).toBe('request')
    expect(scopeOf(new Error('mismatched closing tag in tool call'))).toBe('request')
  })
})

describe('with no declared policy nothing changes', () => {
  afterEach(() => vi.restoreAllMocks())

  it('the classifier adds only `scope` to its results', () => {
    const samples: unknown[] = [
      new ProviderApiError('HTTP 401 unauthorized', { httpStatus: 401 }),
      new ProviderApiError('HTTP 402 payment required', { httpStatus: 402 }),
      new ProviderApiError('HTTP 429 too many requests', { httpStatus: 429, retryAfterMs: 7000 }),
      new ProviderApiError('HTTP 429 you exceeded your current quota', { httpStatus: 429 }),
      new ProviderApiError('HTTP 503 service unavailable', { httpStatus: 503 }),
      new Error('Stream network error: Request failed: net::ERR_CONNECTION_RESET'),
      new ProviderApiError('HTTP 400 invalid request', { httpStatus: 400 }),
      new Error('Repetitive tool calls detected in the conversation history'),
    ]
    const line = (sample: unknown): string => {
      const issue = classifyProviderConnectivityIssue(sample)!
      const { kind, error, retryable, settingsRecommended, status, retryAfterMs, titleKey, summaryKey, detail, scope, ...rest } = issue
      // Nothing beyond the fields listed here: no code, message, resetsAt or anomaly.
      expect(Object.keys(rest).filter(key => rest[key as keyof typeof rest] !== undefined)).toEqual([])
      expect(detail).toBe((sample as Error).message)
      return [kind, error, retryable, settingsRecommended, status, retryAfterMs, titleKey, summaryKey, scope].join(' | ')
    }
    expect(samples.map(line)).toMatchInlineSnapshot(`
      [
        "credentials | authentication_failed | true | true | 401 |  | providerIssue.credentials.title | providerIssue.credentials.summary | key",
        "billing | billing_error | false | false | 402 |  | providerIssue.billing.title | providerIssue.billing.summary | account",
        "rate_limit | rate_limit | true | false | 429 | 7000 | providerIssue.rateLimit.title | providerIssue.rateLimit.summary | key",
        "rate_limit | rate_limit | false | false | 429 |  | providerIssue.quotaExhausted.title | providerIssue.quotaExhausted.summaryMessage | key",
        "service | server_error | true | false | 503 |  | providerIssue.serviceUnavailable.title | providerIssue.serviceUnavailable.summaryUpstream | provider",
        "network | unknown | true | false |  |  | providerIssue.network.title | providerIssue.network.summary | provider",
        "configuration | invalid_request | false | true | 400 |  | providerIssue.configuration.title | providerIssue.configuration.summary | request",
        "provider_policy | repetitive_tool_calls | false | false |  |  | providerIssue.repetitiveToolCalls.title | providerIssue.repetitiveToolCalls.summary | request",
      ]
    `)
  })

  it('the ladder decides and waits as before', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const failure = classifyModelFailure(new ProviderApiError('HTTP 503 service unavailable', { httpStatus: 503 }))
    const delays: number[] = []
    for (let attempt = 1; attempt <= PROVIDER_CONNECTIVITY_MAX_RETRIES + 1; attempt += 1) {
      const decision = decideRetry({
        attempt,
        maxAttempts: PROVIDER_CONNECTIVITY_MAX_RETRIES + 1,
        failure,
        caller: 'test',
        attemptDurationMs: 0,
        cancelled: false,
      })
      delays.push(decision.retry ? decision.delayMs : -1)
    }
    expect(delays).toEqual([562.5, 1125, 2250, 4500, 9000, 18000, 36000, 36000, 36000, 36000, -1])
    expect(retriesAllowed(PROVIDER_CONNECTIVITY_MAX_RETRIES, undefined)).toBe(PROVIDER_CONNECTIVITY_MAX_RETRIES)
    // Past the declared total: the platform ladder has no such limit.
    expect(delays.filter(d => d > 0).reduce((a, b) => a + b, 0)).toBeGreaterThan(DECLARED_RETRY_TOTAL_WAIT_MS)
  })
})

describe('policy.retry: the ladder under a declared policy', () => {
  afterEach(() => vi.restoreAllMocks())

  const serviceDown = () => classifyModelFailure(new ProviderApiError('HTTP 503 service unavailable', { httpStatus: 503 }))
  const decide = (policy: DeclaredRetryPolicy, over: Partial<Parameters<typeof decideRetry>[0]> = {}) => {
    const maxRetries = retriesAllowed(PROVIDER_CONNECTIVITY_MAX_RETRIES, policy)
    return decideRetry({
      attempt: 1,
      maxAttempts: maxRetries + 1,
      failure: serviceDown(),
      caller: 'test',
      attemptDurationMs: 0,
      cancelled: false,
      policy,
      waitedMs: 0,
      ...over,
    })
  }

  it('maxRetries: 0 sends once', () => {
    expect(retriesAllowed(PROVIDER_CONNECTIVITY_MAX_RETRIES, { maxRetries: 0 })).toBe(0)
    expect(decide({ maxRetries: 0 })).toEqual({ retry: false })
  })

  it('maxRetries bounds the attempts', () => {
    expect(decide({ maxRetries: 2 }, { attempt: 2 }).retry).toBe(true)
    expect(decide({ maxRetries: 2 }, { attempt: 3 }).retry).toBe(false)
  })

  it('a kind outside `on` is not retried even when the verdict is retryable', () => {
    expect(serviceDown()).toMatchObject({ issue: { retryable: true, kind: 'service' } })
    expect(decide({ on: ['rate_limit', 'network'] })).toEqual({ retry: false })
    expect(decide({ on: ['service'] }).retry).toBe(true)
    expect(decide({ on: [] })).toEqual({ retry: false })
    expect(decide({}).retry).toBe(true)
  })

  it('`on` matches the kind a rule gave the failure', () => {
    const failure = classifyModelFailure(declaredError('HTTP 503 down', 503, { kind: 'model_unavailable', retryable: true }))
    expect(decide({ on: ['service'] }, { failure })).toEqual({ retry: false })
    expect(decide({ on: ['model_unavailable'] }, { failure }).retry).toBe(true)
  })

  it('a verdict that is not retryable is not retried, whatever `on` lists', () => {
    const failure = classifyModelFailure(declaredError('HTTP 403 FreeTierError', 403, { kind: 'provider_policy', retryable: false }))
    expect(decide({ on: ['provider_policy'] }, { failure })).toEqual({ retry: false })
  })

  it('credentials and configuration in `on` have no effect', () => {
    const unauthorized = classifyModelFailure(new ProviderApiError('HTTP 401 unauthorized', { httpStatus: 401 }))
    expect(unauthorized).toMatchObject({ issue: { kind: 'credentials', retryable: true } })
    expect(decide({ on: ['credentials', 'configuration'] }, { failure: unauthorized })).toEqual({ retry: false })
    // Without a declared `on` the verdict alone decides, as it does with no policy.
    expect(decide({ maxRetries: 3 }, { failure: unauthorized }).retry).toBe(true)
  })

  it('the declared curve sets the delay', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const policy = { initialDelayMs: 1000, maxDelayMs: 3000, jitterRatio: 0.2 }
    const delayAt = (attempt: number) => {
      const decision = decide(policy, { attempt })
      return decision.retry ? decision.delayMs : -1
    }
    expect([1, 2, 3, 4].map(delayAt)).toEqual([1100, 2200, 3300, 3300])
    expect(getProviderConnectivityRetryDelayMs(1, undefined, undefined, { jitterRatio: 0 })).toBe(500)
  })

  it('the response\'s own Retry-After still wins over the declared curve', () => {
    const failure = classifyModelFailure(new ProviderApiError('HTTP 503 down', { httpStatus: 503, retryAfterMs: 7000 }))
    expect(decide({ initialDelayMs: 100, maxDelayMs: 200 }, { failure })).toMatchObject({ retry: true, delayMs: 7000 })
  })

  it('a call waits at most 120 s in all', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const policy = { initialDelayMs: 32_000, maxDelayMs: 32_000, maxRetries: 10 }
    let waitedMs = 0
    let attempts = 1
    for (; attempts <= 11; attempts += 1) {
      const decision = decide(policy, { attempt: attempts, waitedMs })
      if (!decision.retry) break
      waitedMs += decision.delayMs
    }
    expect(waitedMs).toBe(96_000)
    expect(attempts).toBe(4)
    expect(waitedMs).toBeLessThanOrEqual(DECLARED_RETRY_TOTAL_WAIT_MS)
    // A directive that would overrun the total ends the call instead of waiting.
    const longWait = classifyModelFailure(new ProviderApiError('HTTP 503 down', { httpStatus: 503, retryAfterMs: 121_000 }))
    expect(decide({}, { failure: longWait })).toEqual({ retry: false })
  })
})

describe('policy: manifest validation', () => {
  function check(policy: unknown) {
    return checkPluginDescriptor({
      name: 'acme',
      version: '1.0.0',
      providers: {
        main: {
          providerApi: 1,
          displayName: 'Acme',
          defaultBaseUrl: 'https://api.acme.example/v1',
          domains: ['api.acme.example'],
          // Any wire format the platform supports; the policy block does not depend on it.
          format: USER_MODEL_FORMATS[0],
          credentials: { methods: ['apiKey'] },
          module: './provider.ts',
          ...(policy !== undefined ? { policy } : {}),
        },
      },
    })
  }
  const accepted = (policy: unknown): ProviderPolicy | undefined => {
    const out = check(policy)
    expect(out.errors).toEqual([])
    return out.manifest?.providers?.main?.policy
  }
  const refused = (policy: unknown): string => {
    const out = check(policy)
    expect(out.manifest?.providers?.main).toBeUndefined()
    return out.errors.join('\n')
  }

  it('accepts the documented shape', () => {
    const policy = accepted({
      retry: { maxRetries: 8, initialDelayMs: 1000, maxDelayMs: 20000, jitterRatio: 0.2, on: ['rate_limit', 'network', 'service'] },
      errors: [
        {
          match: { status: 403, bodyContains: 'FreeTierError' },
          kind: 'provider_policy',
          scope: 'model',
          retryable: false,
          code: 'free_tier_restricted',
          message: { en: 'This model is not available on the free tier.', 'zh-CN': '免费层不能使用这个模型。' },
        },
        { match: { status: { from: 500, to: 599 }, bodyPointer: '/info/error' }, kind: 'service', retryable: true },
        {
          match: { status: 429, headerPresent: 'X-Quota-Reset' },
          kind: 'quota',
          scope: 'account',
          resetsAtFrom: { header: 'X-Quota-Reset', unit: 'epoch-seconds' },
        },
        { match: { anomaly: 'in_body_error', model: 'big-' }, kind: 'model_unavailable' },
      ],
    })
    expect(policy?.retry).toEqual({ maxRetries: 8, initialDelayMs: 1000, maxDelayMs: 20000, jitterRatio: 0.2, on: ['rate_limit', 'network', 'service'] })
    expect(policy?.errors).toHaveLength(4)
    // Header names are kept in lower case.
    expect(policy?.errors?.[2]).toMatchObject({
      match: { headerPresent: 'x-quota-reset' },
      resetsAtFrom: { header: 'x-quota-reset', unit: 'epoch-seconds' },
    })
  })

  it('no policy, an empty policy and an empty rule list all mean "the platform\'s"', () => {
    expect(accepted(undefined)).toBeUndefined()
    expect(accepted({})).toBeUndefined()
    expect(accepted({ errors: [] })).toBeUndefined()
    expect(accepted({ retry: { on: [] } })).toEqual({ retry: { on: [] } })
  })

  it.each([
    [{ retries: {} }, 'providers.main.policy.retries: not a known property'],
    [{ retry: { maxRetry: 1 } }, 'providers.main.policy.retry.maxRetry: not a known property'],
    [{ retry: { maxRetries: 11 } }, 'providers.main.policy.retry.maxRetries: expected a whole number from 0 to 10'],
    [{ retry: { maxRetries: '3' } }, 'providers.main.policy.retry.maxRetries: expected a whole number'],
    [{ retry: { maxDelayMs: 32001 } }, 'providers.main.policy.retry.maxDelayMs: expected a whole number from 0 to 32000'],
    [{ retry: { initialDelayMs: -1 } }, 'providers.main.policy.retry.initialDelayMs'],
    [{ retry: { jitterRatio: 2 } }, 'providers.main.policy.retry.jitterRatio: expected a number from 0 to 1'],
    [{ retry: { on: 'service' } }, 'providers.main.policy.retry.on: expected a list'],
    [{ retry: { on: ['overloaded'] } }, 'providers.main.policy.retry.on[0]: expected one of'],
    [{ errors: {} }, 'providers.main.policy.errors: expected a list'],
    [{ errors: [{ kind: 'service' }] }, 'providers.main.policy.errors[0].match: required'],
    [{ errors: [{ match: {}, kind: 'service' }] }, 'providers.main.policy.errors[0].match: needs at least one condition'],
    [{ errors: [{ match: { status: 403 } }] }, 'providers.main.policy.errors[0].kind: expected one of'],
    [{ errors: [{ match: { status: 403 }, kind: 'forbidden' }] }, 'providers.main.policy.errors[0].kind: expected one of'],
    [{ errors: [{ match: { bodyContain: 'x' }, kind: 'service' }] }, 'providers.main.policy.errors[0].match.bodyContain: not a known property'],
    [{ errors: [{ match: { bodyMatches: '^x' }, kind: 'service' }] }, 'providers.main.policy.errors[0].match.bodyMatches: not a known property'],
    [{ errors: [{ match: { status: '403' }, kind: 'service' }] }, 'providers.main.policy.errors[0].match.status: expected a status code'],
    [{ errors: [{ match: { status: 99 }, kind: 'service' }] }, 'providers.main.policy.errors[0].match.status: expected a whole number from 100 to 599'],
    [{ errors: [{ match: { status: { from: 500, to: 400 } }, kind: 'service' }] }, 'providers.main.policy.errors[0].match.status: "from" must not be greater'],
    [{ errors: [{ match: { status: { from: 500, upTo: 599 } }, kind: 'service' }] }, 'providers.main.policy.errors[0].match.status.upTo: not a known property'],
    [{ errors: [{ match: { bodyContains: '' }, kind: 'service' }] }, 'providers.main.policy.errors[0].match.bodyContains'],
    [{ errors: [{ match: { bodyPointer: 'info/error' }, kind: 'service' }] }, 'providers.main.policy.errors[0].match.bodyPointer: expected a JSON Pointer'],
    [{ errors: [{ match: { headerPresent: 'bad header' }, kind: 'service' }] }, 'providers.main.policy.errors[0].match.headerPresent'],
    [{ errors: [{ match: { anomaly: 'weird' }, kind: 'service' }] }, 'providers.main.policy.errors[0].match.anomaly: expected one of'],
    [{ errors: [{ match: { status: 403 }, kind: 'service', scope: 'world' }] }, 'providers.main.policy.errors[0].scope: expected one of'],
    [{ errors: [{ match: { status: 403 }, kind: 'service', retryable: 'no' }] }, 'providers.main.policy.errors[0].retryable: expected true or false'],
    [{ errors: [{ match: { status: 403 }, kind: 'service', message: { en: '' } }] }, 'providers.main.policy.errors[0].message'],
    [{ errors: [{ match: { status: 403 }, kind: 'service', retry: false }] }, 'providers.main.policy.errors[0].retry: not a known property'],
    [{ errors: [{ match: { status: 429 }, kind: 'quota', resetsAtFrom: { header: 'x', unit: 'minutes' } }] }, 'providers.main.policy.errors[0].resetsAtFrom.unit: expected one of'],
    [{ errors: [{ match: { status: 429 }, kind: 'quota', resetsAtFrom: { unit: 'epoch-ms' } }] }, 'providers.main.policy.errors[0].resetsAtFrom: needs exactly one of'],
    [{ errors: [{ match: { status: 429 }, kind: 'quota', resetsAtFrom: { header: 'x', pointer: '/y', unit: 'epoch-ms' } }] }, 'providers.main.policy.errors[0].resetsAtFrom: needs exactly one of'],
    ['strict', 'providers.main.policy: expected an object'],
  ])('refuses the provider and names the field: %j', (policy, expected) => {
    expect(refused(policy)).toContain(expected)
  })

  it('refuses more than 64 rules', () => {
    const rules = Array.from({ length: 65 }, () => ({ match: { status: 403 }, kind: 'service' }))
    expect(refused({ errors: rules })).toContain('providers.main.policy.errors: 65 rules; the most is 64')
    expect(accepted({ errors: rules.slice(0, 64) })?.errors).toHaveLength(64)
  })
})

// A codec whose response bytes are newline-separated JSON events.
const linesCodec: ProviderDriver = {
  id: 'policy-verdict-lines',
  auth: {},
  buildRequest: (_payload, context) => ({ url: `${context.baseUrl}/x`, headers: {}, body: new Uint8Array() }),
  createDecoder: () => {
    const text = new TextDecoder()
    let buffered = ''
    const drain = (): DriverStreamEvent[] => {
      const lines = buffered.split('\n')
      buffered = lines.pop() ?? ''
      return lines.filter(Boolean).map(l => JSON.parse(l) as DriverStreamEvent)
    }
    return {
      push: bytes => {
        buffered += text.decode(bytes, { stream: true })
        return drain()
      },
      end: () => {
        buffered += '\n'
        return drain()
      },
    }
  },
  errorFromResponse: ({ status, bodyText }) => ({ type: 'error', message: `HTTP ${status}: ${bodyText}`, httpStatus: status }),
}
registerProviderDriver(linesCodec)

const PROVIDER_ID = 'mod.acme.main'
const FREE_TIER_MESSAGE = { en: 'This model is not available on the free tier.', 'zh-CN': '免费层不能使用这个模型。' }
const FREE_TIER_POLICY: ProviderPolicy = {
  errors: [
    {
      match: { status: 403, bodyContains: 'FreeTierError' },
      kind: 'provider_policy',
      scope: 'model',
      retryable: false,
      code: 'free_tier_restricted',
      message: FREE_TIER_MESSAGE,
    },
    { match: { anomaly: 'in_body_error', bodyContains: 'overloaded_now' }, kind: 'service', code: 'in_body_error' },
  ],
}

function serving(status: number, body: string, headers: Record<string, string> = {}) {
  let opens = 0
  let served = false
  const transport: BrowserBridgeTransport = {
    async request(req: any) {
      if (req.route.action === 'rawStreamOpen') {
        opens += 1
        served = false
        return { ok: true, result: { streamId: 'r', status, statusText: '', finalUrl: 'u', headers } } as any
      }
      if (req.route.action === 'rawStreamCancel') return { ok: true, result: { ok: true } } as any
      const chunk = served ? new Uint8Array() : new TextEncoder().encode(body)
      served = true
      return { ok: true, result: { done: true, chunk } } as any
    },
  }
  return { transport, opens: () => opens }
}

async function errorChunkOf(host: DriverStreamHost, streamId: string) {
  for (let i = 0; i < 10; i += 1) {
    const read = await host.read(streamId, 1000)
    const found = read.chunks.find((c: any) => c.type === 'error')
    if (found) return found as any
    if (read.done) break
  }
  throw new Error('the stream ended without an error chunk')
}

describe('a provider\'s rules reach the failure where the response is read', () => {
  afterEach(() => resetProviderRequestSeams())

  const provider = () => createModelProvider({ id: PROVIDER_ID, format: 'policy-verdict-lines', baseUrl: 'https://api.acme.example' })

  it('a refused response that matches a rule carries the rule\'s verdict', async () => {
    registerProviderRequestSeam(PROVIDER_ID, { policy: FREE_TIER_POLICY })
    const { transport } = serving(403, '{"error":{"type":"FreeTierError"}}')
    const host = new DriverStreamHost(transport)
    const chunk = await errorChunkOf(host, host.start(provider(), { messages: [] }, 'big-1').streamId)
    expect(chunk.error).toMatchObject({
      httpStatus: 403,
      verdict: { kind: 'provider_policy', scope: 'model', retryable: false, code: 'free_tier_restricted', message: FREE_TIER_MESSAGE },
    })
  })

  it('a refused response no rule matches, and a provider without rules, carry none', async () => {
    registerProviderRequestSeam(PROVIDER_ID, { policy: FREE_TIER_POLICY })
    const other = serving(403, '{"error":{"type":"Forbidden"}}')
    const host = new DriverStreamHost(other.transport)
    expect((await errorChunkOf(host, host.start(provider(), { messages: [] }, 'big-1').streamId)).error.verdict).toBeUndefined()

    resetProviderRequestSeams()
    const plain = serving(403, '{"error":{"type":"FreeTierError"}}')
    const plainHost = new DriverStreamHost(plain.transport)
    const chunk = await errorChunkOf(plainHost, plainHost.start(provider(), { messages: [] }, 'big-1').streamId)
    expect(chunk.error).toEqual({ type: 'provider_error', message: 'HTTP 403: {"error":{"type":"FreeTierError"}}', httpStatus: 403 })
  })

  it('an error inside a stream that opened is matched as `in_body_error`', async () => {
    registerProviderRequestSeam(PROVIDER_ID, { policy: FREE_TIER_POLICY })
    const body = `${JSON.stringify({ type: 'error', message: 'overloaded_now' })}\n`
    const { transport } = serving(200, body, { 'content-type': 'text/event-stream' })
    const host = new DriverStreamHost(transport)
    const chunk = await errorChunkOf(host, host.start(provider(), { messages: [] }, 'big-1').streamId)
    expect(chunk.error.verdict).toEqual({ kind: 'service', code: 'in_body_error', anomaly: 'in_body_error' })
  })
})

describe('acceptance: a declared 403 is sent once and shows the rule\'s message', () => {
  afterEach(() => resetProviderRequestSeams())

  function callParams() {
    const toolUseContext = createNoopToolUseContext({
      tools: [],
      platformCapabilities: new NoopPlatformCapabilities(),
      appState: createEmptyAppState(),
      setAppState: () => {},
    })
    const user = {
      type: 'user',
      uuid: 'u-1',
      timestamp: '2026-01-01T00:00:00.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    } as unknown as Message
    return {
      messages: [user],
      baseInstructions: 'test',
      userContext: {},
      systemAmbient: {},
      callContext: toolUseContext,
      querySource: 'test',
      providerId: PROVIDER_ID,
    }
  }

  /** A model transport that answers every stream with `errorChunk`. */
  function modelRoutes(errorChunk: unknown) {
    let starts = 0
    const transport = {
      servesModelRoutes: true,
      request: async (req: { route: { action: string } }) => {
        if (req.route.action === 'streamStart') {
          starts += 1
          return { ok: true as const, result: { streamId: `s${starts}` } }
        }
        if (req.route.action === 'streamRead') return { ok: true as const, result: { done: true, chunks: [errorChunk] } }
        if (req.route.action === 'streamCancel') return { ok: true as const, result: { ok: true } }
        return { ok: false as const, error: { code: 'UNEXPECTED', message: `unexpected ${req.route.action}` } }
      },
    }
    return { transport, starts: () => starts }
  }

  async function runCall(errorChunk: unknown) {
    const runtimeConfig = new DefaultRuntimeConfig()
    const routes = modelRoutes(errorChunk)
    const deps = assembleTurnDependencies(runtimeConfig, {}, { bridgeTransport: routes.transport as never, runtimeConfig })
    const values: any[] = []
    for await (const value of deps.callModel(callParams() as never) as AsyncGenerator<unknown>) values.push(value)
    return { assistant: values.find(v => v?.type === 'assistant'), starts: routes.starts() }
  }

  it('the 403 that matches the rule is sent exactly once and carries the rule\'s message', async () => {
    registerProviderRequestSeam(PROVIDER_ID, { policy: FREE_TIER_POLICY })
    // The chunk the stream host makes of the provider's 403.
    const { transport } = serving(403, '{"error":{"type":"FreeTierError"}}')
    const host = new DriverStreamHost(transport)
    const provider = createModelProvider({ id: PROVIDER_ID, format: 'policy-verdict-lines', baseUrl: 'https://api.acme.example' })
    const errorChunk = await errorChunkOf(host, host.start(provider, { messages: [] }, 'big-1').streamId)

    const { assistant, starts } = await runCall(errorChunk)
    expect(starts).toBe(1)
    expect(assistant).toMatchObject({
      isApiErrorMessage: true,
      error: 'invalid_request',
      errorRetryCount: 0,
      errorMessage: FREE_TIER_MESSAGE,
      errorCode: 'free_tier_restricted',
    })
  })

  it('`maxRetries: 0` sends a retryable failure once', async () => {
    registerProviderRequestSeam(PROVIDER_ID, { policy: { retry: { maxRetries: 0 } } })
    const { assistant, starts } = await runCall({ type: 'error', error: { type: 'provider_error', message: 'HTTP 403 forbidden', httpStatus: 403 } })
    expect(starts).toBe(1)
    expect(assistant).toMatchObject({ isApiErrorMessage: true, error: 'authentication_failed', errorRetryCount: 0 })
    expect(assistant.errorMessage).toBeUndefined()
  })
})

describe('the error card shows the declared message', () => {
  it('the api-error row hands the message and the code to the card', () => {
    const row = {
      isApiErrorMessage: true,
      error: 'invalid_request',
      errorDetails: 'HTTP 403: FreeTierError',
      errorRetryCount: 0,
      errorMessage: FREE_TIER_MESSAGE,
      errorCode: 'free_tier_restricted',
      message: { role: 'assistant', content: [] },
    }
    const out = withProviderApiErrorMetadata({ role: 'assistant', content: [] } as never, row as never, 'hello')
    expect(out.metadata?.custom).toMatchObject({ apiErrorMessage: FREE_TIER_MESSAGE, apiErrorCode: 'free_tier_restricted' })
  })

  it('the message is read in the locale of the page, then the language, then English', () => {
    expect(providerDeclaredMessage(FREE_TIER_MESSAGE, 'zh-CN')).toBe('免费层不能使用这个模型。')
    expect(providerDeclaredMessage(FREE_TIER_MESSAGE, 'zh')).toBe('免费层不能使用这个模型。')
    expect(providerDeclaredMessage(FREE_TIER_MESSAGE, 'de')).toBe('This model is not available on the free tier.')
  })

  it('a failure without a declared message leaves the card its own summary', () => {
    expect(providerDeclaredMessage(undefined, 'en')).toBe('')
    expect(providerDeclaredMessage({ en: '' }, 'en')).toBe('')
    expect(providerDeclaredMessage(42, 'en')).toBe('')
  })
})
