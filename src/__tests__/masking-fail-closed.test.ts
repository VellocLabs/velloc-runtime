/**
 * Model egress masking fails closed (F-39): a request is sent only when the
 * masking state is known to be off or active with a usable table.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserBridgeTransport } from '../browser/bridge/browserBridgeProtocol'
import { openRawProviderStream } from '../browser/bridge/rawProviderStream'
import '../models/drivers/builtinDrivers'
import { DriverStreamHost } from '../models/drivers/driverStreamHost'
import { createModelProvider } from '../models/drivers/modelProvider'
import { registerProviderDriver } from '../models/drivers/driverRegistry'
import type { DriverStreamEvent, ProviderDriver } from '../models/drivers/driverTypes'
import { MaskingResidualError, MaskingUnavailableError } from '../models/masking/egressGuard'
import { MASKING_READ_RETRY_MS, modelMasking } from '../models/masking/maskingHolder'
import { resetModelMaskingBoot, settleWithoutSettings, startModelMasking } from '../models/masking/maskingBoot'
import { readUserLayer, wipeSettingsMemos } from '../settings/settingsStore'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import { maskingRefusalMessage, maskingRefusalOf } from '../utils/maskingRefusal'
import { classifyProviderConnectivityIssue } from '../utils/providerConnectivity'
import { providerErrorSummaryKey } from '../components/assistant-ui/thread'
import { createTranslate } from '../browser/webview/i18n/translate'
import { en } from '../browser/webview/i18n/messages/en'
import { de } from '../browser/webview/i18n/messages/de'
import { es } from '../browser/webview/i18n/messages/es'
import { fr } from '../browser/webview/i18n/messages/fr'
import { ja } from '../browser/webview/i18n/messages/ja'
import { ko } from '../browser/webview/i18n/messages/ko'
import { zh } from '../browser/webview/i18n/messages/zh'

const RULES = [{ match: 'AcmeCo', alias: 'Northwind' }]

const codec: ProviderDriver = {
  id: 'masking-fc-echo',
  auth: {},
  buildRequest: (payload, context) => ({
    url: `${context.baseUrl}/v1/chat`,
    headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode(JSON.stringify(payload)),
  }),
  createDecoder: () => ({ push: () => [], end: (): DriverStreamEvent[] => [{ type: 'finish', finishReason: 'stop' }] }),
  errorFromResponse: ({ status }) => ({ type: 'error', message: `HTTP ${status}`, httpStatus: status }),
}
registerProviderDriver(codec)

function recordingTransport() {
  const opened: Array<{ url: string; headers: Record<string, string>; body: string }> = []
  const transport: BrowserBridgeTransport = {
    async request(req: any) {
      if (req.route.action === 'rawStreamOpen') {
        opened.push({ url: req.payload.url, headers: req.payload.headers ?? {}, body: new TextDecoder().decode(req.payload.body) })
        return { ok: true, result: { streamId: 'r', status: 200, statusText: '', finalUrl: 'u', headers: {} } } as any
      }
      if (req.route.action === 'rawStreamCancel') return { ok: true, result: { ok: true } } as any
      return { ok: true, result: { done: true, chunk: new Uint8Array(0) } } as any
    },
  }
  return { transport, opened }
}

async function drain(host: DriverStreamHost, streamId: string) {
  const chunks: any[] = []
  for (let i = 0; i < 200; i += 1) {
    const read = await host.read(streamId, 1000)
    chunks.push(...read.chunks)
    if (read.done) return chunks
  }
  throw new Error('stream never finished')
}

const provider = () => createModelProvider({ id: 'masking-fc', format: 'masking-fc-echo', baseUrl: 'https://llm.example.com' })

function startStream(content: string) {
  const { transport, opened } = recordingTransport()
  const host = new DriverStreamHost(transport)
  const { streamId } = host.start(provider(), { messages: [{ role: 'user', content }] }, 'm')
  return { host, streamId, opened }
}

afterEach(() => {
  vi.useRealTimers()
  resetModelMaskingBoot()
  wipeSettingsMemos()
})

describe('before the masking settings are known', () => {
  it('a fresh holder holds every stream: nothing is sent while the state is unknown', async () => {
    modelMasking.resetForTest()
    expect(modelMasking.status().state).toBe('unknown')
    const { host, streamId, opened } = startStream('AcmeCo')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(opened).toEqual([])
    modelMasking.configure({ enabled: true, rules: RULES })
    await drain(host, streamId)
    expect(opened).toHaveLength(1)
    expect(opened[0]!.body).not.toContain('AcmeCo')
  })

  it('a request outside a driver stream is refused while unknown', async () => {
    modelMasking.resetForTest()
    const { transport, opened } = recordingTransport()
    await expect(openRawProviderStream(transport, { providerId: 'p', url: 'https://x/plain' }))
      .rejects.toBeInstanceOf(MaskingUnavailableError)
    expect(opened).toEqual([])
  })

  it('a failed read keeps the state unknown and is tried again', async () => {
    vi.useFakeTimers()
    modelMasking.resetForTest()
    let calls = 0
    const read = async () => {
      calls += 1
      if (calls === 1) throw new Error('EIO')
      return { enabled: true, rules: RULES }
    }
    await modelMasking.load(read)
    expect(modelMasking.status()).toMatchObject({ state: 'unknown', lastError: { reason: 'other', detail: 'EIO' } })
    await vi.advanceTimersByTimeAsync(MASKING_READ_RETRY_MS)
    expect(calls).toBe(2)
    expect(modelMasking.status().state).toBe('active')
  })

  it('an unreadable settings file (bad JSON) is not taken for "masking off"', async () => {
    vi.useFakeTimers()
    modelMasking.resetForTest()
    let content = '{ not json'
    const fs = {
      async readFile() {
        return content
      },
    } as unknown as RuntimeFs
    expect((await readUserLayer('/home/u', fs)).unread).toBe(true)
    expect(
      startModelMasking({
        homeDir: () => '/home/u',
        transport: () => recordingTransport().transport,
        requestId: () => 'id',
        fs: () => fs,
      }),
    ).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(modelMasking.status().state).toBe('unknown')
    content = JSON.stringify({ version: 1, modelMasking: { enabled: true, rules: RULES } })
    await vi.advanceTimersByTimeAsync(MASKING_READ_RETRY_MS)
    expect(modelMasking.status().state).toBe('active')
  })

  it('a session with no settings file settles off', () => {
    modelMasking.resetForTest()
    settleWithoutSettings()
    expect(modelMasking.status().state).toBe('off')
  })

  it('a stream cancelled while it waits ends without sending', async () => {
    modelMasking.resetForTest()
    const { host, streamId, opened } = startStream('AcmeCo')
    await host.cancel(streamId)
    modelMasking.configure({ enabled: false, rules: RULES })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(opened).toEqual([])
  })
})

describe('masking turned on with an unusable table', () => {
  for (const [name, rules] of [
    ['an invalid table', [{ match: 'AcmeCo', alias: 'Northwind' }, { match: 'beta', alias: 'Northwind' }]],
    ['a malformed rule beside valid ones', [{ match: 'AcmeCo', alias: 'Northwind' }, { match: 42, alias: 'x' }]],
    ['an empty table', []],
  ] as const) {
    it(`${name}: the request is refused, not sent in clear, and not retried`, async () => {
      modelMasking.configure({ enabled: true, rules: rules as never })
      expect(modelMasking.status().state).toBe('broken')
      const { host, streamId, opened } = startStream('AcmeCo')
      const chunks = await drain(host, streamId)
      expect(opened).toEqual([])
      const error = chunks.find(c => c.type === 'error')
      expect(maskingRefusalOf(error.error.message)).toEqual({ kind: 'broken' })
      expect(error.httpStatus ?? error.error.httpStatus).toBe(400)
    })
  }

  it('a request outside a driver stream is refused too', async () => {
    modelMasking.configure({ enabled: true, rules: [] })
    const { transport, opened } = recordingTransport()
    await expect(openRawProviderStream(transport, { providerId: 'p', url: 'https://x/plain' }))
      .rejects.toBeInstanceOf(MaskingUnavailableError)
    expect(opened).toEqual([])
  })
})

describe('the guard of a stream', () => {
  it('uses the table the stream opened with, not one switched on later', async () => {
    modelMasking.configure({ enabled: false, rules: RULES })
    const { transport, opened } = recordingTransport()
    const host = new DriverStreamHost(transport)
    const original = transport.request.bind(transport)
    let turnedOn = false
    transport.request = (async (req: any) => {
      if (req.route.action === 'rawStreamOpen' && !turnedOn) {
        turnedOn = true
        modelMasking.configure({ enabled: true, rules: RULES })
      }
      return original(req)
    }) as typeof transport.request
    const { streamId } = host.start(provider(), { messages: [{ role: 'user', content: 'AcmeCo' }] }, 'm')
    const chunks = await drain(host, streamId)
    expect(opened).toHaveLength(1)
    expect(chunks.some(c => c.type === 'error')).toBe(false)
  })

  it('still refuses what its own table finds', async () => {
    modelMasking.configure({ enabled: true, rules: RULES })
    const { transport, opened } = recordingTransport()
    const host = new DriverStreamHost(transport)
    const leaky = createModelProvider({ id: 'masking-fc', format: 'masking-fc-echo', baseUrl: 'https://AcmeCo.example' })
    const { streamId } = host.start(leaky, { messages: [{ role: 'user', content: 'hi' }] }, 'm')
    const chunks = await drain(host, streamId)
    expect(opened).toEqual([])
    expect(maskingRefusalOf(chunks.find(c => c.type === 'error').error.message)?.kind).toBe('residual')
  })
})

describe('a text document that cannot be masked', () => {
  const latin1 = (text: string) => btoa(text)

  it('is refused with the undecodable card, sends nothing, and is not retried', async () => {
    modelMasking.configure({ enabled: true, rules: RULES })
    const { transport, opened } = recordingTransport()
    const host = new DriverStreamHost(transport)
    const doc = { type: 'document', data: latin1('AcmeCo caf\u00e9 plan'), mimeType: 'text/plain' }
    const { streamId } = host.start(provider(), { messages: [{ role: 'user', content: [doc] as never }] }, 'm')
    const chunks = await drain(host, streamId)
    expect(opened).toEqual([])
    const error = chunks.find(c => c.type === 'error')
    expect(maskingRefusalOf(error.error.message)).toEqual({ kind: 'undecodable' })
    expect(error.httpStatus ?? error.error.httpStatus).toBe(400)
    expect(classifyProviderConnectivityIssue(error.error.message)).toMatchObject({
      error: 'masking_refused',
      titleKey: 'providerIssue.maskingUndecodable.title',
      summaryKey: 'providerIssue.maskingUndecodable.summary',
      retryable: false,
    })
  })

  it('is sent as it is while masking is off', async () => {
    modelMasking.configure({ enabled: false, rules: RULES })
    const { transport, opened } = recordingTransport()
    const host = new DriverStreamHost(transport)
    const doc = { type: 'document', data: latin1('caf\u00e9'), mimeType: 'text/plain' }
    const { streamId } = host.start(provider(), { messages: [{ role: 'user', content: [doc] as never }] }, 'm')
    await drain(host, streamId)
    expect(opened).toHaveLength(1)
  })
})

describe('the User-Agent outside chat streams', () => {
  it('is sent explicitly and masked while masking is on', async () => {
    modelMasking.configure({ enabled: true, rules: RULES })
    modelMasking.setPresetUserAgentResolver(id => (id === 'p' ? 'AcmeCo-client/1.0' : undefined))
    try {
      const { transport, opened } = recordingTransport()
      await openRawProviderStream(transport, { providerId: 'p', url: 'https://x/models', method: 'GET' })
      expect(opened[0]!.headers['user-agent']).toBe('Northwind-client/1.0')
      await openRawProviderStream(transport, { providerId: 'p', url: 'https://x/models', headers: { 'User-Agent': 'AcmeCo/2' } })
      expect(opened[1]!.headers['User-Agent']).toBe('Northwind/2')
    } finally {
      modelMasking.setPresetUserAgentResolver(() => undefined)
    }
  })

  it('is left to the host while masking is off', async () => {
    modelMasking.configure({ enabled: false, rules: RULES })
    modelMasking.setPresetUserAgentResolver(() => 'AcmeCo-client/1.0')
    try {
      const { transport, opened } = recordingTransport()
      await openRawProviderStream(transport, { providerId: 'p', url: 'https://x/models' })
      expect(opened[0]!.headers['user-agent']).toBeUndefined()
    } finally {
      modelMasking.setPresetUserAgentResolver(() => undefined)
    }
  })

  it('a residual match the masking could not replace still stops the request', async () => {
    modelMasking.configure({ enabled: true, rules: RULES })
    const { transport, opened } = recordingTransport()
    await expect(openRawProviderStream(transport, { providerId: 'p', url: 'https://x/AcmeCo' }))
      .rejects.toBeInstanceOf(MaskingResidualError)
    expect(opened).toEqual([])
  })
})

describe('a masking refusal on the error card', () => {
  it('carries a marker, not English prose, and round-trips', () => {
    for (const refusal of [{ kind: 'residual', rule: 3, where: 'header:user-agent' }, { kind: 'unknown' }, { kind: 'broken' }, { kind: 'undecodable' }] as const) {
      const message = maskingRefusalMessage(refusal)
      expect(message).not.toMatch(/blocked|masking rule/i)
      expect(maskingRefusalOf(`provider_error: ${message}`)).toEqual(refusal)
    }
  })

  it('is classified as a local, non-retryable refusal with catalog keys', () => {
    const issue = classifyProviderConnectivityIssue(maskingRefusalMessage({ kind: 'broken' }))
    expect(issue).toMatchObject({
      error: 'masking_refused',
      titleKey: 'providerIssue.maskingBroken.title',
      summaryKey: 'providerIssue.maskingBroken.summary',
      retryable: false,
    })
    expect(providerErrorSummaryKey({ kind: 'masking_refused', details: maskingRefusalMessage({ kind: 'unknown' }), retryCount: 0 }))
      .toBe('thread.providerMaskingNoRetrySummary')
  })

  it('every key it uses exists in each locale, with the rule and location as parameters', () => {
    const keys = [
      'providerIssue.maskingResidual.summary',
      'providerIssue.maskingUnknown.summary',
      'providerIssue.maskingBroken.summary',
      'providerIssue.maskingUndecodable.title',
      'providerIssue.maskingUndecodable.summary',
      'thread.providerMaskingNoRetrySummary',
      'statusBar.retryKind.masking_refused',
    ] as const
    for (const key of keys) {
      expect(en[key]).toBeTruthy()
      for (const locale of [de, es, fr, ja, ko, zh]) {
        expect(locale[key]).toBeTruthy()
        expect(locale[key]).not.toBe(en[key])
      }
    }
    const text = createTranslate('de')('providerIssue.maskingResidual.summary', { rule: 2, where: 'body', product: 'Velloc' })
    expect(text).toContain('2')
    expect(text).toContain('body')
    expect(en['providerIssue.maskingResidual.summary']).toContain('{rule}')
    expect(en['providerIssue.maskingResidual.summary']).toContain('{where}')
  })
})
