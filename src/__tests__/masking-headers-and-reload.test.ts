/**
 * Model egress masking (F-39): header and query values are masked, not only
 * refused, and an edit of the settings section applies to the next stream.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { BrowserBridgeTransport } from '../browser/bridge/browserBridgeProtocol'
import { openRawProviderStream } from '../browser/bridge/rawProviderStream'
import '../models/drivers/builtinDrivers'
import { DriverStreamHost } from '../models/drivers/driverStreamHost'
import { createModelProvider } from '../models/drivers/modelProvider'
import { registerProviderDriver } from '../models/drivers/driverRegistry'
import type { DriverStreamEvent, ProviderDriver } from '../models/drivers/driverTypes'
import { registerProviderRequestSeam, resetProviderRequestSeams } from '../models/drivers/providerRequestSeam'
import { ModelMaskingHolder, modelMasking } from '../models/masking/maskingHolder'
import { fakeProviderRequestSeam } from './_helpers/fakeProviderRequestSeam'
import type { NexusModelMaskingSettings } from '../settings/settingsTypes'

const RULES = [{ match: 'acmeco', alias: 'northwind' }]

const codec: ProviderDriver = {
  id: 'masking-hdr-echo',
  auth: {},
  buildRequest: (payload, context) => ({
    url: `${context.baseUrl}/v1/chat`,
    headers: {
      'content-type': 'application/json',
      'http-referer': 'https://acmeco.app',
      authorization: 'Bearer {{secret:acmeco_key}}',
    },
    queryParams: { app: 'acmeco' },
    body: new TextEncoder().encode(JSON.stringify(payload)),
  }),
  createDecoder: () => ({ push: () => [], end: (): DriverStreamEvent[] => [{ type: 'finish', finishReason: 'stop' }] }),
  errorFromResponse: ({ status }) => ({ type: 'error', message: `HTTP ${status}`, httpStatus: status }),
}
registerProviderDriver(codec)

type Opened = { headers: Record<string, string>; queryParams?: Record<string, string>; body: string }

function recordingTransport() {
  const opened: Opened[] = []
  const transport: BrowserBridgeTransport = {
    async request(req: any) {
      if (req.route.action === 'rawStreamOpen') {
        opened.push({ headers: req.payload.headers ?? {}, queryParams: req.payload.queryParams, body: new TextDecoder().decode(req.payload.body) })
        return { ok: true, result: { streamId: 'r', status: 200, statusText: '', finalUrl: 'u', headers: {} } } as any
      }
      if (req.route.action === 'rawStreamCancel') return { ok: true, result: { ok: true } } as any
      return { ok: true, result: { done: true, chunk: new Uint8Array(0) } } as any
    },
  }
  return { transport, opened }
}

async function run(content: string) {
  const { transport, opened } = recordingTransport()
  const host = new DriverStreamHost(transport)
  const provider = createModelProvider({ id: 'masking-hdr', format: 'masking-hdr-echo', baseUrl: 'https://llm.example.com' })
  const { streamId } = host.start(provider, { messages: [{ role: 'user', content }] }, 'm')
  const chunks: any[] = []
  for (let i = 0; i < 200; i += 1) {
    const read = await host.read(streamId, 1000)
    chunks.push(...read.chunks)
    if (read.done) return { opened, chunks }
  }
  throw new Error('stream never finished')
}

const errorsOf = (chunks: any[]) => chunks.filter(chunk => chunk.type === 'error')

afterEach(() => {
  modelMasking.resetForTest()
  resetProviderRequestSeams()
})

describe('header and query values', () => {
  it('a provider header holding a match is masked and sent', async () => {
    modelMasking.configure({ enabled: true, rules: RULES })
    const { opened, chunks } = await run('hello acmeco')
    expect(errorsOf(chunks)).toEqual([])
    expect(opened).toHaveLength(1)
    expect(opened[0]!.headers['http-referer']).toBe('https://northwind.app')
    expect(opened[0]!.queryParams).toEqual({ app: 'northwind' })
    expect(opened[0]!.body).toContain('hello northwind')
  })

  it('keeps host placeholders as written', async () => {
    modelMasking.configure({ enabled: true, rules: RULES })
    const { opened } = await run('hi')
    expect(opened[0]!.headers.authorization).toBe('Bearer {{secret:acmeco_key}}')
  })

  it('are masked on requests outside chat streams', async () => {
    modelMasking.configure({ enabled: true, rules: RULES })
    const { transport, opened } = recordingTransport()
    await openRawProviderStream(transport, {
      providerId: 'p',
      url: 'https://x/models',
      method: 'GET',
      headers: { 'x-title': 'acmeco' },
      queryParams: { q: 'acmeco' },
    })
    expect(opened[0]!.headers['x-title']).toBe('northwind')
    expect(opened[0]!.queryParams).toEqual({ q: 'northwind' })
  })
})

describe('a settings edit', () => {
  function loadFrom(section: { current: NexusModelMaskingSettings | undefined }) {
    return modelMasking.load(async () => section.current)
  }

  it('removing the section turns masking off for the next stream', async () => {
    const section = { current: { enabled: true, rules: RULES } as NexusModelMaskingSettings | undefined }
    await loadFrom(section)
    expect(modelMasking.status().state).toBe('active')
    section.current = undefined
    const { opened, chunks } = await run('hello acmeco')
    expect(errorsOf(chunks)).toEqual([])
    expect(modelMasking.status().state).toBe('off')
    expect(opened[0]!.headers['http-referer']).toBe('https://acmeco.app')
    expect(opened[0]!.body).toContain('hello acmeco')
  })

  it('turning masking on applies to the next stream', async () => {
    const section = { current: undefined as NexusModelMaskingSettings | undefined }
    await loadFrom(section)
    expect(modelMasking.status().state).toBe('off')
    section.current = { enabled: true, rules: RULES }
    const { opened } = await run('hello acmeco')
    expect(opened[0]!.headers['http-referer']).toBe('https://northwind.app')
  })

  it('a failed re-read keeps the state it had', async () => {
    let fail = false
    await modelMasking.load(async () => {
      if (fail) throw new Error('disk gone')
      return { enabled: true, rules: RULES }
    })
    fail = true
    const { opened } = await run('hello acmeco')
    expect(modelMasking.status().state).toBe('active')
    expect(opened[0]!.headers['http-referer']).toBe('https://northwind.app')
  })
})

describe('a provider seam', () => {
  it('sees the masked values, and what it signs is sent unchanged', async () => {
    modelMasking.configure({ enabled: true, rules: RULES })
    const fake = fakeProviderRequestSeam({
      request: undefined,
      sign: e => ({ headers: { 'x-signature': `signed:${e.headers['http-referer']}` } }),
    })
    registerProviderRequestSeam('masking-hdr', fake.seam)
    const { opened, chunks } = await run('hello acmeco')
    expect(errorsOf(chunks)).toEqual([])
    expect(fake.calls.request[0]!.headers['http-referer']).toBe('https://northwind.app')
    expect(fake.calls.sign[0]!.headers['http-referer']).toBe('https://northwind.app')
    expect(opened[0]!.headers['http-referer']).toBe('https://northwind.app')
    expect(opened[0]!.headers['x-signature']).toBe('signed:https://northwind.app')
  })
})

describe('refresh', () => {
  function deferredReader(first: NexusModelMaskingSettings | undefined) {
    let calls = 0
    let release: ((settings: NexusModelMaskingSettings | undefined) => void) | undefined
    const read = () => {
      calls += 1
      if (calls === 1) return Promise.resolve(first)
      return new Promise<NexusModelMaskingSettings | undefined>(resolve => { release = resolve })
    }
    return { read, calls: () => calls, release: (s: NexusModelMaskingSettings | undefined) => release!(s) }
  }

  it('returns when the stream is cancelled during a slow read', async () => {
    const holder = new ModelMaskingHolder()
    const reader = deferredReader(undefined)
    await holder.load(reader.read)
    const abort = new AbortController()
    const refreshed = holder.refresh(abort.signal, 60_000)
    abort.abort()
    await expect(Promise.race([refreshed.then(() => 'returned'), new Promise(r => setTimeout(() => r('waiting'), 200))]))
      .resolves.toBe('returned')
  })

  it('streams that start together share one read', async () => {
    const holder = new ModelMaskingHolder()
    const reader = deferredReader(undefined)
    await holder.load(reader.read)
    const both = Promise.all([holder.refresh(), holder.refresh()])
    reader.release({ enabled: true, rules: RULES })
    await both
    expect(reader.calls()).toBe(2)
    expect(holder.status().state).toBe('active')
  })

  it('a read slower than the wait still applies once it lands', async () => {
    const holder = new ModelMaskingHolder()
    const reader = deferredReader(undefined)
    await holder.load(reader.read)
    await holder.refresh(undefined, 10)
    expect(holder.status().state).toBe('off')
    reader.release({ enabled: true, rules: RULES })
    await new Promise(r => setTimeout(r, 0))
    expect(holder.status().state).toBe('active')
  })

  it('a slow read is dropped when /masking changed the section meanwhile', async () => {
    const holder = new ModelMaskingHolder()
    const reader = deferredReader({ enabled: true, rules: RULES })
    await holder.load(reader.read)
    await holder.refresh(undefined, 10)
    holder.configure({ enabled: false, rules: RULES })
    reader.release({ enabled: true, rules: RULES })
    await new Promise(r => setTimeout(r, 0))
    expect(holder.status().state).toBe('off')
  })
})
