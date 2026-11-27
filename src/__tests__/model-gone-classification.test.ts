import { afterEach, describe, expect, it } from 'vitest'
import {
  MODEL_UNAVAILABLE_MS,
  noteProviderConfigs,
  providerStateOf,
  recordProviderVerdict,
  resetProviderHealthLedger,
} from '../models/drivers/providerHealthLedger'
import {
  classifyProviderConnectivityIssue,
  shouldRetryProviderConnectivityIssue,
} from '../utils/providerConnectivity'

const NOON = Date.UTC(2026, 10, 27, 12, 0, 0)

const GONE = [
  'HTTP 404: This model models/acme-2-fast is no longer available to new users. Please update your code to use models/acme-3-fast.',
  'HTTP 404: models/acme-1-pro is not found for API version v1beta, or is not supported for generateContent.',
  'HTTP 404: The model `gpt-legacy` does not exist or you do not have access to it.',
  'HTTP 410: The model old-model has been retired.',
  'HTTP 400: model_decommissioned: The model `old-open-model` has been decommissioned.',
  'HTTP 404: {"error":{"code":"model_not_found","message":"no such model"}}',
  'HTTP 200: Streaming response failed: {"error":{"code":"model_not_found","message":"no such model"}}',
]

describe('a provider answer that the model is gone', () => {
  it.each(GONE)('%s is model_unavailable for that model, not retried in place', message => {
    const issue = classifyProviderConnectivityIssue(new Error(message))
    expect(issue).toMatchObject({ kind: 'model_unavailable', scope: 'model', retryable: false })
    expect(shouldRetryProviderConnectivityIssue(issue)).toBe(false)
  })

  it.each([
    'HTTP 404: 404 page not found',
    'HTTP 404: Not Found',
    'HTTP 400: invalid model name',
    'HTTP 400: Invalid argument: model field is required',
    'HTTP 404: The requested URL /v1beta/models/acme-2-fast:streamGenerateContent was not found on this server.',
  ])('%s stays a configuration problem', message => {
    expect(classifyProviderConnectivityIssue(new Error(message))?.kind).toBe('configuration')
  })

  it('an auth failure that mentions a model is still credentials', () => {
    expect(classifyProviderConnectivityIssue(new Error('HTTP 403: API key not valid for model acme-x, not found'))?.kind)
      .toBe('credentials')
  })
})

describe('the health ledger after a gone model', () => {
  afterEach(() => resetProviderHealthLedger())

  it('holds that model of that provider for an hour and leaves its other models alone', () => {
    const issue = classifyProviderConnectivityIssue(new Error(GONE[0]))!
    recordProviderVerdict('vendor.k1', 'acme-2-fast', issue, NOON)
    expect(providerStateOf('vendor.k1', NOON)).toEqual({
      models: {
        'acme-2-fast': { status: 'cooling', until: NOON + MODEL_UNAVAILABLE_MS, untilFrom: 'platform', reason: 'model_unavailable' },
      },
    })
  })

  it('a changed config of that provider lifts the hold', () => {
    noteProviderConfigs({ 'vendor.k1': { hasApiKey: true } })
    recordProviderVerdict('vendor.k1', 'acme-1-pro', classifyProviderConnectivityIssue(new Error(GONE[1]))!, NOON)
    noteProviderConfigs({ 'vendor.k1': { hasApiKey: true, apiVersion: 'v1' } })
    expect(providerStateOf('vendor.k1', NOON)).toEqual({ models: {} })
  })

  it('a wrong-endpoint 404 is a configuration verdict and holds no model', () => {
    const issue = classifyProviderConnectivityIssue(new Error('HTTP 404: 404 page not found'))!
    recordProviderVerdict('vendor.k1', 'acme-2-fast', issue, NOON)
    expect(providerStateOf('vendor.k1', NOON)).toEqual({ models: {} })
  })
})
