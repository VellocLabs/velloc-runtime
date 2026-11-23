/**
 * A router provider served by a provider mod (F-27): the adapter over the real
 * provider mod runtime and a worker host, the registration wiring, the
 * listing's peers and its re-run, a router row's wire, and the health ledger
 * written by a failed routed send.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const traced = vi.hoisted(() => [] as string[])
vi.mock('../utils/debugLog', async original => {
  const actual = await original<typeof import('../utils/debugLog')>()
  return {
    ...actual,
    traceLine: (message: string, options?: unknown) => {
      traced.push(message)
      return (actual.traceLine as (m: string, o?: unknown) => unknown)(message, options)
    },
  }
})

import type { BrowserBridgeTransport } from '../browser/bridge/browserBridgeProtocol'
import { installModWorkerHost } from '../mods/ModWorkerHost'
import { type ModWorkerHandle } from '../mods/ModRuntime'
import { ProviderModRuntime, type ProviderModuleRef } from '../mods/provider/ProviderModRuntime'
import { createModProviderRouter } from '../mods/provider/providerRouterAdapter'
import { providerSeamListener } from '../mods/provider/providerSeamWiring'
import type { ProviderRegistration } from '../mods/provider/providerModHost'
import type { ProviderManifest } from '../mods/provider/providerManifest'
import type { Peer, ProviderState } from '../mods/provider/nouns/providerPeersTypes'
import { runtimePeersTable } from '../mods/provider/nouns/providerPeersNoun'
import { parseModelsAnswer } from '../mods/provider/providerModelsAnswer'
import { noteRouterListing, resetRouterListings, startRouterRelisting } from '../mods/provider/routerRelisting'
import { providerRequestSeamFor, resetProviderRequestSeams } from '../models/drivers/providerRequestSeam'
import {
  providerRouterBoundsFor,
  providerRouterFor,
  registerProviderRouter,
  resetProviderRouters,
  type RouteEvent,
} from '../models/drivers/providerRouter'
import { registerProviderDriver } from '../models/drivers/driverRegistry'
import type { DriverStreamEvent, ProviderDriver } from '../models/drivers/driverTypes'
import { withModelProviders } from '../models/drivers/driverTransport'
import { resetRuntimeProviders, setRuntimeProviderConfigs } from '../models/drivers/runtimeProviders'
import { resetProviderHealthLedger } from '../models/drivers/providerHealthLedger'
import { DefaultRuntimeConfig } from '../runtime/testing/noopAdapters'

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

let uniqueLoad = 0
const openPorts: MessagePort[] = []
const runtimes: ProviderModRuntime[] = []
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose()
  for (const port of openPorts.splice(0)) port.close()
  resetProviderRouters()
  resetProviderRequestSeams()
  resetRouterListings()
  resetRuntimeProviders()
  resetProviderHealthLedger()
})

const ROUTER = 'mod.pool.router'

/** The real runtime over a worker host, owning `ROUTER` with `source`. */
function routerRuntime(source: string, options: { budgetMs?: number; attachMs?: number } = {}) {
  const ref: ProviderModuleRef = { plugin: 'pool', path: 'pool/providers/router.js', providers: [ROUTER], kind: 'router' }
  const runtime = new ProviderModRuntime({
    readModule: async () => `${source}\n// load ${++uniqueLoad}`,
    openWorker: async () => {
      const channel = new MessageChannel()
      openPorts.push(channel.port1, channel.port2)
      installModWorkerHost(channel.port2)
      let settle!: (closed: { reason: 'closed' | 'crashed' }) => void
      const closed = new Promise<{ reason: 'closed' | 'crashed' }>(resolve => {
        settle = resolve
      })
      return { port: channel.port1, closed, close: () => settle({ reason: 'closed' }) } as ModWorkerHandle
    },
    window: {
      available: () => true,
      attached: async () => {
        if (options.attachMs) await sleep(options.attachMs)
      },
    },
    report: () => {},
    ...(options.budgetMs !== undefined ? { budgetMs: options.budgetMs } : {}),
  })
  runtimes.push(runtime)
  runtime.register('pool', [ref])
  return runtime
}

const PEERS: Peer[] = [
  { id: 'relay-a', definition: 'relay-a', label: 'A', kind: 'provider', source: 'custom', connected: true, models: [], state: { models: {} } },
  { id: 'relay-b', definition: 'relay-b', label: 'B', kind: 'provider', source: 'custom', connected: true, models: [], state: { models: {} } },
] as unknown as Peer[]

const CONTEXT = { sessionId: 's', agentId: 'a', purpose: 'main', querySource: 'test' } as unknown as RouteEvent['requestContext']
const first = (context = CONTEXT, callId = 'call-1'): RouteEvent => ({
  model: 'row',
  requestContext: context,
  callId,
  attempt: 1,
  request: { tools: false, images: false, documents: false },
})
const afterFailure = (context = CONTEXT, callId = 'call-1'): RouteEvent => ({
  model: 'row',
  requestContext: context,
  callId,
  attempt: 2,
  request: { tools: false, images: false, documents: false },
  lastFailure: {
    provider: 'relay-a',
    model: 'm-a',
    status: 429,
    verdict: { kind: 'rate_limit', retryable: false } as never,
    message: 'quota',
    streamStarted: false,
  },
})
const signal = (): AbortSignal => new AbortController().signal

/** Answers the first peer the failure did not name. */
const FIRST_FREE = `
  export function register(on) {
    on('provider.route', ($, e) => {
      const peer = e.peers.find(p => p.id !== e.lastFailure?.provider)
      return peer ? { provider: peer.id, model: 'm', seen: e.peers.length } : { stop: true }
    })
  }
`

describe('createModProviderRouter over the provider mod runtime', () => {
  it('answers from e.peers in order, after a cold start that is not counted in the budget', async () => {
    const runtime = routerRuntime(FIRST_FREE, { budgetMs: 100, attachMs: 300 })
    const router = createModProviderRouter(runtime, ROUTER, () => PEERS)
    expect(await router.route(first(), signal())).toEqual({ provider: 'relay-a', model: 'm', seen: 2 })
    expect(await router.route(afterFailure(), signal())).toEqual({ provider: 'relay-b', model: 'm', seen: 2 })
  })

  it('hands the module the call id and what the request asks for', async () => {
    const runtime = routerRuntime(`
      export function register(on) {
        on('provider.route', ($, e) => ({ provider: 'relay-a', model: 'm', callId: e.callId, request: e.request }))
      }
    `)
    const router = createModProviderRouter(runtime, ROUTER, () => PEERS)
    expect(await router.route({ ...first(), callId: 'call-7', request: { tools: true, images: false, documents: false } }, signal())).toMatchObject({
      callId: 'call-7',
      request: { tools: true, images: false, documents: false },
    })
  })

  it('rejects naming provider.route when the first send overruns the budget', async () => {
    const SLOW = `export function register(on) { on('provider.route', async () => { await new Promise(r => setTimeout(r, 400)); return { provider: 'relay-a', model: 'm' } }) }`
    const router = createModProviderRouter(routerRuntime(SLOW, { budgetMs: 100 }), ROUTER, () => PEERS)
    await expect(router.route(first(), signal())).rejects.toThrow(/provider\.route for mod\.pool\.router/)
  })

  it('rejects on a throw at the first send, and reads a throw after a failure as no answer', async () => {
    const THROWS = `export function register(on) { on('provider.route', () => { throw new Error('no route today') }) }`
    const router = createModProviderRouter(routerRuntime(THROWS), ROUTER, () => PEERS)
    await expect(router.route(first(), signal())).rejects.toThrow(/provider\.route for mod\.pool\.router/)
    expect(await router.route(afterFailure(), signal())).toBeUndefined()
  })

  it('hands back no answer as undefined, and rejects when the module cannot start', async () => {
    const SILENT = `export function register(on) { on('provider.route', () => undefined) }`
    const router = createModProviderRouter(routerRuntime(SILENT), ROUTER, () => PEERS)
    expect(await router.route(first(), signal())).toBeUndefined()
    expect(await router.route(afterFailure(), signal())).toBeUndefined()
    const nobody = createModProviderRouter(routerRuntime(SILENT), 'mod.nobody.router', () => PEERS)
    await expect(nobody.route(first(), signal())).rejects.toThrow(/no provider module provides mod\.nobody\.router/)
  })

  it('ends a first send with no answer unsent, with one error naming provider.route', async () => {
    const SILENT = `export function register(on) { on('provider.route', () => undefined) }`
    registerProviderRouter(ROUTER, createModProviderRouter(routerRuntime(SILENT), ROUTER, () => PEERS), { routesTo: '*' })
    const requests: string[] = []
    const transport = {
      async request(req: any) {
        requests.push(req.route.action)
        return { ok: false, error: { message: 'unexpected' } }
      },
    } as unknown as BrowserBridgeTransport
    const wrapped = withModelProviders(transport, new DefaultRuntimeConfig({}))
    const ask = (id: string, action: string, payload: unknown) =>
      wrapped.request({ id, route: { capability: 'model', action }, payload } as never) as Promise<any>
    const started = await ask('r-silent', 'streamStart', {
      providerId: ROUTER,
      model: 'row',
      messages: [{ role: 'user', content: 'x' }],
      maxOutputTokens: 10,
      requestContext: CONTEXT,
    })
    const chunks: any[] = []
    for (let i = 0; i < 20; i += 1) {
      const read = await ask(`r-read-${i}`, 'streamRead', { streamId: started.result.streamId, waitMs: 2000 })
      chunks.push(...(read.result.chunks ?? []))
      if (read.result.done) break
    }
    const message = String(chunks.find(chunk => chunk.type === 'error')?.error?.message)
    expect(message).toContain(`provider.route of ${ROUTER}: it named no target; the request was not sent`)
    expect(message).not.toContain('the hook failed')
    expect(requests).not.toContain('rawStreamOpen')
  })

  it('reads the peers table once per call and hands the same table to every ask of it', async () => {
    let reads = 0
    const router = createModProviderRouter(routerRuntime(FIRST_FREE), ROUTER, () => {
      reads += 1
      return PEERS
    })
    const call = { ...CONTEXT } as RouteEvent['requestContext']
    await router.route(first(call), signal())
    await router.route(afterFailure(call), signal())
    expect(reads).toBe(1)
    await router.route(first({ ...CONTEXT } as RouteEvent['requestContext'], 'call-2'), signal())
    expect(reads).toBe(2)
  })

  it('shows a member that failed earlier in the call in its current state, and only in that call', async () => {
    const SEEN = `export function register(on) { on('provider.route', ($, e) => ({ provider: 'relay-b', model: 'm', states: e.peers.map(p => p.state.models.m?.status ?? 'ok') })) }`
    let reads = 0
    const states: Record<string, ProviderState> = {}
    const router = createModProviderRouter(
      routerRuntime(SEEN),
      ROUTER,
      () => {
        reads += 1
        return PEERS
      },
      id => states[id] ?? { models: {} },
    )
    const call = { ...CONTEXT } as RouteEvent['requestContext']
    const other = { ...CONTEXT } as RouteEvent['requestContext']
    states['relay-a'] = { models: { m: { status: 'cooling', until: Date.now() + 60_000 } } }
    // A first ask reads the table as it is, overlay or not.
    expect(await router.route(first(call), signal())).toMatchObject({ states: ['ok', 'ok'] })
    expect(await router.route(first(other, 'call-2'), signal())).toMatchObject({ states: ['ok', 'ok'] })
    expect(await router.route(afterFailure(call), signal())).toMatchObject({ states: ['cooling', 'ok'] })
    expect(reads).toBe(2)
    expect(PEERS[0]!.state).toEqual({ models: {} })
    // A member that has not failed in this call keeps the table's state.
    states['relay-b'] = { models: { m: { status: 'exhausted' } } }
    expect(await router.route({ ...afterFailure(call), attempt: 3 }, signal())).toMatchObject({ states: ['cooling', 'ok'] })
    // A new call starts from a fresh table and no overlay.
    states['relay-a'] = { models: {} }
    expect(await router.route(first(call, 'call-3'), signal())).toMatchObject({ states: ['ok', 'ok'] })
    expect(reads).toBe(3)
  })

  it('gives two calls without a request context a context each, so neither reads the other\'s peers', async () => {
    const seen: object[] = []
    registerProviderRouter(
      ROUTER,
      {
        route: async e => {
          seen.push(e.requestContext as object)
          return undefined
        },
      },
      { routesTo: '*' },
    )
    const transport = { request: async () => ({ ok: false, error: { message: 'unexpected' } }) } as unknown as BrowserBridgeTransport
    const wrapped = withModelProviders(transport, new DefaultRuntimeConfig({}))
    for (const id of ['c-1', 'c-2']) {
      const started = (await wrapped.request({
        id,
        route: { capability: 'model', action: 'streamStart' },
        payload: { providerId: ROUTER, model: 'row', messages: [{ role: 'user', content: 'x' }], maxOutputTokens: 10 },
      } as never)) as any
      await wrapped.request({ id: `${id}-read`, route: { capability: 'model', action: 'streamRead' }, payload: { streamId: started.result.streamId, waitMs: 2000 } } as never)
    }
    expect(seen).toHaveLength(2)
    expect(seen[0]).not.toBe(seen[1])
    expect(seen[0]).toMatchObject({ purpose: 'other', querySource: '' })
  })

  it('raises provider.outcome only in a module known to hook it, and never waits on it', async () => {
    const OUTCOME = `
      let told = 0
      export function register(on) {
        on('provider.route', () => ({ provider: 'relay-a', model: 'm', told }))
        on('provider.outcome', () => { told += 1 })
      }
    `
    const runtime = routerRuntime(OUTCOME)
    const router = createModProviderRouter(runtime, ROUTER, () => PEERS)
    const outcome = { provider: ROUTER, model: 'row', target: { provider: 'relay-a', model: 'm' }, ok: true, durationMs: 1 } as never
    // Before the module loaded it is not known to hook it: nothing starts.
    expect(router.outcome!(outcome)).toBeUndefined()
    expect(runtime.status()[0]!.state).toBe('cold')
    await router.route(first(), signal())
    router.outcome!(outcome)
    await sleep(50)
    expect(await router.route(first(), signal())).toMatchObject({ told: 1 })
  })
})

// ── the wiring ──────────────────────────────────────────────────────────────

function registration(manifest: Partial<ProviderManifest>): ProviderRegistration {
  const runtime = {
    hasHook: () => undefined,
    whenLoaded: async () => {},
    call: async () => ({ raised: true, value: { provider: 'relay-a', model: 'm' } }),
  }
  return { providerId: ROUTER, plugin: 'pool', manifest: manifest as ProviderManifest, runtime } as unknown as ProviderRegistration
}

describe('providerSeamListener for a router', () => {
  it('registers a router with its routesTo and declared retry, and no request seam; the cleanup removes it', () => {
    const retry = { attempts: 2, baseDelayMs: 10 }
    const cleanup = providerSeamListener(() => {}, undefined, () => PEERS)(
      registration({ kind: 'router', routesTo: ['relay-a'], policy: { retry } as never }),
    )
    expect(providerRouterFor(ROUTER)).toBeDefined()
    expect(providerRouterBoundsFor(ROUTER)).toEqual({ routesTo: ['relay-a'], retry })
    expect(providerRequestSeamFor(ROUTER)).toBeUndefined()
    cleanup?.()
    expect(providerRouterFor(ROUTER)).toBeUndefined()
  })

  it('declares no retry for a router that states none, so the platform default applies', () => {
    providerSeamListener(() => {})(registration({ kind: 'router', routesTo: '*' }))
    expect(providerRouterBoundsFor(ROUTER)).toEqual({ routesTo: '*' })
  })

  it('still gives a provider that is not a router a request seam and no router', () => {
    providerSeamListener(() => {})(registration({}))
    expect(providerRequestSeamFor(ROUTER)).toBeDefined()
    expect(providerRouterFor(ROUTER)).toBeUndefined()
  })
})

// ── the listing ─────────────────────────────────────────────────────────────

function manualTimers() {
  let pending: Array<{ fn: () => void; at: number }> = []
  let now = 0
  return {
    timers: {
      set: (fn: () => void, ms: number) => {
        const entry = { fn, at: now + ms }
        pending.push(entry)
        return entry
      },
      clear: (handle: unknown) => {
        pending = pending.filter(entry => entry !== handle)
      },
    },
    advance(ms: number) {
      now += ms
      const due = pending.filter(entry => entry.at <= now)
      pending = pending.filter(entry => entry.at > now)
      for (const entry of due) entry.fn()
    },
  }
}

describe('a router listing re-run', () => {
  it('runs once per 2 s burst of provider changes, and skips a router whose peers are unchanged', async () => {
    let fire: () => void = () => {}
    let peers = PEERS
    const relisted: string[] = []
    const clock = manualTimers()
    const relisting = startRouterRelisting({
      onProvidersChanged: listener => {
        fire = listener
        return () => {}
      },
      routerIds: () => [ROUTER],
      isSetUp: () => true,
      peersOf: () => peers,
      relist: async id => {
        relisted.push(id)
        noteRouterListing(id, peers)
      },
      report: () => {},
      timers: clock.timers,
    })
    noteRouterListing(ROUTER, PEERS)

    // A change that leaves the table as the last listing saw it: no listing.
    fire()
    clock.advance(2_000)
    await relisting.idle()
    expect(relisted).toEqual([])

    // A burst: one listing, 2 s after its last change.
    peers = [PEERS[0]!]
    fire()
    clock.advance(1_500)
    fire()
    clock.advance(1_500)
    await relisting.idle()
    expect(relisted).toEqual([])
    clock.advance(500)
    await relisting.idle()
    expect(relisted).toEqual([ROUTER])

    // A deep-equal copy of the table is no change.
    peers = structuredClone(peers)
    fire()
    clock.advance(2_000)
    await relisting.idle()
    expect(relisted).toEqual([ROUTER])

    // A member's health or usage moving is not a change of what the listing saw.
    peers = peers.map(peer => ({ ...peer, state: { status: 'cooling', until: 1_000 }, usage: { at: 5 } }) as unknown as Peer)
    fire()
    clock.advance(2_000)
    await relisting.idle()
    expect(relisted).toEqual([ROUTER])
    relisting.dispose()
  })

  it('never lists a router the person has not set up', async () => {
    let fire: () => void = () => {}
    const relisted: string[] = []
    const clock = manualTimers()
    const relisting = startRouterRelisting({
      onProvidersChanged: listener => {
        fire = listener
        return () => {}
      },
      routerIds: () => [ROUTER],
      isSetUp: () => false,
      peersOf: () => PEERS,
      relist: async id => {
        relisted.push(id)
      },
      report: () => {},
      timers: clock.timers,
    })
    fire()
    clock.advance(2_000)
    await relisting.idle()
    expect(relisted).toEqual([])
    relisting.dispose()
  })

  it('drops a wire on a router row, and says so once', () => {
    traced.length = 0
    const rows = [{ id: 'cheap', supportsTools: true, wire: { format: 'fixture-wire' } }, { id: 'fast', supportsTools: true, wire: { format: 'fixture-wire' } }]
    const parsed = parseModelsAnswer(ROUTER, rows, undefined, { router: true })
    expect(parsed.models.map(row => row.id)).toEqual(['cheap', 'fast'])
    expect(parsed.models.every(row => row.wire === undefined)).toBe(true)
    parseModelsAnswer(ROUTER, rows, undefined, { router: true })
    expect(traced.filter(line => line.includes('carries no wire'))).toHaveLength(1)
  })
})

// ── the health ledger ───────────────────────────────────────────────────────

const codec: ProviderDriver = {
  id: 'router-ledger-json',
  auth: { headers: {} },
  buildRequest: (_payload, context) => ({
    url: `${context.baseUrl}/v1/chat`,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode(JSON.stringify({ model: context.model })),
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

describe('a failed routed send', () => {
  beforeEach(() => {
    setRuntimeProviderConfigs({
      'relay-a': { isCustomProvider: true, apiKey: 'k', modelEntries: [{ family: 'm-a', version: '1', id: 'm-a' }] },
      'relay-b': { isCustomProvider: true, apiKey: 'k', modelEntries: [{ family: 'm-b', version: '1', id: 'm-b' }] },
    } as never)
  })

  it('leaves its target cooling in the next peers read', async () => {
    const ok = new TextEncoder().encode(
      [{ type: 'text_delta', text: 'hi' }, { type: 'finish', finishReason: 'stop' }].map(e => JSON.stringify(e)).join('\n') + '\n',
    )
    const served = new Map<string, { status: number; body: Uint8Array; reads: number }>()
    let n = 0
    const transport: BrowserBridgeTransport = {
      async request(req: any) {
        const action = req.route.action
        if (action === 'rawStreamOpen') {
          const refused = req.payload.providerId === 'relay-a'
          const id = `raw-${++n}`
          served.set(id, { status: refused ? 429 : 200, body: refused ? new TextEncoder().encode('slow down') : ok, reads: 0 })
          return { ok: true, result: { streamId: id, status: refused ? 429 : 200, statusText: 'S', finalUrl: req.payload.url, headers: {} } } as any
        }
        if (action === 'rawStreamCancel') return { ok: true, result: { ok: true } } as any
        const entry = served.get(req.payload.streamId)!
        entry.reads += 1
        return { ok: true, result: { done: true, chunk: entry.reads === 1 ? entry.body : new Uint8Array() } } as any
      },
    }
    registerProviderRouter(
      ROUTER,
      { route: async e => (e.lastFailure ? { provider: 'relay-b', model: 'm-b' } : { provider: 'relay-a', model: 'm-a' }) },
      { routesTo: '*' },
    )
    const config = new DefaultRuntimeConfig({
      providerDrivers: JSON.stringify({
        'relay-a': { format: 'router-ledger-json', baseUrl: 'https://a.vendor.example' },
        'relay-b': { format: 'router-ledger-json', baseUrl: 'https://b.vendor.example' },
      }),
    })
    const wrapped = withModelProviders(transport, config)
    const ask = (action: string, payload: unknown) =>
      wrapped.request({ id: `r-${++n}`, route: { capability: 'model', action }, payload } as never) as Promise<any>
    const started = await ask('streamStart', {
      providerId: ROUTER,
      model: 'row',
      messages: [{ role: 'user', content: 'x' }],
      maxOutputTokens: 100,
      requestContext: CONTEXT,
    })
    expect(started.ok).toBe(true)
    for (let i = 0; i < 20; i += 1) {
      const read = await ask('streamRead', { streamId: started.result.streamId, waitMs: 2000 })
      if (read.result.done) break
    }
    const table = runtimePeersTable(ROUTER)
    expect(table.find(peer => peer.id === 'relay-a')?.state.models['m-a']?.status).toBe('cooling')
    expect(table.find(peer => peer.id === 'relay-b')?.state).toEqual({ models: {} })
  })

  it('lets a router that skips the failed member and reads state stop once both members failed, not bounce', async () => {
    const sends: string[] = []
    let n = 0
    const transport: BrowserBridgeTransport = {
      async request(req: any) {
        const action = req.route.action
        if (action === 'rawStreamOpen') {
          sends.push(req.payload.providerId)
          return { ok: true, result: { streamId: `raw-${++n}`, status: 429, statusText: 'S', finalUrl: req.payload.url, headers: {} } } as any
        }
        if (action === 'rawStreamCancel') return { ok: true, result: { ok: true } } as any
        return { ok: true, result: { done: true, chunk: new TextEncoder().encode('slow down') } } as any
      },
    }
    const SKIPS_FAILED = `
      export function register(on) {
        on('provider.route', ($, e) => {
          const next = e.peers.find(p => p.connected && Object.keys(p.state.models).length === 0 && p.id !== e.lastFailure?.provider)
          return next ? { provider: next.id, model: next.id === 'relay-a' ? 'm-a' : 'm-b' } : { stop: true, message: 'all members failed' }
        })
      }
    `
    registerProviderRouter(ROUTER, createModProviderRouter(routerRuntime(SKIPS_FAILED), ROUTER, runtimePeersTable), {
      routesTo: '*',
    })
    const config = new DefaultRuntimeConfig({
      providerDrivers: JSON.stringify({
        'relay-a': { format: 'router-ledger-json', baseUrl: 'https://a.vendor.example' },
        'relay-b': { format: 'router-ledger-json', baseUrl: 'https://b.vendor.example' },
      }),
    })
    const wrapped = withModelProviders(transport, config)
    const ask = (action: string, payload: unknown) =>
      wrapped.request({ id: `r-${++n}`, route: { capability: 'model', action }, payload } as never) as Promise<any>
    const started = await ask('streamStart', {
      providerId: ROUTER,
      model: 'row',
      messages: [{ role: 'user', content: 'x' }],
      maxOutputTokens: 100,
      requestContext: { ...CONTEXT },
    })
    const chunks: any[] = []
    for (let i = 0; i < 40; i += 1) {
      const read = await ask('streamRead', { streamId: started.result.streamId, waitMs: 2000 })
      chunks.push(...(read.result.chunks ?? []))
      if (read.result.done) break
    }
    expect(sends).toEqual(['relay-a', 'relay-b'])
    expect(chunks.find(chunk => chunk.type === 'error')?.error?.route).toMatchObject({ stop: true })
  })
})
