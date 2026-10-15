/**
 * RuntimeConnection (client) against a real ConnectionHub over a MessageChannel:
 * handshake, requests (ok / error / timeout / abort), topic subscriptions
 * (snapshot, deltas, gap → re-subscribe, hold semantics), blobs (assembled from
 * chunks, acked), `can()`, and close.
 */
import { describe, expect, it, vi } from 'vitest'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import { RUNTIME_PROTOCOL_VERSION, wireError, type BlobRef, type Frame } from '../browser/runtimeProtocol'
import { createMessagePortTransport } from '../browser/runtimeTransport'
import {
  CapabilityRegistry,
  ConnectionHub,
  TopicBroker,
  type RuntimeContext,
  type TopicProvider,
} from '../browser/runtimeHub'
import {
  RuntimeConnectionClosedError,
  type RuntimeRequestError,
  connectRuntime,
  connectRuntimeOverSharedWorker,
  isRuntimeRequestError,
  type RuntimeConnection,
  type TopicEvent,
} from '../browser/runtimeClient'

async function flush(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await new Promise<void>(resolve => setTimeout(resolve, 0))
}

/** The RuntimeRequestError a request rejects with (the test fails if it resolves). */
async function rejectionOf(promise: Promise<unknown>): Promise<RuntimeRequestError> {
  try {
    await promise
  } catch (error) {
    return error as RuntimeRequestError
  }
  throw new Error('expected the request to reject')
}

async function until(predicate: () => boolean, label: string, rounds = 100): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    if (predicate()) return
    await flush(1)
  }
  throw new Error(`timed out waiting for ${label}`)
}

function makeServer(options: { broker?: TopicBroker } = {}) {
  const registry = new CapabilityRegistry()
  const broker = options.broker ?? new TopicBroker()
  const context: RuntimeContext = {
    fs: {} as RuntimeFs,
    host: null,
    homeDir: '/h',
    publish: (id, payload, opts) => broker.publish(id, payload, opts),
    connections: () => hub.list(),
    webUiBridge: { homeDir: '/h', fs: {} as RuntimeFs, broadcastEvent: vi.fn(), directBridge: null },
  }
  const hub = new ConnectionHub({
    registry,
    broker,
    context,
    runtimeVersion: 'rc-test',
    bootstrap: () => ({ homeDir: '/h', platform: 'test', pathSep: '/' }),
  })
  const provider = (state: Map<string, unknown[]>): TopicProvider => ({
    matches: id => id.startsWith('t/'),
    authorize: () => true,
    async *snapshot(id) {
      for (const page of state.get(id) ?? []) yield { payload: page }
    },
  })
  return { registry, broker, hub, context, provider }
}

async function connect(
  server: ReturnType<typeof makeServer>,
  opts: {
    requestTimeoutMs?: number
    /** What the SERVER end reports as un-drained (a MessagePort says 0; a lagging websocket says more). */
    serverBufferedBytes?: () => number
    /** Frames the CLIENT end loses on the way in (a frame that never arrived). */
    dropClientFrame?: (frame: Frame) => boolean
  } = {},
) {
  const channel = new MessageChannel()
  const serverTransport = createMessagePortTransport(channel.port1)
  server.hub.attach(
    opts.serverBufferedBytes ? { ...serverTransport, bufferedBytes: opts.serverBufferedBytes } : serverTransport,
  )
  const clientTransport = createMessagePortTransport(channel.port2)
  const drop = opts.dropClientFrame
  const connection = await connectRuntime({
    transport: drop
      ? { ...clientTransport, onFrame: listener => clientTransport.onFrame(frame => (drop(frame) ? undefined : listener(frame))) }
      : clientTransport,
    client: { clientId: 'c1', kind: 'desktop-shell' },
    requestTimeoutMs: opts.requestTimeoutMs,
  })
  return { connection, channel }
}

describe('connectRuntime', () => {
  it('resolves after welcome with state ready, bootstrap and can()', async () => {
    const server = makeServer()
    server.registry.registerCapability({ cap: 'echo', actions: { say: { scope: 'observe' } }, handle: async r => r.payload })
    const { connection } = await connect(server)
    expect(connection.state.status).toBe('ready')
    expect(connection.welcome?.v).toBe(RUNTIME_PROTOCOL_VERSION)
    expect(connection.welcome?.bootstrap).toEqual({ homeDir: '/h', platform: 'test', pathSep: '/' })
    expect(connection.can('echo')).toBe(true)
    expect(connection.can('echo', 'say')).toBe(true)
    expect(connection.can('echo', 'shout')).toBe(false)
    expect(connection.can('nope')).toBe(false)
    connection.close()
  })

  it('rejects with RuntimeConnectionClosedError when the runtime says bye', async () => {
    const server = makeServer()
    const channel = new MessageChannel()
    server.hub.attach(createMessagePortTransport(channel.port1))
    // A websocket-kind hello is what a `pair` client without a table gets refused for;
    // over a port, an unsupported version does the same.
    const states: string[] = []
    const promise = connectRuntime({
      transport: createMessagePortTransport(channel.port2),
      client: { clientId: 'c', kind: 'mobile' },
      auth: { mode: 'pair', pairId: 'p' },
    })
    await expect(promise).rejects.toBeInstanceOf(RuntimeConnectionClosedError)
    await expect(promise).rejects.toMatchObject({ code: 'unauthorized' })
    void states
  })

  it('times out the handshake when nothing answers', async () => {
    vi.useFakeTimers()
    try {
      const channel = new MessageChannel()
      const promise = connectRuntime({
        transport: createMessagePortTransport(channel.port2),
        client: { clientId: 'c', kind: 'cli' },
        handshakeTimeoutMs: 50,
      })
      const rejection = expect(promise).rejects.toMatchObject({ code: 'transport' })
      await vi.advanceTimersByTimeAsync(60)
      await rejection
      channel.port1.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('handshakeTimeoutMs 0 waits for welcome indefinitely instead of closing the connection', async () => {
    vi.useFakeTimers()
    try {
      const channel = new MessageChannel()
      let settled = false
      const promise = connectRuntime({
        transport: createMessagePortTransport(channel.port2),
        client: { clientId: 'c', kind: 'desktop-shell' },
        handshakeTimeoutMs: 0,
      })
      promise.then(() => { settled = true }, () => { settled = true })
      // A cold SharedWorker start: far past the 10 s default.
      await vi.advanceTimersByTimeAsync(120_000)
      expect(settled).toBe(false)
      channel.port1.close()
    } finally {
      vi.useRealTimers()
    }
  })
})

/** The connect promise's outcome within `ms`, or 'still waiting' — so a missing failure path is a bounded red, not a hang. */
async function outcomeWithin(promise: Promise<unknown>, ms: number): Promise<unknown> {
  return Promise.race([
    promise.then(() => 'resolved', error => error),
    new Promise(resolve => setTimeout(() => resolve('still waiting'), ms)),
  ])
}

describe('a SharedWorker that never answers, with no handshake budget (handshakeTimeoutMs 0)', () => {
  it('the worker’s `error` event (its script failed to load) rejects the connect promise', async () => {
    const channel = new MessageChannel()
    // Stands in for the SharedWorker object: `error` is fired at it when the
    // script cannot be fetched or parsed, and never on any port.
    const worker = new EventTarget()
    const promise = connectRuntimeOverSharedWorker(channel.port1, {
      homeDir: '/h',
      clientId: 'c',
      handshakeTimeoutMs: 0,
      worker,
    })
    await flush()
    worker.dispatchEvent(new Event('error'))
    const outcome = await outcomeWithin(promise, 200)
    expect(outcome).toBeInstanceOf(RuntimeConnectionClosedError)
    expect(outcome).toMatchObject({ code: 'transport', reason: 'worker-error' })
    channel.port1.close()
    channel.port2.close()
  })

  it('a `messageerror` on the port (a frame that cannot be deserialized) rejects the connect promise', async () => {
    const channel = new MessageChannel()
    const promise = connectRuntime({
      transport: createMessagePortTransport(channel.port2),
      client: { clientId: 'c', kind: 'desktop-shell' },
      handshakeTimeoutMs: 0,
    })
    await flush()
    channel.port2.dispatchEvent(new Event('messageerror'))
    const outcome = await outcomeWithin(promise, 200)
    expect(outcome).toBeInstanceOf(RuntimeConnectionClosedError)
    expect(outcome).toMatchObject({ code: 'transport', reason: 'messageerror' })
    channel.port1.close()
  })
})

describe('request', () => {
  it('resolves with the result; an error response rejects with a RuntimeRequestError carrying the WireError', async () => {
    const server = makeServer()
    server.registry.registerCapability({
      cap: 'k',
      actions: { ok: { scope: 'observe' }, fail: { scope: 'observe' } },
      handle: async r => {
        if (r.route.act === 'fail') throw wireError('not_found', 'missing', { id: 7 })
        return { got: r.payload }
      },
    })
    const { connection } = await connect(server)
    await expect(connection.request('k.ok', { a: 1 })).resolves.toEqual({ got: { a: 1 } })
    await expect(connection.request({ cap: 'k', act: 'ok' })).resolves.toEqual({ got: undefined })
    const error = await rejectionOf(connection.request('k.fail'))
    expect(isRuntimeRequestError(error)).toBe(true)
    expect(error).toMatchObject({ code: 'not_found', retryable: false, data: { id: 7 } })
    expect(error.wire).toEqual({ code: 'not_found', message: 'missing', data: { id: 7 }, retryable: false })
    const unknown = await rejectionOf(connection.request('nope.x'))
    expect(unknown.code).toBe('unknown_route')
    connection.close()
  })

  it('a timeout sends cancel and rejects with timeout; an aborted signal cancels too', async () => {
    const server = makeServer()
    const aborted: boolean[] = []
    server.registry.registerCapability({
      cap: 'slow',
      actions: { run: { scope: 'observe' } },
      handle: r =>
        new Promise(() => {
          r.signal.addEventListener('abort', () => aborted.push(true))
        }),
    })
    const { connection } = await connect(server)
    const timedOut = await rejectionOf(connection.request('slow.run', {}, { timeoutMs: 30 }))
    expect(timedOut.code).toBe('timeout')
    await until(() => aborted.length === 1, 'server abort after timeout')

    const controller = new AbortController()
    const pending = connection.request('slow.run', {}, { signal: controller.signal })
    await flush()
    controller.abort()
    const cancelled = await rejectionOf(pending)
    expect(cancelled.code).toBe('cancelled')
    await until(() => aborted.length === 2, 'server abort after client abort')
    connection.close()
  })

  it('requests after close reject immediately, and pending ones reject on close', async () => {
    const server = makeServer()
    server.registry.registerCapability({ cap: 'slow', actions: { run: { scope: 'observe' } }, handle: () => new Promise(() => {}) })
    const { connection } = await connect(server)
    const pending = connection.request('slow.run')
    await flush()
    connection.close()
    expect(connection.state).toEqual({ status: 'closed', code: 'shutting_down' })
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
    await expect(connection.request('slow.run')).rejects.toMatchObject({ code: 'cancelled' })
    await until(() => server.hub.list().length === 0, 'server forgets the connection')
  })
})

describe('subscribe', () => {
  it('first listener subscribes on the wire, snapshot then deltas arrive in order, last listener unsubscribes', async () => {
    const server = makeServer()
    const state = new Map<string, unknown[]>([['t/a', ['S']]])
    server.broker.registerProvider(server.provider(state))
    const { connection } = await connect(server)
    const seenA: TopicEvent[] = []
    const seenB: TopicEvent[] = []
    const offA = connection.subscribe('t/a', e => seenA.push(e))
    // Wait for A's snapshot to have ARRIVED (not just for the server-side
    // registration): B must join after it to prove a later listener sees only
    // what follows.
    await until(() => seenA.length === 1, "A's snapshot")
    expect(server.broker.subscribersOf('t/a')).toHaveLength(1)
    const offB = connection.subscribe('t/a', e => seenB.push(e))
    server.context.publish('t/a', 'd1', { type: 'updated' })
    await until(() => seenA.length === 2, 'snapshot + delta')
    expect(seenA.map(e => [e.form, e.payload, e.seq])).toEqual([['snapshot', 'S', 0], ['delta', 'd1', 1]])
    expect(seenA[1]?.type).toBe('updated')
    // The second listener joined after the snapshot: it sees only what came after.
    expect(seenB.map(e => e.payload)).toEqual(['d1'])
    offA()
    await flush()
    expect(server.broker.subscribersOf('t/a')).toHaveLength(1)
    offB()
    await until(() => server.broker.subscribersOf('t/a').length === 0, 'server unsubscribe')
    connection.close()
  })

  it('a seq gap re-subscribes with since and the missed deltas are replayed, no hole and no duplicate', async () => {
    const server = makeServer()
    server.broker.registerProvider(server.provider(new Map()))
    const { connection, channel } = await connect(server)
    const seen: TopicEvent[] = []
    connection.subscribe('t/g', e => seen.push(e))
    await until(() => seen.length === 1, 'baseline snapshot')
    server.context.publish('t/g', 'd1')
    await until(() => seen.length === 2, 'd1')
    // Forge a hole: an evt with seq 4 arriving directly on the client's port.
    channel.port1.postMessage({ kind: 'evt', topic: 't/g', seq: 4, payload: 'forged', form: 'delta' })
    server.context.publish('t/g', 'd2')
    server.context.publish('t/g', 'd3')
    await until(() => seen.filter(e => e.form === 'delta').length >= 3, 'replayed deltas')
    await flush()
    const deltas = seen.filter(e => e.form === 'delta').map(e => [e.seq, e.payload])
    expect(deltas).toEqual([[1, 'd1'], [2, 'd2'], [3, 'd3']])
    // The ring could replay the hole: no second snapshot, nothing flagged resync.
    expect(seen.filter(e => e.form === 'snapshot')).toHaveLength(1)
    expect(seen.some(e => e.resync)).toBe(false)
    connection.close()
  })

  // R6: `deltas` is the batch marker the frame set needs before it freezes.
  // A batch takes ONE seq, so `since` and the hole detector stay exact, and a
  // listener cannot tell how the runtime chose to pack its deltas.
  it('a batched frame is unfolded into one delta per payload, sharing its seq', async () => {
    const server = makeServer()
    server.broker.registerProvider(server.provider(new Map()))
    const { connection } = await connect(server)
    const seen: TopicEvent[] = []
    connection.subscribe('t/b', e => seen.push(e))
    await until(() => seen.length === 1, 'baseline snapshot')

    server.broker.publishBatch('t/b', ['d1', 'd2', 'd3'], { type: 'updated' })
    await until(() => seen.filter(e => e.form === 'delta').length === 3, 'the three deltas')
    expect(seen.filter(e => e.form === 'delta').map(e => [e.seq, e.type, e.payload])).toEqual([
      [1, 'updated', 'd1'],
      [1, 'updated', 'd2'],
      [1, 'updated', 'd3'],
    ])

    // The next single delta continues the seq line — the batch consumed one.
    server.context.publish('t/b', 'd4')
    await until(() => seen.filter(e => e.form === 'delta').length === 4, 'the next delta')
    expect(seen.at(-1)).toMatchObject({ seq: 2, payload: 'd4' })

    // An empty batch is not published at all.
    const before = server.broker.seqOf('t/b')
    expect(server.broker.publishBatch('t/b', [])).toBe(before)
    await flush()
    expect(seen.filter(e => e.form === 'delta')).toHaveLength(4)
    connection.close()
  })

  it('a refused topic never fires and does not break other subscriptions', async () => {
    const server = makeServer()
    server.broker.registerProvider(server.provider(new Map()))
    const { connection } = await connect(server)
    const refused: TopicEvent[] = []
    const fine: TopicEvent[] = []
    connection.subscribe('nowhere', e => refused.push(e))
    connection.subscribe('t/ok', e => fine.push(e))
    await until(() => fine.length === 1, 'the fine topic')
    expect(refused).toHaveLength(0)
    connection.close()
  })
})

// A snapshot on a topic that has already delivered is the broker recovering a
// gap (it never re-snapshots a held topic otherwise). The session topics of
// the seam snapshot to `null`, so a listener must be TOLD it missed deltas or
// it treats the recovery as the seq baseline it does not need and stays stale
// `resync` is that signal; the first snapshot never carries it.
describe('resync snapshots (a recovered gap)', () => {
  it('the first snapshot is not a resync; a lag-recovery snapshot is, on every page', async () => {
    const server = makeServer()
    const state = new Map<string, unknown[]>([['t/l', ['S1', 'S2']]])
    server.broker.registerProvider(server.provider(state))
    let buffered = 0
    const { connection } = await connect(server, { serverBufferedBytes: () => buffered })
    const seen: TopicEvent[] = []
    connection.subscribe('t/l', e => seen.push(e))
    await until(() => seen.length === 2, 'the initial paged snapshot')
    expect(seen.map(e => [e.form, e.payload, e.resync])).toEqual([
      ['snapshot', 'S1', undefined],
      ['snapshot', 'S2', undefined],
    ])
    server.context.publish('t/l', 'd1')
    await until(() => seen.length === 3, 'd1')

    // The wire backs up past lagBytes: d2 is skipped and the subscriber lags.
    buffered = 2 * 1024 * 1024
    server.context.publish('t/l', 'd2')
    // Drained: the next publish starts the broker's recovery snapshot instead.
    buffered = 0
    state.set('t/l', ['R1', 'R2'])
    server.context.publish('t/l', 'd3')
    await until(() => seen.length === 5, 'the recovery snapshot')
    expect(seen.slice(3).map(e => [e.form, e.seq, e.payload, e.resync])).toEqual([
      ['snapshot', 3, 'R1', true],
      ['snapshot', 3, 'R2', true],
    ])
    // Deltas resume on the seq line the snapshot set, with no flag.
    server.context.publish('t/l', 'd4')
    await until(() => seen.length === 6, 'd4')
    expect(seen[5]).toMatchObject({ form: 'delta', seq: 4, payload: 'd4' })
    expect(seen[5]?.resync).toBeUndefined()
    connection.close()
  })

  it('a hole the replay ring no longer covers is re-snapshotted, flagged resync', async () => {
    const server = makeServer({ broker: new TopicBroker({ ringCount: 2 }) })
    server.broker.registerProvider(server.provider(new Map([['t/e', ['S']]])))
    const { connection } = await connect(server, {
      dropClientFrame: frame => frame.kind === 'evt' && frame.payload === 'lost',
    })
    const seen: TopicEvent[] = []
    connection.subscribe('t/e', e => seen.push(e))
    await until(() => seen.length === 1, 'baseline snapshot')
    server.context.publish('t/e', 'd1')
    await until(() => seen.length === 2, 'd1')
    // seq 2 never arrives; seq 3 opens the hole and the client re-subscribes
    // from 1 — by then the two-entry ring holds only 3 and 4.
    server.context.publish('t/e', 'lost')
    server.context.publish('t/e', 'd3')
    server.context.publish('t/e', 'd4')
    await until(() => seen.length === 3, 'the recovery snapshot')
    expect(seen[2]).toMatchObject({ form: 'snapshot', seq: 4, payload: 'S', resync: true })
    expect(seen.some(e => e.payload === 'd3')).toBe(false)
    connection.close()
  })

  it('a re-snapshot stamped with the seq already held missed nothing: not a resync', async () => {
    const server = makeServer({ broker: new TopicBroker({ ringCount: 2 }) })
    server.broker.registerProvider(server.provider(new Map([['t/n', ['S']]])))
    const { connection, channel } = await connect(server)
    const seen: TopicEvent[] = []
    connection.subscribe('t/n', e => seen.push(e))
    await until(() => seen.length === 1, 'baseline snapshot')
    server.context.publish('t/n', 'd1')
    await until(() => seen.length === 2, 'd1')
    // A forged hole makes the client re-subscribe from 1; every real delta
    // still arrives before the broker answers that with a snapshot at seq 5.
    channel.port1.postMessage({ kind: 'evt', topic: 't/n', seq: 5, payload: 'forged', form: 'delta' })
    for (const d of ['d2', 'd3', 'd4', 'd5']) server.context.publish('t/n', d)
    await until(() => seen.length === 7, 'd2..d5 and the re-subscribe snapshot')
    expect(seen.map(e => [e.form, e.seq])).toEqual([
      ['snapshot', 0], ['delta', 1], ['delta', 2], ['delta', 3], ['delta', 4], ['delta', 5], ['snapshot', 5],
    ])
    expect(seen[6]?.resync).toBeUndefined()
    connection.close()
  })
})

describe('readBlob', () => {
  it('assembles chunks (arriving before or after the read), acks each chunk, resolves the bytes', async () => {
    const server = makeServer()
    // Fresh bytes per call: the port transport MOVES a whole-buffer view, so the
    // handler's array is detached after the first send (that is the point).
    const payload = () => new Uint8Array(70_000).map((_, i) => i % 251)
    server.registry.registerCapability({
      cap: 'file',
      actions: { read: { scope: 'observe' } },
      handle: async r => ({ data: r.blobs.offer(payload(), { mime: 'application/octet-stream' }) }),
    })
    const { connection } = await connect(server)
    const res = (await connection.request('file.read')) as { data: BlobRef }
    expect(res.data.bytes).toBe(70_000)
    // Read straight away (chunks may still be in flight) …
    const bytes = await connection.readBlob(res.data)
    expect(bytes.byteLength).toBe(70_000)
    expect(Array.from(bytes.subarray(0, 5))).toEqual([0, 1, 2, 3, 4])
    expect(bytes[69_999]).toBe(69_999 % 251)
    // … and a second read after everything has landed.
    const again = (await connection.request('file.read')) as { data: BlobRef }
    await flush(10)
    const late = await connection.readBlob(again.data)
    expect(late.byteLength).toBe(70_000)
    connection.close()
  })

  it('a blob nobody reads is dropped after its TTL; a late read within the TTL still succeeds', async () => {
    const server = makeServer()
    server.registry.registerCapability({
      cap: 'file',
      actions: { read: { scope: 'observe' } },
      handle: async r => ({ data: r.blobs.offer(new Uint8Array([1, 2, 3])) }),
    })
    const { connection } = await connect(server)
    const nowSpy = vi.spyOn(Date, 'now')
    let clock = 1_000_000
    nowSpy.mockImplementation(() => clock)
    try {
      const first = (await connection.request('file.read')) as { data: BlobRef }
      await flush(10) // chunks land with nobody reading → orphaned at `clock`
      clock += 10_000
      expect(Array.from(await connection.readBlob(first.data))).toEqual([1, 2, 3]) // within the TTL
      const second = (await connection.request('file.read')) as { data: BlobRef }
      await flush(10)
      clock += 31_000 // past the TTL: the next blob activity evicts it
      const third = (await connection.request('file.read')) as { data: BlobRef }
      await flush(10)
      const late = connection.readBlob(second.data, { signal: AbortSignal.timeout(200) })
      await expect(late).rejects.toMatchObject({ code: 'cancelled' })
      expect(Array.from(await connection.readBlob(third.data))).toEqual([1, 2, 3])
    } finally {
      nowSpy.mockRestore()
      connection.close()
    }
  })

  it('an aborted read rejects with cancelled', async () => {
    const server = makeServer()
    const { connection } = await connect(server)
    const controller = new AbortController()
    const pending = connection.readBlob({ $blob: 'never', bytes: 1 }, { signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
    connection.close()
  })

  it('a read whose bytes never arrive times out on the request deadline and leaves nothing behind', async () => {
    // A blob waiter used to have no deadline at all: a BlobRef whose chunks
    // never came (the handler died, the wire dropped them) hung its reader
    // for good and kept the assembly forever.
    const server = makeServer()
    const { connection } = await connect(server, { requestTimeoutMs: 30 })
    const blobs = (connection as unknown as { blobs: Map<string, unknown> }).blobs
    await expect(connection.readBlob({ $blob: 'never', bytes: 1 })).rejects.toMatchObject({
      code: 'timeout',
      retryable: true,
    })
    expect(blobs.size).toBe(0)
    // Per-read override, `0` = no deadline: still pending well past 30 ms.
    let settled = false
    const controller = new AbortController()
    connection
      .readBlob({ $blob: 'never-2', bytes: 1 }, { timeoutMs: 0, signal: controller.signal })
      .catch(() => {})
      .finally(() => {
        settled = true
      })
    await new Promise<void>(resolve => setTimeout(resolve, 60))
    expect(settled).toBe(false)
    controller.abort()
    connection.close()
  })

  it('a stale PARTIAL assembly nobody waits on is evicted', async () => {
    // Chunks without a `last` — the sender gave up mid-blob — used to be
    // immortal: no `total`, no `orphanedAt`, so `evictOrphans` skipped them.
    const server = makeServer()
    server.registry.registerCapability({
      cap: 'file',
      actions: { read: { scope: 'observe' } },
      handle: async r => ({ data: r.blobs.offer(new Uint8Array([1, 2, 3])) }),
    })
    const { connection } = await connect(server)
    const internals = connection as unknown as {
      blobs: Map<string, { chunks: Map<number, Uint8Array> }>
      assemblyFor(id: string): { chunks: Map<number, Uint8Array> }
    }
    const nowSpy = vi.spyOn(Date, 'now')
    let clock = 1_000_000
    nowSpy.mockImplementation(() => clock)
    try {
      internals.assemblyFor('half').chunks.set(0, new Uint8Array([9]))
      expect(internals.blobs.has('half')).toBe(true)
      clock += 30_000 // young: the next blob activity keeps it
      const first = (await connection.request('file.read')) as { data: BlobRef }
      await connection.readBlob(first.data)
      expect(internals.blobs.has('half')).toBe(true)
      clock += 31_000 // past the partial TTL
      const second = (await connection.request('file.read')) as { data: BlobRef }
      await connection.readBlob(second.data)
      expect(internals.blobs.has('half')).toBe(false)
    } finally {
      nowSpy.mockRestore()
      connection.close()
    }
  })

  it('readBlob while reconnecting rejects at once, retryable', async () => {
    const server = makeServer()
    const { connection } = await connect(server)
    const internals = connection as unknown as {
      setState(state: unknown): void
      state: unknown
    }
    const ready = internals.state
    // White-box: put the object in the gap without a reconnect harness (that
    // lives in runtime-connection-reconnect.test.ts) — only the guard matters.
    internals.setState({ status: 'reconnecting', attempt: 1, lastWelcome: connection.welcome, nextAttemptAt: 0 })
    try {
      await expect(connection.readBlob({ $blob: 'gap', bytes: 1 })).rejects.toMatchObject({
        code: 'cancelled',
        retryable: true,
      })
    } finally {
      internals.setState(ready)
      connection.close()
    }
  })
})

describe('request when the transport refuses the frame', () => {
  it('a synchronous send throw settles the request at once and leaves no pending entry or timer', async () => {
    // Before: the pending entry, its deadline timer and the abort listener
    // stayed until the timer fired — which then sent a spurious `cancel` for
    // a request that never left this side.
    const server = makeServer()
    const { connection } = await connect(server, { requestTimeoutMs: 50 })
    const internals = connection as unknown as {
      transport: { send(frame: unknown): void }
      pending: Map<string, unknown>
    }
    const realSend = internals.transport.send.bind(internals.transport)
    const sent: unknown[] = []
    internals.transport.send = (frame: unknown) => {
      sent.push(frame)
      if ((frame as { kind: string }).kind === 'req') throw new Error('socket is CLOSING')
      realSend(frame)
    }
    try {
      const controller = new AbortController()
      const error = await rejectionOf(connection.request('k.ok', {}, { signal: controller.signal }))
      expect(error).toMatchObject({ code: 'cancelled', retryable: true })
      expect(error.message).toContain('socket is CLOSING')
      expect(internals.pending.size).toBe(0)
      // Neither the deadline nor a later abort sends a `cancel` for it.
      await new Promise<void>(resolve => setTimeout(resolve, 80))
      controller.abort()
      expect(sent.filter(frame => (frame as { kind: string }).kind === 'cancel')).toHaveLength(0)
    } finally {
      internals.transport.send = realSend
      connection.close()
    }
  })
})

describe('state', () => {
  it('reports closed with transport when the peer port dies, and notifies listeners', async () => {
    const server = makeServer()
    const { connection, channel } = await connect(server)
    const states: string[] = []
    connection.watchLinkState(s => states.push(s.status))
    channel.port1.close()
    await until(() => connection.state.status === 'closed', 'closed')
    // (plus the transport's own `reason` for the close, whatever it names it)
    expect(connection.state).toMatchObject({ status: 'closed', code: 'transport' })
    expect(states).toEqual(['closed'])
  })

  it('is a RuntimeConnection by interface', async () => {
    const server = makeServer()
    const { connection } = await connect(server)
    const asInterface: RuntimeConnection = connection
    expect(typeof asInterface.request).toBe('function')
    connection.close()
  })
})

describe('scopeCeiling', () => {
  it('rides hello; the welcome scope, the adverts and the request checks all reflect the clamp', async () => {
    const server = makeServer()
    server.registry.registerCapability({
      cap: 'echo',
      actions: { say: { scope: 'observe' }, admin: { scope: 'full' } },
      handle: async r => r.payload,
    })
    const channel = new MessageChannel()
    server.hub.attach(createMessagePortTransport(channel.port1))
    const connection = await connectRuntime({
      transport: createMessagePortTransport(channel.port2),
      client: { clientId: 'c', kind: 'desktop-shell' },
      scopeCeiling: 'observe',
    })
    expect(connection.welcome?.scope).toEqual({ mode: 'observe', sessions: 'all' })
    expect(connection.can('echo', 'say')).toBe(true)
    expect(connection.can('echo', 'admin')).toBe(false)
    expect(await connection.request('echo.say', { ok: 1 })).toEqual({ ok: 1 })
    const rejection = await rejectionOf(connection.request('echo.admin', {}))
    expect(rejection.code).toBe('forbidden_scope')
    connection.close()
  })
})

/**
 * A runtime NEWER than this client: it speaks enumeration values this build
 * does not know. The client must degrade (fallback value), never drop the
 * frame — a dropped `res` would hang until the timeout, a dropped `welcome`
 * would never connect, a dropped `evt` would leave a seq hole.
 */
describe('a newer runtime (unknown enumeration values)', () => {
  async function newerRuntime(scopeMode = 'full') {
    const channel = new MessageChannel()
    const sent: Array<Record<string, unknown>> = []
    const server = channel.port1
    server.onmessage = event => {
      const frame = event.data as Record<string, unknown>
      sent.push(frame)
      if (frame['kind'] === 'hello') {
        server.postMessage({
          kind: 'welcome',
          v: RUNTIME_PROTOCOL_VERSION,
          connectionId: 'conn-n',
          resumed: false,
          scope: { mode: scopeMode, sessions: 'all' },
          server: { runtimeVersion: 'newer', capabilities: [{ cap: 'x', acts: ['go'] }] },
        })
      }
    }
    const connection = await connectRuntime({
      transport: createMessagePortTransport(channel.port2),
      client: { clientId: 'c1', kind: 'desktop-shell' },
      requestTimeoutMs: 60_000,
    })
    return { connection, server, sent }
  }

  it('connects when welcome names a scope mode it does not know, reading it as observe', async () => {
    const { connection } = await newerRuntime('superuser')
    expect(connection.state.status).toBe('ready')
    if (connection.state.status === 'ready') expect(connection.state.welcome.scope.mode).toBe('observe')
    connection.close()
  })

  it('an unknown error code rejects the request at once as internal, keeping the sent code', async () => {
    const { connection, server, sent } = await newerRuntime()
    const pending = connection.request('x.go', {})
    await until(() => sent.some(f => f['kind'] === 'req'), 'the req')
    const req = sent.find(f => f['kind'] === 'req')!
    server.postMessage({
      kind: 'res',
      id: req['id'],
      ok: false,
      error: { code: 'quota_exceeded', message: 'later', retryable: true },
    })
    const rejection = await rejectionOf(pending)
    expect(rejection.code).toBe('internal')
    expect(rejection.retryable).toBe(true)
    expect(rejection.wire.unknownCode).toBe('quota_exceeded')
    connection.close()
  })

  it('an event with an unknown form advances the seq silently: the next delta is delivered, no re-subscribe', async () => {
    const { connection, server, sent } = await newerRuntime()
    const seen: TopicEvent[] = []
    connection.subscribe('t/a', e => seen.push(e))
    await until(() => sent.some(f => f['kind'] === 'req'), 'the subscribe')
    const sub = sent.find(f => f['kind'] === 'req')!
    server.postMessage({ kind: 'res', id: sub['id'], ok: true })
    server.postMessage({ kind: 'evt', topic: 't/a', seq: 0, form: 'snapshot', payload: 'S' })
    server.postMessage({ kind: 'evt', topic: 't/a', seq: 1, form: 'patch', payload: { op: 'x' } })
    server.postMessage({ kind: 'evt', topic: 't/a', seq: 2, form: 'delta', payload: 'd2' })
    await until(() => seen.length === 2, 'snapshot + d2')
    await flush()
    expect(seen.map(e => [e.form, e.payload, e.seq])).toEqual([['snapshot', 'S', 0], ['delta', 'd2', 2]])
    expect(sent.filter(f => f['kind'] === 'req')).toHaveLength(1)
    connection.close()
  })

  it('an unknown bye code closes the connection instead of being ignored', async () => {
    const { connection, server } = await newerRuntime()
    server.postMessage({ kind: 'bye', code: 'maintenance' })
    await until(() => connection.state.status === 'closed', 'closed')
    connection.close()
  })
})

describe('an older runtime meeting a newer client', () => {
  it('an auth mode it does not know is answered bye unauthorized, not silence', async () => {
    const server = makeServer()
    const channel = new MessageChannel()
    server.hub.attach(createMessagePortTransport(channel.port1))
    const received: Array<Record<string, unknown>> = []
    channel.port2.onmessage = event => received.push(event.data as Record<string, unknown>)
    channel.port2.postMessage({
      kind: 'hello',
      v: RUNTIME_PROTOCOL_VERSION,
      client: { clientId: 'c9', kind: 'smartwatch' },
      auth: { mode: 'oauth', token: 't' },
    })
    await until(() => received.length > 0, 'an answer')
    expect(received[0]).toEqual({ kind: 'bye', code: 'unauthorized' })
  })

  it('an unknown client kind and scope ceiling still connect, clamped to observe', async () => {
    const server = makeServer()
    const channel = new MessageChannel()
    server.hub.attach(createMessagePortTransport(channel.port1))
    const received: Array<Record<string, unknown>> = []
    channel.port2.onmessage = event => received.push(event.data as Record<string, unknown>)
    channel.port2.postMessage({
      kind: 'hello',
      v: RUNTIME_PROTOCOL_VERSION,
      client: { clientId: 'c9', kind: 'smartwatch' },
      auth: { mode: 'local' },
      scopeCeiling: 'auditor',
    })
    await until(() => received.length > 0, 'an answer')
    expect(received[0]?.['kind']).toBe('welcome')
    expect((received[0]?.['scope'] as { mode: string }).mode).toBe('observe')
  })
})
