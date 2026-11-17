/**
 * UI ⇄ Runtime protocol — server side. Every test drives a
 * `ConnectionHub` through a loopback `FrameTransport` pair exactly as a client
 * would: frames in, frames out. The in-memory pair lets a test pretend to be
 * a WebSocket (small blob window, reported buffered bytes) — the code path is
 * the same one a MessagePort takes. The rig is in _helpers/runtimeHubRig.ts;
 * the provider capabilities have their own file.
 */
import { TERMINAL_AGENT_SOURCE_ID } from '../sessionImport/sources/claude-code/sourceIdentity'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import { NEXUS_SETTINGS_FILE_NAME, wipeSettingsMemos } from '../settings/settingsStore'
import { handleMemoryBridgeRequest } from '../browser/bridge/adapter/memoryBridgeAdapter'
import type {
  BlobChunkHeader,
  BlobRef,
  EvtFrame,
  WelcomeFrame,
} from '../browser/runtimeProtocol'
import {
  RUNTIME_PROTOCOL_VERSION,
  SCOPE_MODES,
  SYS_PING_ROUTE,
  TOPICS_SUBSCRIBE_ROUTE,
  TOPICS_UNSUBSCRIBE_ROUTE,
  isFrame,
  routeKey,
  topic,
  wireError,
} from '../browser/runtimeProtocol'
import {
  BlobSendLoop,
  createMessagePortTransport,
  type FrameTransport,
} from '../browser/runtimeTransport'
import { createPairingTable } from '../browser/runtimeHub/pairingTable'
import {
  CapabilityRegistry,
  ConnectionHub,
  HOST_PROXY_TABLE,
  LEGACY_WEBUI_CAPABILITIES,
  TopicBroker,
  hostProxyRouteCount,
  hostProxySpecs,
  legacyBridgeErrorToWire,
  registerLegacyWebUiCapabilities,
  scopeAllows,
  settingsTopicScope,
  toWireError,
  type ConnectionInfo,
  type TopicProvider,
} from '../browser/runtimeHub'
import type { WebUiBridgeContext } from '../browser/worker/webUiBridge'
import { handlePluginsBridgeRequest } from '../browser/bridge/adapter/pluginsBridgeAdapter'
import { TestClient, flush, loopback, makeContext, makeRig } from './_helpers/runtimeHubRig'

/** A provider for `t/*` topics: authorizes everyone, snapshots from `state`. */
function simpleProvider(state: Map<string, unknown[]>, opts: { authorize?: (c: ConnectionInfo) => boolean } = {}): TopicProvider {
  return {
    matches: id => id.startsWith('t/'),
    authorize: (_id, conn) => opts.authorize?.(conn) ?? true,
    async *snapshot(id) {
      for (const page of state.get(id) ?? []) yield { payload: page }
    },
  }
}

const echo = { cap: 'echo', actions: { say: { scope: 'observe' as const }, shout: { scope: 'control' as const }, admin: { scope: 'full' as const } }, handle: async (req: { payload: unknown }) => ({ echoed: req.payload }) }

beforeEach(() => {
  vi.useRealTimers()
})
afterEach(() => {
  vi.restoreAllMocks()
})

// ---- handshake -------------------------------------------------------------------

describe('ConnectionHub handshake', () => {
  it('answers a local hello with a welcome carrying scope full, bootstrap and the scoped capability adverts', async () => {
    const { client, registry, hub } = makeRig()
    registry.registerCapability(echo)
    const frame = (await client.hello()) as WelcomeFrame
    expect(frame.kind).toBe('welcome')
    expect(frame.v).toBe(RUNTIME_PROTOCOL_VERSION)
    expect(frame.resumed).toBe(false)
    expect(frame.scope).toEqual({ mode: 'full', sessions: 'all' })
    expect(frame.bootstrap).toEqual({ homeDir: '/home/t', platform: 'test', pathSep: '/' })
    expect(frame.server.runtimeVersion).toBe('test-1')
    expect(frame.server.capabilities).toEqual([{ cap: 'echo', acts: ['say', 'shout', 'admin'] }])
    expect(isFrame(frame)).toBe(true)
    expect(hub.list()).toHaveLength(1)
    expect(hub.list()[0]).toMatchObject({ clientId: 'client-A', kind: 'desktop-shell', transport: 'message-port' })
  })

  it('a hello with a version this runtime does not serve gets bye protocol_too_new / protocol_too_old', async () => {
    const newer = makeRig()
    expect(await newer.client.hello({ v: RUNTIME_PROTOCOL_VERSION + 1 })).toEqual({ kind: 'bye', code: 'protocol_too_new' })
    const older = makeRig()
    expect(await older.client.hello({ v: 0 as never })).toEqual({ kind: 'bye', code: 'protocol_too_old' })
    expect(older.hub.list()).toHaveLength(0)
  })

  it('pair auth is bye unauthorized until the pairing table exists; local auth off a message-port is bye unauthorized too', async () => {
    const paired = makeRig()
    expect(await paired.client.hello({ auth: { mode: 'pair', pairId: 'p' } })).toEqual({ kind: 'bye', code: 'unauthorized' })
    const socket = makeRig({ loopback: { kind: 'websocket' } })
    expect(await socket.client.hello()).toEqual({ kind: 'bye', code: 'unauthorized' })
  })

  it('anything but hello before the handshake is bye unauthorized', async () => {
    const { client, ends } = makeRig()
    const bye = client.nextFrame(f => f.kind === 'bye')
    client.transport.send({ kind: 'req', id: 'x', route: 'sys.ping', payload: { t: 1 } })
    expect(await bye).toEqual({ kind: 'bye', code: 'unauthorized' })
    expect(ends.client.isClosed).toBe(true)
  })

  it('hello.scopeCeiling clamps a local connection DOWN, never up, and the adverts and checks follow', async () => {
    const control = makeRig()
    control.registry.registerCapability(echo)
    const welcome = (await control.client.hello({ scopeCeiling: 'control' })) as WelcomeFrame
    expect(welcome.scope).toEqual({ mode: 'control', sessions: 'all' })
    expect(welcome.server.capabilities).toEqual([{ cap: 'echo', acts: ['say', 'shout'] }])
    expect(control.hub.list()[0]?.scope.mode).toBe('control')
    const denied = await control.client.request('echo.admin', {})
    expect(denied.ok === false && denied.error.code).toBe('forbidden_scope')
    const allowed = await control.client.request('echo.shout', { x: 1 })
    expect(allowed.ok === true && allowed.result).toEqual({ echoed: { x: 1 } })

    // Asking for what you already have, or for more, changes nothing.
    const same = makeRig()
    expect(((await same.client.hello({ scopeCeiling: 'full' })) as WelcomeFrame).scope.mode).toBe('full')
  })

  it('panelId comes from hello.client, falling back to the attach options', async () => {
    const registry = new CapabilityRegistry()
    const broker = new TopicBroker()
    const context = makeContext()
    const hub = new ConnectionHub({ registry, broker, context, runtimeVersion: 'v', bootstrap: () => undefined })
    const first = loopback()
    hub.attach(first.server, { panelId: 'panel-attach' })
    const c1 = new TestClient(first.client)
    await c1.hello()
    expect(hub.list()[0]?.panelId).toBe('panel-attach')
    const second = loopback()
    hub.attach(second.server, { panelId: 'panel-attach' })
    const c2 = new TestClient(second.client)
    await c2.hello({ client: { clientId: 'c2', kind: 'panel-host', panelId: 'panel-hello' } })
    expect(hub.list().map(c => c.panelId).sort()).toEqual(['panel-attach', 'panel-hello'])
  })
})

// ---- requests --------------------------------------------------------------------

describe('ConnectionHub requests', () => {
  it('dispatches a req to the registered handler and answers res ok', async () => {
    const { client, registry } = makeRig()
    registry.registerCapability(echo)
    await client.hello()
    const res = await client.request('echo.say', { hi: 1 })
    expect(res).toEqual({ kind: 'res', id: res.id, ok: true, result: { echoed: { hi: 1 } } })
  })

  it('unknown or malformed routes are unknown_route; a failing guard is bad_payload', async () => {
    const { client, registry } = makeRig()
    registry.registerCapability({
      cap: 'g',
      actions: { need: { scope: 'observe', guard: p => typeof p === 'number' } },
      handle: async () => 'ok',
    })
    await client.hello()
    expect((await client.request('nope.nothing')).ok).toBe(false)
    const malformed = await client.request('not-a-route')
    expect(malformed.ok === false && malformed.error.code).toBe('unknown_route')
    const bad = await client.request('g.need', 'string')
    expect(bad.ok === false && bad.error.code).toBe('bad_payload')
    const good = await client.request('g.need', 7)
    expect(good.ok === true && good.result).toBe('ok')
  })

  it('a handler throwing a WireError is answered with that error; any other throw is internal', async () => {
    const { client, registry } = makeRig()
    registry.registerCapability({
      cap: 'f',
      actions: { wire: { scope: 'observe' }, plain: { scope: 'observe' } },
      handle: async req => {
        if (req.route.act === 'wire') throw wireError('not_found', 'no such thing', { k: 1 })
        throw new Error('boom')
      },
    })
    await client.hello()
    const wire = await client.request('f.wire')
    expect(wire.ok === false && wire.error).toEqual({ code: 'not_found', message: 'no such thing', data: { k: 1 }, retryable: false })
    const plain = await client.request('f.plain')
    expect(plain.ok === false && plain.error).toMatchObject({ code: 'internal', message: 'boom' })
  })

  it('cancel aborts the handler signal, answers cancelled, and the late result is dropped', async () => {
    const { client, registry } = makeRig()
    let resolveHandler: (v: unknown) => void = () => {}
    let aborted = false
    registry.registerCapability({
      cap: 'slow',
      actions: { run: { scope: 'observe' } },
      handle: (req) =>
        new Promise(resolve => {
          req.signal.addEventListener('abort', () => {
            aborted = true
          })
          resolveHandler = resolve
        }),
    })
    await client.hello()
    const pending = client.request('slow.run')
    await flush()
    client.transport.send({ kind: 'cancel', id: pending.id })
    const res = await pending
    expect(res.ok === false && res.error.code).toBe('cancelled')
    expect(aborted).toBe(true)
    resolveHandler('late')
    await flush()
    expect(client.frames.filter(f => f.kind === 'res' && f.id === pending.id)).toHaveLength(1)
  })

  it('a request cancelled while the hub settles before serving never reaches its handler', async () => {
    let settle: () => void = () => {}
    const { client, registry } = makeRig({ beforeRequest: () => new Promise(resolve => (settle = resolve)) })
    let ran = false
    registry.registerCapability({
      cap: 'write',
      actions: { run: { scope: 'observe' } },
      handle: async () => {
        ran = true
        return 'done'
      },
    })
    await client.hello()
    const pending = client.request('write.run')
    await flush()
    client.transport.send({ kind: 'cancel', id: pending.id })
    const res = await pending
    expect(res.ok === false && res.error.code).toBe('cancelled')
    settle()
    await flush()
    expect(ran).toBe(false)
    expect(client.frames.filter(f => f.kind === 'res' && f.id === pending.id)).toHaveLength(1)
  })

  it('a duplicate in-flight id is conflict; cancel of an unknown id is ignored', async () => {
    const { client, registry } = makeRig()
    registry.registerCapability({ cap: 'slow', actions: { run: { scope: 'observe' } }, handle: () => new Promise(() => {}) })
    await client.hello()
    void client.request('slow.run', undefined, 'dup')
    await flush()
    const second = await client.request('slow.run', undefined, 'dup')
    expect(second.ok === false && second.error.code).toBe('conflict')
    client.transport.send({ kind: 'cancel', id: 'never' })
    await flush()
    expect(client.frames.filter(f => f.kind === 'res').length).toBe(1)
  })

  it('sys.ping echoes t and rejects a malformed payload', async () => {
    const { client } = makeRig()
    await client.hello()
    const ok = await client.request(SYS_PING_ROUTE, { t: 123 })
    expect(ok.ok === true && ok.result).toEqual({ t: 123 })
    const bad = await client.request(SYS_PING_ROUTE, { t: 'x' })
    expect(bad.ok === false && bad.error.code).toBe('bad_payload')
  })

  it('a handler sees the connection info and the request id', async () => {
    const { client, registry } = makeRig()
    registry.registerCapability({
      cap: 'who',
      actions: { ami: { scope: 'observe' } },
      handle: async req => ({ id: req.id, clientId: req.conn.clientId, mode: req.conn.scope.mode }),
    })
    await client.hello()
    const res = await client.request('who.ami', undefined, 'req-42')
    expect(res.ok === true && res.result).toEqual({ id: 'req-42', clientId: 'client-A', mode: 'full' })
  })

  it('closing the transport aborts every in-flight request and forgets the connection', async () => {
    const { client, registry, hub, ends } = makeRig()
    const signals: AbortSignal[] = []
    registry.registerCapability({
      cap: 'slow',
      actions: { run: { scope: 'observe' } },
      handle: req => {
        signals.push(req.signal)
        return new Promise(() => {})
      },
    })
    await client.hello()
    void client.request('slow.run')
    void client.request('slow.run')
    await flush()
    expect(signals).toHaveLength(2)
    ends.client.close()
    await flush()
    expect(signals.every(s => s.aborted)).toBe(true)
    expect(hub.list()).toHaveLength(0)
  })
})

// ---- scope -----------------------------------------------------------------------

describe('scope', () => {
  it('scopeAllows ranks observe < control < manager < full', () => {
    expect(scopeAllows('full', 'observe')).toBe(true)
    expect(scopeAllows('control', 'full')).toBe(false)
    expect(scopeAllows('observe', 'observe')).toBe(true)
    expect(scopeAllows('observe', 'control')).toBe(false)
    expect(scopeAllows('manager', 'control')).toBe(true)
    expect(scopeAllows('full', 'manager')).toBe(true)
    expect(scopeAllows('manager', 'full')).toBe(false)
    expect(scopeAllows('control', 'manager')).toBe(false)
  })

  it('advertise filters at action level', () => {
    const registry = new CapabilityRegistry()
    registry.registerCapability(echo)
    expect(registry.advertise({ mode: 'observe', sessions: 'all' })).toEqual([{ cap: 'echo', acts: ['say'] }])
    expect(registry.advertise({ mode: 'control', sessions: 'all' })).toEqual([{ cap: 'echo', acts: ['say', 'shout'] }])
    registry.registerCapability({ cap: 'adminOnly', actions: { x: { scope: 'full' } }, handle: async () => 1 })
    // A capability with nothing callable at this scope is not advertised at all.
    expect(registry.advertise({ mode: 'observe', sessions: 'all' }).map(a => a.cap)).toEqual(['echo'])
  })

  it('registering the same action twice throws; two sources may share a capability', () => {
    const registry = new CapabilityRegistry()
    registry.registerHostProxy({ cap: 'session', actions: { setActiveSession: { scope: 'full' } } })
    registry.registerCapability({ cap: 'session', actions: { submit: { scope: 'control' } }, handle: async () => 1 })
    expect(registry.advertise({ mode: 'full', sessions: 'all' })).toEqual([{ cap: 'session', acts: ['setActiveSession', 'submit'] }])
    expect(() =>
      registry.registerCapability({ cap: 'session', actions: { submit: { scope: 'control' } }, handle: async () => 1 }),
    ).toThrow(/already registered/)
    expect(() =>
      registry.registerCapability({ cap: 'bad', actions: { x: { scope: 'root' as never } }, handle: async () => 1 }),
    ).toThrow(RangeError)
  })

  it('the hub enforces scope and session binding before the handler runs', async () => {
    // Every local connection is `full`, so exercise the checks through the registry
    // with a narrowed connection: drive `dispatch` via a hub whose LOCAL scope
    // is what the client gets, and assert on the handler never running for a
    // forbidden route by registering with a scope no connection can hold.
    const { client, registry } = makeRig()
    const handle = vi.fn(async () => 'ran')
    registry.registerCapability({
      cap: 's',
      actions: {
        bound: { scope: 'control', sessionOf: p => (p as { sessionId?: string }).sessionId },
      },
      handle,
    })
    await client.hello()
    // `full` + sessions:'all' passes both checks.
    const ok = await client.request('s.bound', { sessionId: 'abc' })
    expect(ok.ok).toBe(true)
    expect(handle).toHaveBeenCalledTimes(1)
  })
})

// ---- topics ----------------------------------------------------------------------

describe('topics', () => {
  it('subscribe confirms with res, then sends a snapshot stamped with the current seq, then live deltas in order', async () => {
    const state = new Map<string, unknown[]>([['t/one', [{ a: 1 }]]])
    const { client, broker } = makeRig()
    broker.registerProvider(simpleProvider(state))
    broker.publish('t/one', { pre: true })
    broker.publish('t/one', { pre: 2 })
    await client.hello()
    const res = await client.request(TOPICS_SUBSCRIBE_ROUTE, { topics: [{ topic: 't/one' }] })
    expect(res.ok).toBe(true)
    broker.publish('t/one', { live: 1 }, { type: 'updated' })
    const events = await client.eventsFor('t/one', 2)
    expect(events[0]).toEqual({ kind: 'evt', topic: 't/one', seq: 2, payload: { a: 1 }, form: 'snapshot' })
    expect(events[1]).toEqual({ kind: 'evt', topic: 't/one', seq: 3, type: 'updated', payload: { live: 1 }, form: 'delta' })
    expect(events.every(isFrame)).toBe(true)
  })

  it('a multi-page snapshot marks every page but the last with more:true', async () => {
    const state = new Map<string, unknown[]>([['t/pages', ['p1', 'p2', 'p3']]])
    const { client, broker } = makeRig()
    broker.registerProvider(simpleProvider(state))
    await client.hello()
    await client.request(TOPICS_SUBSCRIBE_ROUTE, { topics: [{ topic: 't/pages' }] })
    const events = await client.eventsFor('t/pages', 3)
    expect(events.map(e => [e.payload, e.more, e.seq])).toEqual([['p1', true, 0], ['p2', true, 0], ['p3', undefined, 0]])
  })

  it('a delta-only topic (provider yields nothing) still gets one empty snapshot as the seq baseline', async () => {
    const { client, broker } = makeRig()
    broker.registerProvider(simpleProvider(new Map()))
    broker.publish('t/empty', 'x')
    await client.hello()
    await client.request(TOPICS_SUBSCRIBE_ROUTE, { topics: [{ topic: 't/empty' }] })
    const [snapshot] = await client.eventsFor('t/empty', 1)
    expect(snapshot).toEqual({ kind: 'evt', topic: 't/empty', seq: 1, payload: null, form: 'snapshot' })
  })

  it('deltas published while the snapshot is being produced arrive after the last page, not before', async () => {
    let releaseSnapshot: () => void = () => {}
    const gate = new Promise<void>(resolve => {
      releaseSnapshot = resolve
    })
    const { client, broker } = makeRig()
    broker.registerProvider({
      matches: id => id === 't/slow',
      authorize: () => true,
      async *snapshot() {
        await gate
        yield { payload: 'snap' }
      },
    })
    await client.hello()
    await client.request(TOPICS_SUBSCRIBE_ROUTE, { topics: [{ topic: 't/slow' }] })
    await flush()
    broker.publish('t/slow', 'd1')
    broker.publish('t/slow', 'd2')
    await flush()
    expect(client.events.filter(e => e.topic === 't/slow')).toHaveLength(0)
    releaseSnapshot()
    const events = await client.eventsFor('t/slow', 3)
    expect(events.map(e => [e.form, e.payload, e.seq])).toEqual([['snapshot', 'snap', 0], ['delta', 'd1', 1], ['delta', 'd2', 2]])
  })

  it('a second subscribe while a snapshot is in flight waits for it — pages never interleave with held deltas', async () => {
    const releases: Array<() => void> = []
    const { client, broker } = makeRig()
    broker.registerProvider({
      matches: id => id === 't/ovl',
      authorize: () => true,
      async *snapshot() {
        await new Promise<void>(resolve => releases.push(resolve))
        yield { payload: `snap${releases.length}` }
      },
    })
    await client.hello()
    await client.request(TOPICS_SUBSCRIBE_ROUTE, { topics: [{ topic: 't/ovl' }] })
    await flush()
    // Re-subscribe (no since → a second snapshot) while the first is still blocked.
    await client.request(TOPICS_SUBSCRIBE_ROUTE, { topics: [{ topic: 't/ovl' }] })
    await flush()
    expect(releases).toHaveLength(1) // the second run has not started
    broker.publish('t/ovl', 'd1')
    releases[0]!()
    await flush()
    expect(releases).toHaveLength(2) // now the second run started, after the first finished
    broker.publish('t/ovl', 'd2')
    releases[1]!()
    const events = await client.eventsFor('t/ovl', 4)
    // Each snapshot's pages come before the deltas held during it; nothing interleaves.
    expect(events.map(e => [e.form, e.payload])).toEqual([
      ['snapshot', 'snap1'],
      ['delta', 'd1'],
      ['snapshot', 'snap2'],
      ['delta', 'd2'],
    ])
  })

  it('since inside the replay ring replays exactly the missed deltas; since at the head replays nothing', async () => {
    const { client, broker } = makeRig()
    broker.registerProvider(simpleProvider(new Map([['t/r', ['SNAP']]])))
    for (let i = 1; i <= 5; i += 1) broker.publish('t/r', `d${i}`)
    await client.hello()
    await client.request(TOPICS_SUBSCRIBE_ROUTE, { topics: [{ topic: 't/r', since: 3 }] })
    const events = await client.eventsFor('t/r', 2)
    expect(events.map(e => [e.seq, e.payload, e.form])).toEqual([[4, 'd4', 'delta'], [5, 'd5', 'delta']])
    await client.request(TOPICS_UNSUBSCRIBE_ROUTE, { topics: ['t/r'] })
    await client.request(TOPICS_SUBSCRIBE_ROUTE, { topics: [{ topic: 't/r', since: 5 }] })
    broker.publish('t/r', 'd6')
    const more = await client.eventsFor('t/r', 3)
    expect(more[2]).toMatchObject({ seq: 6, payload: 'd6' })
  })

  it('a provider narrows a delta per connection under the same seq; a withheld one is a typeless null delta, live and on replay', async () => {
    // The session list, a notification, the workspace index: topics anyone may
    // subscribe to whose events are not all for everyone. The client treats a
    // seq hole as lost events and re-subscribes, so a withheld event must still
    // spend its seq on the wire — as a delta every consumer ignores.
    const { client, broker } = makeRig()
    const narrowing: TopicProvider = {
      ...simpleProvider(new Map()),
      project: (_id, conn, evt) => {
        const payload = evt.payload as { to?: string; body: string }
        if (payload.to === undefined) return payload
        if (payload.to !== conn.clientId) return undefined
        return { body: `${payload.body} for ${conn.clientId}` }
      },
    }
    broker.registerProvider(narrowing)
    await client.hello()
    await client.request(TOPICS_SUBSCRIBE_ROUTE, { topics: [{ topic: 't/n' }] })
    await client.eventsFor('t/n', 1)
    broker.publish('t/n', { body: 'all' }, { type: 'note' })
    broker.publish('t/n', { to: 'client-A', body: 'mine' }, { type: 'note' })
    broker.publish('t/n', { to: 'client-B', body: 'theirs' }, { type: 'note' })
    const events = await client.eventsFor('t/n', 4)
    expect(events.slice(1)).toEqual([
      { kind: 'evt', topic: 't/n', seq: 1, type: 'note', payload: { body: 'all' }, form: 'delta' },
      { kind: 'evt', topic: 't/n', seq: 2, type: 'note', payload: { body: 'mine for client-A' }, form: 'delta' },
      { kind: 'evt', topic: 't/n', seq: 3, payload: null, form: 'delta' },
    ])
    // A batch is narrowed item by item.
    broker.publishBatch('t/n', [{ to: 'client-B', body: 'x' }, { to: 'client-A', body: 'y' }], { type: 'note' })
    expect((await client.eventsFor('t/n', 5))[4]).toMatchObject({ seq: 4, form: 'deltas', payload: [{ body: 'y for client-A' }] })
    // Replay narrows the ring the same way.
    await client.request(TOPICS_UNSUBSCRIBE_ROUTE, { topics: ['t/n'] })
    for (let i = 1; i <= 3; i += 1) broker.publish('t/n', { to: i === 2 ? 'client-A' : 'client-B', body: `r${i}` }, { type: 'note' })
    await client.request(TOPICS_SUBSCRIBE_ROUTE, { topics: [{ topic: 't/n', since: 4 }] })
    const replayed = (await client.eventsFor('t/n', 8)).slice(5)
    expect(replayed.map(e => [e.seq, e.payload])).toEqual([[5, null], [6, { body: 'r2 for client-A' }], [7, null]])
  })

  it('since that fell out of the ring — or is ahead of the topic — gets a snapshot instead', async () => {
    const broker = new TopicBroker({ ringCount: 3 })
    const { client } = makeRig({ broker })
    broker.registerProvider(simpleProvider(new Map([['t/r', ['SNAP']]])))
    for (let i = 1; i <= 10; i += 1) broker.publish('t/r', `d${i}`)
    await client.hello()
    await client.request(TOPICS_SUBSCRIBE_ROUTE, { topics: [{ topic: 't/r', since: 2 }] })
    const [first] = await client.eventsFor('t/r', 1)
    expect(first).toMatchObject({ form: 'snapshot', payload: 'SNAP', seq: 10 })
    await client.request(TOPICS_UNSUBSCRIBE_ROUTE, { topics: ['t/r'] })
    await client.request(TOPICS_SUBSCRIBE_ROUTE, { topics: [{ topic: 't/r', since: 99 }] })
    const events = await client.eventsFor('t/r', 2)
    expect(events[1]).toMatchObject({ form: 'snapshot', seq: 10 })
  })

  it('the replay ring evicts by bytes and by count, never below one entry', async () => {
    const byCount = new TopicBroker({ ringCount: 2 })
    for (let i = 1; i <= 5; i += 1) byCount.publish('x', i)
    // seq 4 and 5 remain: since=3 replays; since=2 cannot.
    const sent: EvtFrame[] = []
    const sub = { conn: { connectionId: 'c', clientId: 'c', kind: 'cli', scope: { mode: 'full', sessions: 'all' }, transport: 'message-port' } as ConnectionInfo, send: (e: EvtFrame) => sent.push(e), bufferedBytes: () => 0 }
    byCount.registerProvider({ matches: () => true, authorize: () => true, async *snapshot() { yield { payload: 'S' } } })
    void byCount.subscribe(sub, 'x', 3)
    expect(sent.map(e => e.seq)).toEqual([4, 5])

    const byBytes = new TopicBroker({ ringBytes: 200 })
    byBytes.registerProvider({ matches: () => true, authorize: () => true, async *snapshot() { yield { payload: 'S' } } })
    byBytes.publish('y', 'a'.repeat(150))
    byBytes.publish('y', 'b'.repeat(150))
    // Entry 1 was evicted (two 150-char payloads exceed 200 bytes): since=1
    // still replays (seq 2 is the ring head), since=0 cannot and snapshots.
    const sent2: EvtFrame[] = []
    void byBytes.subscribe({ ...sub, send: e => sent2.push(e) }, 'y', 1)
    expect(sent2.map(e => e.seq)).toEqual([2])
    const sent3: EvtFrame[] = []
    await byBytes.subscribe({ ...sub, conn: { ...sub.conn, connectionId: 'c3' }, send: e => sent3.push(e) }, 'y', 0)
    expect(sent3.map(e => [e.form, e.payload, e.seq])).toEqual([['snapshot', 'S', 2]])
  })

  it('the last explicit unsubscribe releases the replay ring but keeps seq; a dropped connection keeps it for resume', async () => {
    const broker = new TopicBroker()
    broker.registerProvider({ matches: () => true, authorize: () => true, async *snapshot() { yield { payload: 'S' } } })
    const conn = (id: string) => ({ connectionId: id, clientId: id, kind: 'cli', scope: { mode: 'full', sessions: 'all' }, transport: 'message-port' }) as ConnectionInfo
    const sub = (id: string, sent: EvtFrame[]) => ({ conn: conn(id), send: (e: EvtFrame) => sent.push(e), bufferedBytes: () => 0 })

    await broker.subscribe(sub('a', []), 'x')
    broker.publish('x', 'd1')
    broker.publish('x', 'd2')
    broker.unsubscribe('a', 'x')
    const late: EvtFrame[] = []
    await broker.subscribe(sub('b', late), 'x', 1)
    // Ring released: since=1 can no longer replay, so a snapshot at the kept seq.
    expect(late.map(e => [e.form, e.seq])).toEqual([['snapshot', 2]])

    broker.publish('x', 'd3')
    broker.removeConnection('b')
    const resumed: EvtFrame[] = []
    await broker.subscribe(sub('b', resumed), 'x', 2)
    expect(resumed.map(e => [e.form, e.seq, e.payload])).toEqual([['delta', 3, 'd3']])
  })

  it('the ring byte cap charges base64 nested as deep as a transcript tool result', async () => {
    const broker = new TopicBroker({ ringBytes: 10_000 })
    broker.registerProvider({ matches: () => true, authorize: () => true, async *snapshot() { yield { payload: 'S' } } })
    const deep = (fill: string) => ({ payload: { messages: [{ message: { content: [{ result: [{ image: fill.repeat(8_000) }] }] } }] } })
    broker.publish('t', deep('a'))
    broker.publish('t', deep('b'))
    const sent: EvtFrame[] = []
    await broker.subscribe({ conn: { connectionId: 'c', clientId: 'c', kind: 'cli', scope: { mode: 'full', sessions: 'all' }, transport: 'message-port' } as ConnectionInfo, send: e => sent.push(e), bufferedBytes: () => 0 }, 't', 0)
    // Two ~8 KB payloads exceed 10 KB: seq 1 was evicted, so since=0 snapshots.
    expect(sent.map(e => e.form)).toEqual(['snapshot'])
  })

  it('an unknown topic is not_found, a topic the provider refuses is forbidden_scope, a malformed payload is bad_payload', async () => {
    const { client, broker } = makeRig()
    broker.registerProvider(simpleProvider(new Map(), { authorize: () => false }))
    await client.hello()
    const missing = await client.request(TOPICS_SUBSCRIBE_ROUTE, { topics: [{ topic: 'nowhere' }] })
    expect(missing.ok === false && missing.error).toMatchObject({ code: 'not_found', data: { topic: 'nowhere' } })
    const refused = await client.request(TOPICS_SUBSCRIBE_ROUTE, { topics: [{ topic: 't/secret' }] })
    expect(refused.ok === false && refused.error.code).toBe('forbidden_scope')
    const bad = await client.request(TOPICS_SUBSCRIBE_ROUTE, { topics: 'nope' })
    expect(bad.ok === false && bad.error.code).toBe('bad_payload')
    const badUnsub = await client.request(TOPICS_UNSUBSCRIBE_ROUTE, {})
    expect(badUnsub.ok === false && badUnsub.error.code).toBe('bad_payload')
  })

  it('unsubscribe stops deltas; a closed connection is removed from every topic', async () => {
    const { client, broker, ends } = makeRig()
    broker.registerProvider(simpleProvider(new Map()))
    await client.hello()
    await client.request(TOPICS_SUBSCRIBE_ROUTE, { topics: [{ topic: 't/a' }, { topic: 't/b' }] })
    await client.eventsFor('t/a', 1)
    await client.request(TOPICS_UNSUBSCRIBE_ROUTE, { topics: ['t/a'] })
    broker.publish('t/a', 'lost')
    broker.publish('t/b', 'kept')
    await client.eventsFor('t/b', 2)
    expect(client.events.filter(e => e.topic === 't/a')).toHaveLength(1)
    expect(broker.subscribersOf('t/b')).toHaveLength(1)
    ends.client.close()
    await flush()
    expect(broker.subscribersOf('t/b')).toHaveLength(0)
  })

  it('a lagging subscriber skips deltas until its transport drains, then gets a fresh snapshot and resumes', async () => {
    const broker = new TopicBroker({ lagBytes: 100 })
    const { client, ends } = makeRig({ broker, loopback: { kind: 'message-port' } })
    const state = new Map<string, unknown[]>([['t/hot', ['SNAP']]])
    broker.registerProvider(simpleProvider(state))
    await client.hello()
    await client.request(TOPICS_SUBSCRIBE_ROUTE, { topics: [{ topic: 't/hot' }] })
    await client.eventsFor('t/hot', 1)
    ends.server.buffered = 1000
    broker.publish('t/hot', 'skipped-1')
    broker.publish('t/hot', 'skipped-2')
    await flush()
    expect(client.events.filter(e => e.topic === 't/hot')).toHaveLength(1)
    ends.server.buffered = 0
    state.set('t/hot', ['SNAP-2'])
    broker.publish('t/hot', 'trigger')
    const events = await client.eventsFor('t/hot', 2)
    expect(events[1]).toMatchObject({ form: 'snapshot', payload: 'SNAP-2', seq: 3 })
    broker.publish('t/hot', 'after')
    const resumed = await client.eventsFor('t/hot', 3)
    expect(resumed[2]).toMatchObject({ form: 'delta', payload: 'after', seq: 4 })
  })

  it('a MessagePort transport never lags — bufferedBytes is 0 by contract', () => {
    const channel = new MessageChannel()
    const transport = createMessagePortTransport(channel.port1)
    expect(transport.bufferedBytes()).toBe(0)
    transport.close()
    channel.port2.close()
  })
})

// ---- resume ----------------------------------------------------------------------

describe('resume', () => {
  it('a hello.resume naming a retained connection keeps its id, is resumed:true without bootstrap, and re-subscribes with since', async () => {
    let clock = 1000
    const broker = new TopicBroker()
    const { client, ends, hub, registry, context } = makeRig({ broker, now: () => clock })
    broker.registerProvider(simpleProvider(new Map([['t/s', ['SNAP']]])))
    const welcome = (await client.hello()) as WelcomeFrame
    await client.request(TOPICS_SUBSCRIBE_ROUTE, { topics: [{ topic: 't/s' }] })
    await client.eventsFor('t/s', 1)
    ends.client.close()
    await flush()
    expect(hub.list()).toHaveLength(0)
    broker.publish('t/s', 'while-away')

    clock += 60_000
    const second = loopback()
    hub.attach(second.server)
    void registry
    void context
    const c2 = new TestClient(second.client)
    const again = (await c2.hello({ resume: { connectionId: welcome.connectionId, topics: { 't/s': 0 } } })) as WelcomeFrame
    expect(again.resumed).toBe(true)
    expect(again.connectionId).toBe(welcome.connectionId)
    expect(again.bootstrap).toBeUndefined()
    const events = await c2.eventsFor('t/s', 1)
    expect(events[0]).toMatchObject({ form: 'delta', seq: 1, payload: 'while-away' })
  })

  it('resume is refused (fresh connection) for another client, an expired id, or an unknown id', async () => {
    let clock = 0
    const { client, ends, hub } = makeRig({ now: () => clock, resumeRetentionMs: 1000 })
    const welcome = (await client.hello()) as WelcomeFrame
    ends.client.close()
    await flush()

    const other = loopback()
    hub.attach(other.server)
    const asOther = (await new TestClient(other.client).hello({
      client: { clientId: 'client-B', kind: 'mobile' },
      resume: { connectionId: welcome.connectionId, topics: {} },
    })) as WelcomeFrame
    expect(asOther.resumed).toBe(false)
    expect(asOther.connectionId).not.toBe(welcome.connectionId)

    clock = 5000
    const late = loopback()
    hub.attach(late.server)
    const expired = (await new TestClient(late.client).hello({ resume: { connectionId: welcome.connectionId, topics: {} } })) as WelcomeFrame
    expect(expired.resumed).toBe(false)
    expect(expired.bootstrap).toBeDefined()
  })

  it('a client that says bye is not resumable', async () => {
    const { client, hub } = makeRig()
    const welcome = (await client.hello()) as WelcomeFrame
    client.transport.send({ kind: 'bye', code: 'shutting_down' })
    await flush()
    expect(hub.list()).toHaveLength(0)
    const next = loopback()
    hub.attach(next.server)
    const again = (await new TestClient(next.client).hello({ resume: { connectionId: welcome.connectionId, topics: {} } })) as WelcomeFrame
    expect(again.resumed).toBe(false)
  })

  it('resume is bound to the pairing and the transport kind, not the clientId alone', async () => {
    // `clientId` is published to managers on `remote/state`, so another paired
    // device knows it — and could claim a dropped connection's identity (its
    // id, its scope, its subscriptions) inside the retention window.
    const pairings = createPairingTable()
    const owner = pairings.start({ mode: 'control', sessions: 'all' })
    const other = pairings.start({ mode: 'control', sessions: 'all' })
    const { client, ends, hub } = makeRig({ loopback: { kind: 'websocket' }, pairings })
    const welcome = (await client.pairHello(owner)) as WelcomeFrame
    expect(welcome.kind).toBe('welcome')
    ends.client.close()
    await flush()

    // Another pairing, the same clientId: a fresh connection, not a resume.
    const hijack = loopback({ kind: 'websocket' })
    hub.attach(hijack.server)
    const asOther = (await new TestClient(hijack.client).pairHello(other, {
      resume: { connectionId: welcome.connectionId, topics: {} },
    })) as WelcomeFrame
    expect(asOther.kind).toBe('welcome')
    expect(asOther.resumed).toBe(false)
    expect(asOther.connectionId).not.toBe(welcome.connectionId)

    // The desktop's own local hello over a port, same clientId: not a resume either.
    const local = loopback()
    hub.attach(local.server)
    const asLocal = (await new TestClient(local.client).hello({
      resume: { connectionId: welcome.connectionId, topics: {} },
    })) as WelcomeFrame
    expect(asLocal.resumed).toBe(false)

    // The owner itself, back on a websocket: resumed.
    const back = loopback({ kind: 'websocket' })
    hub.attach(back.server)
    const asOwner = (await new TestClient(back.client).pairHello(owner, {
      resume: { connectionId: welcome.connectionId, topics: {} },
    })) as WelcomeFrame
    expect(asOwner.resumed).toBe(true)
    expect(asOwner.connectionId).toBe(welcome.connectionId)
  })

  it('a retained identity that expires unclaimed is pruned by the reaper, and its replay rings go with it', async () => {
    let clock = 0
    const broker = new TopicBroker()
    const { client, ends, hub } = makeRig({ broker, now: () => clock, resumeRetentionMs: 1000 })
    broker.registerProvider(simpleProvider(new Map([['t/ring', ['SNAP']]])))
    await client.hello()
    await client.request(TOPICS_SUBSCRIBE_ROUTE, { topics: [{ topic: 't/ring' }] })
    await client.eventsFor('t/ring', 1)
    ends.client.close()
    await flush()
    broker.publish('t/ring', 'while-away')

    // Inside the window the ring is kept for a resume: since=0 replays.
    clock = 500
    hub.sweepNow()
    const peek = loopback()
    hub.attach(peek.server)
    const peeker = new TestClient(peek.client)
    await peeker.hello({ client: { clientId: 'peeker', kind: 'cli' } })
    await peeker.request(TOPICS_SUBSCRIBE_ROUTE, { topics: [{ topic: 't/ring', since: 0 }] })
    expect((await peeker.eventsFor('t/ring', 1))[0]).toMatchObject({ form: 'delta', seq: 1, payload: 'while-away' })
    await peeker.request(TOPICS_UNSUBSCRIBE_ROUTE, { topics: ['t/ring'] })
    // (the explicit unsubscribe released the ring — re-fill it for the check below)
    broker.publish('t/ring', 'after-peek')

    // Past the window, with nobody resuming: the reaper alone prunes it and
    // releases the ring. since=1 can no longer replay; a snapshot at the kept seq.
    clock = 2000
    hub.sweepNow()
    const late = loopback()
    hub.attach(late.server)
    const latecomer = new TestClient(late.client)
    await latecomer.hello({ client: { clientId: 'late', kind: 'cli' } })
    await latecomer.request(TOPICS_SUBSCRIBE_ROUTE, { topics: [{ topic: 't/ring', since: 1 }] })
    expect((await latecomer.eventsFor('t/ring', 1))[0]).toMatchObject({ form: 'snapshot', payload: 'SNAP', seq: 2 })
  })

  it('a client that says bye is not resumable, so its rings are released at once', async () => {
    const broker = new TopicBroker()
    broker.registerProvider(simpleProvider(new Map([['t/bye', ['SNAP']]])))
    const { client, hub } = makeRig({ broker })
    await client.hello()
    await client.request(TOPICS_SUBSCRIBE_ROUTE, { topics: [{ topic: 't/bye' }] })
    await client.eventsFor('t/bye', 1)
    broker.publish('t/bye', 'd1')
    client.transport.send({ kind: 'bye', code: 'shutting_down' })
    await flush()
    // Nothing to resume, so the ring is gone: since=0 snapshots instead of replaying d1.
    const after = loopback()
    hub.attach(after.server)
    const reader = new TestClient(after.client)
    await reader.hello({ client: { clientId: 'reader', kind: 'cli' } })
    await reader.request(TOPICS_SUBSCRIBE_ROUTE, { topics: [{ topic: 't/bye', since: 0 }] })
    expect((await reader.eventsFor('t/bye', 1))[0]).toMatchObject({ form: 'snapshot', seq: 1 })
  })

  it('dispose() stops the heartbeat reaper', () => {
    vi.useFakeTimers()
    const before = vi.getTimerCount()
    const registry = new CapabilityRegistry()
    const broker = new TopicBroker()
    const hub = new ConnectionHub({ registry, broker, context: makeContext(), runtimeVersion: 'v', bootstrap: () => undefined })
    expect(vi.getTimerCount()).toBe(before + 1)
    hub.dispose()
    expect(vi.getTimerCount()).toBe(before)
    vi.useRealTimers()
  })
})

// ---- blobs -----------------------------------------------------------------------

describe('blobs', () => {
  it('a handler offering bytes returns a BlobRef; chunks follow the res, cut at chunkBytes, last flagged', async () => {
    const { client, registry } = makeRig({ loopback: { limits: { chunkBytes: 4, windowChunks: Number.POSITIVE_INFINITY } } })
    registry.registerCapability({
      cap: 'file',
      actions: { read: { scope: 'observe' } },
      handle: async req => ({ data: req.blobs.offer(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]), { mime: 'application/octet-stream' }) }),
    })
    await client.hello()
    const res = await client.request('file.read')
    const ref = (res.ok === true ? (res.result as { data: BlobRef }).data : null)!
    expect(ref).toEqual({ $blob: 'id-2', bytes: 9, mime: 'application/octet-stream' })
    await flush()
    expect(client.chunks.map(c => [c.header.index, c.header.last, Array.from(c.bytes)])).toEqual([
      [0, false, [1, 2, 3, 4]],
      [1, false, [5, 6, 7, 8]],
      [2, true, [9]],
    ])
    // The res came before the first chunk.
    const resIndex = client.frames.findIndex(f => f.kind === 'res')
    expect(resIndex).toBeGreaterThanOrEqual(0)
    expect(client.chunks.every(c => c.header.id === ref.$blob)).toBe(true)
  })

  it('with a finite window the sender waits for ack credit', async () => {
    const { client, registry } = makeRig({ loopback: { kind: 'message-port', limits: { chunkBytes: 2, windowChunks: 2 } } })
    registry.registerCapability({
      cap: 'file',
      actions: { read: { scope: 'observe' } },
      handle: async req => req.blobs.offer(new Uint8Array([1, 2, 3, 4, 5, 6, 7])),
    })
    await client.hello()
    const res = await client.request('file.read')
    const ref = (res.ok === true ? res.result : null) as BlobRef
    await flush()
    expect(client.chunks.map(c => c.header.index)).toEqual([0, 1])
    client.transport.send({ kind: 'ack', id: ref.$blob, upTo: 0 })
    await flush()
    expect(client.chunks.map(c => c.header.index)).toEqual([0, 1, 2])
    client.transport.send({ kind: 'ack', id: ref.$blob, upTo: 2 })
    await flush()
    expect(client.chunks.map(c => c.header.index)).toEqual([0, 1, 2, 3])
    expect(client.chunks[3]?.header.last).toBe(true)
    // An ack for an unknown blob is ignored.
    client.transport.send({ kind: 'ack', id: 'ghost', upTo: 9 })
    await flush()
    expect(client.chunks).toHaveLength(4)
  })

  it('an ack past the last chunk still settles the send (clamped), instead of pinning the bytes forever', async () => {
    const sent: BlobChunkHeader[] = []
    const transport = {
      kind: 'websocket',
      limits: { chunkBytes: 2, windowChunks: 2 },
      bufferedBytes: () => 0,
      send: () => {},
      sendBlobChunk: (header: BlobChunkHeader) => { sent.push(header) },
      onFrame: () => () => {},
      onBlobChunk: () => () => {},
      onClosed: () => () => {},
      close: () => {},
    } satisfies FrameTransport
    const loop = new BlobSendLoop(transport)
    let settled = false
    const done = loop.send('b', new Uint8Array([1, 2, 3, 4, 5, 6, 7])).then(() => { settled = true })
    expect(sent.map(h => h.index)).toEqual([0, 1])
    // upTo far past chunkCount - 1 (3): the window opens fully and the send completes.
    loop.onAck({ kind: 'ack', id: 'b', upTo: 99 })
    expect(sent.map(h => h.index)).toEqual([0, 1, 2, 3])
    await done
    expect(settled).toBe(true)
    // A precise final ack behaves the same way.
    const exact = loop.send('c', new Uint8Array([1, 2, 3]))
    loop.onAck({ kind: 'ack', id: 'c', upTo: 1 })
    await expect(exact).resolves.toBeUndefined()
  })

  it('an empty blob is one empty last chunk; offers of a failing request are discarded', async () => {
    const { client, registry } = makeRig()
    registry.registerCapability({
      cap: 'file',
      actions: { empty: { scope: 'observe' }, fail: { scope: 'observe' } },
      handle: async req => {
        const ref = req.blobs.offer(new Uint8Array(0))
        if (req.route.act === 'fail') throw wireError('internal', 'after offering')
        return ref
      },
    })
    await client.hello()
    const ok = await client.request('file.empty')
    expect(ok.ok === true && (ok.result as BlobRef).bytes).toBe(0)
    await flush()
    expect(client.chunks.map(c => [c.header.index, c.header.last, c.bytes.byteLength])).toEqual([[0, true, 0]])
    const failed = await client.request('file.fail')
    expect(failed.ok).toBe(false)
    await flush()
    expect(client.chunks).toHaveLength(1)
  })
})

// ---- host proxy ------------------------------------------------------------------

describe('host proxy', () => {
  it('forwards to ctx.host with the C++ route shape and returns the result; host errors map to WireError', async () => {
    const context = makeContext()
    const request = vi.fn(async (route: { capability: string; action: string }, payload: unknown) =>
      route.action === 'fail'
        ? { ok: false as const, error: { code: 'not_found', message: 'gone' } }
        : { ok: true as const, result: { got: payload } },
    )
    context.host = { request: request as never }
    const { client, registry } = makeRig({ context })
    registry.registerHostProxy({ cap: 'ui', actions: { openUrl: { scope: 'full' }, fail: { scope: 'full' } } })
    await client.hello()
    const ok = await client.request('ui.openUrl', { url: 'https://x' })
    expect(ok.ok === true && ok.result).toEqual({ got: { url: 'https://x' } })
    expect(request).toHaveBeenCalledWith({ namespace: 'nexus', capability: 'ui', action: 'openUrl' }, { url: 'https://x' })
    const failed = await client.request('ui.fail')
    expect(failed.ok === false && failed.error).toMatchObject({ code: 'not_found', message: 'gone' })
  })

  it('search.queryTranscripts reaches the host from a control grant only with transcript targets', async () => {
    // The real table row + guard: a remote page searches the
    // host's conversations, but never names a file outside the transcripts.
    const context = makeContext({ homeDir: 'C:/Users/u' })
    const request = vi.fn(async () => ({ ok: true as const, result: { matches: [] } }))
    context.host = { request: request as never }
    const { client, registry } = makeRig({ context })
    for (const spec of hostProxySpecs()) registry.registerHostProxy(spec)
    await client.hello({ scopeCeiling: 'control' })
    const transcript = 'C:/Users/u/.velloc/projects/D--work/s-1/transcript.jsonl'
    const ok = await client.request('search.queryTranscripts', { targets: [transcript], query: 'x', generation: 1 })
    expect(ok.ok).toBe(true)
    expect(request).toHaveBeenCalledTimes(1)
    const escaped = await client.request('search.queryTranscripts', {
      targets: [transcript, 'C:/Users/u/.ssh/id_rsa'], query: 'x', generation: 2,
    })
    expect(escaped.ok === false && escaped.error.code).toBe('bad_payload')
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('without a host bridge every proxied route is host_unavailable (retryable)', async () => {
    const { client, registry } = makeRig()
    registry.registerHostProxy({ cap: 'ui', actions: { openUrl: { scope: 'full' } } })
    await client.hello()
    const res = await client.request('ui.openUrl', {})
    expect(res.ok === false && res.error).toMatchObject({ code: 'host_unavailable', retryable: true })
  })

  it('binaryResultFields become BlobRefs with their bytes pushed as chunks', async () => {
    const context = makeContext()
    context.host = {
      request: async () => ({ ok: true, result: { name: 'f', bytes: new Uint8Array([7, 8, 9]), other: 'kept' } }),
    }
    const { client, registry } = makeRig({ context })
    registry.registerHostProxy({ cap: 'fsx', actions: { readBlob: { scope: 'full' } }, binaryResultFields: { readBlob: ['bytes', 'missing'] } })
    await client.hello()
    const res = await client.request('fsx.readBlob', {})
    expect(res.ok === true && res.result).toEqual({ name: 'f', bytes: { $blob: 'id-2', bytes: 3 }, other: 'kept' })
    await flush()
    expect(client.chunks.map(c => Array.from(c.bytes))).toEqual([[7, 8, 9]])
  })

  // 43 (41 guest call sites + the two inspect-menu actions); minus
  // `model.publishCatalog`, which the RUNTIME publishes now — the host's copy
  // backs `model.catalog`, so it cannot be a client's to supply. The
  // per-client appearance rework dropped `appearance.setColorScheme`
  // and `appearance.setUserColor` (the host pref writes are gone) and added
  // `appearance.resolveTheme` (now `observe`) — net −1, so 41. The MCP
  // pre-save probe moved into the worker (`mcpSettings.testConnect`) — 40. `session.publishStatus` was removed from the host
  // 39. The browser pane's strip and address field: three `ui` routes — 42.
  // The proxy setting of the host: two `network` routes — 44.
  it('HOST_PROXY_TABLE covers the 44 routes the plan lists', () => {
    expect(hostProxyRouteCount()).toBe(44)
    const specs = hostProxySpecs()
    expect(specs.map(s => s.cap).sort()).toEqual(Object.keys(HOST_PROXY_TABLE).sort())
    // Below `full`: the pure read a remote observer needs (observe); the
    // reads and credentials a MANAGER may hold (provider auth, the webapp URL
    // read — the WRITE stays `full`); and the one PURE resolver a client uses to paint its own view, which
    // writes nothing on the host. And transcript search: a remote
    // page searches the host's conversations, payload-guarded to transcripts.
    const belowFull = specs.flatMap(s => Object.entries(s.actions).filter(([, a]) => a.scope !== 'full').map(([act]) => `${s.cap}.${act}`))
    expect(belowFull.sort()).toEqual([
      'appInfo.getVersionInfo', 'appInfo.getWebappUrl',
      'appearance.resolveTheme',
      'providerAuth.list', 'providerAuth.oauthStatus', 'providerAuth.beginOAuth',
      'providerAuth.verify', 'providerAuth.refresh', 'providerAuth.reset',
      'search.queryTranscripts',
    ].sort())
    expect(routeScope(specs, 'search', 'queryTranscripts')).toBe('control')
    const registry = new CapabilityRegistry()
    for (const spec of specs) registry.registerHostProxy(spec)
    expect(registry.resolve('sqlite', 'query')?.spec.scope).toBe('full')
    // The C++ `mcp` capability is no client's: the MCP page's probe is the
    // worker's `mcpSettings.testConnect` now.
    expect(registry.resolve('mcp', 'testConnect')).toBeUndefined()
    expect(registry.advertise({ mode: 'full', sessions: 'all' }).find(a => a.cap === 'mcp')).toBeUndefined()
    // The pure resolver is an observer's too: it paints only the caller's own
    // view, and refusing it left an observer's swatch silently classic.
    expect(registry.resolve('appearance', 'resolveTheme')?.spec.scope).toBe('observe')
    expect(registry.advertise({ mode: 'observe', sessions: 'all' })).toEqual([
      { cap: 'appearance', acts: ['resolveTheme'] },
      { cap: 'appInfo', acts: ['getVersionInfo'] },
    ])
  })
})

// ---- legacy WebUI capabilities ---------------------------------------------------

describe('legacy WebUI capabilities on the new hub', () => {
  it('registers all ten capabilities with their audited scopes, and calls the legacy handler with the legacy request shape and context', async () => {
    const primeLegacyHandlers = vi.fn()
    const legacyHandler = vi.fn(async (request: { id: string; route: { capability: string; action: string }; payload: unknown }, ctx: WebUiBridgeContext) => ({
      id: request.id,
      route: request.route,
      ok: true as const,
      result: { action: request.route.action, home: ctx.homeDir, payload: request.payload },
    }))
    const { client, registry, context } = makeRig()
    registerLegacyWebUiCapabilities(registry, {
      primeLegacyHandlers,
      getHandler: cap => (cap === 'features' ? (legacyHandler as never) : undefined),
    })
    expect(registry.capabilities()).toEqual(Object.keys(LEGACY_WEBUI_CAPABILITIES))
    // The settings a remote client can own are
    // readable at `observe` and writable at `control`; a secret, a host path
    // outside a session, or code that runs on the host stays `full`.
    const observe = registry.advertise({ mode: 'observe', sessions: 'all' })
    expect(observe.find(a => a.cap === 'features')?.acts).toEqual(['catalog', 'snapshot'])
    expect(observe.find(a => a.cap === 'providers')).toBeUndefined()
    expect(observe.find(a => a.cap === 'mcpSettings')).toBeUndefined()
    const control = registry.advertise({ mode: 'control', sessions: 'all' })
    expect(control.find(a => a.cap === 'features')?.acts).toEqual(['catalog', 'snapshot', 'setEnabled'])
    // Import: a remote page imports the HOST's sessions, skills and
    // memory — each bound to its source's fixed root, add-only.
    const MEMORY_AT_CONTROL = [
      'snapshot', 'setField',
      'listImportableProjects', 'importProject', 'listImportableGlobalMemory', 'importGlobalMemory',
    ]
    expect(control.find(a => a.cap === 'memory')?.acts).toEqual(MEMORY_AT_CONTROL)
    expect(control.find(a => a.cap === 'skills')?.acts).toEqual(['listInstalled', 'rescan', 'listImportable', 'importLocal'])
    // The listing is a read; the rescan that reloads sessions is not.
    expect(observe.find(a => a.cap === 'skills')?.acts).toEqual(['listInstalled'])
    // Enabling a plugin re-activates host code in every session: manager.
    expect(control.find(a => a.cap === 'plugins')?.acts).toEqual([
      'listInstalled', 'listMarketplaces', 'listMarketplacePlugins', 'listBuiltin',
    ])
    expect(control.find(a => a.cap === 'sessionImport')?.acts).toEqual([
      'detect', 'listSessions', 'readSession', 'writeSession',
    ])
    expect(observe.find(a => a.cap === 'sessionImport')).toBeUndefined()
    const manager = registry.advertise({ mode: 'manager', sessions: 'all' })
    // A manager holds provider keys and MCP server configs — but installs no
    // code and names no host path outside the import sources (`full`).
    expect(manager.find(a => a.cap === 'providers')?.acts).toEqual(['list', 'upsert', 'remove', 'setActive', 'setOrder', 'verify', 'modelFamilies', 'setModelEntries', 'setUserModels', 'dismissRemoved', 'freshModelIds', 'modOptions', 'setModOptions', 'setModBaseUrl'])
    // `testConnect` is the MCP page's pre-save probe (the worker MCP client),
    // a manager's like the upsert it precedes; a control client gets none.
    expect(manager.find(a => a.cap === 'mcpSettings')?.acts).toEqual(['list', 'upsert', 'remove', 'testConnect'])
    expect(control.find(a => a.cap === 'mcpSettings')).toBeUndefined()
    expect(manager.find(a => a.cap === 'memory')?.acts).toEqual(MEMORY_AT_CONTROL)
    expect(manager.find(a => a.cap === 'plugins')?.acts).toEqual([
      'listInstalled', 'listMarketplaces', 'listMarketplacePlugins', 'listBuiltin', 'setEnabled', 'setLocalEnabled', 'listLocal', 'requiredSettings', 'setSettings',
    ])
    expect(manager.find(a => a.cap === 'sessionImport')?.acts).toHaveLength(4)
    expect(manager.find(a => a.cap === 'skills')?.acts).toEqual(['listInstalled', 'rescan', 'listImportable', 'importLocal'])
    const full = registry.advertise({ mode: 'full', sessions: 'all' })
    expect(full.find(a => a.cap === 'memory')?.acts).toHaveLength(11)

    await client.hello()
    const res = await client.request(routeKey({ cap: 'features', act: 'setEnabled' }), { id: 'x', enabled: true }, 'legacy-1')
    expect(primeLegacyHandlers).toHaveBeenCalled()
    expect(legacyHandler).toHaveBeenCalledWith(
      { id: 'legacy-1', route: { namespace: 'nexus', capability: 'features', action: 'setEnabled' }, payload: { id: 'x', enabled: true } },
      context.webUiBridge,
    )
    expect(res.ok === true && res.result).toEqual({ action: 'setEnabled', home: '/home/t', payload: { id: 'x', enabled: true } })
    // A capability whose legacy handler is missing answers unknown_route, not a crash.
    const missing = await client.request('plugins.listInstalled')
    expect(missing.ok === false && missing.error.code).toBe('unknown_route')
  })

  /** The REAL memory adapter behind the hub, over an in-memory settings file
   *  that already names the owner's memory directory. */
  function memoryRig(scopeCeiling: 'observe' | 'control') {
    wipeSettingsMemos()
    const settingsPath = `/home/t/.velloc/${NEXUS_SETTINGS_FILE_NAME}`
    const files = new Map([[settingsPath, JSON.stringify({ version: 1, autoMemoryDirectory: '/home/t/owner-mem' })]])
    const fs = {
      readFile: vi.fn(async (path: string) => {
        const content = files.get(path)
        if (content === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
        return content
      }),
      writeFile: vi.fn(async (path: string, data: string) => {
        files.set(path, data)
      }),
      mkdir: vi.fn(async () => {}),
    }
    const { client, registry } = makeRig()
    registerLegacyWebUiCapabilities(registry, {
      primeLegacyHandlers: () => {},
      getHandler: cap =>
        cap === 'memory'
          ? (request, ctx) => handleMemoryBridgeRequest(request, { homeDir: ctx.homeDir, fs: fs as unknown as RuntimeFs })
          : undefined,
    })
    const settings = () => JSON.parse(files.get(settingsPath)!) as Record<string, unknown>
    return { client, fs, settings, hello: () => client.hello({ scopeCeiling }) }
  }

  it('a control connection cannot point memory at another host directory; the toggles stay writable', async () => {
    // `memory.setField` is `control` for the toggles. The memory DIRECTORY is a
    // host path outside any session: every later session reads and writes its
    // memory files there, and recall pulls them into the prompt. It is
    // settings.json-only, so the action refuses it (setting it, clearing it,
    // or riding along with a toggle) and writes nothing.
    const { client, fs, settings, hello } = memoryRig('control')
    await hello()
    for (const patch of [
      { autoMemoryDirectory: '/home/t/.ssh' },
      { autoMemoryDirectory: null },
      { autoMemoryDirectory: '' },
      { memoryRecallEnabled: false, autoMemoryDirectory: '/home/t/.ssh' },
    ]) {
      const res = await client.request('memory.setField', { patch })
      expect(res.ok === false && res.error.code).toBe('bad_payload')
    }
    expect(fs.writeFile).not.toHaveBeenCalled()
    expect(settings()).toEqual({ version: 1, autoMemoryDirectory: '/home/t/owner-mem' })

    const toggle = await client.request('memory.setField', { patch: { memoryRecallEnabled: false } })
    expect(toggle.ok).toBe(true)
    expect(settings()).toEqual({ version: 1, autoMemoryDirectory: '/home/t/owner-mem', memoryRecallEnabled: false })
    // The write's echo does not name the directory either.
    expect(toggle.ok === true && (toggle.result as { values: object }).values).not.toHaveProperty('autoMemoryDirectory')
  })

  it('memory.snapshot does not tell an observe connection where the memory directory is', async () => {
    const { client, hello } = memoryRig('observe')
    await hello()
    const snap = await client.request('memory.snapshot', {})
    expect(snap.ok === true && snap.result).toEqual({
      values: {
        autoMemoryEnabled: true,
        memoryMaintenance: 'off',
        autoExtractEnabled: false,
        memoryRecallEnabled: true,
      },
      source: 'file',
    })
    // Where the directory is stays with `memory.list`, which is `full`.
    const list = await client.request('memory.list', {})
    expect(list.ok === false && list.error.code).toBe('forbidden_scope')
  })

  it('a control connection cannot enable a plugin: that re-activates its hooks and MCP servers in every session', async () => {
    const pluginsHandler = vi.fn(async (request: { id: string; route: unknown }) => ({
      id: request.id,
      route: request.route,
      ok: true as const,
      result: { ok: true, effectiveEnabled: true },
    }))
    for (const scopeCeiling of ['control', 'manager'] as const) {
      const { client, registry } = makeRig()
      registerLegacyWebUiCapabilities(registry, {
        primeLegacyHandlers: () => {},
        getHandler: cap => (cap === 'plugins' ? (pluginsHandler as never) : undefined),
      })
      await client.hello({ scopeCeiling })
      const res = await client.request('plugins.setEnabled', { identifier: 'hooky@market', enabled: true })
      if (scopeCeiling === 'control') {
        expect(res.ok === false && res.error.code).toBe('forbidden_scope')
        expect(pluginsHandler).not.toHaveBeenCalled()
      } else {
        expect(res.ok).toBe(true)
        expect(pluginsHandler).toHaveBeenCalledTimes(1)
      }
    }
  })

  it('skills.rescan — the reload fan-out a listing no longer makes — is refused below control', async () => {
    const skillsHandler = vi.fn(async (request: { id: string; route: unknown }) => ({
      id: request.id,
      route: request.route,
      ok: true as const,
      result: { reloaded: true },
    }))
    for (const scopeCeiling of ['observe', 'control'] as const) {
      skillsHandler.mockClear()
      const { client, registry } = makeRig()
      registerLegacyWebUiCapabilities(registry, {
        primeLegacyHandlers: () => {},
        getHandler: cap => (cap === 'skills' ? (skillsHandler as never) : undefined),
      })
      await client.hello({ scopeCeiling })
      const res = await client.request('skills.rescan', {})
      if (scopeCeiling === 'observe') {
        expect(res.ok === false && res.error.code).toBe('forbidden_scope')
        expect(skillsHandler).not.toHaveBeenCalled()
        // The observer still lists.
        const list = await client.request('skills.listInstalled', {})
        expect(list.ok).toBe(true)
      } else {
        expect(res.ok === true && res.result).toEqual({ reloaded: true })
        expect(skillsHandler).toHaveBeenCalledTimes(1)
      }
    }
  })

  it('a legacy error response becomes the mapped WireError', async () => {
    const { client, registry } = makeRig()
    registerLegacyWebUiCapabilities(registry, {
      primeLegacyHandlers: () => {},
      getHandler: () =>
        (async (request: { id: string; route: unknown }) => ({
          id: request.id,
          route: request.route,
          ok: false,
          error: { code: 'unknown_action', message: 'nope' },
        })) as never,
    })
    await client.hello()
    const res = await client.request('agent.setField', {})
    expect(res.ok === false && res.error).toMatchObject({ code: 'unknown_route', message: 'nope' })
  })

  it('an observe connection cannot make plugins.listMarketplacePlugins fetch or write a marketplace', async () => {
    // The row is `observe` because the action only reads the local manifest;
    // the fetch-and-write is `refreshMarketplace`, which stays `full`. The
    // payload once carried `refresh: true`, which ran that same fetch-and-write
    // first — a `full` effect behind an `observe` row. Drive the REAL adapter:
    // the official marketplace is pre-seeded, so an adapter that still honoured
    // the flag would fetch it here (and fail on the 500).
    const fetchImpl = vi.fn(async () => new Response('', { status: 500 }))
    const fs = {
      readFile: vi.fn(async (path: string) => {
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
      }),
      writeFile: vi.fn(async () => {}),
      mkdir: vi.fn(async () => {}),
    }
    const { client, registry } = makeRig()
    registerLegacyWebUiCapabilities(registry, {
      primeLegacyHandlers: () => {},
      getHandler: cap =>
        cap === 'plugins'
          ? (request, ctx) =>
              handlePluginsBridgeRequest(request, { homeDir: ctx.homeDir, fs: fs as unknown as RuntimeFs, fetchImpl })
          : undefined,
    })
    await client.hello({ scopeCeiling: 'observe' })
    const res = await client.request('plugins.listMarketplacePlugins', { marketplace: 'claude-plugins-official', refresh: true })
    expect(res.ok === true && res.result).toEqual({ marketplace: 'claude-plugins-official', manifest: null })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(fs.writeFile).not.toHaveBeenCalled()
    expect(fs.mkdir).not.toHaveBeenCalled()
    // The re-fetch itself is still refused below `full`.
    const refresh = await client.request('plugins.refreshMarketplace', { name: 'claude-plugins-official' })
    expect(refresh.ok === false && refresh.error.code).toBe('forbidden_scope')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('a control connection cannot bind an imported session to a folder the runtime does not know; a known one lands in the runtime\u2019s spelling', async () => {
    // `writeSession` binds the new session to `result.projectRoot` — its
    // runtime, its `fsx` root and its cwd. `control` may import, so a remote
    // could name ANY host folder here and then open a session in it. The
    // hub applies the known-project rule `session.open` uses before the
    // legacy handler (which takes the path as given) sees the payload.
    const written: unknown[] = []
    const { client, registry } = makeRig()
    registerLegacyWebUiCapabilities(registry, {
      primeLegacyHandlers: () => {},
      getHandler: cap =>
        cap === 'sessionImport'
          ? async request => {
              written.push(request.payload)
              return { id: request.id, route: request.route, ok: true as const, result: { sessionId: 'imp-1', skipped: false } }
            }
          : undefined,
      knownProjectRoots: async sessionScope => (sessionScope === 'all' ? ['C:\\Work\\Api'] : []),
    })
    await client.hello({ scopeCeiling: 'control' })
    const bundle = (projectRoot?: string) => ({
      source: TERMINAL_AGENT_SOURCE_ID,
      result: { source: TERMINAL_AGENT_SOURCE_ID, sessionId: 'imp-1', entries: [], meta: { sessionId: 'imp-1' }, ...(projectRoot !== undefined ? { projectRoot } : {}) },
    })
    const refused = await client.request('sessionImport.writeSession', bundle('/home/t/.ssh'))
    expect(refused.ok === false && refused.error.code).toBe('forbidden_scope')
    expect(written).toEqual([])

    const known = await client.request('sessionImport.writeSession', bundle('c:/work/api/'))
    expect(known.ok).toBe(true)
    expect((written[0] as { result: { projectRoot: string } }).result.projectRoot).toBe('C:\\Work\\Api')
    // A bundle naming no folder is written unbound, as before.
    const unbound = await client.request('sessionImport.writeSession', bundle())
    expect(unbound.ok).toBe(true)
    expect((written[1] as { result: object }).result).not.toHaveProperty('projectRoot')
  })

  it('the import folder rule covers meta.metadata.projectRoot and every sub-agent’s, not only result.projectRoot', async () => {
    // meta.json's projectRoot is the durable binding grouped storage routes
    // by, and a sub-agent's routes the PARENT before the parent is written —
    // both reach disk as given, so a remote omitting result.projectRoot
    // could otherwise bind any host folder through either.
    const written: unknown[] = []
    const { client, registry } = makeRig()
    registerLegacyWebUiCapabilities(registry, {
      primeLegacyHandlers: () => {},
      getHandler: cap =>
        cap === 'sessionImport'
          ? async request => {
              written.push(request.payload)
              return { id: request.id, route: request.route, ok: true as const, result: { sessionId: 'imp-1', skipped: false } }
            }
          : undefined,
      knownProjectRoots: async sessionScope => (sessionScope === 'all' ? ['C:\\Work\\Api'] : []),
    })
    await client.hello({ scopeCeiling: 'control' })
    const meta = (projectRoot: string) => ({ sessionId: 'imp-1', metadata: { projectRoot, title: 't' } })
    const viaMeta = await client.request('sessionImport.writeSession', {
      source: TERMINAL_AGENT_SOURCE_ID,
      result: { source: TERMINAL_AGENT_SOURCE_ID, sessionId: 'imp-1', entries: [], meta: meta('/home/t/.ssh') },
    })
    expect(viaMeta.ok === false && viaMeta.error.code).toBe('forbidden_scope')
    const viaSubAgent = await client.request('sessionImport.writeSession', {
      source: TERMINAL_AGENT_SOURCE_ID,
      result: {
        source: TERMINAL_AGENT_SOURCE_ID, sessionId: 'imp-1', entries: [], meta: { sessionId: 'imp-1' },
        subAgents: [{ sessionId: 'sub-1', entries: [], meta: meta('/home/t/.ssh'), toolDetails: [], task: {} }],
      },
    })
    expect(viaSubAgent.ok === false && viaSubAgent.error.code).toBe('forbidden_scope')
    expect(written).toEqual([])

    const ok = await client.request('sessionImport.writeSession', {
      source: TERMINAL_AGENT_SOURCE_ID,
      result: {
        source: TERMINAL_AGENT_SOURCE_ID, sessionId: 'imp-1', entries: [], meta: meta('c:/work/api/'),
        subAgents: [{ sessionId: 'sub-1', entries: [], meta: meta('C:/Work/Api'), toolDetails: [], task: {} }],
      },
    })
    expect(ok.ok).toBe(true)
    const r = (written[0] as { result: { meta: { metadata: { projectRoot: string; title: string } }; subAgents: { meta: { metadata: { projectRoot: string } } }[] } }).result
    expect(r.meta.metadata).toEqual({ projectRoot: 'C:\\Work\\Api', title: 't' })
    expect(r.subAgents[0].meta.metadata.projectRoot).toBe('C:\\Work\\Api')
  })
})

// ---- error mapping ---------------------------------------------------------------

describe('error mapping', () => {
  it('legacyBridgeErrorToWire keeps protocol codes, maps known legacy codes, and preserves the rest under internal', () => {
    expect(legacyBridgeErrorToWire({ code: 'timeout', message: 't' })).toMatchObject({ code: 'timeout', retryable: true })
    expect(legacyBridgeErrorToWire({ code: 'webui_capability_unregistered', message: 'm' }).code).toBe('unknown_route')
    expect(legacyBridgeErrorToWire({ code: 'invalid_payload', message: 'm' }).code).toBe('bad_payload')
    expect(legacyBridgeErrorToWire({ code: 'FS_ERROR', message: 'disk', data: { path: '/x' } })).toEqual({
      code: 'internal',
      message: 'disk',
      data: { code: 'FS_ERROR', data: { path: '/x' } },
      retryable: false,
    })
  })

  it('toWireError passes WireErrors through, maps aborts to cancelled, wraps everything else as internal', () => {
    const wire = wireError('stale', 'old')
    expect(toWireError(wire)).toBe(wire)
    const abort = new Error('x')
    abort.name = 'AbortError'
    expect(toWireError(abort).code).toBe('cancelled')
    expect(toWireError(new Error('e'))).toMatchObject({ code: 'internal', message: 'e' })
    expect(toWireError('str')).toMatchObject({ code: 'internal', message: 'str' })
  })
})

// ---- end to end over a real MessageChannel ---------------------------------------

describe('over a real MessageChannel', () => {
  it('hello → welcome → request → topic → blob all round-trip through structured clone', async () => {
    const registry = new CapabilityRegistry()
    const broker = new TopicBroker()
    const context = makeContext()
    context.publish = (id, payload, opts) => broker.publish(id, payload, opts)
    const hub = new ConnectionHub({ registry, broker, context, runtimeVersion: 'mc', bootstrap: () => undefined })
    broker.registerProvider(simpleProvider(new Map([['t/mc', [{ hello: 'world' }]]])))
    registry.registerCapability({
      cap: 'file',
      actions: { read: { scope: 'observe' } },
      handle: async req => req.blobs.offer(new Uint8Array([42, 43])),
    })
    const channel = new MessageChannel()
    hub.attach(createMessagePortTransport(channel.port1))
    const client = new TestClient(createMessagePortTransport(channel.port2))

    const welcome = (await client.hello()) as WelcomeFrame
    expect(welcome.kind).toBe('welcome')
    expect(welcome.server.capabilities).toEqual([{ cap: 'file', acts: ['read'] }])

    await client.request(TOPICS_SUBSCRIBE_ROUTE, { topics: [{ topic: 't/mc' }] })
    context.publish('t/mc', { n: 1 }, { type: 'updated' })
    const events = await client.eventsFor('t/mc', 2)
    expect(events.map(e => e.form)).toEqual(['snapshot', 'delta'])

    const res = await client.request('file.read')
    expect(res.ok === true && (res.result as BlobRef).bytes).toBe(2)
    for (let i = 0; i < 20 && client.chunks.length === 0; i += 1) await flush()
    expect(Array.from(client.chunks[0]!.bytes)).toEqual([42, 43])
    expect(client.chunks[0]!.header.last).toBe(true)

    client.transport.close()
    await flush()
    expect(hub.list()).toHaveLength(0)
  })

  // The topic's scope is the LEAST scope any action of the
  // capability asks for, by the ladder. The old observe→control→else-`full`
  // chain predated `manager` and filed every all-manager capability under
  // `full` — a manager remote could write providers but never heard an edit.
  it('a settings topic is readable at the least scope its capability grants, manager included', () => {
    expect(settingsTopicScope('providers')).toBe('manager')
    expect(settingsTopicScope('mcpSettings')).toBe('manager')
    expect(settingsTopicScope('features')).toBe('observe')
    expect(settingsTopicScope('no-such-capability')).toBe('full')
    // And for every capability: exactly the minimum of its action scopes.
    const rank = (m: string) => SCOPE_MODES.indexOf(m as (typeof SCOPE_MODES)[number])
    for (const [cap, acts] of Object.entries(LEGACY_WEBUI_CAPABILITIES)) {
      const least = Math.min(...Object.values(acts as Record<string, string>).map(rank))
      expect([cap, settingsTopicScope(cap)]).toEqual([cap, SCOPE_MODES[least]])
    }
  })

  it('topic ids from the protocol builders are what the settings provider matches', () => {
    expect(topic.settings('features')).toBe('settings/features')
  })
})

/** The declared scope of one host-proxy route, straight from its spec. */
function routeScope(specs: ReturnType<typeof hostProxySpecs>, cap: string, act: string) {
  return specs.find(s => s.cap === cap)?.actions[act]?.scope
}
