/**
 * Provider mods PM-13 — the `cwd` need over the whole path: a real provider
 * module in a real mod worker host (MessageChannel, as
 * provider-mod-request-hooks.test.ts), the real `ProviderModRuntime`, the
 * adapter's seam plugged into the real `DriverStreamHost`, the session's
 * directory registered the way a runtime registers it, and a fake endpoint
 * that records what was actually sent.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { BrowserBridgeTransport } from '../browser/bridge/browserBridgeProtocol'
import { registerProviderDriver } from '../models/drivers/driverRegistry'
import { DriverStreamHost } from '../models/drivers/driverStreamHost'
import { buildSystemInstruction } from '../models/drivers/hostCallOptions'
import { createModelProvider } from '../models/drivers/modelProvider'
import type { DriverStreamEvent, ProviderDriver } from '../models/drivers/driverTypes'
import { registerProviderRequestSeam, resetProviderRequestSeams } from '../models/drivers/providerRequestSeam'
import { registerSessionWorkingDir } from '../models/drivers/sessionWorkingDirs'
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
const errorOf = (chunks: any[]) => chunks.find(c => c.type === 'error')?.error


// The module derives a header from `context.cwd` (as a vendor's client-side
// project id would) and records what its worker can reach: `crypto.subtle` and
// whether `context` has a `cwd` key at all.
const MODULE = `
  export function register(on) {
    on('provider.request', ($, e) => ({
      headers: {
        'x-has-cwd': String('cwd' in e.context),
        'x-project': e.context.cwd === undefined ? 'none' : 'proj_' + e.context.cwd.split(/[\\/]/).pop(),
        'x-cwd': String(e.context.cwd),
        'x-subtle': typeof (globalThis.crypto && globalThis.crypto.subtle),
      },
    }))
    on('provider.sign', ($, e) => ({ headers: { 'x-sign-cwd': String(e.context.cwd) } }))
  }
`

const CWD = 'C:/work/acme-app'
const undo: Array<() => void> = []
afterEach(() => {
  for (const f of undo.splice(0)) f()
})

describe('requestNeeds "cwd" — a real module in a real worker', () => {
  it('a module that declared it derives a header from context.cwd, seen at the endpoint', async () => {
    undo.push(registerSessionWorkingDir('sess-42', CWD))
    const { runtime } = runtimeFor(MODULE)
    registerProviderRequestSeam(ID, createProviderSeam(runtime, ID, { requestNeeds: ['cwd'] }))
    const { transport, opens } = endpoint([{ status: 200 }])

    const chunks = await stream(transport)

    expect(errorOf(chunks)).toBeUndefined()
    expect(opens).toHaveLength(1)
    expect(opens[0]!.headers).toMatchObject({
      'x-has-cwd': 'true',
      'x-project': 'proj_acme-app',
      'x-cwd': CWD,
      'x-sign-cwd': CWD,
    })
    // Recorded, not asserted as a requirement: the vitest worker is not the
    // browser's opaque-origin sandbox, so this does not settle the real worker.
    expect(['object', 'undefined']).toContain(opens[0]!.headers['x-subtle'])
    process.stdout.write(`[PM-13] typeof crypto.subtle inside the provider worker (vitest): ${opens[0]!.headers['x-subtle']}
`)
  })

  it('a module that did not declare it sees no cwd, though the session has one', async () => {
    undo.push(registerSessionWorkingDir('sess-42', CWD))
    const { runtime } = runtimeFor(MODULE)
    registerProviderRequestSeam(ID, createProviderSeam(runtime, ID, { requestNeeds: ['system'] }))
    const { transport, opens } = endpoint([{ status: 200 }])

    await stream(transport)

    expect(opens[0]!.headers).toMatchObject({ 'x-has-cwd': 'false', 'x-project': 'none', 'x-cwd': 'undefined', 'x-sign-cwd': 'undefined' })
    expect(JSON.stringify(opens[0])).not.toContain('acme-app')
  })

  it('a declared module in a session with no directory sees none', async () => {
    const { runtime } = runtimeFor(MODULE)
    registerProviderRequestSeam(ID, createProviderSeam(runtime, ID, { requestNeeds: ['cwd'] }))
    const { transport, opens } = endpoint([{ status: 200 }])

    await stream(transport)

    expect(opens[0]!.headers).toMatchObject({ 'x-has-cwd': 'false', 'x-project': 'none' })
  })
})
