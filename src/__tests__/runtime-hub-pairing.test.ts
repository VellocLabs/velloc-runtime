/**
 * (F-24): the hub side of the `pair`
 * handshake. Driven through a ConnectionHub over loopback transports exactly
 * as runtime-hub.test.ts drives the local handshake, but with `kind:
 * 'websocket'` so the pair branch is reachable. Every failure (unknown pairId,
 * expired, revoked, rate-limited, bad proof, local-over-websocket) closes with
 * the SAME indistinguishable `bye unauthorized`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import {
  RUNTIME_PROTOCOL_VERSION,
  SYS_PING_ROUTE,
  TOPICS_SUBSCRIBE_ROUTE,
  isFrame,
  type EvtFrame,
  type Frame,
  type HelloFrame,
  type ResFrame,
  type WelcomeFrame,
} from '../browser/runtimeProtocol'
import {
  ListenerSet,
  type FrameTransport,
  type FrameTransportKind,
} from '../browser/runtimeTransport'
import { CapabilityRegistry } from '../browser/runtimeHub/CapabilityRegistry'
import { ConnectionHub } from '../browser/runtimeHub/ConnectionHub'
import { TopicBroker } from '../browser/runtimeHub/TopicBroker'
import { createPairingTable, type PairingTable } from '../browser/runtimeHub/pairingTable'
import { pairProof } from '../browser/runtimeProtocol/pairProof'
import type { ConnectionInfo, RuntimeContext } from '../browser/runtimeHub'
import type { WebUiBridgeContext } from '../browser/worker/webUiBridge'

// ---- loopback (websocket kind, small blob window like a real socket) ----------

type End = FrameTransport & {
  sent: Frame[]
  peer: End | null
  frames: ListenerSet<[Frame]>
  closed: ListenerSet<[string, boolean]>
  isClosed: boolean
}

function loopback(kind: FrameTransportKind = 'websocket'): { client: End; server: End } {
  function makeEnd(): End {
    const end = {
      kind,
      limits: { chunkBytes: 1024, windowChunks: 8 },
      sent: [] as Frame[],
      peer: null as End | null,
      frames: new ListenerSet<[Frame]>(),
      closed: new ListenerSet<[string, boolean]>(),
      isClosed: false,
      bufferedBytes: () => 0,
      send(frame: Frame) {
        if (end.isClosed) return
        end.sent.push(frame)
        const p = end.peer
        queueMicrotask(() => p?.frames.emit(frame))
      },
      sendBlobChunk() {},
      onFrame: (l: (f: Frame) => void) => end.frames.add(l),
      onBlobChunk: () => () => {},
      onClosed: (l: (r: string, retryable: boolean) => void) => end.closed.add(l),
      close() {
        if (end.isClosed) return
        end.isClosed = true
        end.closed.emit('closed', false)
        const p = end.peer
        if (p && !p.isClosed) {
          p.isClosed = true
          queueMicrotask(() => p.closed.emit('closed', false))
        }
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

const flush = async (rounds = 6) => {
  for (let i = 0; i < rounds; i += 1) await new Promise<void>(r => setTimeout(r, 0))
}

function makeContext(): RuntimeContext {
  const webUiBridge: WebUiBridgeContext = {
    homeDir: '/h', fs: {} as RuntimeFs, broadcastEvent: vi.fn(), directBridge: null,
  }
  return {
    fs: {} as RuntimeFs, host: null, homeDir: '/h',
    publish: () => 0, connections: () => [], webUiBridge,
  }
}

type Rig = {
  hub: ConnectionHub
  pairings: PairingTable
  registry: CapabilityRegistry
  broker: TopicBroker
}

function makeRig(
  options: {
    now?: () => number
    challengeTimeoutMs?: number
    onConnectionOpened?: (info: ConnectionInfo) => void
    onConnectionClosed?: (info: ConnectionInfo) => void
  } = {},
): Rig {
  const registry = new CapabilityRegistry()
  const broker = new TopicBroker()
  const context = makeContext()
  context.publish = (id, payload, opts) => broker.publish(id, payload, opts)
  const pairings = createPairingTable(options.now)
  let nextId = 1
  const hub = new ConnectionHub({
    registry, broker, context,
    runtimeVersion: 'test', bootstrap: () => undefined,
    createId: () => `conn-${nextId++}`,
    now: options.now,
    pairings,
    ...(options.challengeTimeoutMs !== undefined
      ? { challengeTimeoutMs: options.challengeTimeoutMs }
      : {}),
    ...(options.onConnectionOpened ? { onConnectionOpened: options.onConnectionOpened } : {}),
    ...(options.onConnectionClosed ? { onConnectionClosed: options.onConnectionClosed } : {}),
  })
  return { hub, pairings, registry, broker }
}

/** A connected pair-handshake client: send hello, get challenge, answer auth. */
class PairClient {
  readonly events: Frame[] = []
  constructor(readonly end: End) {
    end.onFrame(f => this.events.push(f))
  }
  last(): Frame | undefined {
    return this.events[this.events.length - 1]
  }
  async hello(over: Partial<HelloFrame> = {}): Promise<void> {
    this.end.send({
      kind: 'hello', v: RUNTIME_PROTOCOL_VERSION,
      client: { clientId: 'device-1', kind: 'browser' },
      auth: { mode: 'pair', pairId: 'pair-x' },
      ...over,
    } as HelloFrame)
    await flush()
  }
  async auth(proof: string): Promise<void> {
    this.end.send({ kind: 'auth', proof })
    await flush()
  }
  get challenge(): { kind: 'challenge'; nonce: string } | undefined {
    return this.events.find((f): f is { kind: 'challenge'; nonce: string } => f.kind === 'challenge')
  }
  get welcome(): WelcomeFrame | undefined {
    return this.events.find((f): f is WelcomeFrame => f.kind === 'welcome')
  }
  get bye(): Extract<Frame, { kind: 'bye' }> | undefined {
    return this.events.find((f): f is Extract<Frame, { kind: 'bye' }> => f.kind === 'bye')
  }
}

function connect(rig: Rig): PairClient {
  const { client, server } = loopback('websocket')
  rig.hub.attach(server)
  return new PairClient(client)
}

describe('hub pair handshake (WP-3)', () => {
  it('grants the pairing scope on a correct proof', async () => {
    const rig = makeRig()
    const pairing = rig.pairings.start({ mode: 'control', sessions: 'all' })
    const client = connect(rig)
    await client.hello({ auth: { mode: 'pair', pairId: pairing.pairId } })
    expect(client.challenge).toBeDefined()
    await client.auth(pairProof(pairing.secret, client.challenge!.nonce, 'device-1'))
    expect(client.welcome).toBeDefined()
    expect(client.welcome!.scope).toEqual({ mode: 'control', sessions: 'all' })
    expect(client.bye).toBeUndefined()
  })

  it('clamps the pairing scope down to the client\'s scopeCeiling', async () => {
    const rig = makeRig()
    const pairing = rig.pairings.start({ mode: 'control', sessions: 'all' })
    const client = connect(rig)
    await client.hello({
      auth: { mode: 'pair', pairId: pairing.pairId },
      scopeCeiling: 'observe',
    })
    await client.auth(pairProof(pairing.secret, client.challenge!.nonce, 'device-1'))
    expect(client.welcome!.scope.mode).toBe('observe')
  })

  it('scopes a sessions:[id] pairing to that session only', async () => {
    const rig = makeRig()
    const pairing = rig.pairings.start({ mode: 'control', sessions: ['s1'] })
    const client = connect(rig)
    await client.hello({ auth: { mode: 'pair', pairId: pairing.pairId } })
    await client.auth(pairProof(pairing.secret, client.challenge!.nonce, 'device-1'))
    expect(client.welcome!.scope).toEqual({ mode: 'control', sessions: ['s1'] })
    // The hub connection is registered with that sessions binding.
    const info = rig.hub.list().find(c => c.clientId === 'device-1')
    expect(info?.scope.sessions).toEqual(['s1'])
  })

  it('rejects a wrong proof with the SAME bye as every other failure', async () => {
    const rig = makeRig()
    const pairing = rig.pairings.start({ mode: 'control', sessions: 'all' })
    const client = connect(rig)
    await client.hello({ auth: { mode: 'pair', pairId: pairing.pairId } })
    await client.auth('wrong-proof')
    expect(client.bye?.code).toBe('unauthorized')
    expect(client.welcome).toBeUndefined()
  })

  it('rejects an unknown pairId indistinguishably', async () => {
    const rig = makeRig()
    const client = connect(rig)
    await client.hello({ auth: { mode: 'pair', pairId: 'no-such-pair' } })
    expect(client.challenge).toBeUndefined()
    expect(client.bye?.code).toBe('unauthorized')
  })

  it('rejects a revoked pairing and drops its live connections', async () => {
    const rig = makeRig()
    const pairing = rig.pairings.start({ mode: 'control', sessions: 'all' })
    const client = connect(rig)
    await client.hello({ auth: { mode: 'pair', pairId: pairing.pairId } })
    await client.auth(pairProof(pairing.secret, client.challenge!.nonce, 'device-1'))
    expect(client.welcome).toBeDefined()
    expect(rig.hub.list().some(c => c.clientId === 'device-1')).toBe(true)

    // Revoke: the live connection is closed unauthorized (and cannot resume).
    const closed = new Promise<void>(resolve => client.end.onClosed(() => resolve()))
    rig.hub.revokePairing(pairing.pairId)
    await flush()
    await closed
    expect(rig.hub.list().some(c => c.clientId === 'device-1')).toBe(false)

    // And a fresh hello with the revoked id fails like an unknown id.
    const client2 = connect(rig)
    await client2.hello({ auth: { mode: 'pair', pairId: pairing.pairId } })
    expect(client2.bye?.code).toBe('unauthorized')
  })

  it('rejects `local` over a websocket (off a port, local is a lie)', async () => {
    const rig = makeRig()
    const client = connect(rig)
    await client.hello({ auth: { mode: 'local' } })
    expect(client.bye?.code).toBe('unauthorized')
  })

  it('rejects `pair` over a message-port', async () => {
    const rig = makeRig()
    const pairing = rig.pairings.start({ mode: 'control', sessions: 'all' })
    const { client, server } = loopback('message-port')
    rig.hub.attach(server)
    const c = new PairClient(client)
    await c.hello({ auth: { mode: 'pair', pairId: pairing.pairId } })
    expect(c.bye?.code).toBe('unauthorized')
  })

  it('times out a challenge that is never answered, on the configured window', async () => {
    let now = 1_000_000
    // A NON-default window, so the test pins the option rather than the 10 s
    // constant: a hub that ignored challengeTimeoutMs would still be holding
    // this connection at +6 s.
    const rig = makeRig({ now: () => now, challengeTimeoutMs: 5_000 })
    const pairing = rig.pairings.start({ mode: 'control', sessions: 'all' })
    const client = connect(rig)
    await client.hello({ auth: { mode: 'pair', pairId: pairing.pairId } })
    expect(client.challenge).toBeDefined()

    // Still inside the configured window.
    now += 4_000
    rig.hub.sweepNow()
    await flush()
    expect(client.bye).toBeUndefined()

    // Past it — the sweep is the injected reaper, not the wall-clock interval.
    now += 2_000
    rig.hub.sweepNow()
    await flush()
    expect(client.bye?.code).toBe('unauthorized')
  })

  it('rate-limits repeated failed handshakes for one pairId', async () => {
    const rig = makeRig()
    const pairing = rig.pairings.start({ mode: 'control', sessions: 'all' })
    // 10 failed attempts (bad proof) — each gets a challenge then fails.
    for (let i = 0; i < 10; i += 1) {
      const c = connect(rig)
      await c.hello({ auth: { mode: 'pair', pairId: pairing.pairId } })
      await c.auth('bad')
      expect(c.bye?.code).toBe('unauthorized')
    }
    // The 11th is rate-limited: no challenge issued.
    const c = connect(rig)
    await c.hello({ auth: { mode: 'pair', pairId: pairing.pairId } })
    expect(c.challenge).toBeUndefined()
    expect(c.bye?.code).toBe('unauthorized')
  })

  it('rate-limits CONCURRENT legs too: the budget is spent at the challenge, not at the failure', async () => {
    // Counting only failures let N legs opened at once each collect a
    // challenge — and a free guess — before the first of them had failed.
    const rig = makeRig()
    const pairing = rig.pairings.start({ mode: 'control', sessions: 'all' })
    const legs: PairClient[] = []
    for (let i = 0; i < 11; i += 1) legs.push(connect(rig))
    // All eleven hellos land before any leg answers its challenge.
    for (const leg of legs) {
      leg.end.send({
        kind: 'hello', v: RUNTIME_PROTOCOL_VERSION,
        client: { clientId: 'device-1', kind: 'browser' },
        auth: { mode: 'pair', pairId: pairing.pairId },
      })
    }
    await flush()
    const challenged = legs.filter(leg => leg.challenge !== undefined)
    expect(challenged).toHaveLength(10)
    // The eleventh is refused outright, indistinguishably.
    const refused = legs.find(leg => leg.challenge === undefined)!
    expect(refused.bye?.code).toBe('unauthorized')

    // Nine of the ten guess wrong and fail.
    for (const leg of challenged.slice(0, 9)) {
      await leg.auth('bad')
      expect(leg.bye?.code).toBe('unauthorized')
    }
    // The tenth — an honest leg that was challenged inside the budget — still
    // completes: its own attempt is not counted against it at `auth`.
    const honest = challenged[9]!
    await honest.auth(pairProof(pairing.secret, honest.challenge!.nonce, 'device-1'))
    expect(honest.welcome).toBeDefined()

    // A success clears the budget; a fresh leg is challenged again.
    const next = connect(rig)
    await next.hello({ auth: { mode: 'pair', pairId: pairing.pairId } })
    expect(next.challenge).toBeDefined()
  })

  it('a failed leg stays counted for a minute from its failure, not from its challenge', async () => {
    let now = 1_000_000
    const rig = makeRig({ now: () => now, challengeTimeoutMs: 120_000 })
    const pairing = rig.pairings.start({ mode: 'control', sessions: 'all' })
    // Ten legs challenged at t=0 …
    const legs: PairClient[] = []
    for (let i = 0; i < 10; i += 1) {
      const leg = connect(rig)
      await leg.hello({ auth: { mode: 'pair', pairId: pairing.pairId } })
      expect(leg.challenge).toBeDefined()
      legs.push(leg)
    }
    // … all guess wrong 50 s later.
    now += 50_000
    for (const leg of legs) await leg.auth('bad')
    // 61 s after the challenges (11 s after the failures): still limited.
    now += 11_000
    const early = connect(rig)
    await early.hello({ auth: { mode: 'pair', pairId: pairing.pairId } })
    expect(early.challenge).toBeUndefined()
    expect(early.bye?.code).toBe('unauthorized')
    // 61 s after the failures: the window has passed.
    now += 50_000
    const late = connect(rig)
    await late.hello({ auth: { mode: 'pair', pairId: pairing.pairId } })
    expect(late.challenge).toBeDefined()
  })

  it('reaps a websocket connection silent past 60 s, and a ping keeps it alive', async () => {
    let now = 1_000_000
    const rig = makeRig({ now: () => now })
    const pairing = rig.pairings.start({ mode: 'control', sessions: 'all' })
    const client = connect(rig)
    await client.hello({ auth: { mode: 'pair', pairId: pairing.pairId } })
    await client.auth(pairProof(pairing.secret, client.challenge!.nonce, 'device-1'))
    const connectionId = client.welcome!.connectionId
    expect(rig.hub.list().some(c => c.connectionId === connectionId)).toBe(true)

    // 30 s of silence: still alive (under the 60 s window).
    now += 30_000
    rig.hub.sweepNow()
    await flush()
    expect(rig.hub.list().some(c => c.connectionId === connectionId)).toBe(true)

    // A frame (the client's sys.ping) resets the clock.
    client.end.send({ kind: 'req', id: 'ping1', route: SYS_PING_ROUTE, payload: { t: now } })
    await flush()
    now += 30_000
    rig.hub.sweepNow()
    await flush()
    expect(rig.hub.list().some(c => c.connectionId === connectionId)).toBe(true)

    // 61 s with no frame: reaped (resumably — the remote may reconnect).
    now += 61_000
    rig.hub.sweepNow()
    await flush()
    expect(rig.hub.list().some(c => c.connectionId === connectionId)).toBe(false)
  })

  it('a pairing REVOKED between the challenge and the auth is not granted', async () => {
    // The window the saved-Pairing-object shortcut opened: onHello looked the
    // pairing up and stashed it; if onAuth trusts that object, a revoke landing
    // in between is invisible and the proof still buys a live connection.
    const rig = makeRig()
    const pairing = rig.pairings.start({ mode: 'control', sessions: 'all' })
    const client = connect(rig)
    await client.hello({ auth: { mode: 'pair', pairId: pairing.pairId } })
    const nonce = client.challenge!.nonce

    rig.hub.revokePairing(pairing.pairId)
    await flush()

    // The correct proof, answered after the revoke.
    await client.auth(pairProof(pairing.secret, nonce, 'device-1'))
    expect(client.welcome).toBeUndefined()
    expect(client.bye?.code).toBe('unauthorized')
    expect(rig.hub.list().some(c => c.clientId === 'device-1')).toBe(false)
  })

  it('revoking drops a challenged connection, not just the ready ones', async () => {
    const rig = makeRig()
    const pairing = rig.pairings.start({ mode: 'control', sessions: 'all' })
    const client = connect(rig)
    await client.hello({ auth: { mode: 'pair', pairId: pairing.pairId } })
    expect(client.challenge).toBeDefined()

    // Mid-handshake, so invisible to hub.list() — the revoke must reach it anyway.
    rig.hub.revokePairing(pairing.pairId)
    await flush()
    expect(client.bye?.code).toBe('unauthorized')
    expect(rig.hub.pendingConnections.size).toBe(0)
  })

  it('a pairing EXPIRING between the challenge and the auth is not granted', async () => {
    let now = 1_000_000
    const rig = makeRig({ now: () => now })
    // A 5 s pairing, and a challenge window long enough to outlive it, so the
    // expiry — not the challenge deadline — is what has to reject the auth.
    const pairing = rig.pairings.start({ mode: 'control', sessions: 'all', ttlMs: 5_000 })
    const client = connect(rig)
    await client.hello({ auth: { mode: 'pair', pairId: pairing.pairId } })
    const nonce = client.challenge!.nonce

    now += 6_000 // past expiresAt, still inside the 10 s challenge window
    await client.auth(pairProof(pairing.secret, nonce, 'device-1'))
    expect(client.welcome).toBeUndefined()
    expect(client.bye?.code).toBe('unauthorized')
  })

  it('counts only connections that reached ready in pairing.connections', async () => {
    const rig = makeRig()
    const pairing = rig.pairings.start({ mode: 'control', sessions: 'all' })

    const live = connect(rig)
    await live.hello({ auth: { mode: 'pair', pairId: pairing.pairId } })
    await live.auth(pairProof(pairing.secret, live.challenge!.nonce, 'device-1'))
    expect(live.welcome).toBeDefined()
    expect(pairing.connections).toBe(1)

    // A failed attempt never incremented, so its teardown must not decrement —
    // otherwise it cancels out the live connection and remote/state under-reports.
    const bad = connect(rig)
    await bad.hello({ auth: { mode: 'pair', pairId: pairing.pairId } })
    await bad.auth('wrong-proof')
    expect(bad.bye?.code).toBe('unauthorized')
    expect(pairing.connections).toBe(1)

    // And the real one still decrements when it goes.
    live.end.close()
    await flush()
    expect(pairing.connections).toBe(0)
  })

  it('reaps a websocket that opens and never says hello', async () => {
    let now = 1_000_000
    const rig = makeRig({ now: () => now, challengeTimeoutMs: 4_000 })
    const { client, server } = loopback('websocket')
    rig.hub.attach(server)
    const silent = new PairClient(client)
    expect(rig.hub.pendingConnections.size).toBe(1)

    // Inside the window: still parked, waiting for a hello.
    now += 3_000
    rig.hub.sweepNow()
    await flush()
    expect(rig.hub.pendingConnections.size).toBe(1)

    // Past it: a socket that cannot start the handshake is not a client.
    now += 2_000
    rig.hub.sweepNow()
    await flush()
    expect(silent.bye?.code).toBe('unauthorized')
    expect(rig.hub.pendingConnections.size).toBe(0)
  })

  it('a pairing that EXPIRES leaves its live connections up (v1: expiry gates admission, revoke evicts)', async () => {
    // Invariant 24: expiry is a ceiling on getting IN, not a session clock.
    // Only revoke reaches back into a live connection.
    let now = 1_000_000
    const rig = makeRig({ now: () => now })
    const pairing = rig.pairings.start({ mode: 'control', sessions: 'all', ttlMs: 5_000 })
    const client = connect(rig)
    await client.hello({ auth: { mode: 'pair', pairId: pairing.pairId } })
    await client.auth(pairProof(pairing.secret, client.challenge!.nonce, 'device-1'))
    const connectionId = client.welcome!.connectionId

    now += 6_000 // past expiresAt
    rig.hub.sweepNow()
    await flush()
    // Still connected — but nothing new gets in on that pairing.
    expect(rig.hub.list().some(c => c.connectionId === connectionId)).toBe(true)
    const late = connect(rig)
    await late.hello({ auth: { mode: 'pair', pairId: pairing.pairId } })
    expect(late.challenge).toBeUndefined()
    expect(late.bye?.code).toBe('unauthorized')
  })

  it('does not reap a silent message-port (the port close event owns it)', async () => {
    let now = 1_000_000
    const rig = makeRig({ now: () => now, challengeTimeoutMs: 4_000 })
    const { server } = loopback('message-port')
    rig.hub.attach(server)
    now += 60_000
    rig.hub.sweepNow()
    await flush()
    expect(rig.hub.pendingConnections.size).toBe(1)
  })

  it('a successful pair connection resumes within the retention window', async () => {
    const rig = makeRig()
    const pairing = rig.pairings.start({ mode: 'control', sessions: 'all' })
    const client = connect(rig)
    await client.hello({ auth: { mode: 'pair', pairId: pairing.pairId } })
    await client.auth(pairProof(pairing.secret, client.challenge!.nonce, 'device-1'))
    const connectionId = client.welcome!.connectionId

    // Drop the transport (not a bye): resumable.
    client.end.close()
    await flush()

    // Reconnect with a resume hello for the same connectionId + clientId.
    const client2 = connect(rig)
    await client2.hello({
      auth: { mode: 'pair', pairId: pairing.pairId },
      client: { clientId: 'device-1', kind: 'browser' },
      resume: { connectionId, topics: {} },
    })
    await client2.auth(pairProof(pairing.secret, client2.challenge!.nonce, 'device-1'))
    expect(client2.welcome).toBeDefined()
    expect(client2.welcome!.connectionId).toBe(connectionId)
    expect(client2.welcome!.resumed).toBe(true)
  })
})


/**
 * F-24: the hub's connection hooks feed the desktop's device list (`remote/state`). `userAgent` is the client's own
 * claim, carried verbatim; nothing is parsed, validated or granted from it.
 */
describe('hub connection rows for the device list', () => {
  it('records the UA a paired client sent, and the moment it became ready', async () => {
    const opened: ConnectionInfo[] = []
    const rig = makeRig({ now: () => 1_700_000_000_000, onConnectionOpened: i => opened.push(i) })
    const pairing = rig.pairings.start({ mode: 'control', sessions: 'all' })
    const client = connect(rig)
    await client.hello({
      auth: { mode: 'pair', pairId: pairing.pairId },
      client: { clientId: 'device-1', kind: 'browser', userAgent: 'Mozilla/5.0 (iPad)' },
    })
    await client.auth(pairProof(pairing.secret, client.challenge!.nonce, 'device-1'))

    expect(opened).toHaveLength(1)
    expect(rig.hub.list()[0]).toMatchObject({
      kind: 'browser',
      transport: 'websocket',
      userAgent: 'Mozilla/5.0 (iPad)',
      connectedAt: 1_700_000_000_000,
    })
  })

  it('leaves userAgent absent when the client sent none', async () => {
    const rig = makeRig()
    const pairing = rig.pairings.start({ mode: 'control', sessions: 'all' })
    const client = connect(rig)
    await client.hello({ auth: { mode: 'pair', pairId: pairing.pairId } })
    await client.auth(pairProof(pairing.secret, client.challenge!.nonce, 'device-1'))
    expect(rig.hub.list()[0]).not.toHaveProperty('userAgent')
  })

  it('does not announce a connection that never completed its handshake', async () => {
    const opened: ConnectionInfo[] = []
    const rig = makeRig({ onConnectionOpened: i => opened.push(i) })
    const pairing = rig.pairings.start({ mode: 'control', sessions: 'all' })
    const client = connect(rig)
    await client.hello({ auth: { mode: 'pair', pairId: pairing.pairId } })
    await client.auth('wrong-proof')
    expect(client.bye?.code).toBe('unauthorized')
    expect(opened).toHaveLength(0)
  })
})
