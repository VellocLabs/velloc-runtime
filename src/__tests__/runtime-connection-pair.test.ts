/**
 * (F-24): the client (RuntimeConnection) side
 * of the pair handshake and the websocket heartbeat. Driven against a real
 * ConnectionHub over a loopback transport, with the heartbeat timings shrunk
 * via the injectable option. The pairing secret must NEVER appear in a
 * serialized hello (asserted as a string on the wire form).
 */
import { describe, expect, it, vi } from 'vitest'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import {
  RUNTIME_PROTOCOL_VERSION,
  SYS_PING_ROUTE,
  encodeFrame,
  type Frame,
  type HelloFrame,
} from '../browser/runtimeProtocol'
import {
  ListenerSet,
  type FrameTransport,
} from '../browser/runtimeTransport'
import {
  CapabilityRegistry,
  ConnectionHub,
  TopicBroker,
  type RuntimeContext,
} from '../browser/runtimeHub'
import { createPairingTable } from '../browser/runtimeHub/pairingTable'
import { connectRuntime, type RuntimeConnection } from '../browser/runtimeClient'

const flush = async (rounds = 6) => {
  for (let i = 0; i < rounds; i += 1) await new Promise<void>(r => setTimeout(r, 0))
}

type End = FrameTransport & {
  sent: Frame[]
  sentRaw: string[]
  peer: End | null
  frames: ListenerSet<[Frame]>
  isClosed: boolean
}

function loopback(): { client: End; server: End } {
  function makeEnd(): End {
    const end = {
      kind: 'websocket' as const,
      limits: { chunkBytes: 1024, windowChunks: 8 },
      sent: [] as Frame[],
      sentRaw: [] as string[],
      peer: null as End | null,
      frames: new ListenerSet<[Frame]>(),
      isClosed: false,
      bufferedBytes: () => 0,
      send(frame: Frame) {
        if (end.isClosed) return
        end.sent.push(frame)
        end.sentRaw.push(encodeFrame(frame))
        const p = end.peer
        queueMicrotask(() => p?.frames.emit(frame))
      },
      sendBlobChunk() {},
      onFrame: (l: (f: Frame) => void) => end.frames.add(l),
      onBlobChunk: () => () => {},
      onClosed: () => () => {},
      close() {
        end.isClosed = true
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

function makeServer(): { hub: ConnectionHub; pairings: ReturnType<typeof createPairingTable> } {
  const registry = new CapabilityRegistry()
  const broker = new TopicBroker()
  const context: RuntimeContext = {
    fs: {} as RuntimeFs, host: null, homeDir: '/h',
    publish: (id, payload, opts) => broker.publish(id, payload, opts),
    connections: () => hub.list(),
    webUiBridge: { homeDir: '/h', fs: {} as RuntimeFs, broadcastEvent: vi.fn(), directBridge: null },
  }
  const pairings = createPairingTable()
  const hub = new ConnectionHub({
    registry, broker, context, runtimeVersion: 'rc-pair', bootstrap: () => undefined, pairings,
  })
  return { hub, pairings }
}

describe('RuntimeConnection pair handshake (WP-3)', () => {
  it('completes hello → challenge → auth → welcome, and the secret never hits the wire', async () => {
    const server = makeServer()
    const pairing = server.pairings.start({ mode: 'control', sessions: 'all' })
    const { client, server: serverEnd } = loopback()
    server.hub.attach(serverEnd)

    const connection = await connectRuntime({
      transport: client,
      client: { clientId: 'device-9', kind: 'browser' },
      auth: { mode: 'pair', pairId: pairing.pairId },
      pairSecret: pairing.secret,
    })
    expect(connection.state.status).toBe('ready')
    expect(connection.welcome?.scope).toEqual({ mode: 'control', sessions: 'all' })

    // The hello carried the pairId but NOT the secret — asserted on the raw
    // serialized frame, so a field rename cannot smuggle it through.
    const hello = client.sent.find((f): f is HelloFrame => f.kind === 'hello')!
    expect(hello.auth).toEqual({ mode: 'pair', pairId: pairing.pairId })
    const raw = client.sentRaw.join('\n')
    expect(raw).not.toContain(pairing.secret)
    // And the auth frame carries a proof, not the secret.
    const auth = client.sent.find(f => f.kind === 'auth')
    expect(auth).toBeDefined()
    connection.close()
  })

  it('rejects when the pairing is unknown (hub answers bye unauthorized)', async () => {
    const server = makeServer()
    const { client, server: serverEnd } = loopback()
    server.hub.attach(serverEnd)
    const promise = connectRuntime({
      transport: client,
      client: { clientId: 'device-9', kind: 'browser' },
      auth: { mode: 'pair', pairId: 'no-such' },
      pairSecret: 'whatever',
    })
    await expect(promise).rejects.toMatchObject({ code: 'unauthorized' })
  })

  it('a websocket connection pings and stays open while the hub answers', async () => {
    const server = makeServer()
    const pairing = server.pairings.start({ mode: 'control', sessions: 'all' })
    const { client, server: serverEnd } = loopback()
    server.hub.attach(serverEnd)
    const connection = await connectRuntime({
      transport: client,
      client: { clientId: 'device-9', kind: 'browser' },
      auth: { mode: 'pair', pairId: pairing.pairId },
      pairSecret: pairing.secret,
      heartbeat: { intervalMs: 20, timeoutMs: 1000 },
    })
    expect(connection.state.status).toBe('ready')
    // Several ping intervals pass; the hub answers sys.ping, so the connection
    // must NOT close. Wait and assert it is still ready.
    await flush(20)
    const pings = client.sent.filter(f =>
      f.kind === 'req' && (f as { route?: string }).route === SYS_PING_ROUTE)
    expect(pings.length).toBeGreaterThan(0)
    expect(connection.state.status).toBe('ready')
    connection.close()
  })

  it('closes after two consecutive ping timeouts on a dead wire', async () => {
    // A server that NEVER answers sys.ping: attach the transport but drop the
    // connection's requests by closing the hub side immediately after welcome.
    const server = makeServer()
    const pairing = server.pairings.start({ mode: 'control', sessions: 'all' })
    const { client, server: serverEnd } = loopback()
    server.hub.attach(serverEnd)
    const connection = await connectRuntime({
      transport: client,
      client: { clientId: 'device-9', kind: 'browser' },
      auth: { mode: 'pair', pairId: pairing.pairId },
      pairSecret: pairing.secret,
      heartbeat: { intervalMs: 10, timeoutMs: 5 },
    })
    expect(connection.state.status).toBe('ready')
    // Kill the wire: the server end stops responding (isClosed) so pings time out.
    serverEnd.close()
    // Two missed pings (10ms interval, 5ms timeout) should close the connection.
    await vi.waitFor(() => {
      expect(connection.state.status).toBe('closed')
    }, { timeout: 2000 })
    expect((connection.state as { code?: string }).code).toBe('transport')
  })
})
