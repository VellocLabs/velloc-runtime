/**
 * (F-24): reconnect-and-resume in `RuntimeConnection`, against a real `ConnectionHub` over loopback transports with
 * `close(code, retryable)`. Pinned: the object and listeners survive the swap; heartbeat and handshake timers re-arm
 * per transport; a resumed topic has no seq hole or duplicate; a refused resume re-subscribes; `unauthorized` /
 * 4003 never retry and `close()` cancels a pending retry; a failed retry counts as one attempt.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import { type Frame } from '../browser/runtimeProtocol'
import {
  ListenerSet,
  createWebSocketTransport,
  type FrameTransport,
  type FrameTransportKind,
  type SocketSurface,
} from '../browser/runtimeTransport'
import { CapabilityRegistry } from '../browser/runtimeHub/CapabilityRegistry'
import { ConnectionHub } from '../browser/runtimeHub/ConnectionHub'
import { TopicBroker, type TopicBrokerOptions } from '../browser/runtimeHub/TopicBroker'
import { createPairingTable } from '../browser/runtimeHub/pairingTable'
import type { RuntimeContext, TopicProvider } from '../browser/runtimeHub'
import type { WebUiBridgeContext } from '../browser/worker/webUiBridge'
import { STALE_DIAL_MS } from '../browser/runtimeClient/RuntimeConnection'
import {
  connectRuntime,
  type ConnectionState,
  type RuntimeConnection,
  type TopicEvent,
} from '../browser/runtimeClient'

// ---- loopback with a controllable close --------------------------------------

type End = FrameTransport & {
  peer: End | null
  frames: ListenerSet<[Frame]>
  closed: ListenerSet<[string, boolean]>
  isClosed: boolean
  /** Kill this end (and its peer) reporting `reason` / `retryable`. */
  drop(reason: string, retryable: boolean): void
}

function loopback(kind: FrameTransportKind = 'websocket'): { client: End; server: End } {
  function makeEnd(): End {
    const end = {
      kind,
      limits: { chunkBytes: 1024, windowChunks: 8 },
      peer: null as End | null,
      frames: new ListenerSet<[Frame]>(),
      closed: new ListenerSet<[string, boolean]>(),
      isClosed: false,
      bufferedBytes: () => 0,
      send(frame: Frame) {
        if (end.isClosed) return
        const p = end.peer
        queueMicrotask(() => {
          if (p && !p.isClosed) p.frames.emit(frame)
        })
      },
      sendBlobChunk() {},
      onFrame: (l: (f: Frame) => void) => end.frames.add(l),
      onBlobChunk: () => () => {},
      onClosed: (l: (r: string, retryable: boolean) => void) => end.closed.add(l),
      drop(reason: string, retryable: boolean) {
        if (end.isClosed) return
        end.isClosed = true
        end.closed.emit(reason, retryable)
        const p = end.peer
        if (p && !p.isClosed) {
          // The peer is marked closed INSIDE the deferred hop, not here: a
          // frame this end sent immediately before closing is already queued,
          // and on a real wire it arrives BEFORE the close. Marking the peer
          // closed synchronously would make the delivery guard swallow it —
          // and `bye` + `close()` is exactly how the hub revokes a pairing.
          queueMicrotask(() =>
            queueMicrotask(() => {
              if (p.isClosed) return
              p.isClosed = true
              p.closed.emit(reason, retryable)
            }),
          )
        }
      },
      close() {
        end.drop('closed', false)
      },
    } as End
    return end
  }
  const client = makeEnd()
  const server = makeEnd()
  client.peer = server
  server.peer = client
  return { client, server }
}

/**
 * Let queued microtasks (the loopback's delivery) and zero-delay timers run.
 * Fake timers are installed for the whole file, so a plain `setTimeout(0)`
 * would never fire — every round has to advance them.
 */
const flush = async (rounds = 8): Promise<void> => {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(0)
  }
}

function makeContext(): RuntimeContext {
  const webUiBridge: WebUiBridgeContext = {
    homeDir: '/h',
    fs: {} as RuntimeFs,
    broadcastEvent: vi.fn(),
    directBridge: null,
  }
  return {
    fs: {} as RuntimeFs,
    host: null,
    homeDir: '/h',
    publish: () => 0,
    connections: () => [],
    webUiBridge,
  }
}

/**
 * A hub with one `observe` topic (`t/feed`) and one `observe` action, reached
 * through a REAL `pair` handshake — `local` auth is refused off a websocket
 * by design ("local off a port is a lie"), and `pair` is what a
 * remote client actually speaks, so every reconnect here re-answers the
 * challenge the way the live path does.
 */
function makeRig(brokerOptions: TopicBrokerOptions = {}) {
  const registry = new CapabilityRegistry()
  const broker = new TopicBroker(brokerOptions)
  const state: unknown[] = ['snap-0']
  const provider: TopicProvider = {
    matches: id => id.startsWith('t/'),
    authorize: () => true,
    async *snapshot() {
      for (const page of state) yield { payload: page }
    },
  }
  broker.registerProvider(provider)
  registry.registerCapability({
    cap: 'echo',
    actions: { say: { scope: 'observe' } },
    handle: async r => r.payload,
  })
  const pairings = createPairingTable()
  const pairing = pairings.start({ mode: 'control', sessions: 'all' })
  const hub = new ConnectionHub({
    registry,
    broker,
    context: makeContext(),
    runtimeVersion: 'rc-test',
    bootstrap: () => ({ homeDir: '/h', platform: 'test', pathSep: '/' }),
    pairings,
  })
  return { hub, broker, registry, state, pairings, pairing }
}

type Rig = ReturnType<typeof makeRig>

/** Attach a fresh loopback pair to the hub and hand the client end back. */
function dial(rig: Rig): End {
  const { client, server } = loopback()
  rig.hub.attach(server)
  return client
}

/** The pair auth every client in this file uses. */
function pairAuth(rig: Rig): {
  auth: { mode: 'pair'; pairId: string }
  pairSecret: string
} {
  return {
    auth: { mode: 'pair', pairId: rig.pairing.pairId },
    pairSecret: rig.pairing.secret,
  }
}

async function connectWithReconnect(
  rig: Rig,
  options: { random?: () => number } = {},
): Promise<{ connection: RuntimeConnection; states: ConnectionState[]; transports: End[] }> {
  const transports: End[] = []
  const first = dial(rig)
  transports.push(first)
  const connecting = connectRuntime({
    transport: first,
    client: { clientId: 'remote-1', kind: 'browser' },
    ...pairAuth(rig),
    // 0 = no handshake deadline. The hub's own challenge timeout still
    // bounds a stuck handshake; a client-side deadline here would race the
    // fake clock the reconnect assertions advance.
    handshakeTimeoutMs: 0,
    reconnect: {
      createTransport: () => {
        const next = dial(rig)
        transports.push(next)
        return next
      },
      baseDelayMs: 10,
      maxDelayMs: 40,
      // Deterministic jitter: the delay is exactly the ceiling's midpoint.
      random: options.random ?? (() => 0),
    },
  })
  // The handshake is challenge/auth round trips over queued microtasks, and
  // fake timers are already installed — drive them.
  await vi.advanceTimersByTimeAsync(0)
  await flush()
  const connection = await connecting
  const states: ConnectionState[] = []
  connection.watchLinkState(s => states.push(s))
  return { connection, states, transports }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

/** Advance fake timers AND let microtask-driven loopback traffic settle. */
async function tick(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
  await flush()
}

describe('RuntimeConnection reconnect', () => {
  it('reconnects after a retryable drop and resumes the same connectionId', async () => {
    const rig = makeRig()
    const { connection, states } = await connectWithReconnect(rig)
    const originalId = connection.welcome!.connectionId

    // The wire dies the way a relay restart looks: retryable, mid-session.
    expect(rig.hub.list()).toHaveLength(1)
    ;(connection as unknown as { transport: End }).transport.drop('ws-1006', true)
    await flush()
    expect(connection.state.status).toBe('reconnecting')

    await tick(50)
    await flush()

    expect(connection.state.status).toBe('ready')
    // Resume means the SAME connection id, not a new one.
    expect(connection.welcome!.connectionId).toBe(originalId)
    expect(connection.welcome!.resumed).toBe(true)
    expect(states.map(s => s.status)).toEqual(['reconnecting', 'ready'])
    connection.close()
  })

  it('keeps the same object and its subscriptions, with no seq hole across the gap', async () => {
    const rig = makeRig()
    const { connection } = await connectWithReconnect(rig)

    const seen: TopicEvent[] = []
    connection.subscribe('t/feed', e => seen.push(e))
    await flush()
    rig.broker.publish('t/feed', 'a')
    await flush()

    const beforeGap = seen.length
    expect(beforeGap).toBeGreaterThan(0)
    const lastSeqBefore = seen[seen.length - 1]!.seq

    ;(connection as unknown as { transport: End }).transport.drop('ws-1006', true)
    await flush()
    // Published while the client is away: the broker's ring holds it, and the
    // resume's `topics` seq is what makes it arrive rather than vanish.
    rig.broker.publish('t/feed', 'b')
    await tick(50)
    await flush()
    rig.broker.publish('t/feed', 'c')
    await flush()

    expect(connection.state.status).toBe('ready')
    const after = seen.slice(beforeGap)
    const payloads = after.map(e => e.payload)
    expect(payloads).toContain('b')
    expect(payloads).toContain('c')
    // No duplicate of what we already had, and the seqs only go up.
    const seqs = seen.map(e => e.seq)
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y))
    expect(new Set(after.map(e => e.seq)).size).toBe(after.length)
    expect(after[0]!.seq).toBeGreaterThan(lastSeqBefore)
    connection.close()
  })

  it('a topic still waiting for its snapshot when the wire died is subscribed fresh, not resumed from seq 0', async () => {
    // `since: 0` reads to the broker as "replay what follows 0": with nothing
    // published yet that is nothing at all (and with a ring, deltas only), so
    // the snapshot the listener was waiting for never came and the session
    // list / state stayed empty. Left out of the resume, the topic gets the
    // fresh subscribe `onResumeWelcome` sends for a topic the resume did not name.
    const rig = makeRig()
    const { connection } = await connectWithReconnect(rig)
    const seen: TopicEvent[] = []
    connection.subscribe('t/feed', e => seen.push(e))
    // The wire dies before the subscribe's snapshot can come back.
    ;(connection as unknown as { transport: End }).transport.drop('ws-1006', true)
    await flush()
    expect(seen).toEqual([])

    await tick(50)
    await flush()
    expect(connection.state.status).toBe('ready')
    expect(connection.welcome!.resumed).toBe(true)
    expect(seen.map(e => [e.form, e.payload])).toContainEqual(['snapshot', 'snap-0'])
    // Nothing had been delivered on it: this is its first snapshot, not a recovery.
    expect(seen.some(e => e.resync)).toBe(false)
    connection.close()
  })

  it('re-subscribes every held topic when the runtime refuses the resume', async () => {
    const rig = makeRig()
    const { connection } = await connectWithReconnect(rig)
    const originalId = connection.welcome!.connectionId

    const seen: TopicEvent[] = []
    connection.subscribe('t/feed', e => seen.push(e))
    await flush()
    const before = seen.length

    ;(connection as unknown as { transport: End }).transport.drop('ws-1006', true)
    await flush()
    // The runtime forgot us (retention lapsed / worker restarted). Cleared
    // AFTER the drop, because the drop's own teardown is what files the
    // retention entry in the first place.
    ;(rig.hub as unknown as { retained: Map<string, unknown> }).retained.clear()
    await tick(50)
    await flush()

    expect(connection.state.status).toBe('ready')
    expect(connection.welcome!.resumed).toBe(false)
    // A new identity...
    expect(connection.welcome!.connectionId).not.toBe(originalId)
    // ...and the topic is live again, via a fresh snapshot rather than a replay.
    expect(seen.length).toBeGreaterThan(before)
    expect(seen[seen.length - 1]!.form).toBe('snapshot')
    // The topic had delivered before the gap, and a new seq space says
    // nothing about what was missed: the snapshot is a recovery.
    expect(seen[seen.length - 1]!.resync).toBe(true)
    connection.close()
  })

  it('a resume whose since the replay ring evicted gets a snapshot flagged resync', async () => {
    const rig = makeRig({ ringCount: 2 })
    const { connection } = await connectWithReconnect(rig)
    const seen: TopicEvent[] = []
    connection.subscribe('t/feed', e => seen.push(e))
    await flush()
    rig.broker.publish('t/feed', 'a')
    await flush()
    expect(seen.map(e => [e.form, e.payload, e.resync])).toEqual([
      ['snapshot', 'snap-0', undefined],
      ['delta', 'a', undefined],
    ])

    ;(connection as unknown as { transport: End }).transport.drop('ws-1006', true)
    await flush()
    // A busy stretch while away: the two-entry ring no longer reaches back to 1.
    for (const d of ['b', 'c', 'd']) rig.broker.publish('t/feed', d)
    await tick(50)
    await flush()

    expect(connection.state.status).toBe('ready')
    expect(connection.welcome!.resumed).toBe(true)
    expect(seen.slice(2).map(e => [e.form, e.seq, e.payload, e.resync])).toEqual([['snapshot', 4, 'snap-0', true]])
    connection.close()
  })

  it('a topic subscribed between the resume hello and its welcome goes on the wire once resumed', async () => {
    // The resume names the topics held when the retry DIALLED. A subscribe
    // made after that — the wire is up, the welcome not yet in — cannot be
    // sent (requests are refused while reconnecting), and a RESUMED welcome
    // used to re-subscribe nothing: the topic sat in the client map with a
    // listener that never fired.
    const rig = makeRig()
    const { connection } = await connectWithReconnect(rig)
    const feed: TopicEvent[] = []
    connection.subscribe('t/feed', e => feed.push(e))
    await flush()

    ;(connection as unknown as { transport: End }).transport.drop('ws-1006', true)
    await flush()
    expect(connection.state.status).toBe('reconnecting')
    // Dial now: the new transport is wired and `hello.resume` is queued, but
    // nothing has crossed the loopback yet — this is the window.
    connection.reconnectNow()
    const other: TopicEvent[] = []
    connection.subscribe('t/other', e => other.push(e))
    expect(connection.state.status).toBe('reconnecting')

    await flush()
    expect(connection.state.status).toBe('ready')
    expect(connection.welcome!.resumed).toBe(true)
    await flush()
    rig.broker.publish('t/other', 'x')
    await flush()
    expect(other.map(e => e.payload)).toContain('x')
    // The topic the resume DID carry is untouched: no second snapshot.
    expect(feed.filter(e => e.form === 'snapshot')).toHaveLength(1)
    connection.close()
  })

  it('a topic unsubscribed between the resume hello and its welcome is released on the runtime once resumed', async () => {
    // Mirror case: the resume re-attached the topic server-side, and the
    // client's unsubscribe in the window was refused — an orphan subscription
    // the runtime kept publishing into.
    const rig = makeRig()
    const { connection } = await connectWithReconnect(rig)
    const connectionId = connection.welcome!.connectionId
    const off = connection.subscribe('t/feed', () => {})
    await flush()
    expect(rig.broker.subscribersOf('t/feed')).toContain(connectionId)

    ;(connection as unknown as { transport: End }).transport.drop('ws-1006', true)
    await flush()
    connection.reconnectNow()
    off()

    await flush()
    expect(connection.state.status).toBe('ready')
    expect(connection.welcome!.resumed).toBe(true)
    await flush()
    expect(rig.broker.subscribersOf('t/feed')).not.toContain(connectionId)
    connection.close()
  })

  it('rejects in-flight and new requests as retryable while reconnecting', async () => {
    const rig = makeRig()
    const { connection } = await connectWithReconnect(rig)

    const inflight = connection.request('echo.say', { hi: 1 })
    // Asserted below, but attach the handler NOW: the rejection fires inside
    // the drop, and an unhandled one fails the run.
    const inflightSettled = inflight.catch((e: unknown) => e)
    ;(connection as unknown as { transport: End }).transport.drop('ws-1006', true)
    await flush()

    expect(await inflightSettled).toMatchObject({ code: 'cancelled', retryable: true })
    await expect(connection.request('echo.say', {})).rejects.toMatchObject({
      code: 'cancelled',
      retryable: true,
    })
    expect(connection.state.status).toBe('reconnecting')

    await tick(50)
    await flush()
    // And it works again on the other side of the gap.
    await expect(connection.request('echo.say', { ok: true })).resolves.toEqual({ ok: true })
    connection.close()
  })

  it('does not reconnect after bye unauthorized', async () => {
    const rig = makeRig()
    const { connection, transports } = await connectWithReconnect(rig)

    // Exactly what `PairingTable.revoke` → `hub.revokePairing` does to a live
    // connection: `bye unauthorized`, then close the wire.
    ;(rig.hub as unknown as { connections: Map<string, { close(c: string): void }> }).connections
      .get(connection.welcome!.connectionId)!
      .close('unauthorized')
    await flush()

    expect(connection.state).toEqual({ status: 'closed', code: 'unauthorized' })
    await tick(200)
    expect(transports).toHaveLength(1)
  })

  it('does not reconnect on a non-retryable transport close (4003 listener_disabled)', async () => {
    const rig = makeRig()
    const { connection, transports } = await connectWithReconnect(rig)

    // `createWebSocketTransport` reports 4003 as the one non-retryable close.
    ;(connection as unknown as { transport: End }).transport.drop('ws-4003', false)
    await flush()

    // The reason survives the close: it is the ONLY thing that lets the
    // connect screen say "remote access was turned off" (listener_disabled)
    // instead of a generic "failed".
    expect(connection.state).toEqual({ status: 'closed', code: 'transport', reason: 'ws-4003' })
    await tick(200)
    expect(transports).toHaveLength(1)
  })

  it('uses the fixed slow cadence for 4001 (desktop panel closed), not the ladder, and PUBLISHES the reason', async () => {
    const rig = makeRig()
    const { connection, transports } = await connectWithReconnect(rig)

    ;(connection as unknown as { transport: End }).transport.drop('ws-4001', true)
    await flush()
    expect(connection.state.status).toBe('reconnecting')

    // The cadence alone is invisible to the user. The banner needs to tell
    // "the desktop panel is closed" from "the wire blipped" (F-24 names
    // both states), so the reason that PICKS the cadence must also reach the
    // state — 4001 is `runtime_offline`.
    expect(connection.state).toMatchObject({ status: 'reconnecting', reason: 'ws-4001' })

    // The ladder's first step is 10 ms here; 4001 must wait the fixed 5 s.
    await tick(100)
    expect(transports).toHaveLength(1)
    await tick(5_000)
    await flush()
    expect(transports.length).toBeGreaterThan(1)
    connection.close()
  })

  it('carries the close reason of an ordinary blip, and clears it once resumed', async () => {
    const rig = makeRig()
    const { connection } = await connectWithReconnect(rig)

    ;(connection as unknown as { transport: End }).transport.drop('ws-1006', true)
    await flush()
    // The state reports WHAT closed the wire and leaves the interpreting to the
    // UI — `isDesktopOffline` is what narrows this to 4001, so an ordinary 1006
    // never borrows the "open your desktop" copy (pinned in the render test).
    expect(connection.state).toMatchObject({ status: 'reconnecting', reason: 'ws-1006' })

    await tick(50)
    await flush()
    // Resumed: the episode is over, and a stale reason on a live connection
    // would be a banner explaining a gap that has already closed.
    expect(connection.state.status).toBe('ready')
    expect((connection.state as { reason?: string }).reason).toBeUndefined()
    connection.close()
  })

  it('backs off with a doubling, jittered delay capped at maxDelayMs', async () => {
    const rig = makeRig()
    // Every attempt fails: the hub is not dialled at all, so nothing answers
    // and each handshake times out.
    const delays: number[] = []
    const first = dial(rig)
    const connecting = connectRuntime({
      transport: first,
      client: { clientId: 'remote-2', kind: 'browser' },
      ...pairAuth(rig),
      handshakeTimeoutMs: 20,
      reconnect: {
        createTransport: () => loopback().client, // nothing on the other end
        baseDelayMs: 100,
        maxDelayMs: 400,
        random: () => 1, // upper end of the jitter window = exactly the ceiling
      },
    })
    await vi.advanceTimersByTimeAsync(0)
    await flush()
    const connection = await connecting
    const seen: string[] = []
    let droppedAt = 0
    connection.watchLinkState(s => {
      seen.push(s.status === 'reconnecting' ? `reconnecting#${s.attempt}@${Date.now() - droppedAt}` : s.status)
    })

    droppedAt = Date.now()
    ;(connection as unknown as { transport: End }).transport.drop('ws-1006', true)
    await flush()
    // attempt 1 at 100, 2 at 200, 3 at 400, 4 capped at 400.
    for (const expected of [100, 200, 400, 400]) {
      delays.push(expected)
      await tick(expected + 25)
      await flush()
    }
    // Each timed-out retry wire is ONE attempt, published once: the numbers
    // run consecutively, the next one follows its wire's 20 ms deadline by
    // exactly the ladder's delay, and the state never passes through closed.
    // The loopback's close() reports itself non-retryable, so a deadline that
    // closed the wire while still listening would publish `closed` here.
    expect(seen).toEqual([
      'reconnecting#1@0',
      'reconnecting#2@120', // 100 delay + 20 deadline
      'reconnecting#3@340', // + 200 + 20
      'reconnecting#4@760', // + 400 + 20
      'reconnecting#5@1180', // + 400 (capped) + 20
    ])
    connection.close()
    expect(connection.state.status).toBe('closed')
  })

  it('a timed-out retry wire over a real websocket transport counts as one attempt', async () => {
    // The production shape: `createWebSocketTransport.close()` reports its own
    // close synchronously as a retryable `ws-1000`. The handshake deadline must
    // not ALSO count that report as a failed attempt.
    const rig = makeRig()
    const neverOpens = (): SocketSurface =>
      ({
        readyState: 0,
        bufferedAmount: 0,
        binaryType: 'blob',
        send() {},
        close() {},
        addEventListener() {},
        removeEventListener() {},
      }) as unknown as SocketSurface
    const connecting = connectRuntime({
      transport: dial(rig),
      client: { clientId: 'remote-ws', kind: 'browser' },
      ...pairAuth(rig),
      handshakeTimeoutMs: 20,
      reconnect: {
        createTransport: () => createWebSocketTransport(neverOpens()),
        baseDelayMs: 100,
        maxDelayMs: 400,
        random: () => 1,
      },
    })
    await vi.advanceTimersByTimeAsync(0)
    await flush()
    const connection = await connecting
    const attempts: Array<number | string> = []
    connection.watchLinkState(s => attempts.push(s.status === 'reconnecting' ? s.attempt : s.status))

    ;(connection as unknown as { transport: End }).transport.drop('ws-1006', true)
    await flush()
    await tick(120) // attempt 1's wire: dialled at 100, deadline at 120
    expect(attempts).toEqual([1, 2])
    await tick(220) // attempt 2's wire: dialled at 320, deadline at 340
    expect(attempts).toEqual([1, 2, 3])
    connection.close()
  })

  it('a retry wire that answers bye shutting_down is one attempt, retried on the ladder', async () => {
    // The runtime restarting again while we reconnect: the new wire says
    // goodbye before any welcome. That is one failed attempt — not two (the
    // wire's own close report on top), and never the end of the connection.
    const rig = makeRig()
    const retries: End[] = []
    const connecting = connectRuntime({
      transport: dial(rig),
      client: { clientId: 'remote-bye', kind: 'browser' },
      ...pairAuth(rig),
      // Long: the bye, not the deadline, must drive the next attempt.
      handshakeTimeoutMs: 15_000,
      reconnect: {
        createTransport: () => {
          const { client, server } = loopback()
          retries.push(client)
          server.send({ kind: 'bye', code: 'shutting_down' })
          return client
        },
        baseDelayMs: 10,
        maxDelayMs: 40,
        random: () => 1,
      },
    })
    await vi.advanceTimersByTimeAsync(0)
    await flush()
    const connection = await connecting
    const attempts: Array<number | string> = []
    connection.watchLinkState(s => attempts.push(s.status === 'reconnecting' ? s.attempt : s.status))

    ;(connection as unknown as { transport: End }).transport.drop('ws-1006', true)
    await flush()
    await tick(10)
    expect(attempts).toEqual([1, 2])
    await tick(20)
    expect(attempts).toEqual([1, 2, 3])
    await tick(40)
    expect(attempts).toEqual([1, 2, 3, 4])
    expect(retries).toHaveLength(3)
    connection.close()
  })

  it('a closed connection is never brought back by a late retry', async () => {
    // Defence in depth for the invariant above: `markClosed` has already
    // rejected the caller's work and dropped the subscriptions, so nothing
    // may schedule a retry from `closed` (white-box — every public path now
    // checks for reconnecting first).
    const rig = makeRig()
    const { connection, transports } = await connectWithReconnect(rig)
    connection.close()
    ;(connection as unknown as { queueRedial(reason: string | null): void }).queueRedial(null)
    expect(connection.state.status).toBe('closed')
    await tick(500)
    expect(connection.state.status).toBe('closed')
    expect(transports).toHaveLength(1)
  })

  /**
   * A connection whose every retry wire is closed by the far end right after
   * it is created — the relay refusing each `/rt` dial. `handshakeTimeoutMs`
   * is deliberately long: the close, not the deadline, must drive the retry.
   */
  async function connectWithRefusedRetries(
    rig: Rig,
    refuse: { reason: string; retryable: boolean },
  ): Promise<{ connection: RuntimeConnection; retries: End[] }> {
    const retries: End[] = []
    const connecting = connectRuntime({
      transport: dial(rig),
      client: { clientId: 'remote-refused', kind: 'browser' },
      ...pairAuth(rig),
      handshakeTimeoutMs: 15_000,
      reconnect: {
        createTransport: () => {
          const next = loopback().client
          retries.push(next)
          // After tryReconnect has wired it, as a real socket's close is async.
          queueMicrotask(() => next.drop(refuse.reason, refuse.retryable))
          return next
        },
        baseDelayMs: 10,
        maxDelayMs: 40,
        random: () => 0,
      },
    })
    await vi.advanceTimersByTimeAsync(0)
    await flush()
    return { connection: await connecting, retries }
  }

  it('a retry wire refused with 4001 schedules the next attempt at the slow cadence, not after the handshake deadline', async () => {
    const rig = makeRig()
    const { connection, retries } = await connectWithRefusedRetries(rig, { reason: 'ws-4001', retryable: true })

    ;(connection as unknown as { transport: End }).transport.drop('ws-4001', true)
    await flush()
    await tick(5_100)
    expect(retries).toHaveLength(1)
    // The refusal is seen at once, so attempt 2 follows 5 s later — not 15 s
    // of handshake deadline and then the doubling ladder.
    await tick(5_100)
    expect(retries).toHaveLength(2)
    expect(connection.state).toMatchObject({ status: 'reconnecting', reason: 'ws-4001' })
    connection.close()
  })

  it('a final close (4003) on a retry wire ends the connection', async () => {
    const rig = makeRig()
    const { connection, retries } = await connectWithRefusedRetries(rig, { reason: 'ws-4003', retryable: false })

    ;(connection as unknown as { transport: End }).transport.drop('ws-1006', true)
    await flush()
    await tick(50)
    expect(retries).toHaveLength(1)
    expect(connection.state).toEqual({ status: 'closed', code: 'transport', reason: 'ws-4003' })
    await tick(20_000)
    expect(retries).toHaveLength(1)
  })

  it('close() cancels a scheduled reconnect', async () => {
    const rig = makeRig()
    const { connection, transports } = await connectWithReconnect(rig)

    ;(connection as unknown as { transport: End }).transport.drop('ws-1006', true)
    await flush()
    expect(connection.state.status).toBe('reconnecting')

    connection.close()
    expect(connection.state.status).toBe('closed')
    const count = transports.length
    await tick(500)
    expect(transports).toHaveLength(count)
  })

  it('a connection that never reached ready does not reconnect', async () => {
    // A handshake that fails is not a gap to bridge: the caller's
    // `connectRuntime` rejects, and retrying behind their back would hide a
    // bad pairing behind an infinite loop.
    const transports: End[] = []
    const promise = connectRuntime({
      transport: loopback().client,
      client: { clientId: 'remote-3', kind: 'browser' },
      auth: { mode: 'pair', pairId: 'never-answered' },
      pairSecret: 'AAAA',
      handshakeTimeoutMs: 20,
      reconnect: {
        createTransport: () => {
          const next = loopback().client
          transports.push(next)
          return next
        },
        baseDelayMs: 10,
      },
    })
    const rejection = expect(promise).rejects.toMatchObject({ code: 'transport' })
    await tick(40)
    await rejection
    await tick(200)
    expect(transports).toHaveLength(0)
  })

  it('re-arms the heartbeat on the new transport (WP-3 note: timers were per-object)', async () => {
    const rig = makeRig()
    const first = dial(rig)
    const connecting = connectRuntime({
      transport: first,
      client: { clientId: 'remote-4', kind: 'browser' },
      ...pairAuth(rig),
      handshakeTimeoutMs: 0,
      heartbeat: { intervalMs: 50, timeoutMs: 20 },
      reconnect: {
        createTransport: () => dial(rig),
        baseDelayMs: 10,
        maxDelayMs: 40,
        random: () => 0,
      },
    })
    await vi.advanceTimersByTimeAsync(0)
    await flush()
    const connection = await connecting

    ;(connection as unknown as { transport: End }).transport.drop('ws-1006', true)
    await flush()
    await tick(50)
    await flush()
    expect(connection.state.status).toBe('ready')

    // The heartbeat must be alive on the NEW wire: let several intervals pass
    // and the connection must still be ready (pings answered). If the timer
    // had not re-armed, nothing would ping; if it had leaked onto the dead
    // transport, the misses would close this connection.
    await tick(300)
    await flush()
    expect(connection.state.status).toBe('ready')
    connection.close()
  })
})

/**
 * The remote's offline overlay: the connection says WHEN it will
 * next dial, keeps a flat cadence the overlay can count down after its first
 * quick try, and dials at once when the user presses "Reconnect now".
 */
describe('RuntimeConnection delay ladder and reconnectNow', () => {
  function connectFlaky(rig: Rig, desktop: { back: boolean }, dials: { count: number }) {
    return connectRuntime({
      transport: dial(rig),
      client: { clientId: 'remote-steady', kind: 'browser' },
      ...pairAuth(rig),
      handshakeTimeoutMs: 20,
      reconnect: {
        createTransport: () => {
          dials.count += 1
          // Nothing on the other end until the desktop is back.
          return desktop.back ? dial(rig) : loopback().client
        },
        // The remote's shape (LIVE_RECONNECT_LADDER_MS), shrunk.
        delayLadderMs: [100, 1_000, 3_000],
        random: () => 1,
      },
    })
  }

  it('publishes when the next attempt dials: each ladder step in turn, unjittered, the last one repeating', async () => {
    const rig = makeRig()
    const connecting = connectFlaky(rig, { back: false }, { count: 0 })
    await vi.advanceTimersByTimeAsync(0)
    await flush()
    const connection = await connecting
    const seen: string[] = []
    let droppedAt = 0
    connection.watchLinkState(s => {
      if (s.status !== 'reconnecting') return
      seen.push(`#${s.attempt}@${Date.now() - droppedAt}->${s.nextAttemptAt - droppedAt}`)
    })

    droppedAt = Date.now()
    ;(connection as unknown as { transport: End }).transport.drop('ws-1006', true)
    await flush()
    await tick(125) // attempt 1 dials at 100, its deadline at 120
    await tick(1_025) // attempt 2 dials at 1120, deadline at 1140
    await tick(3_025) // attempt 3 dials at 4140, deadline at 4160
    expect(seen).toEqual([
      '#1@0->100', // step 1
      '#2@120->1120', // the deadline + exactly step 2
      '#3@1140->4140', // step 3
      '#4@4160->7160', // past the end: the last step repeats
    ])
    connection.close()
  })

  it('the ladder also replaces the slow 4001 cadence', async () => {
    const rig = makeRig()
    const connecting = connectFlaky(rig, { back: false }, { count: 0 })
    await vi.advanceTimersByTimeAsync(0)
    await flush()
    const connection = await connecting
    ;(connection as unknown as { transport: End }).transport.drop('ws-4001', true)
    await flush()
    // Not 4001's fixed 5 s: the ladder's first step, and the reason is kept.
    const first = connection.state
    expect(first).toMatchObject({ status: 'reconnecting', attempt: 1, reason: 'ws-4001' })
    expect((first as { nextAttemptAt: number }).nextAttemptAt - Date.now()).toBe(100)
    await tick(125)
    const second = connection.state as { attempt: number; nextAttemptAt: number }
    expect(second.attempt).toBe(2)
    expect(second.nextAttemptAt - Date.now()).toBeLessThanOrEqual(1_000)
    expect(second.nextAttemptAt - Date.now()).toBeGreaterThan(975)
    connection.close()
  })

  it('reconnectNow starts the ladder over: a failed press is followed by the FIRST step, not the one it had climbed to', async () => {
    const rig = makeRig()
    const dials = { count: 0 }
    const connecting = connectFlaky(rig, { back: false }, dials)
    await vi.advanceTimersByTimeAsync(0)
    await flush()
    const connection = await connecting
    ;(connection as unknown as { transport: End }).transport.drop('ws-1006', true)
    await flush()
    await tick(125)
    await tick(1_025) // attempt 2 failed; now waiting step 3 (3 s)
    expect(connection.state).toMatchObject({ status: 'reconnecting', attempt: 3 })
    const dialsBefore = dials.count

    const pressedAt = Date.now()
    connection.reconnectNow()
    expect(connection.state).toMatchObject({ status: 'reconnecting', attempt: 0, nextAttemptAt: pressedAt })
    expect(dials.count).toBe(dialsBefore + 1)
    await tick(25) // the pressed dial's deadline (20 ms): it failed
    const after = connection.state as { attempt: number; nextAttemptAt: number }
    expect(after.attempt).toBe(1)
    expect(after.nextAttemptAt - Date.now()).toBeLessThanOrEqual(100)
    expect(after.nextAttemptAt - Date.now()).toBeGreaterThan(75)
    // …and it climbs again from there.
    await tick(125)
    expect(connection.state).toMatchObject({ status: 'reconnecting', attempt: 2 })
    connection.close()
  })

  it('reconnectNow dials at once, and the connection comes back without waiting out the delay', async () => {
    const rig = makeRig()
    const desktop = { back: false }
    const dials = { count: 0 }
    const connecting = connectFlaky(rig, desktop, dials)
    await vi.advanceTimersByTimeAsync(0)
    await flush()
    const connection = await connecting

    // Ready: nothing to hurry.
    connection.reconnectNow()
    expect(dials.count).toBe(0)
    expect(connection.state.status).toBe('ready')

    ;(connection as unknown as { transport: End }).transport.drop('ws-1006', true)
    await flush()
    await tick(125) // attempt 1 failed; now waiting 1 s for attempt 2
    expect(connection.state).toMatchObject({ status: 'reconnecting', attempt: 2 })
    expect(dials.count).toBe(1)

    desktop.back = true
    const pressedAt = Date.now()
    connection.reconnectNow()
    // Due now, the ladder restarted — the overlay stops counting at once.
    expect(connection.state).toMatchObject({ status: 'reconnecting', attempt: 0, nextAttemptAt: pressedAt })
    expect(dials.count).toBe(2)
    // A second press while that dial is on the wire does not race it.
    connection.reconnectNow()
    expect(dials.count).toBe(2)

    await tick(0)
    await flush()
    expect(connection.state.status).toBe('ready')
    expect(Date.now() - pressedAt).toBeLessThan(1_000)
    expect(connection.welcome!.resumed).toBe(true)
    connection.close()
  })

  it('reconnectNow dials over a HUNG attempt once it is stale, and the connection comes back', async () => {
    // Reported: the desktop quit, came back, and the overlay's
    // button stayed disabled until the page was reloaded — a dial that never
    // answered had nothing to cut it short. A press is now a no-op only while
    // the dial on the wire is young.
    const rig = makeRig()
    const desktop = { back: false }
    const dials = { count: 0 }
    const connecting = connectRuntime({
      transport: dial(rig),
      client: { clientId: 'remote-hung', kind: 'browser' },
      ...pairAuth(rig),
      // Long enough that the deadline never rescues the hung dial here.
      handshakeTimeoutMs: 600_000,
      reconnect: {
        createTransport: () => {
          dials.count += 1
          return desktop.back ? dial(rig) : loopback().client
        },
        delayLadderMs: [100, 1_000],
        random: () => 1,
      },
    })
    await vi.advanceTimersByTimeAsync(0)
    await flush()
    const connection = await connecting
    ;(connection as unknown as { transport: End }).transport.drop('ws-1006', true)
    await flush()
    await tick(125) // attempt 1 dials at 100 — and hangs
    expect(dials.count).toBe(1)

    desktop.back = true
    // Young: a press does not race it.
    connection.reconnectNow()
    expect(dials.count).toBe(1)

    await tick(STALE_DIAL_MS)
    expect(connection.state.status).toBe('reconnecting')
    connection.reconnectNow()
    expect(dials.count).toBe(2)
    await tick(0)
    await flush()
    expect(connection.state.status).toBe('ready')
    expect(connection.welcome!.resumed).toBe(true)
    connection.close()
  })

  it('a state listener that throws does not strand the reconnect schedule', async () => {
    // The schedule used to publish `reconnecting` and THEN arm its timer, so
    // a UI listener throwing on that publish left the connection with no
    // next attempt and nothing to trigger one — "reconnecting" forever.
    const rig = makeRig()
    const desktop = { back: true }
    const connecting = connectFlaky(rig, desktop, { count: 0 })
    await vi.advanceTimersByTimeAsync(0)
    await flush()
    const connection = await connecting
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const later = vi.fn()
    connection.watchLinkState(state => {
      if (state.status === 'reconnecting') throw new Error('listener bug')
    })
    connection.watchLinkState(later)
    try {
      ;(connection as unknown as { transport: End }).transport.drop('ws-1006', true)
    } catch {
      // Pre-fix the throw escaped into the transport's close; either way the
      // question is whether the connection still comes back.
    }
    await flush()
    // Listeners after the thrower still hear the state.
    expect(later).toHaveBeenCalledWith(expect.objectContaining({ status: 'reconnecting' }))
    await tick(125)
    await flush()
    expect(connection.state.status).toBe('ready')
    expect(errors).toHaveBeenCalled()
    errors.mockRestore()
    connection.close()
  })

  it('reconnectNow after close does nothing', async () => {
    const rig = makeRig()
    const dials = { count: 0 }
    const connecting = connectFlaky(rig, { back: false }, dials)
    await vi.advanceTimersByTimeAsync(0)
    await flush()
    const connection = await connecting
    connection.close()
    connection.reconnectNow()
    expect(dials.count).toBe(0)
    expect(connection.state.status).toBe('closed')
  })
})
