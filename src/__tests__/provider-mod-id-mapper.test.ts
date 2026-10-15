/**
 * Provider mods PM-6b - the whole path: a real provider module in a real mod
 * worker host (MessageChannel, as provider-mod-request-hooks.test.ts), the
 * real `ProviderModRuntime`, the seam `seamForRegistration` builds (with the
 * id mapper), the real `DriverStreamHost` and the real openai-chat codec, and
 * a fake endpoint behind the transport seam that records what was sent.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { BrowserBridgeTransport } from '../browser/bridge/browserBridgeProtocol'
import { registerProviderDriver } from '../models/drivers/driverRegistry'
import { DriverStreamHost } from '../models/drivers/driverStreamHost'
import { createModelProvider } from '../models/drivers/modelProvider'
import { openaiChatDriver } from '../models/drivers/openaiChatDriver'
import { providerRequestSeamFor, registerProviderRequestSeam, resetProviderRequestSeams } from '../models/drivers/providerRequestSeam'
import type { ModWorkerHandle } from '../mods/ModRuntime'
import { installModWorkerHost } from '../mods/ModWorkerHost'
import { ProviderModRuntime, type ProviderModuleRef } from '../mods/provider/ProviderModRuntime'
import { IdMapStores } from '../mods/provider/ids/idMapStore'
import type { ProviderManifest } from '../mods/provider/providerManifest'
import { seamForRegistration } from '../mods/provider/providerSeamWiring'
import { MemorySessionStores } from '../mods/provider/nouns/sessionStore'

registerProviderDriver(openaiChatDriver)

const ID = 'mod.acme.zen'
const BASE = 'https://api.zen.example/v1'
const KEY = await crypto.subtle.importKey('raw', new Uint8Array(32).fill(9), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])

const enc = new TextEncoder()

/** An SSE reply in which the model calls a tool under `callId`. */
const toolReply = (callId: string) =>
  enc.encode(
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: callId, function: { name: 'Read', arguments: '{}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`,
  )

function endpoint(replies: Array<Uint8Array | { status: number; text: string }>) {
  const opens: Array<Record<string, any>> = []
  const bodies = new Map<string, Uint8Array>()
  const transport: BrowserBridgeTransport = {
    async request(req: any) {
      const action = req.route.action
      if (action === 'rawStreamOpen') {
        opens.push(req.payload)
        const streamId = `raw-${opens.length}`
        const reply = replies.shift() ?? toolReply('toolu_unused')
        const status = reply instanceof Uint8Array ? 200 : reply.status
        bodies.set(streamId, reply instanceof Uint8Array ? reply : enc.encode(reply.text))
        return { ok: true, result: { streamId, status, statusText: 'S', finalUrl: req.payload.url, headers: {} } } as any
      }
      if (action === 'rawStreamCancel') return { ok: true, result: { ok: true } } as any
      const body = bodies.get(req.payload.streamId) ?? new Uint8Array()
      bodies.set(req.payload.streamId, new Uint8Array())
      return { ok: true, result: { done: true, chunk: body } } as any
    },
  }
  return { transport, opens }
}

let uniqueLoad = 0
const openPorts: MessagePort[] = []
const runtimes: ProviderModRuntime[] = []
afterEach(() => {
  resetProviderRequestSeams()
  for (const runtime of runtimes.splice(0)) runtime.dispose()
  for (const port of openPorts.splice(0)) port.close()
})

function runtimeFor(source: string) {
  const ref: ProviderModuleRef = { plugin: 'acme', path: 'acme/providers/zen.js', providers: [ID] }
  const runtime = new ProviderModRuntime({
    readModule: async () => `${source}\n// load ${++uniqueLoad}`,
    openWorker: async () => {
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
  })
  runtimes.push(runtime)
  runtime.register('acme', [ref])
  return runtime
}

/** A module with one kind on the hook: it counts its own calls and returns them in the ids. */
const ZEN = `
  let calls = 0
  export function register(on) {
    on('provider.ids', ($, e) => {
      calls += 1
      return e.ids.map(item => 'zen_' + item.value.replace('toolu_', '') + '_c' + calls)
    })
    on('provider.request', ($, e) => ({
      headers: { 'x-session': String(e.context.ids && e.context.ids.session), 'x-request': String(e.context.ids && e.context.ids.request) },
    }))
  }
`

const MANIFEST = {
  ids: {
    toolCall: { derive: 'hook' },
    session: { derive: 'hmac', prefix: 'ses_', template: '{hex:12}{base62:14}' },
    request: { derive: 'random', prefix: 'msg_', template: '{time:hex:12}{base62:14}' },
  },
} as unknown as ProviderManifest

function install(source: string, manifest: ProviderManifest = MANIFEST) {
  const runtime = runtimeFor(source)
  const stores = new IdMapStores(new MemorySessionStores(), { flushDelayMs: 1 })
  registerProviderRequestSeam(
    ID,
    seamForRegistration({ providerId: ID, manifest, runtime }, () => {}, { idKey: async () => KEY, stores }),
  )
  return { runtime, stores }
}

const history = (...ids: string[]) =>
  ({
    messages: [
      { role: 'user', content: 'go' },
      ...ids.flatMap(id => [
        { role: 'assistant', content: [{ type: 'tool-call', toolCallId: id, toolName: 'Read', args: { path: id } }] },
        { role: 'user', content: [{ type: 'tool-result', toolCallId: id, toolName: 'Read', result: `out ${id}` }] },
      ]),
    ],
    maxOutputTokens: 100,
  }) as Record<string, unknown>

async function stream(transport: BrowserBridgeTransport, payload: unknown, sessionId: string | undefined = 'sess-9') {
  const host = new DriverStreamHost(transport)
  const provider = createModelProvider({ id: ID, format: 'openai-chat', baseUrl: BASE })
  const { streamId } = host.start(
    provider,
    { ...(payload as object), requestContext: { ...(sessionId ? { sessionId } : {}), purpose: 'turn', querySource: 'sdk' } } as never,
    'm-1',
  )
  const all: any[] = []
  for (let i = 0; i < 50; i += 1) {
    const read = await host.read(streamId, 5000)
    all.push(...read.chunks)
    if (read.done) return all
  }
  throw new Error('stream never finished')
}

const bodyOf = (open: Record<string, any>) => JSON.parse(new TextDecoder().decode(open.body))
const wireToolIds = (open: Record<string, any>): string[] =>
  bodyOf(open).messages.flatMap((m: any) => [...(m.tool_calls ?? []).map((c: any) => c.id), ...(m.tool_call_id ? [m.tool_call_id] : [])])
const errorOf = (chunks: any[]) => chunks.find(c => c.type === 'error')?.error

describe('the id mapper in the whole request path', () => {
  it('maps through the module\'s provider.ids once, reuses it on the next request with no worker call, and asks only for the new id', async () => {
    install(ZEN)
    const { transport, opens } = endpoint([toolReply('toolu_9'), toolReply('toolu_10'), toolReply('toolu_11')])

    expect(errorOf(await stream(transport, history('toolu_1')))).toBeUndefined()
    expect(wireToolIds(opens[0]!)).toEqual(['zen_1_c1', 'zen_1_c1'])

    // The same history plus one more turn: the old id is the cache's (c1), the new id is the one new ask (c2).
    await stream(transport, history('toolu_1', 'toolu_2'))
    expect(wireToolIds(opens[1]!)).toEqual(['zen_1_c1', 'zen_1_c1', 'zen_2_c2', 'zen_2_c2'])

    // The very same request again: identical ids on the wire, and the module was not asked.
    await stream(transport, history('toolu_1', 'toolu_2'))
    expect(wireToolIds(opens[2]!)).toEqual(wireToolIds(opens[1]!))
    // Nothing else in the body changed between the second and third request.
    expect(opens[2]!.body).toEqual(opens[1]!.body)
  })

  it('context.ids reaches provider.request: a session id stable across requests, a request id fresh for each', async () => {
    install(ZEN)
    const { transport, opens } = endpoint([toolReply('a'), toolReply('b')])
    await stream(transport, history('toolu_1'))
    await stream(transport, history('toolu_1'))
    const [a, b] = opens as [Record<string, any>, Record<string, any>]
    expect(a.headers['x-session']).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
    expect(b.headers['x-session']).toBe(a.headers['x-session'])
    expect(a.headers['x-request']).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
    expect(b.headers['x-request']).not.toBe(a.headers['x-request'])
    // Another session: another session id.
    const { transport: t2, opens: o2 } = endpoint([toolReply('c')])
    await stream(t2, history('toolu_1'), 'sess-other')
    expect(o2[0]!.headers['x-session']).not.toBe(a.headers['x-session'])
  })

  it('the model\'s echo of a mapped id comes back as the engine\'s own', async () => {
    install(ZEN)
    const { transport } = endpoint([toolReply('zen_1_c1'), toolReply('toolu_brand_new')])
    const echoed = JSON.stringify(await stream(transport, history('toolu_1')))
    expect(echoed).toContain('toolu_1')
    expect(echoed).not.toContain('zen_1_c1')
    // An id the map does not know passes through unchanged.
    const fresh = JSON.stringify(await stream(transport, history('toolu_1')))
    expect(fresh).toContain('toolu_brand_new')
  })

  it('a request hook that replaces the system prompt: the body is built again and its ids are the same', async () => {
    const runtime = runtimeFor(ZEN.replace('headers: {', "system: 'rewritten', headers: {"))
    const stores = new IdMapStores(new MemorySessionStores(), { flushDelayMs: 1 })
    registerProviderRequestSeam(
      ID,
      seamForRegistration(
        { providerId: ID, manifest: { ...MANIFEST, requestNeeds: ['system'] } as ProviderManifest, runtime },
        () => {},
        { idKey: async () => KEY, stores },
      ),
    )
    const { transport, opens } = endpoint([])
    expect(errorOf(await stream(transport, { ...history('toolu_1'), systemPrompt: 'original' }))).toBeUndefined()
    expect(JSON.stringify(bodyOf(opens[0]!))).toContain('rewritten')
    // The rebuilt body carries the same mapped ids, from the cache (c1 = one ask only).
    expect(wireToolIds(opens[0]!)).toEqual(['zen_1_c1', 'zen_1_c1'])
    expect(opens[0]!.headers['x-session']).toMatch(/^ses_/)
  })

  it('a re-send after retry keeps the mapped ids and gets a new request id in context.ids', async () => {
    const runtime = runtimeFor(`
      let calls = 0
      export function register(on) {
        on('provider.ids', ($, e) => { calls += 1; return e.ids.map(i => 'zen_' + i.value + '_c' + calls) })
        on('provider.request', ($, e) => ({ headers: { 'x-request': e.context.ids.request } }))
        on('provider.retry', ($, e) => e.attempt === 1 ? { retry: { headers: { 'x-retry': 'once' } } } : undefined)
        on('provider.sign', ($, e) => ({ headers: { 'x-sign-request': e.context.ids.request } }))
      }
    `)
    const stores = new IdMapStores(new MemorySessionStores(), { flushDelayMs: 1 })
    registerProviderRequestSeam(
      ID,
      seamForRegistration({ providerId: ID, manifest: MANIFEST, runtime }, () => {}, { idKey: async () => KEY, stores }),
    )
    const { transport, opens } = endpoint([{ status: 400, text: 'try again' }, toolReply('x')])
    expect(errorOf(await stream(transport, history('toolu_1')))).toBeUndefined()
    expect(opens).toHaveLength(2)
    expect(wireToolIds(opens[1]!)).toEqual(wireToolIds(opens[0]!))
    // `sign` sees each attempt's own context: the re-send has a new request id (made by the rule).
    expect(opens[0]!.headers['x-sign-request']).toBe(opens[0]!.headers['x-request'])
    expect(opens[1]!.headers['x-sign-request']).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
    expect(opens[1]!.headers['x-sign-request']).not.toBe(opens[0]!.headers['x-sign-request'])
  })

  it('a hook that is not there fails closed: nothing is sent', async () => {
    install(`export function register(on) { on('provider.request', () => ({})) }`)
    const { transport, opens } = endpoint([])
    const chunks = await stream(transport, history('toolu_1'))
    expect(opens).toHaveLength(0)
    expect(errorOf(chunks).message).toMatch(/ids hook of the provider mod.acme.zen failed, so the request was not sent.*no provider\.ids hook/)
  })

  it('a hook that answers the wrong number of ids fails closed', async () => {
    install(`export function register(on) { on('provider.ids', () => ['only-one']) }`)
    const { transport, opens } = endpoint([])
    const chunks = await stream(transport, history('toolu_1', 'toolu_2'))
    expect(opens).toHaveLength(0)
    expect(errorOf(chunks).message).toMatch(/ids hook of the provider mod.acme.zen failed.*answered 1 ids for 2 asked/)
  })

  it('a hook that throws fails closed', async () => {
    install(`export function register(on) { on('provider.ids', () => { throw new Error('vendor down') }) }`)
    const { transport, opens } = endpoint([])
    const chunks = await stream(transport, history('toolu_1'))
    expect(opens).toHaveLength(0)
    expect(errorOf(chunks).message).toMatch(/ids hook of the provider mod.acme.zen failed/)
  })

  it('a hook that never answers fails closed inside its own budget', async () => {
    const runtime = runtimeFor(`export function register(on) { on('provider.ids', () => new Promise(() => {})) }`)
    const stores = new IdMapStores(new MemorySessionStores(), { flushDelayMs: 1 })
    registerProviderRequestSeam(
      ID,
      seamForRegistration({ providerId: ID, manifest: MANIFEST, runtime }, () => {}, { idKey: async () => KEY, stores }),
    )
    const { transport, opens } = endpoint([])
    const started = Date.now()
    const chunks = await stream(transport, history('toolu_1'))
    expect(opens).toHaveLength(0)
    expect(errorOf(chunks).message).toMatch(/ids hook of the provider mod.acme.zen failed/)
    // provider.ids has a 1 s budget.
    expect(Date.now() - started).toBeLessThan(4_000)
  }, 10_000)

  it('rules in process never ask the module for ids', async () => {
    const { runtime } = install(`export function register(on) { on('provider.ids', () => { throw new Error('must not be asked') }) }`, {
      ids: { toolCall: { derive: 'hmac', prefix: 'call_', length: 20 } },
    } as unknown as ProviderManifest)
    const { transport, opens } = endpoint([])
    const chunks = await stream(transport, history('toolu_1'))
    expect(errorOf(chunks)).toBeUndefined()
    const ids = wireToolIds(opens[0]!)
    expect(ids[0]).toBe(ids[1])
    expect(ids[0]).toMatch(/^call_[0-9A-Za-z]{20}$/)
    expect(runtime.hasHook(ID, 'provider.ids')).toBe(true)
  })
})

describe('wiring', () => {
  const fakeRuntime = { hasHook: () => false, whenLoaded: async () => {}, call: async () => ({ raised: false as const }) } as unknown as ProviderModRuntime
  const reg = (manifest: Partial<ProviderManifest>) => ({ providerId: ID, manifest: manifest as ProviderManifest, runtime: fakeRuntime })
  const ids = { idKey: async () => KEY, stores: new IdMapStores(undefined) }

  it('a provider that states no id rules has no mapper', () => {
    expect(seamForRegistration(reg({}), () => {}, ids).ids).toBeUndefined()
    expect(seamForRegistration(reg({ ids: {} }), () => {}, ids).ids).toBeUndefined()
    expect(providerRequestSeamFor(ID)).toBeUndefined()
  })

  it('a provider with rules gets one', () => {
    expect(seamForRegistration(reg({ ids: { toolCall: { derive: 'hmac' } } }), () => {}, ids).ids).toBeDefined()
  })

  it('rules that cannot run (no id key store here) fail every request closed, said once', async () => {
    const lines: string[] = []
    const seam = seamForRegistration(reg({ ids: { toolCall: { derive: 'hmac' } } }), line => lines.push(line))
    expect(seam.ids).toBeUndefined()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/id rules cannot run in this realm/)
    await expect(Promise.resolve().then(() => seam.request!({} as never))).rejects.toThrow(/could not be attached/)
  })
})
