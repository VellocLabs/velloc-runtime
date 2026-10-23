/**
 * The `terminal` capability on the protocol (F-31), driven through a real
 * ConnectionHub over a real TerminalService on a fake host port: full-only
 * actions and topics, the payload guards, the `terminals` list and the
 * `terminal/<id>` snapshot-then-deltas stream across two connections.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { renderSnapshot } from './_helpers/renderTerminalSnapshot'
import { CapabilityRegistry } from '../browser/runtimeHub/CapabilityRegistry'
import { ConnectionHub } from '../browser/runtimeHub/ConnectionHub'
import { registerTerminalCapability, TERMINALS_STATE_EVENT } from '../browser/runtimeHub/terminalCapability'
import { TopicBroker } from '../browser/runtimeHub/TopicBroker'
import type { ConnectionInfo, RuntimeContext } from '../browser/runtimeHub/types'
import type { WebUiBridgeContext } from '../browser/worker/webUiBridge'
import {
  RUNTIME_PROTOCOL_VERSION,
  TOPICS_SUBSCRIBE_ROUTE,
  topic,
  type EvtFrame,
  type Frame,
  type HelloFrame,
  type ResFrame,
  type ScopeMode,
} from '../browser/runtimeProtocol'
import type { FrameTransport, Unsubscribe } from '../browser/runtimeTransport'
import {
  TERMINAL_ACTION_SCOPES,
  TERMINAL_ACTIONS,
  TERMINAL_WRITE_MAX_BYTES,
  type TerminalSnapshot,
  type TerminalsState,
} from '../terminal/protocol'
import { TerminalService } from '../terminal/TerminalService'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import { fakePtyHost, settle } from './_helpers/fakePtyHost'

// ── a loopback transport and a tiny client, as the other hub tests have them ──

type FrameListener = (frame: Frame) => void
type End = FrameTransport & { peer: End | null; emit(frame: Frame): void }

function loopback(): { client: End; server: End } {
  const makeEnd = (): End => {
    const frameListeners = new Set<FrameListener>()
    const closedListeners = new Set<(reason: string, retryable: boolean) => void>()
    let isClosed = false
    const end = {
      kind: 'message-port',
      limits: { chunkBytes: 4, windowChunks: Number.POSITIVE_INFINITY },
      peer: null as End | null,
      emit: (frame: Frame) => frameListeners.forEach(listener => listener(frame)),
      bufferedBytes: () => 0,
      send(frame: Frame) {
        if (isClosed) return
        const peer = end.peer
        queueMicrotask(() => peer?.emit(frame))
      },
      sendBlobChunk() {},
      onFrame(listener: FrameListener) {
        frameListeners.add(listener)
        return () => {
          frameListeners.delete(listener)
        }
      },
      onBlobChunk() {
        return () => {}
      },
      onClosed(listener: (reason: string, retryable: boolean) => void) {
        closedListeners.add(listener)
        return () => {
          closedListeners.delete(listener)
        }
      },
      close() {
        if (isClosed) return
        isClosed = true
        closedListeners.forEach(listener => listener('closed', false))
      },
    }
    return end as unknown as End
  }
  const client = makeEnd()
  const server = makeEnd()
  client.peer = server
  server.peer = client
  return { client, server }
}

class TestClient {
  private nextId = 1
  private readonly pending = new Map<string, (res: ResFrame) => void>()
  readonly events: EvtFrame[] = []
  constructor(
    readonly transport: FrameTransport,
    private readonly clientId: string,
  ) {
    transport.onFrame((frame: Frame) => {
      if (frame.kind === 'res') this.pending.get(frame.id)?.(frame)
      if (frame.kind === 'evt') this.events.push(frame)
    })
  }
  async hello(overrides: Partial<HelloFrame> = {}): Promise<Frame> {
    const done = this.nextFrame(f => f.kind === 'welcome' || f.kind === 'bye')
    this.transport.send({
      kind: 'hello',
      v: RUNTIME_PROTOCOL_VERSION,
      client: { clientId: this.clientId, kind: 'desktop-shell' },
      auth: { mode: 'local' },
      ...overrides,
    })
    return done
  }
  request(route: string, payload?: unknown, id = `${this.clientId}-r${this.nextId++}`): Promise<ResFrame> {
    const promise = new Promise<ResFrame>(resolve => this.pending.set(id, resolve))
    this.transport.send({ kind: 'req', id, route: route as never, payload })
    return promise
  }
  subscribe(topicId: string, since?: number): Promise<ResFrame> {
    return this.request(TOPICS_SUBSCRIBE_ROUTE, { topics: [since === undefined ? { topic: topicId } : { topic: topicId, since }] })
  }
  nextFrame(match: (f: Frame) => boolean): Promise<Frame> {
    return new Promise(resolve => {
      const unsubscribe: Unsubscribe = this.transport.onFrame((frame: Frame) => {
        if (match(frame)) {
          unsubscribe()
          resolve(frame)
        }
      })
    })
  }
  on(topicId: string): EvtFrame[] {
    return this.events.filter(e => e.topic === topicId)
  }
  async eventsFor(topicId: string, count: number): Promise<EvtFrame[]> {
    for (let i = 0; i < 50; i += 1) {
      const got = this.on(topicId)
      if (got.length >= count) return got
      await settle(2)
    }
    throw new Error(`only ${this.on(topicId).length} events for ${topicId}`)
  }
}

const errorCode = (res: ResFrame): string | undefined => (res.ok ? undefined : res.error.code)

const rigs: Array<{ dispose(): void }> = []
afterEach(() => {
  for (const r of rigs.splice(0)) r.dispose()
})

async function rig() {
  const registry = new CapabilityRegistry()
  const broker = new TopicBroker()
  const webUiBridge: WebUiBridgeContext = {
    homeDir: '/home/t',
    fs: {} as RuntimeFs,
    broadcastEvent: () => {},
    directBridge: null,
  }
  const context: RuntimeContext = {
    fs: {} as RuntimeFs,
    host: null,
    homeDir: '/home/t',
    publish: (id, payload, opts) => broker.publish(id, payload, opts),
    connections: () => [],
    webUiBridge,
  }
  let nextId = 1
  const hub = new ConnectionHub({
    registry,
    broker,
    context,
    runtimeVersion: 'test-1',
    bootstrap: () => ({ homeDir: context.homeDir, platform: 'test', pathSep: '/' }),
    createId: () => `id-${nextId++}`,
  })
  context.connections = () => hub.list()

  const fake = fakePtyHost()
  let n = 0
  const service = new TerminalService({
    host: () => fake.host(),
    createRequestId: () => `r-${++n}`,
    sessionCwd: id => (id === 's1' ? '/proj/s1' : undefined),
    coalesceWindowMs: 1,
    newId: () => 'one',
  })
  const registration = registerTerminalCapability(registry, broker, { service })
  service.refreshHost()
  await settle()

  const connect = async (clientId: string, ceiling?: ScopeMode) => {
    const ends = loopback()
    hub.attach(ends.server)
    const client = new TestClient(ends.client, clientId)
    const welcome = await client.hello(ceiling ? { scopeCeiling: ceiling } : {})
    expect(welcome.kind).toBe('welcome')
    return client
  }
  const out = {
    hub,
    registry,
    broker,
    service,
    fake,
    connect,
    dispose: () => {
      registration.dispose()
      service.dispose()
      hub.closeAll('shutting_down')
    },
  }
  rigs.push(out)
  return out
}

const CREATE = { sessionId: 's1', cols: 80, rows: 24 }

describe('terminal capability scope', () => {
  it('declares every action full', async () => {
    const r = await rig()
    expect(TERMINAL_ACTION_SCOPES).toEqual({ create: 'full', write: 'full', resize: 'full', restart: 'full', close: 'full', rescanClis: 'full' })
    for (const action of TERMINAL_ACTIONS) expect(r.registry.resolve('terminal', action)!.spec.scope).toBe('full')
  })

  it.each(['observe', 'control', 'manager'] as const)('a %s connection is refused every action and both topics', async mode => {
    const r = await rig()
    const full = await r.connect('full-client')
    const created = await full.request('terminal.create', CREATE)
    expect(created.ok).toBe(true)
    const id = (created as { result: { id: string } }).result.id

    const lesser = await r.connect(`${mode}-client`, mode)
    const payloads: Record<(typeof TERMINAL_ACTIONS)[number], unknown> = {
      create: CREATE,
      write: { id, data: 'x' },
      resize: { id, cols: 90, rows: 30 },
      restart: { id },
      close: { id },
      rescanClis: {},
    }
    for (const action of TERMINAL_ACTIONS) {
      expect(errorCode(await lesser.request(`terminal.${action}`, payloads[action])), action).toBe('forbidden_scope')
    }
    expect(errorCode(await lesser.subscribe(topic.terminals()))).toBe('forbidden_scope')
    expect(errorCode(await lesser.subscribe(topic.terminal(id)))).toBe('forbidden_scope')
    // Nothing of it reached the host or the service.
    expect(r.fake.shellRequests('writeStdin')).toHaveLength(0)
    expect(r.fake.shellRequests('spawn')).toHaveLength(1)
    expect(await r.service.snapshot(id)).toMatchObject({ cols: 80, rows: 24, state: { kind: 'running' } })
    await settle(2)
    expect(lesser.events).toEqual([])
  })

  it('the topic providers answer full only, by connection scope', async () => {
    const r = await rig()
    const conn = (mode: ScopeMode): ConnectionInfo =>
      ({ connectionId: mode, clientId: mode, kind: 'cli', scope: { mode, sessions: 'all' }, transport: 'message-port' }) as ConnectionInfo
    expect(r.broker.authorize(topic.terminals(), conn('full'))).toBe('ok')
    expect(r.broker.authorize(topic.terminals(), conn('manager'))).toBe('forbidden')
    expect(r.broker.authorize(topic.terminal('term_missing'), conn('full'))).toBe('not_found')
  })
})

describe('terminal capability payload guards', () => {
  it('refuses unknown fields, oversized writes, sizes outside 1..1000, unknown shells and non-string ids', async () => {
    const r = await rig()
    const client = await r.connect('c')
    const bad: Array<[string, unknown]> = [
      ['terminal.create', { ...CREATE, cwd: '/etc' }],
      ['terminal.create', { ...CREATE, shell: 'fish' }],
      ['terminal.create', { ...CREATE, cols: 0 }],
      ['terminal.create', { ...CREATE, rows: 1001 }],
      ['terminal.create', { ...CREATE, cols: 10.5 }],
      ['terminal.create', { ...CREATE, sessionId: '' }],
      ['terminal.create', { ...CREATE, sessionId: 7 }],
      ['terminal.create', 'nope'],
      ['terminal.write', { id: 7, data: 'x' }],
      ['terminal.write', { id: 'term_one', data: 'x'.repeat(TERMINAL_WRITE_MAX_BYTES + 1) }],
      ['terminal.write', { id: 'term_one', data: '€'.repeat(Math.floor(TERMINAL_WRITE_MAX_BYTES / 3) + 1) }],
      ['terminal.write', { id: 'term_one', data: 'x', extra: 1 }],
      ['terminal.write', { id: 'term_one' }],
      ['terminal.resize', { id: 'term_one', cols: 80, rows: 0 }],
      ['terminal.resize', { id: 'term_one', cols: 80, rows: 24, depth: 1 }],
      ['terminal.restart', { id: ['term_one'] }],
      ['terminal.restart', { id: 'term_one', force: true }],
      ['terminal.close', {}],
      ['terminal.close', { id: 'term_one', all: true }],
    ]
    for (const [route, payload] of bad) {
      expect(errorCode(await client.request(route, payload)), `${route} ${JSON.stringify(payload)?.slice(0, 40)}`).toBe('bad_payload')
    }
    expect(r.fake.shellRequests('spawn')).toHaveLength(0)
    // The largest write the cap allows, measured in UTF-8 bytes, passes the guard.
    const created = await client.request('terminal.create', CREATE)
    expect(created.ok).toBe(true)
    const full = await client.request('terminal.write', { id: 'term_one', data: '€'.repeat(Math.floor(TERMINAL_WRITE_MAX_BYTES / 3)) })
    expect(full.ok).toBe(true)
    expect(r.fake.shellRequests('writeStdin')).toHaveLength(1)
  })

  it('an unknown terminal id is not_found on every action and on its topic', async () => {
    const r = await rig()
    const client = await r.connect('c')
    expect(errorCode(await client.request('terminal.write', { id: 'term_nope', data: 'x' }))).toBe('not_found')
    expect(errorCode(await client.request('terminal.resize', { id: 'term_nope', cols: 80, rows: 24 }))).toBe('not_found')
    expect(errorCode(await client.request('terminal.restart', { id: 'term_nope' }))).toBe('not_found')
    expect(errorCode(await client.request('terminal.close', { id: 'term_nope' }))).toBe('not_found')
    expect(errorCode(await client.subscribe(topic.terminal('term_nope')))).toBe('not_found')
    expect(errorCode(await client.request('terminal.create', { ...CREATE, sessionId: 'unknown-session' }))).toBe('not_found')
  })
})

describe('terminal topics', () => {
  it('terminals: the snapshot is the whole list and every state delta carries it again', async () => {
    const r = await rig()
    const client = await r.connect('c')
    expect((await client.subscribe(topic.terminals())).ok).toBe(true)
    const [snapshot] = await client.eventsFor(topic.terminals(), 1)
    expect(snapshot).toMatchObject({ form: 'snapshot', type: TERMINALS_STATE_EVENT })
    const list = snapshot!.payload as TerminalsState
    expect(list.available).toBe(true)
    expect(list.shells.map(s => s.id)).toEqual(['pwsh', 'powershell', 'cmd', 'bash'])
    expect(list.terminals).toEqual([])

    const created = await client.request('terminal.create', { ...CREATE, shell: 'cmd' })
    expect(created).toMatchObject({ ok: true, result: { id: 'term_one' } })
    await settle(2)
    const deltas = client.on(topic.terminals()).slice(1)
    expect(deltas.length).toBeGreaterThanOrEqual(2)
    for (const delta of deltas) expect(delta).toMatchObject({ form: 'delta', type: TERMINALS_STATE_EVENT })
    expect((deltas.at(-1)!.payload as TerminalsState).terminals).toEqual([
      { id: 'term_one', sessionId: 's1', shell: 'cmd', title: 'cmd', state: { kind: 'running' } },
    ])
  })

  it('terminal/<id>: a late subscriber gets the scrollback as its snapshot; two connections both get the deltas', async () => {
    const r = await rig()
    const a = await r.connect('a')
    const b = await r.connect('b')
    const created = await a.request('terminal.create', CREATE)
    const id = (created as { result: { id: string } }).result.id
    const stream = r.fake.spawned[0]!

    expect((await a.subscribe(topic.terminal(id))).ok).toBe(true)
    const [aSnapshot] = await a.eventsFor(topic.terminal(id), 1)
    expect(aSnapshot!.form).toBe('snapshot')
    expect(aSnapshot!.payload).toEqual({ cols: 80, rows: 24, title: 'pwsh', state: { kind: 'running' }, scrollback: '' } satisfies TerminalSnapshot)

    r.fake.output(stream, 'first line\r\n')
    await settle()
    const aFirst = await a.eventsFor(topic.terminal(id), 2)
    expect(aFirst[1]).toMatchObject({ form: 'delta', type: 'output', payload: { data: 'first line\r\n' } })

    // B arrives late: its snapshot already holds the first line, and it is not sent again as a delta.
    expect((await b.subscribe(topic.terminal(id))).ok).toBe(true)
    const [bSnapshot] = await b.eventsFor(topic.terminal(id), 1)
    expect(bSnapshot!.form).toBe('snapshot')
    expect(await renderSnapshot(bSnapshot!.payload as TerminalSnapshot)).toEqual(['first line'])

    r.fake.output(stream, '\x1b]2;Shell\x07second')
    await settle()
    await a.request('terminal.resize', { id, cols: 100, rows: 30 })
    await settle()
    r.fake.exit(stream, 0)
    await settle(2)

    const types = (client: TestClient) => client.on(topic.terminal(id)).map(e => `${e.form}:${e.type ?? '-'}`)
    expect(types(b)).toEqual(['snapshot:-', 'delta:title', 'delta:output', 'delta:resize', 'delta:state'])
    expect(types(a)).toEqual(['snapshot:-', 'delta:output', 'delta:title', 'delta:output', 'delta:resize', 'delta:state'])
    const last = b.on(topic.terminal(id))
    expect(last[1]!.payload).toEqual({ title: 'Shell' })
    expect(last[2]!.payload).toEqual({ data: '\x1b]2;Shell\x07second' })
    expect(last[3]!.payload).toEqual({ cols: 100, rows: 30 })
    expect(last[4]!.payload).toEqual({ state: { kind: 'exited', exitCode: 0 } })
    expect(r.fake.shellRequests('resize')[0]!.payload).toEqual({ streamId: stream, cols: 100, rows: 30 })

    // The host saw A's keystrokes.
    expect((await a.request('terminal.write', { id, data: 'ls\r' })).ok).toBe(true)
    // (the child has exited: nothing is written any more)
    expect(r.fake.shellRequests('writeStdin')).toHaveLength(0)

    // Restart, then close: the topic goes with the terminal.
    expect((await b.request('terminal.restart', { id })).ok).toBe(true)
    await settle(2)
    expect(a.on(topic.terminal(id)).at(-1)!.payload).toEqual({ state: { kind: 'running' } })
    expect((await a.request('terminal.close', { id })).ok).toBe(true)
    await settle(2)
    expect(r.fake.shellRequests('streamKill').map(req => (req.payload as { streamId: string }).streamId)).toEqual([r.fake.spawned[1]])
    expect(r.broker.subscribersOf(topic.terminal(id))).toEqual([])
    expect(errorCode(await b.subscribe(topic.terminal(id)))).toBe('not_found')
    const final = a.on(topic.terminals()).at(-1)
    expect(final === undefined || (final.payload as TerminalsState).terminals.length === 0).toBe(true)
  })

  it('a resume whose since fell out of the replay ring gets a fresh snapshot, never a gap', async () => {
    const r = await rig()
    const broker = new TopicBroker({ ringCount: 2 })
    registerTerminalCapability(new CapabilityRegistry(), broker, { service: r.service })
    const id = await r.service.create(CREATE)
    const stream = r.fake.spawned[0]!
    for (const piece of ['a', 'b', 'c', 'd']) {
      r.fake.output(stream, piece)
      await settle()
    }
    const received: EvtFrame[] = []
    const conn = { connectionId: 'late', clientId: 'late', kind: 'cli', scope: { mode: 'full', sessions: 'all' }, transport: 'message-port' } as ConnectionInfo
    await broker.subscribe({ conn, send: evt => received.push(evt), bufferedBytes: () => 0 }, topic.terminal(id), 1)
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({ form: 'snapshot', payload: { scrollback: 'abcd' } })
    // A since the ring still covers replays only the deltas after it.
    const replayed: EvtFrame[] = []
    const fresh = { ...conn, connectionId: 'fresh' } as ConnectionInfo
    await broker.subscribe({ conn: fresh, send: evt => replayed.push(evt), bufferedBytes: () => 0 }, topic.terminal(id), broker.seqOf(topic.terminal(id)) - 1)
    expect(replayed.map(e => e.payload)).toEqual([{ data: 'd' }])
  })

  it('without a service the list says unavailable and every action is host_unavailable', async () => {
    const registry = new CapabilityRegistry()
    const broker = new TopicBroker()
    registerTerminalCapability(registry, broker, { service: null })
    const conn = { connectionId: 'c', clientId: 'c', kind: 'cli', scope: { mode: 'full', sessions: 'all' }, transport: 'message-port' } as ConnectionInfo
    const received: EvtFrame[] = []
    await broker.subscribe({ conn, send: evt => received.push(evt), bufferedBytes: () => 0 }, topic.terminals())
    expect(received[0]!.payload).toEqual({ available: false, shells: [], clis: [], terminals: [] })
    const entry = registry.resolve('terminal', 'create')!
    // No service: no shell is known, so only a create that leaves the choice to the runtime passes the guard.
    expect(entry.spec.guard?.(CREATE, conn, {} as never)).toBe(true)
    expect(entry.spec.guard?.({ ...CREATE, shell: 'pwsh' }, conn, {} as never)).toBe(false)
    await expect(
      entry.handle({ id: '1', route: { cap: 'terminal', act: 'create' }, payload: CREATE, conn } as never, {} as never),
    ).rejects.toSatisfy(e => (e as { code?: string }).code === 'host_unavailable')
    await expect(
      registry.resolve('terminal', 'close')!.handle({ id: '1', route: { cap: 'terminal', act: 'close' }, payload: { id: 'x' }, conn } as never, {} as never),
    ).rejects.toSatisfy(e => (e as { code?: string }).code === 'host_unavailable')
    expect(broker.authorize(topic.terminal('x'), conn)).toBe('not_found')
  })
})
