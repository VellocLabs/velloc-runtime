/**
 * Provider mods PM-6 — the whole path: a real provider module in a real mod
 * worker host (MessageChannel, as provider-mod-runtime.test.ts), the real
 * `ProviderModRuntime`, the adapter's seam plugged into the real
 * `DriverStreamHost`, and a fake endpoint behind the transport seam that
 * records what was actually sent.
 */
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type { BrowserBridgeTransport } from '../browser/bridge/browserBridgeProtocol'
import { registerProviderDriver } from '../models/drivers/driverRegistry'
import { DriverStreamHost } from '../models/drivers/driverStreamHost'
import { buildSystemInstruction } from '../models/drivers/hostCallOptions'
import { createModelProvider } from '../models/drivers/modelProvider'
import type { DriverStreamEvent, ProviderDriver } from '../models/drivers/driverTypes'
import { registerProviderRequestSeam, resetProviderRequestSeams } from '../models/drivers/providerRequestSeam'
import type { ModWorkerHandle } from '../mods/ModRuntime'
import { installModWorkerHost } from '../mods/ModWorkerHost'
import {
  ProviderModRuntime,
  type ProviderModuleRef,
} from '../mods/provider/ProviderModRuntime'
import { createProviderSeam } from '../mods/provider/providerSeamAdapter'

const ID = 'mod.acme.zen'
const BASE = 'https://api.zen.example'
const IMAGE_DATA = 'QUJD'.repeat(1_000)
const imagePart = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: IMAGE_DATA } }

const codec: ProviderDriver = {
  id: 'zen-json',
  auth: { headers: { authorization: 'Bearer {{secret:api_key}}' } },
  buildRequest: (payload, context) => ({
    url: `${context.baseUrl}/v1/chat`,
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer {{secret:api_key}}' },
    body: new TextEncoder().encode(
      JSON.stringify({
        model: context.model,
        system: buildSystemInstruction(payload),
        messages: [{ role: 'user', content: [imagePart, { type: 'text', text: 'look' }] }],
        meta: { tags: ['a'] },
      }),
    ),
  }),
  createDecoder: () => {
    const decoder = new TextDecoder()
    let buffered = ''
    const drain = (): DriverStreamEvent[] => {
      const lines = buffered.split('\n')
      buffered = lines.pop() ?? ''
      return lines.filter(Boolean).map(line => JSON.parse(line) as DriverStreamEvent)
    }
    return {
      push: bytes => {
        buffered += decoder.decode(bytes, { stream: true })
        return drain()
      },
      end: () => {
        buffered += '\n'
        return drain()
      },
    }
  },
  errorFromResponse: ({ status, bodyText }) => ({ type: 'error', message: `API Error: ${status} ${bodyText}`, httpStatus: status }),
}
registerProviderDriver(codec)

const lines = (events: DriverStreamEvent[]) => new TextEncoder().encode(events.map(e => JSON.stringify(e)).join('\n') + '\n')
const OK_BODY = lines([{ type: 'text_delta', text: 'hi' }, { type: 'finish', finishReason: 'stop' }])

/** The fake endpoint: each open takes the next scripted reply and is recorded. */
function endpoint(replies: Array<{ status: number; text?: string }>) {
  const opens: Array<Record<string, any>> = []
  const bodies = new Map<string, Uint8Array>()
  const transport: BrowserBridgeTransport = {
    async request(req: any) {
      const action = req.route.action
      if (action === 'rawStreamOpen') {
        opens.push(req.payload)
        const reply = replies.shift() ?? { status: 200 }
        const streamId = `raw-${opens.length}`
        bodies.set(streamId, reply.text !== undefined ? new TextEncoder().encode(reply.text) : OK_BODY)
        return {
          ok: true,
          result: { streamId, status: reply.status, statusText: 'S', finalUrl: req.payload.url, headers: {} },
        } as any
      }
      if (action === 'rawStreamCancel') return { ok: true, result: { ok: true } } as any
      const body = bodies.get(req.payload.streamId) ?? new Uint8Array()
      bodies.set(req.payload.streamId, new Uint8Array())
      return { ok: true, result: { done: true, chunk: body } } as any
    },
  }
  return { transport, opens }
}

// ── the runtime over a real worker host ─────────────────────────────────────

let uniqueLoad = 0
const openPorts: MessagePort[] = []
const runtimes: ProviderModRuntime[] = []
afterEach(() => {
  resetProviderRequestSeams()
  for (const runtime of runtimes.splice(0)) runtime.dispose()
  for (const port of openPorts.splice(0)) port.close()
})

function runtimeFor(source: string, options: { budgetMs?: number } = {}) {
  let opened = 0
  const ref: ProviderModuleRef = { plugin: 'acme', path: 'acme/providers/zen.js', providers: [ID] }
  const runtime = new ProviderModRuntime({
    readModule: async () => `${source}\n// load ${++uniqueLoad}`,
    openWorker: async () => {
      opened += 1
      const channel = new MessageChannel()
      openPorts.push(channel.port1, channel.port2)
      installModWorkerHost(channel.port2)
      let settle!: (closed: { reason: 'closed' | 'crashed'; message?: string }) => void
      const closed = new Promise<{ reason: 'closed' | 'crashed'; message?: string }>(resolve => {
        settle = resolve
      })
      const worker: ModWorkerHandle = { port: channel.port1, closed, close: () => settle({ reason: 'closed' }) }
      return worker
    },
    window: { available: () => true, attached: async () => {} },
    report: () => {},
    respawnBackoffMs: [10],
    ...options,
  })
  runtimes.push(runtime)
  runtime.register('acme', [ref])
  return { runtime, opened: () => opened }
}

async function drain(host: DriverStreamHost, streamId: string) {
  const all: any[] = []
  for (let i = 0; i < 50; i += 1) {
    const read = await host.read(streamId, 5000)
    all.push(...read.chunks)
    if (read.done) return all
  }
  throw new Error('stream never finished')
}

async function stream(transport: BrowserBridgeTransport, extra: Record<string, unknown> = {}) {
  const host = new DriverStreamHost(transport)
  const provider = createModelProvider({ id: ID, format: 'zen-json', baseUrl: BASE })
  const { streamId } = host.start(
    provider,
    {
      messages: [{ role: 'user', content: 'x' }],
      systemPrompt: 'You are terse.',
      maxOutputTokens: 1000,
      thinkingTier: 'high',
      requestContext: { sessionId: 'sess-42', purpose: 'turn', querySource: 'sdk' },
      ...extra,
    } as never,
    'm-1',
  )
  return drain(host, streamId)
}

const bodyOf = (open: Record<string, any>) => JSON.parse(new TextDecoder().decode(open.body))
const sha = (open: Record<string, any>) => createHash('sha256').update(Buffer.from(open.body)).digest('hex')
const errorOf = (chunks: any[]) => chunks.find(c => c.type === 'error')?.error

const ZEN = `
  export function register(on) {
    on('provider.request', ($, e) => ({
      headers: {
        'x-client': 'acme/1.4',
        'x-request-id': 'msg_' + e.context.requestId,
        'x-session': 'ses_' + e.context.sessionId,
        'x-effort': String(e.effort),
        'x-format': e.format,
      },
      system: e.system + '\\n\\n[acme]',
    }))
    on('provider.sign', ($, e) => ({ headers: { 'x-sign': 'v1:' + e.bodySha256 + ':' + e.bodyLength, 'x-sign-attempt': e.context.attempt + ':' + e.context.requestId } }))
    on('provider.retry', ($, e) =>
      e.status === 400 && e.bodyText.includes('encrypted') && e.attempt === 1
        ? { retry: { headers: { 'x-retry': 'once' }, patch: [{ op: 'remove', path: '/meta' }] } }
        : undefined)
  }
`

describe('provider request hooks — a real module in a real worker', () => {
  it('headers, a request-id header, a rewritten system prompt, a signature, and one retry after a 400', async () => {
    const { runtime, opened } = runtimeFor(ZEN)
    registerProviderRequestSeam(ID, createProviderSeam(runtime, ID, { requestNeeds: ['system'] }))
    const { transport, opens } = endpoint([{ status: 400, text: 'invalid encrypted_content' }, { status: 200 }])

    const chunks = await stream(transport)

    expect(errorOf(chunks)).toBeUndefined()
    expect(chunks.map(c => c.type)).toContain('message_stop')
    expect(opened()).toBe(1)
    expect(opens).toHaveLength(2)

    const [first, second] = opens as [Record<string, any>, Record<string, any>]
    expect(first.headers).toMatchObject({
      'x-client': 'acme/1.4',
      'x-session': 'ses_sess-42',
      'x-effort': 'high',
      'x-format': 'zen-json',
      authorization: 'Bearer {{secret:api_key}}',
    })
    expect(first.headers['x-request-id']).toMatch(/^msg_[0-9a-f-]{36}$/)
    // The system prompt was edited under `requestNeeds: ['system']`.
    expect(bodyOf(first).system).toBe('You are terse.\n\n[acme]')
    expect(bodyOf(first).meta).toEqual({ tags: ['a'] })
    // Signed over the final bytes, after the rewrite.
    expect(first.headers['x-sign']).toBe(`v1:${sha(first)}:${first.body.byteLength}`)

    // The retry: its header, its patch, signed afresh, a fresh request id.
    expect(second.headers['x-retry']).toBe('once')
    expect(bodyOf(second)).not.toHaveProperty('meta')
    expect(bodyOf(second).system).toBe('You are terse.\n\n[acme]')
    expect(second.headers['x-sign']).toBe(`v1:${sha(second)}:${second.body.byteLength}`)
    expect(second.headers['x-sign']).not.toBe(first.headers['x-sign'])
    // `request` ran once (its headers carry over); the re-send is a new
    // attempt with a new request id, which is what `sign` sees.
    expect(second.headers['x-request-id']).toBe(first.headers['x-request-id'])
    expect(first.headers['x-sign-attempt']).toMatch(/^1:/)
    expect(second.headers['x-sign-attempt']).toMatch(/^2:/)
    expect(second.headers['x-sign-attempt'].slice(2)).not.toBe(first.headers['x-sign-attempt'].slice(2))
    // The image part was never touched.
    expect(bodyOf(second).messages[0].content[0]).toEqual(imagePart)
  })

  it('a second refusal, or an unwanted status, is the engine\'s: the module answers nothing', async () => {
    const { runtime } = runtimeFor(ZEN)
    registerProviderRequestSeam(ID, createProviderSeam(runtime, ID, { requestNeeds: ['system'] }))
    const { transport, opens } = endpoint([{ status: 401, text: 'bad key' }])
    const chunks = await stream(transport)
    expect(opens).toHaveLength(1)
    expect(errorOf(chunks)).toMatchObject({ httpStatus: 401, message: 'API Error: 401 bad key' })
  })

  it('a module with no sign hook: nothing is signed, and the request goes out with the rest', async () => {
    const { runtime } = runtimeFor(`
      export function register(on) {
        on('provider.request', ($, e) => ({ headers: { 'x-only': '1' } }))
      }
    `)
    const seam = createProviderSeam(runtime, ID)
    registerProviderRequestSeam(ID, seam)
    const { transport, opens } = endpoint([])
    await stream(transport)
    expect(opens[0]!.headers['x-only']).toBe('1')
    expect(opens[0]!.headers).not.toHaveProperty('x-sign')
    // Loaded now: the module's hooks are known, so the absent ones are not defined.
    expect(runtime.hasHook(ID, 'provider.sign')).toBe(false)
    expect(seam.sign).toBeUndefined()
    expect(seam.retry).toBeUndefined()
    expect(seam.request).toBeTypeOf('function')
  })

  it("the whole body crosses with its image held; signNeeds 'body' brings the bytes", async () => {
    const { runtime } = runtimeFor(`
      export function register(on) {
        on('provider.request', ($, e) => {
          const image = e.body.messages[0].content[0]
          return {
            headers: { 'x-image': image.kind + ':' + image.bytes + ':' + (JSON.stringify(e.body).includes('QUJD') ? 'LEAK' : 'held') },
            patch: [{ op: 'set', path: '/meta/seen', value: true }],
          }
        })
        on('provider.sign', ($, e) => ({ headers: { 'x-sign-len': e.body.byteLength + '/' + e.bodyLength } }))
      }
    `)
    registerProviderRequestSeam(ID, createProviderSeam(runtime, ID, { requestNeeds: ['body'], signNeeds: 'body' }))
    const { transport, opens } = endpoint([])
    const chunks = await stream(transport)
    expect(errorOf(chunks)).toBeUndefined()
    const open = opens[0]!
    expect(open.headers['x-image']).toBe('image:3000:held')
    const sent = bodyOf(open)
    expect(sent.meta).toEqual({ tags: ['a'], seen: true })
    expect(sent.messages[0].content[0]).toEqual(imagePart)
    expect(open.headers['x-sign-len']).toBe(`${open.body.byteLength}/${open.body.byteLength}`)
  })

  it('a module that answers a placeholder it was never given: the rewrite is refused, nothing is sent', async () => {
    const { runtime } = runtimeFor(`
      export function register(on) {
        on('provider.request', () => ({ patch: [{ op: 'set', path: '/messages/0/content/0', value: { kind: 'image', bytes: 1, ref: 'b9' } }] }))
      }
    `)
    registerProviderRequestSeam(ID, createProviderSeam(runtime, ID, { requestNeeds: ['body'] }))
    const { transport, opens } = endpoint([])
    const chunks = await stream(transport)
    expect(opens).toHaveLength(0)
    expect(errorOf(chunks).message).toMatch(/request hook of the provider mod.acme.zen failed.*not one this request gave/)
  })

  it('a module that cannot load fails closed — the request is not sent', async () => {
    const { runtime } = runtimeFor(`
      export function register(on) {
        throw new Error('boom at load')
      }
    `)
    registerProviderRequestSeam(ID, createProviderSeam(runtime, ID))
    const { transport, opens } = endpoint([])
    const chunks = await stream(transport)
    expect(opens).toHaveLength(0)
    expect(errorOf(chunks).message).toMatch(/hook of the provider mod.acme.zen failed, so the request was not sent/)
  })

  it('a request hook that never answers fails closed inside its own budget, the cold start excluded', async () => {
    // A short budget on both counts (the runtime's own and the seam's).
    const { runtime } = runtimeFor(`
      export function register(on) {
        on('provider.request', () => new Promise(() => {}))
      }
    `, { budgetMs: 60 })
    const seam = createProviderSeam(runtime, ID)
    seam.budgetMs = 80
    registerProviderRequestSeam(ID, seam)
    const { transport, opens } = endpoint([])
    const chunks = await stream(transport)
    expect(opens).toHaveLength(0)
    expect(errorOf(chunks).message).toContain('The request hook of the provider mod.acme.zen failed')
  })
})
