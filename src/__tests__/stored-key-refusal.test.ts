/**
 * A model request the host refuses before sending because the provider's
 * `{{secret:api_key}}` has no usable value (SECRET_UNAVAILABLE). The refusal's
 * `error.data.reason` decides what the user is told: a key this computer's
 * keystore cannot open is not "connection error", and not a key never saved.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { BrowserBridgeTransport } from '../browser/bridge/browserBridgeProtocol'
import { RawProviderStreamError, openRawProviderStream } from '../browser/bridge/rawProviderStream'
import { DriverStreamHost, resetDriverStreamPools } from '../models/drivers/driverStreamHost'
import { createModelProvider } from '../models/drivers/modelProvider'
import { resolveProviderSpec } from '../models/drivers/driverRegistry'
import '../models/drivers/builtinDrivers'
import { classifyProviderConnectivityIssue } from '../utils/providerConnectivity'
import { storedKeyProblemOf } from '../utils/storedKeyProblem'

const payload = {
  messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }],
  maxOutputTokens: 1024,
} as never

const UNREADABLE = "Provider's stored secret api_key cannot be decrypted by this OS keystore; enter it again."
const MISSING = 'Provider has no secret named api_key.'

function refusingHost(error: Record<string, unknown>): BrowserBridgeTransport {
  return {
    async request(req: any) {
      if (req.route.action === 'rawStreamOpen') return { id: req.id, route: req.route, ok: false, error } as any
      return { id: req.id, route: req.route, ok: true, result: { ok: true } } as any
    },
  }
}

async function streamErrorText(error: Record<string, unknown>): Promise<string> {
  const streams = new DriverStreamHost(refusingHost(error))
  const provider = createModelProvider(resolveProviderSpec('openrouter')!)
  const { streamId } = streams.start(provider, payload, 'test/model-a')
  const chunks: any[] = []
  for (;;) {
    const read = await streams.read(streamId, 1000)
    chunks.push(...read.chunks)
    if (read.done) break
  }
  const failed = chunks.find(c => c.type === 'error')
  expect(failed).toBeDefined()
  return failed.error.message as string
}

afterEach(() => resetDriverStreamPools())

describe('a SECRET_UNAVAILABLE refusal', () => {
  it('keeps the host\'s error.data on the raw stream error', async () => {
    const data = { secret: 'api_key', reason: 'unreadable' }
    const failure = await openRawProviderStream(
      refusingHost({ code: 'SECRET_UNAVAILABLE', message: UNREADABLE, data }),
      { providerId: 'openrouter', url: 'https://openrouter.ai/api/v1/chat/completions' } as never,
    ).catch(error => error)
    expect(failure).toBeInstanceOf(RawProviderStreamError)
    expect(failure).toMatchObject({ code: 'SECRET_UNAVAILABLE', data })
  })

  it('an unreadable stored key reads as such and is not retried', async () => {
    const text = await streamErrorText({
      code: 'SECRET_UNAVAILABLE',
      message: UNREADABLE,
      data: { secret: 'api_key', reason: 'unreadable' },
    })
    expect(storedKeyProblemOf(text)).toBe('unreadable')
    expect(text).toContain('cannot be decrypted')
    expect(classifyProviderConnectivityIssue(`provider_error: ${text}`)).toMatchObject({
      kind: 'credentials',
      error: 'authentication_failed',
      titleKey: 'providerIssue.storedKeyUnreadable.title',
      summaryKey: 'providerIssue.storedKeyUnreadable.summary',
      retryable: false,
      settingsRecommended: true,
    })
  })

  it('a missing key, and an older host that sends no reason, read as no usable key', async () => {
    for (const error of [
      { code: 'SECRET_UNAVAILABLE', message: MISSING, data: { secret: 'api_key', reason: 'missing' } },
      { code: 'SECRET_UNAVAILABLE', message: MISSING },
    ]) {
      const text = await streamErrorText(error)
      expect(storedKeyProblemOf(text)).toBe('unavailable')
      expect(classifyProviderConnectivityIssue(`provider_error: ${text}`)).toMatchObject({
        kind: 'credentials',
        summaryKey: 'providerIssue.storedKeyUnavailable.summary',
        retryable: false,
        settingsRecommended: true,
      })
    }
  })

  it('a keystore not yet ready is not reported as a key problem', async () => {
    const text = await streamErrorText({
      code: 'SECRET_UNAVAILABLE',
      message: 'The OS keystore is not ready; cannot read secret api_key.',
      data: { secret: 'api_key', reason: 'keystore_not_ready' },
    })
    expect(storedKeyProblemOf(text)).toBeUndefined()
    expect(classifyProviderConnectivityIssue(`provider_error: ${text}`)?.kind).not.toBe('credentials')
  })
})
