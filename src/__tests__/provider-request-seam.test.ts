import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  BridgeModelRequestContext,
  BrowserBridgeTransport,
} from '../browser/bridge/browserBridgeProtocol'
import { runBlockingCall } from '../models/drivers/blockingCall'
import { DriverStreamHost } from '../models/drivers/driverStreamHost'
import { registerProviderDriver } from '../models/drivers/driverRegistry'
import { createModelProvider } from '../models/drivers/modelProvider'
import type { DriverStreamEvent, ProviderDriver } from '../models/drivers/driverTypes'
import {
  applyBodyPatch,
  patchBodyBytes,
  ProviderBodyPatchError,
  registerProviderRequestSeam,
  resetProviderRequestSeams,
} from '../models/drivers/providerRequestSeam'
import { fakeProviderRequestSeam } from './_helpers/fakeProviderRequestSeam'

// ── a JSON codec: request body = {model, n, meta}; response = JSON lines ────
const jsonCodec: ProviderDriver = {
  id: 'seam-json',
  auth: { headers: { authorization: 'Bearer {{secret:api_key}}' } },
  buildRequest: (payload, context) => ({
    url: `${context.baseUrl}/v1/chat`,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer {{secret:api_key}}',
      'x-drop-me': 'yes',
    },
    body: new TextEncoder().encode(
      JSON.stringify({ model: context.model, n: payload.messages.length, meta: { tags: ['a'] } }),
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
  errorFromResponse: ({ status, bodyText }) => ({
    type: 'error',
    message: `API Error: ${status} ${bodyText}`,
    httpStatus: status,
  }),
}
registerProviderDriver(jsonCodec)

const enc = (events: DriverStreamEvent[]) =>
  new TextEncoder().encode(events.map(e => JSON.stringify(e)).join('\n') + '\n')
const OK_BODY = enc([{ type: 'text_delta', text: 'hi' }, { type: 'finish', finishReason: 'stop' }])

type Reply = { status: number; body: Uint8Array }

/** A host that answers each `rawStreamOpen` with the next scripted reply,
 *  its whole body in one read; every open payload is recorded. */
function rawHost(replies: Reply[]) {
  const opens: Array<Record<string, any>> = []
  const bodies = new Map<string, Uint8Array>()
  let next = 0
  const transport: BrowserBridgeTransport = {
    async request(req: any) {
      const action = req.route.action
      if (action === 'rawStreamOpen') {
        opens.push(req.payload)
        const reply = replies.shift() ?? { status: 200, body: OK_BODY }
        next += 1
        const streamId = `raw-${next}`
        bodies.set(streamId, reply.body)
        return {
          ok: true,
          result: { streamId, status: reply.status, statusText: 'S', finalUrl: req.payload.url, headers: { 'x-r': '1' } },
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

const BASE = 'https://api.vendor.example'
const provider = (id = 'vendor') => createModelProvider({ id, format: 'seam-json', baseUrl: BASE })
const CONTEXT: BridgeModelRequestContext = {
  sessionId: 'session-1',
  agentId: 'agent-1',
  purpose: 'compaction',
  querySource: 'compact',
}
const payload = (extra: Record<string, unknown> = {}) => ({
  messages: [{ role: 'user', content: 'x' }],
  maxOutputTokens: 1000,
  requestContext: CONTEXT,
  ...extra,
})

async function drain(host: DriverStreamHost, streamId: string) {
  const all: any[] = []
  for (let i = 0; i < 50; i += 1) {
    const read = await host.read(streamId, 5000)
    all.push(...read.chunks)
    if (read.done) return all
  }
  throw new Error('stream never finished')
}

async function run(transport: BrowserBridgeTransport, providerId = 'vendor', extra: Record<string, unknown> = {}) {
  const host = new DriverStreamHost(transport)
  const { streamId } = host.start(provider(providerId), payload(extra) as never, 'm-1')
  return drain(host, streamId)
}

const bodyOf = (open: Record<string, any>) => JSON.parse(new TextDecoder().decode(open.body))
const errorOf = (chunks: any[]) => chunks.find(c => c.type === 'error')?.error

afterEach(() => {
  resetProviderRequestSeams()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

// ── body patches ────────────────────────────────────────────────────────────

describe('applyBodyPatch (JSON Pointer set / remove)', () => {
  it('sets and replaces object members, nested, with ~0 / ~1 escapes', () => {
    const doc = { a: { b: 1 }, 'x/y': 0 }
    const out = applyBodyPatch(doc, [
      { op: 'set', path: '/a/b', value: 2 },
      { op: 'set', path: '/a/c', value: { d: [1] } },
      { op: 'set', path: '/x~1y', value: 'slash' },
      { op: 'set', path: '/t~0', value: 'tilde' },
    ])
    expect(out).toEqual({ a: { b: 2, c: { d: [1] } }, 'x/y': 'slash', 't~': 'tilde' })
  })

  it('replaces, appends (`-` and the length) and removes array items', () => {
    const out = applyBodyPatch({ l: [1, 2, 3] }, [
      { op: 'set', path: '/l/0', value: 9 },
      { op: 'set', path: '/l/-', value: 4 },
      { op: 'set', path: '/l/4', value: 5 },
      { op: 'remove', path: '/l/1' },
    ])
    expect(out).toEqual({ l: [9, 3, 4, 5] })
  })

  it('a set of the root replaces the document; removing what is absent is a no-op', () => {
    expect(applyBodyPatch({ a: 1 }, [{ op: 'set', path: '', value: { b: 2 } }])).toEqual({ b: 2 })
    expect(applyBodyPatch({ a: 1 }, [{ op: 'remove', path: '/missing/deep' }, { op: 'remove', path: '/l/7' }]))
      .toEqual({ a: 1 })
  })

  it('refuses a missing parent, a bad pointer, a bad index, a valueless set, the root remove and unknown ops', () => {
    const bad: Array<[unknown, any]> = [
      [{}, { op: 'set', path: '/a/b', value: 1 }],
      [{}, { op: 'set', path: 'a', value: 1 }],
      [{ l: [] }, { op: 'set', path: '/l/01', value: 1 }],
      [{ l: [] }, { op: 'set', path: '/l/3', value: 1 }],
      [{}, { op: 'set', path: '/a' }],
      [{}, { op: 'remove', path: '' }],
      [{}, { op: 'move', path: '/a' }],
    ]
    for (const [doc, op] of bad) {
      expect(() => applyBodyPatch(doc, [op]), JSON.stringify(op)).toThrow(ProviderBodyPatchError)
    }
  })

  it('writes `__proto__` as an own member, never the prototype', () => {
    const out = applyBodyPatch({}, [{ op: 'set', path: '/__proto__', value: { polluted: true } }]) as object
    expect(({} as any).polluted).toBeUndefined()
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
    expect(JSON.stringify(out)).toBe('{"__proto__":{"polluted":true}}')
  })

  it('patchBodyBytes re-serializes JSON, keeps bytes untouched for no ops, refuses a non-JSON body', () => {
    const body = new TextEncoder().encode('{"a":1}')
    expect(patchBodyBytes(body, [])).toBe(body)
    expect(new TextDecoder().decode(patchBodyBytes(body, [{ op: 'set', path: '/b', value: 2 }]))).toBe('{"a":1,"b":2}')
    expect(() => patchBodyBytes(new Uint8Array([0xff, 0x00]), [{ op: 'remove', path: '/a' }]))
      .toThrow(/not JSON/)
  })
})

// ── the seam in DriverStreamHost ───────────────────────────────────────────

describe('DriverStreamHost — the provider request seam', () => {
  it('no seam for the provider: the open is what it always was, and nothing is built for a seam', async () => {
    const uuid = vi.spyOn(crypto, 'randomUUID')
    const digest = vi.spyOn(crypto.subtle, 'digest')
    const plain = rawHost([])
    await run(plain.transport)
    const plainUuids = uuid.mock.calls.length
    uuid.mockClear()
    // A seam registered for ANOTHER provider changes nothing here either.
    const other = fakeProviderRequestSeam({ request: { headers: { 'x-other': '1' } }, sign: { headers: { s: '1' } } })
    registerProviderRequestSeam('someone-else', other.seam)
    const again = rawHost([])
    const chunks = await run(again.transport)
    expect(chunks.map(c => c.type)).toContain('message_stop')
    expect(other.calls.request).toHaveLength(0)
    // No request id minted, no digest taken: only the transport's own ids.
    expect(uuid.mock.calls.length).toBe(plainUuids)
    expect(digest).not.toHaveBeenCalled()
    const strip = (open: Record<string, any>) => ({ ...open, streamId: undefined })
    expect(strip(again.opens[0]!)).toEqual(strip(plain.opens[0]!))
    expect(again.opens[0]).not.toHaveProperty('headers.x-other')
  })

  it('request: gets the small payload with the context, and its url / headers / patch / idle timeout are applied', async () => {
    const fake = fakeProviderRequestSeam({
      request: {
        url: `${BASE}/v2/chat?x=1`,
        headers: { 'x-session': 'S', 'x-drop-me': '' },
        patch: [
          { op: 'set', path: '/meta/session', value: 'S' },
          { op: 'remove', path: '/meta/tags' },
        ],
        idleTimeoutMs: 1234,
      },
    })
    registerProviderRequestSeam('vendor', fake.seam)
    const { transport, opens } = rawHost([])
    const chunks = await run(transport)
    expect(chunks.map(c => c.type)).toContain('message_stop')
    const [event] = fake.calls.request
    expect(event).toMatchObject({
      provider: 'vendor',
      model: 'm-1',
      format: 'seam-json',
      method: 'POST',
      url: `${BASE}/v1/chat`,
      maxOutputTokens: 1000,
      headers: { authorization: 'Bearer {{secret:api_key}}' },
      context: { ...CONTEXT, attempt: 1 },
    })
    expect(event!.context.requestId).toMatch(/^[0-9a-f-]{36}$/)
    expect(typeof event!.context.nowMs).toBe('number')
    // The small payload: no messages, tools or body cross.
    expect(Object.keys(event!).sort()).toEqual(
      ['context', 'format', 'headers', 'maxOutputTokens', 'method', 'model', 'provider', 'url'],
    )
    const open = opens[0]!
    expect(open.url).toBe(`${BASE}/v2/chat?x=1`)
    expect(open.headers['x-session']).toBe('S')
    expect(open.headers).not.toHaveProperty('x-drop-me')
    expect(open.headers.authorization).toBe('Bearer {{secret:api_key}}')
    expect(open.idleTimeoutMs).toBe(1234)
    expect(bodyOf(open)).toEqual({ model: 'm-1', n: 1, meta: { session: 'S' } })
  })

  it('request: a url off the provider origin fails closed — nothing is sent', async () => {
    for (const url of ['https://evil.example/v1/chat', 'http://api.vendor.example/v1/chat', 'not a url']) {
      resetProviderRequestSeams()
      registerProviderRequestSeam('vendor', fakeProviderRequestSeam({ request: { url } }).seam)
      const { transport, opens } = rawHost([])
      const chunks = await run(transport)
      expect(opens, url).toHaveLength(0)
      expect(errorOf(chunks).message).toMatch(/request hook of the provider vendor failed/)
    }
  })

  it('request: a malformed answer or a bad patch fails closed', async () => {
    for (const answer of [{ headers: { a: 1 } }, { patch: [{ op: 'set', path: '/meta/x/y', value: 1 }] }, { idleTimeoutMs: -1 }]) {
      resetProviderRequestSeams()
      registerProviderRequestSeam('vendor', fakeProviderRequestSeam({ request: answer as never }).seam)
      const { transport, opens } = rawHost([])
      const chunks = await run(transport)
      expect(opens, JSON.stringify(answer)).toHaveLength(0)
      expect(chunks.map(c => c.type)).toEqual(['message_start', 'error'])
    }
  })

  it('request: a hook that throws fails closed, with the reason in the error', async () => {
    registerProviderRequestSeam('vendor', fakeProviderRequestSeam({
      request: () => {
        throw new Error('vendor refuses')
      },
    }).seam)
    const { transport, opens } = rawHost([])
    const chunks = await run(transport)
    expect(opens).toHaveLength(0)
    expect(errorOf(chunks).message).toBe(
      'The request hook of the provider vendor failed, so the request was not sent: vendor refuses',
    )
  })

  it('request / sign: a hook past its budget fails closed', async () => {
    for (const hook of ['request', 'sign'] as const) {
      resetProviderRequestSeams()
      const never = () => new Promise<undefined>(() => {})
      registerProviderRequestSeam('vendor', fakeProviderRequestSeam({ budgetMs: 20, [hook]: never }).seam)
      const { transport, opens } = rawHost([])
      const chunks = await run(transport)
      expect(opens, hook).toHaveLength(0)
      expect(errorOf(chunks).message).toContain(`The ${hook} hook of the provider vendor failed`)
      expect(errorOf(chunks).message).toContain('no answer within 20 ms')
    }
  })

  it('the budget starts once the seam is ready; a seam that never gets ready fails closed', async () => {
    let ready!: () => void
    const fake = fakeProviderRequestSeam({
      budgetMs: 30,
      whenReady: () => new Promise<void>(resolve => {
        ready = resolve
      }),
      request: { headers: { 'x-ok': '1' } },
    })
    registerProviderRequestSeam('vendor', fake.seam)
    const { transport, opens } = rawHost([])
    const host = new DriverStreamHost(transport)
    const { streamId } = host.start(provider(), payload() as never, 'm-1')
    await new Promise(r => setTimeout(r, 80))
    expect(opens).toHaveLength(0)
    ready()
    await drain(host, streamId)
    expect(opens[0]!.headers['x-ok']).toBe('1')

    resetProviderRequestSeams()
    registerProviderRequestSeam('vendor', fakeProviderRequestSeam({
      whenReady: async () => {
        throw new Error('worker died')
      },
      request: {},
    }).seam)
    const failing = rawHost([])
    const chunks = await run(failing.transport)
    expect(failing.opens).toHaveLength(0)
    expect(errorOf(chunks).message).toContain('not ready (worker died)')
  })

  it('a stream cancelled while its hook runs sends nothing and ends without an error', async () => {
    registerProviderRequestSeam('vendor', fakeProviderRequestSeam({ request: () => new Promise(() => {}) }).seam)
    const { transport, opens } = rawHost([])
    const host = new DriverStreamHost(transport)
    const { streamId } = host.start(provider(), payload() as never, 'm-1')
    await new Promise(r => setTimeout(r, 10))
    await host.cancel(streamId)
    await new Promise(r => setTimeout(r, 10))
    expect(opens).toHaveLength(0)
  })

  it('sign: runs over the final bytes after request, and its headers are added', async () => {
    const fake = fakeProviderRequestSeam({
      request: { headers: { 'x-session': 'S' }, patch: [{ op: 'set', path: '/n', value: 7 }] },
      sign: e => ({ headers: { 'x-signature': `sig:${e.bodySha256}` } }),
    })
    registerProviderRequestSeam('vendor', fake.seam)
    const { transport, opens } = rawHost([])
    await run(transport)
    const open = opens[0]!
    const sent = Buffer.from(open.body as Uint8Array)
    const sha = createHash('sha256').update(sent).digest('hex')
    const [sign] = fake.calls.sign
    expect(sign).toMatchObject({
      provider: 'vendor',
      method: 'POST',
      url: `${BASE}/v1/chat`,
      bodySha256: sha,
      bodyLength: sent.byteLength,
      context: { attempt: 1, requestId: fake.calls.request[0]!.context.requestId },
    })
    expect(sign!.headers['x-session']).toBe('S')
    expect(bodyOf(open).n).toBe(7)
    expect(open.headers['x-signature']).toBe(`sig:${sha}`)
  })

  it('sign: may only add — a header already set, or an empty one, fails closed', async () => {
    for (const headers of [{ Authorization: 'x' }, { 'x-new': '' }] as Array<Record<string, string>>) {
      resetProviderRequestSeams()
      registerProviderRequestSeam('vendor', fakeProviderRequestSeam({ sign: { headers } }).seam)
      const { transport, opens } = rawHost([])
      const chunks = await run(transport)
      expect(opens, JSON.stringify(headers)).toHaveLength(0)
      expect(errorOf(chunks).message).toContain('sign may only add headers')
    }
  })

  it('retry: one re-send with its changes, signed afresh with a fresh request id', async () => {
    const fake = fakeProviderRequestSeam({
      request: { headers: { 'x-session': 'S' } },
      sign: e => ({ headers: { 'x-sig': `${e.context.attempt}:${e.bodySha256.slice(0, 8)}` } }),
      retry: e => (e.status === 400
        ? { retry: { headers: { 'x-retry': '1' }, patch: [{ op: 'remove', path: '/meta' }] } }
        : undefined),
    })
    registerProviderRequestSeam('vendor', fake.seam)
    const { transport, opens } = rawHost([
      { status: 400, body: new TextEncoder().encode('bad encrypted content') },
      { status: 200, body: OK_BODY },
    ])
    const chunks = await run(transport)
    expect(chunks.map(c => c.type)).toContain('message_stop')
    expect(errorOf(chunks)).toBeUndefined()
    expect(opens).toHaveLength(2)
    const [retry] = fake.calls.retry
    expect(retry).toMatchObject({
      provider: 'vendor',
      status: 400,
      bodyText: 'bad encrypted content',
      headers: { 'x-r': '1' },
      attempt: 1,
      request: { method: 'POST', url: `${BASE}/v1/chat` },
    })
    expect(retry!.request.headers['x-sig']).toBe(opens[0]!.headers['x-sig'])
    // The re-send: retry's changes over the request hook's, one fresh signature.
    expect(opens[1]!.headers['x-retry']).toBe('1')
    expect(opens[1]!.headers['x-session']).toBe('S')
    expect(opens[1]!.headers['x-sig']).toMatch(/^2:/)
    expect(bodyOf(opens[1]!)).toEqual({ model: 'm-1', n: 1 })
    // `request` once; `sign` per send; a fresh request id per attempt.
    expect(fake.calls.request).toHaveLength(1)
    expect(fake.calls.sign.map(e => e.context.attempt)).toEqual([1, 2])
    const ids = fake.calls.sign.map(e => e.context.requestId)
    expect(new Set(ids).size).toBe(2)
    expect(ids[0]).toBe(fake.calls.request[0]!.context.requestId)
  })

  it('retry: at most once — a second refusal goes to the engine as the core error', async () => {
    const fake = fakeProviderRequestSeam({ retry: { retry: { headers: { 'x-retry': '1' } } } })
    registerProviderRequestSeam('vendor', fake.seam)
    const { transport, opens } = rawHost([
      { status: 400, body: new TextEncoder().encode('one') },
      { status: 429, body: new TextEncoder().encode('two') },
    ])
    const chunks = await run(transport)
    expect(opens).toHaveLength(2)
    expect(fake.calls.retry).toHaveLength(1)
    expect(errorOf(chunks)).toEqual({ type: 'provider_error', message: 'API Error: 429 two', httpStatus: 429 })
  })

  it('retry: no answer, a throw or a bad answer leave the error exactly as without a seam', async () => {
    const plain = rawHost([{ status: 401, body: new TextEncoder().encode('bad key') }])
    const expected = await run(plain.transport)
    const answers = [
      () => undefined,
      () => {
        throw new Error('boom')
      },
      () => ({ retry: { patch: [{ op: 'set', path: '/no/such', value: 1 }] } }),
    ]
    for (const retry of answers) {
      resetProviderRequestSeams()
      registerProviderRequestSeam('vendor', fakeProviderRequestSeam({ retry: retry as never }).seam)
      const { transport, opens } = rawHost([{ status: 401, body: new TextEncoder().encode('bad key') }])
      const chunks = await run(transport)
      expect(opens).toHaveLength(1)
      expect(chunks).toEqual(expected)
    }
  })

  it('the blocking route goes through the seam too, with the payload context', async () => {
    const fake = fakeProviderRequestSeam({ request: { headers: { 'x-b': '1' } } })
    registerProviderRequestSeam('vendor', fake.seam)
    const { transport, opens } = rawHost([])
    const result = await runBlockingCall(new DriverStreamHost(transport), provider(), payload() as never, 'm-1')
    expect(result.status).toBe('ok')
    expect(opens[0]!.headers['x-b']).toBe('1')
    expect(fake.calls.request[0]!.context).toMatchObject(CONTEXT)
  })

  it('a payload without a context still reaches the seam, as purpose other', async () => {
    const fake = fakeProviderRequestSeam({ request: undefined })
    registerProviderRequestSeam('vendor', fake.seam)
    const { transport } = rawHost([])
    const host = new DriverStreamHost(transport)
    const { streamId } = host.start(provider(), { messages: [] }, 'm-1')
    await drain(host, streamId)
    expect(fake.calls.request[0]!.context).toMatchObject({ purpose: 'other', querySource: '', attempt: 1 })
  })

  it('unregistering restores the plain path; a replaced seam is not removed by the old unplug', () => {
    const a = fakeProviderRequestSeam({}).seam
    const b = fakeProviderRequestSeam({}).seam
    const unplugA = registerProviderRequestSeam('vendor', a)
    registerProviderRequestSeam('vendor', b)
    unplugA()
    // b is still in place.
    return import('../models/drivers/providerRequestSeam').then(m => {
      expect(m.providerRequestSeamFor('vendor')).toBe(b)
    })
  })
})
