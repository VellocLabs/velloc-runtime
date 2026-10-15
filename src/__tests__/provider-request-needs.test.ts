/**
 * Provider mods: what a provider's request hooks ask to see (`requestNeeds` / `signNeeds`), held parts,
 * `provider.sign` after a rewrite, `provider.retry` with a body, and `effort`, through the real `DriverStreamHost`.
 */
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BridgeModelRequestContext, BrowserBridgeTransport } from '../browser/bridge/browserBridgeProtocol'
import { buildModelRequest } from '../engine/turn/modelTransport'
import { registerProviderDriver } from '../models/drivers/driverRegistry'
import { DriverStreamHost } from '../models/drivers/driverStreamHost'
import { buildSystemInstruction } from '../models/drivers/hostCallOptions'
import { createModelProvider } from '../models/drivers/modelProvider'
import type { DriverStreamEvent, ProviderDriver } from '../models/drivers/driverTypes'
import { registerProviderRequestSeam, resetProviderRequestSeams } from '../models/drivers/providerRequestSeam'
import { registerSessionWorkingDir, sessionWorkingDirOf } from '../models/drivers/sessionWorkingDirs'
import {
  checkProviderNeeds,
  holdRequestBody,
  restoreRequestBody,
  wirePartKind,
} from '../mods/provider/providerRequestNeeds'
import { NoopPlatformCapabilities, createEmptyAppState, createNoopToolUseContext } from '../runtime/testing/noopAdapters'
import { fakeProviderRequestSeam } from './_helpers/fakeProviderRequestSeam'

// ── a codec whose body shows the system prompt, the tools and an image ──────

const IMAGE_DATA = 'QUJD'.repeat(2_000) // 6000 decoded bytes
const imagePart = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: IMAGE_DATA } }

const needsCodec: ProviderDriver = {
  id: 'needs-json',
  auth: { headers: { authorization: 'Bearer {{secret:api_key}}' } },
  buildRequest: (payload, context) => ({
    url: `${context.baseUrl}/v1/chat`,
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer {{secret:api_key}}' },
    body: new TextEncoder().encode(
      JSON.stringify({
        model: context.model,
        system: buildSystemInstruction(payload),
        tools: (payload.tools ?? []).map(tool => tool.name),
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
registerProviderDriver(needsCodec)

const enc = (events: DriverStreamEvent[]) => new TextEncoder().encode(events.map(e => JSON.stringify(e)).join('\n') + '\n')
const OK_BODY = enc([{ type: 'text_delta', text: 'hi' }, { type: 'finish', finishReason: 'stop' }])

type Reply = { status: number; body: Uint8Array }

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
        return { ok: true, result: { streamId, status: reply.status, statusText: 'S', finalUrl: req.payload.url, headers: {} } } as any
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
const CONTEXT: BridgeModelRequestContext = { sessionId: 's1', purpose: 'turn', querySource: 'sdk' }
const TOOLS = [
  { type: 'function', name: 'read', description: 'Read', parameters: { type: 'object' } },
  { type: 'function', name: 'write', description: 'Write', parameters: { type: 'object' } },
]
const payload = (extra: Record<string, unknown> = {}) => ({
  messages: [{ role: 'user', content: 'x' }],
  systemPrompt: ['You are terse.', 'Be kind.'],
  userContext: { who: 'ann' },
  tools: TOOLS,
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

async function run(transport: BrowserBridgeTransport, extra: Record<string, unknown> = {}) {
  const host = new DriverStreamHost(transport)
  const provider = createModelProvider({ id: 'vendor', format: 'needs-json', baseUrl: BASE })
  const { streamId } = host.start(provider, payload(extra) as never, 'm-1')
  return drain(host, streamId)
}

const bodyOf = (open: Record<string, any>) => JSON.parse(new TextDecoder().decode(open.body))
const errorOf = (chunks: any[]) => chunks.find(c => c.type === 'error')?.error

afterEach(() => {
  resetProviderRequestSeams()
  vi.restoreAllMocks()
})

// ── the declaration ─────────────────────────────────────────────────────────

describe('checkProviderNeeds', () => {
  it('accepts nothing, any subset of system / tools / body, and signNeeds body', () => {
    expect(checkProviderNeeds({})).toEqual({ ok: true, needs: { requestNeeds: [] } })
    expect(checkProviderNeeds({ requestNeeds: ['tools', 'system'], signNeeds: 'body' })).toEqual({
      ok: true,
      needs: { requestNeeds: ['tools', 'system'], signNeeds: 'body' },
    })
    expect(checkProviderNeeds({ requestNeeds: ['body'] })).toMatchObject({ ok: true })
  })

  it('refuses an unknown word, a repeat, the wrong shape and a bad signNeeds', () => {
    const bad: Array<[object, RegExp]> = [
      [{ requestNeeds: ['messages'] }, /"messages" is not one of/],
      [{ requestNeeds: ['body', 'body'] }, /listed twice/],
      [{ requestNeeds: 'body' }, /must be a list/],
      [{ requestNeeds: [1] }, /is not one of/],
      [{ signNeeds: 'digest' }, /signNeeds/],
      [{ signNeeds: true }, /signNeeds/],
    ]
    for (const [input, message] of bad) {
      const checked = checkProviderNeeds(input)
      expect(checked.ok, JSON.stringify(input)).toBe(false)
      expect((checked as { error: string }).error).toMatch(message)
    }
  })
})

// ── held parts ──────────────────────────────────────────────────────────────

describe('holding binary parts of a codec body', () => {
  const enc8 = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))

  it('names the wire spellings of an image or document part', () => {
    expect(wirePartKind({ type: 'image' })).toBe('image')
    expect(wirePartKind({ type: 'image_url', image_url: { url: 'data:...' } })).toBe('image')
    expect(wirePartKind({ type: 'input_image' })).toBe('image')
    expect(wirePartKind({ inlineData: { mimeType: 'image/png', data: 'x' } })).toBe('image')
    expect(wirePartKind({ type: 'document' })).toBe('document')
    expect(wirePartKind({ type: 'input_file' })).toBe('document')
    expect(wirePartKind({ type: 'text', text: 'hi' })).toBeUndefined()
  })

  it('a part crosses as { kind, bytes, ref } and comes back whole; text stays', () => {
    const { view, held } = holdRequestBody(enc8({ messages: [{ content: [imagePart, { type: 'text', text: 'hi' }] }] }))
    const placeholder = (view as any).messages[0].content[0]
    expect(placeholder).toEqual({ kind: 'image', bytes: 6000, ref: 'b0' })
    expect(JSON.stringify(view)).not.toContain(IMAGE_DATA)
    expect(restoreRequestBody(view, held)).toEqual({ messages: [{ content: [imagePart, { type: 'text', text: 'hi' }] }] })
  })

  it('a placeholder naming a ref the request never gave refuses the body', () => {
    const { held } = holdRequestBody(enc8({ parts: [imagePart] }))
    expect(() => restoreRequestBody({ parts: [{ kind: 'image', bytes: 1, ref: 'b9' }] }, held)).toThrow(/not one this request gave/)
    expect(() => restoreRequestBody({ parts: [{ kind: 'document', bytes: 1, ref: 'zz' }] }, held)).toThrow(/refused/)
  })

  it('a body that is not JSON cannot be shown', () => {
    expect(() => holdRequestBody(new Uint8Array([0xff, 0x00]))).toThrow(/not JSON/)
  })
})

// ── request: system / tools / body ──────────────────────────────────────────

describe('provider.request — requestNeeds', () => {
  it('no needs (or an empty list): the event is the small one and the outbound request is byte-identical to no seam', async () => {
    const plain = rawHost([])
    await run(plain.transport)
    for (const requestNeeds of [undefined, []] as const) {
      resetProviderRequestSeams()
      const fake = fakeProviderRequestSeam({ request: undefined, ...(requestNeeds ? { requestNeeds } : {}) })
      registerProviderRequestSeam('vendor', fake.seam)
      const seamed = rawHost([])
      await run(seamed.transport)
      expect(Object.keys(fake.calls.request[0]!).sort()).toEqual(
        ['context', 'format', 'headers', 'maxOutputTokens', 'method', 'model', 'provider', 'url'],
      )
      const strip = (open: Record<string, any>) => ({ ...open, streamId: undefined })
      expect(strip(seamed.opens[0]!)).toEqual(strip(plain.opens[0]!))
      expect(Buffer.from(seamed.opens[0]!.body).equals(Buffer.from(plain.opens[0]!.body))).toBe(true)
    }
  })

  it('system and tools: shown as sent, only when declared', async () => {
    const fake = fakeProviderRequestSeam({ request: undefined, requestNeeds: ['system', 'tools'] })
    registerProviderRequestSeam('vendor', fake.seam)
    const { transport } = rawHost([])
    await run(transport)
    const [event] = fake.calls.request
    expect(event!.system).toBe('You are terse.\n\nBe kind.\n\nUser context:\n- who: ann')
    expect(event!.tools).toEqual(TOOLS)
    expect(event).not.toHaveProperty('body')

    resetProviderRequestSeams()
    const onlyTools = fakeProviderRequestSeam({ request: undefined, requestNeeds: ['tools'] })
    registerProviderRequestSeam('vendor', onlyTools.seam)
    await run(rawHost([]).transport)
    expect(onlyTools.calls.request[0]).not.toHaveProperty('system')
    expect(onlyTools.calls.request[0]).toHaveProperty('tools')
  })

  it('system / tools: a replacement builds the request again from the payload', async () => {
    const fake = fakeProviderRequestSeam({
      request: { system: 'Compaction rules.', tools: [TOOLS[1]], headers: { 'x-kind': 'compaction' } },
      requestNeeds: ['system'],
    })
    registerProviderRequestSeam('vendor', fake.seam)
    const { transport, opens } = rawHost([])
    const chunks = await run(transport)
    expect(errorOf(chunks)).toBeUndefined()
    expect(bodyOf(opens[0]!)).toMatchObject({ system: 'Compaction rules.', tools: ['write'], meta: { tags: ['a'] } })
    expect(opens[0]!.headers['x-kind']).toBe('compaction')
  })

  it('a replacement needs no declaration: a hook may set the system prompt without reading it', async () => {
    registerProviderRequestSeam('vendor', fakeProviderRequestSeam({ request: { system: 'Blind.' } }).seam)
    const { transport, opens } = rawHost([])
    await run(transport)
    expect(bodyOf(opens[0]!).system).toBe('Blind.')
    expect(bodyOf(opens[0]!).tools).toEqual(['read', 'write'])
  })

  it('body: shown with the image held; a patch addresses that view and the image goes out intact', async () => {
    const fake = fakeProviderRequestSeam({
      request: {
        patch: [
          { op: 'set', path: '/meta/session', value: 'S' },
          { op: 'set', path: '/messages/0/content/1/text', value: 'look closely' },
        ],
      },
      requestNeeds: ['body'],
    })
    registerProviderRequestSeam('vendor', fake.seam)
    const { transport, opens } = rawHost([])
    const chunks = await run(transport)
    expect(errorOf(chunks)).toBeUndefined()
    const event = fake.calls.request[0]!
    const shown = (event.body as any).messages[0].content[0]
    expect(shown).toEqual({ kind: 'image', bytes: 6000, ref: 'b0' })
    expect(JSON.stringify(event.body)).not.toContain(IMAGE_DATA)
    const sent = bodyOf(opens[0]!)
    expect(sent.meta).toEqual({ tags: ['a'], session: 'S' })
    expect(sent.messages[0].content).toEqual([imagePart, { type: 'text', text: 'look closely' }])
  })

  it('body: a whole body comes back with its placeholder restored', async () => {
    registerProviderRequestSeam('vendor', fakeProviderRequestSeam({
      request: e => {
        const body = structuredClone(e.body) as any
        body.model = 'rewritten'
        body.messages[0].content.push({ type: 'text', text: 'more' })
        return { body }
      },
      requestNeeds: ['body'],
    }).seam)
    const { transport, opens } = rawHost([])
    await run(transport)
    const sent = bodyOf(opens[0]!)
    expect(sent.model).toBe('rewritten')
    expect(sent.messages[0].content).toEqual([imagePart, { type: 'text', text: 'look' }, { type: 'text', text: 'more' }])
  })

  it('body: a placeholder naming a ref the request never gave refuses the rewrite — nothing is sent', async () => {
    const forged = { kind: 'image', bytes: 1, ref: 'b7' }
    const answers: Array<[string, (e: any) => object]> = [
      ['whole body', () => ({ body: { messages: [{ role: 'user', content: [forged] }] } })],
      ['patch value', () => ({ patch: [{ op: 'set', path: '/messages/0/content/0', value: forged }] })],
    ]
    for (const [name, answer] of answers) {
      resetProviderRequestSeams()
      registerProviderRequestSeam('vendor', fakeProviderRequestSeam({ request: answer, requestNeeds: ['body'] }).seam)
      const { transport, opens } = rawHost([])
      const chunks = await run(transport)
      expect(opens, name).toHaveLength(0)
      expect(errorOf(chunks).message, name).toMatch(/request hook of the provider vendor failed.*not one this request gave/)
    }
  })

  it('body: only from a provider that declared it, and not with system / tools / patch', async () => {
    const cases: Array<[string, object, string[] | undefined, RegExp]> = [
      ['undeclared', { body: {} }, undefined, /only for a provider that declared/],
      ['declared system only', { body: {} }, ['system'], /only for a provider that declared/],
      ['body + patch', { body: {}, patch: [] }, ['body'], /cannot be combined/],
      ['body + system', { body: {}, system: 'x' }, ['body'], /cannot be combined/],
      ['patch + tools, body declared', { tools: [], patch: [{ op: 'remove', path: '/meta' }] }, ['body'], /cannot be combined/],
    ]
    for (const [name, answer, needs, message] of cases) {
      resetProviderRequestSeams()
      registerProviderRequestSeam('vendor', fakeProviderRequestSeam({
        request: answer as never,
        ...(needs ? { requestNeeds: needs as never } : {}),
      }).seam)
      const { transport, opens } = rawHost([])
      const chunks = await run(transport)
      expect(opens, name).toHaveLength(0)
      expect(errorOf(chunks).message, name).toMatch(message)
    }
  })

  it('patch + system without body declared: the patch edits the rebuilt body', async () => {
    registerProviderRequestSeam('vendor', fakeProviderRequestSeam({
      request: { system: 'New.', patch: [{ op: 'set', path: '/meta/x', value: 1 }] },
    }).seam)
    const { transport, opens } = rawHost([])
    await run(transport)
    expect(bodyOf(opens[0]!)).toMatchObject({ system: 'New.', meta: { tags: ['a'], x: 1 } })
  })
})

// ── sign ────────────────────────────────────────────────────────────────────

describe('provider.sign — over the bytes that go out', () => {
  it('runs after a requestNeeds rewrite, over the rewritten bytes: digest by default, no body', async () => {
    const order: string[] = []
    const fake = fakeProviderRequestSeam({
      request: e => {
        order.push('request')
        return { system: 'Rewritten.', headers: { 'x-id': e.context.requestId } }
      },
      sign: e => {
        order.push('sign')
        return { headers: { 'x-sig': e.bodySha256 } }
      },
      requestNeeds: ['system'],
    })
    registerProviderRequestSeam('vendor', fake.seam)
    const { transport, opens } = rawHost([])
    await run(transport)
    expect(order).toEqual(['request', 'sign'])
    const sent = Buffer.from(opens[0]!.body)
    expect(bodyOf(opens[0]!).system).toBe('Rewritten.')
    const [sign] = fake.calls.sign
    expect(sign!.bodySha256).toBe(createHash('sha256').update(sent).digest('hex'))
    expect(sign!.bodyLength).toBe(sent.byteLength)
    expect(sign).not.toHaveProperty('body')
    expect(sign!.headers['x-id']).toBe(fake.calls.request[0]!.context.requestId)
    expect(opens[0]!.headers['x-sig']).toBe(sign!.bodySha256)
  })

  it("signNeeds 'body': the bytes themselves cross, and are the ones sent", async () => {
    const fake = fakeProviderRequestSeam({
      request: { patch: [{ op: 'set', path: '/meta/p', value: true }] },
      sign: { headers: { 'x-sig': 'ok' } },
      signNeeds: 'body',
    })
    registerProviderRequestSeam('vendor', fake.seam)
    const { transport, opens } = rawHost([])
    await run(transport)
    const [sign] = fake.calls.sign
    expect(Buffer.from(sign!.body!).equals(Buffer.from(opens[0]!.body))).toBe(true)
    expect(sign!.bodyLength).toBe(sign!.body!.byteLength)
  })
})

// ── retry ───────────────────────────────────────────────────────────────────

describe('provider.retry — with body declared', () => {
  const refused = [{ status: 400, body: new TextEncoder().encode('bad') }]

  it('shows the refused body (parts held) and re-sends the whole body it answers, signed afresh', async () => {
    const fake = fakeProviderRequestSeam({
      request: { system: 'First.' },
      sign: e => ({ headers: { 'x-sig': `${e.context.attempt}:${e.bodySha256.slice(0, 6)}` } }),
      retry: e => {
        const body = structuredClone(e.request.body) as any
        body.system = 'Second.'
        return { retry: { headers: { 'x-retry': '1' }, body } }
      },
      requestNeeds: ['body'],
    })
    registerProviderRequestSeam('vendor', fake.seam)
    const { transport, opens } = rawHost([...refused, { status: 200, body: OK_BODY }])
    const chunks = await run(transport)
    expect(errorOf(chunks)).toBeUndefined()
    const [retry] = fake.calls.retry
    expect((retry!.request.body as any).system).toBe('First.')
    expect(JSON.stringify(retry!.request.body)).not.toContain(IMAGE_DATA)
    expect(retry).toMatchObject({ status: 400, bodyText: 'bad', attempt: 1 })
    expect(opens).toHaveLength(2)
    const resent = bodyOf(opens[1]!)
    expect(resent.system).toBe('Second.')
    expect(resent.messages[0].content[0]).toEqual(imagePart)
    expect(opens[1]!.headers['x-sig']).toMatch(/^2:/)
    expect(opens[1]!.headers['x-sig']).not.toBe(opens[0]!.headers['x-sig'])
  })

  it('a forged placeholder, or a body without the declaration, leaves the error to the engine', async () => {
    const plain = rawHost([...refused])
    const expected = await run(plain.transport)
    const answers: Array<[object, string[] | undefined]> = [
      [{ retry: { body: { messages: [{ kind: 'image', bytes: 1, ref: 'nope' }] } } }, ['body']],
      [{ retry: { body: {} } }, undefined],
      [{ retry: { body: {}, patch: [] } }, ['body']],
    ]
    for (const [answer, needs] of answers) {
      resetProviderRequestSeams()
      registerProviderRequestSeam('vendor', fakeProviderRequestSeam({
        retry: answer as never,
        ...(needs ? { requestNeeds: needs as never } : {}),
      }).seam)
      const { transport, opens } = rawHost([...refused])
      const chunks = await run(transport)
      expect(opens).toHaveLength(1)
      expect(chunks).toEqual(expected)
    }
  })

  it('without body declared the retry event carries no body, and a patch edits the real body', async () => {
    const fake = fakeProviderRequestSeam({
      retry: { retry: { patch: [{ op: 'remove', path: '/meta' }] } },
    })
    registerProviderRequestSeam('vendor', fake.seam)
    const { transport, opens } = rawHost([...refused, { status: 200, body: OK_BODY }])
    await run(transport)
    expect(fake.calls.retry[0]!.request).not.toHaveProperty('body')
    expect(bodyOf(opens[1]!)).not.toHaveProperty('meta')
  })
})

// ── effort ──────────────────────────────────────────────────────────────────

describe('effort', () => {
  it("the payload's thinking tier is the event's effort, as is; none when the request has none", async () => {
    const fake = fakeProviderRequestSeam({ request: undefined })
    registerProviderRequestSeam('vendor', fake.seam)
    for (const tier of ['extra-high', 'minimal', 'none']) {
      await run(rawHost([]).transport, { thinkingTier: tier })
    }
    expect(fake.calls.request.map(e => e.effort)).toEqual(['extra-high', 'minimal', 'none'])
    await run(rawHost([]).transport)
    expect(fake.calls.request[3]).not.toHaveProperty('effort')
  })

  it('buildModelRequest threads the tier it sends to the payload, and only that one', () => {
    const callContext = createNoopToolUseContext({
      tools: [] as never,
      platformCapabilities: new NoopPlatformCapabilities(),
      appState: createEmptyAppState(),
      setAppState: () => {},
    })
    callContext.options = { ...callContext.options, sessionId: 's1' }
    const params = (thinkingTier?: string) => ({
      messages: [{ type: 'user', uuid: 'u1', message: { role: 'user', content: 'hello' } }],
      baseInstructions: 'be brief',
      userContext: {},
      systemAmbient: {},
      callContext,
      querySource: 'sdk',
      providerId: 'anthropic',
      modelOverride: 'claude-opus-4-8',
      ...(thinkingTier ? { thinkingTier } : {}),
    }) as never
    const withTier = buildModelRequest(params('high'), []).payload
    expect(withTier.thinkingTier).toBe('high')
    // The tier the model does not offer is not sent, so it is not shown.
    expect(buildModelRequest(params('bogus-tier'), []).payload).not.toHaveProperty('thinkingTier')
    expect(buildModelRequest(params(), []).payload).not.toHaveProperty('thinkingTier')
  })
})

// ── cwd ─────────────────────────────────────────────────────────────────────

describe('cwd — the session working directory, an opt-in need', () => {
  const ROOT = 'C:\work\proj'
  let drop: Array<() => void> = []
  const register = (sessionId: string, cwd: string) => drop.push(registerSessionWorkingDir(sessionId, cwd))
  afterEach(() => {
    for (const undo of drop.splice(0)) undo()
  })

  it('checkProviderNeeds accepts cwd alone or with the others, and still refuses a word it does not know', () => {
    expect(checkProviderNeeds({ requestNeeds: ['cwd'] })).toEqual({ ok: true, needs: { requestNeeds: ['cwd'] } })
    expect(checkProviderNeeds({ requestNeeds: ['system', 'cwd'] })).toMatchObject({ ok: true })
    const bad = checkProviderNeeds({ requestNeeds: ['folder'] })
    expect(bad.ok).toBe(false)
    expect((bad as { error: string }).error).toMatch(/"cwd"/)
  })

  it('request, sign and retry contexts carry cwd when declared', async () => {
    register('s1', ROOT)
    const fake = fakeProviderRequestSeam({
      request: undefined,
      sign: undefined,
      retry: undefined,
      requestNeeds: ['cwd'],
    })
    registerProviderRequestSeam('vendor', fake.seam)
    const { transport } = rawHost([{ status: 400, body: new TextEncoder().encode('bad') }, { status: 200, body: OK_BODY }])
    await run(transport)
    expect(fake.calls.request[0]!.context.cwd).toBe(ROOT)
    expect(fake.calls.sign[0]!.context.cwd).toBe(ROOT)
    expect(fake.calls.retry[0]!.context.cwd).toBe(ROOT)
  })

  it('without the need the field is absent and the no-need request is byte-identical to a declared-nothing one', async () => {
    register('s1', ROOT)
    const withNothing = fakeProviderRequestSeam({ request: undefined, sign: undefined })
    registerProviderRequestSeam('vendor', withNothing.seam)
    const first = rawHost([])
    await run(first.transport)
    const withOther = fakeProviderRequestSeam({ request: undefined, sign: undefined, requestNeeds: ['system'] })
    registerProviderRequestSeam('vendor', withOther.seam)
    const second = rawHost([])
    await run(second.transport)
    for (const fake of [withNothing, withOther]) {
      expect(fake.calls.request[0]!.context).not.toHaveProperty('cwd')
      expect(fake.calls.sign[0]!.context).not.toHaveProperty('cwd')
    }
    const strip = (open: Record<string, any>) => ({ ...open, streamId: undefined })
    expect(strip(second.opens[0]!)).toEqual(strip(first.opens[0]!))
  })

  it('a sub-agent and the compaction summarizer ask under the root session id, so they see the root cwd', async () => {
    register('s1', ROOT)
    const fake = fakeProviderRequestSeam({ request: undefined, requestNeeds: ['cwd'] })
    registerProviderRequestSeam('vendor', fake.seam)
    await run(rawHost([]).transport, { requestContext: { sessionId: 's1', agentId: 'sub-9', purpose: 'turn', querySource: 'agent_tool' } })
    await run(rawHost([]).transport, { requestContext: { sessionId: 's1', purpose: 'compaction', querySource: 'compact' } })
    expect(fake.calls.request.map(e => [e.context.purpose, e.context.cwd])).toEqual([
      ['turn', ROOT],
      ['compaction', ROOT],
    ])
  })

  it('a session with no directory (a headless run, a payload with no session) has no cwd, and the request still goes', async () => {
    const fake = fakeProviderRequestSeam({ request: undefined, requestNeeds: ['cwd'] })
    registerProviderRequestSeam('vendor', fake.seam)
    const { transport, opens } = rawHost([])
    await run(transport, { requestContext: { sessionId: 'headless-1', purpose: 'turn', querySource: 'sdk' } })
    await run(rawHost([]).transport, { requestContext: undefined })
    expect(fake.calls.request).toHaveLength(2)
    for (const e of fake.calls.request) expect(e.context).not.toHaveProperty('cwd')
    expect(opens).toHaveLength(1)
  })

  it('the directory is never on the payload buildModelRequest builds', () => {
    const callContext = createNoopToolUseContext({
      tools: [] as never,
      platformCapabilities: new NoopPlatformCapabilities(),
      appState: createEmptyAppState(),
      setAppState: () => {},
    })
    callContext.options = { ...callContext.options, sessionId: 's1', cwd: ROOT }
    const built = buildModelRequest(
      {
        messages: [{ type: 'user', uuid: 'u1', message: { role: 'user', content: 'hello' } }],
        baseInstructions: 'be brief',
        userContext: {},
        systemAmbient: {},
        callContext,
        querySource: 'sdk',
        providerId: 'anthropic',
        modelOverride: 'claude-opus-4-8',
      } as never,
      [],
    )
    expect(JSON.stringify(built.payload)).not.toContain('proj')
    expect(built.payload.requestContext).toEqual({ sessionId: 's1', purpose: 'turn', querySource: 'sdk' })
  })

  it('the registry drops a session on undo, and an old undo does not drop a newer entry', () => {
    const undoOld = registerSessionWorkingDir('s2', 'A')
    const undoNew = registerSessionWorkingDir('s2', 'B')
    undoOld()
    expect(sessionWorkingDirOf('s2')).toBe('B')
    undoNew()
    expect(sessionWorkingDirOf('s2')).toBeUndefined()
    expect(sessionWorkingDirOf(undefined)).toBeUndefined()
  })
})
