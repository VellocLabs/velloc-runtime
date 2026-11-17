/**
 * Test rig for the UI ⇄ Runtime protocol server: an in-memory `FrameTransport`
 * pair, a small protocol client, and a `ConnectionHub` wired to a fresh
 * registry, broker and context.
 */
import { vi } from 'vitest'
import type { RuntimeFs } from '../../utils/fs/runtimeFs'
import type { BlobChunkHeader, EvtFrame, Frame, HelloFrame, ResFrame } from '../../browser/runtimeProtocol'
import { RUNTIME_PROTOCOL_VERSION } from '../../browser/runtimeProtocol'
import {
  ListenerSet,
  type FrameTransport,
  type FrameTransportKind,
  type FrameTransportLimits,
} from '../../browser/runtimeTransport'
import { pairProof } from '../../browser/runtimeProtocol/pairProof'
import type { Pairing, PairingTable } from '../../browser/runtimeHub/pairingTable'
import { CapabilityRegistry, ConnectionHub, TopicBroker, type RuntimeContext } from '../../browser/runtimeHub'
import type { WebUiBridgeContext } from '../../browser/worker/webUiBridge'

// ---- loopback transport pair ---------------------------------------------------

export type LoopbackOptions = {
  kind?: FrameTransportKind
  limits?: FrameTransportLimits
}

export type LoopbackEnd = FrameTransport & {
  /** Everything this end has sent, in order. */
  sent: Array<Frame | { chunk: BlobChunkHeader; bytes: Uint8Array }>
  /** What `bufferedBytes()` reports — the test's knob for lagging. */
  buffered: number
  isClosed: boolean
}

/** Two symmetric ends; delivery is a microtask later, like a port. */
export function loopback(options: LoopbackOptions = {}): { client: LoopbackEnd; server: LoopbackEnd } {
  const kind = options.kind ?? 'message-port'
  const limits = options.limits ?? { chunkBytes: 4, windowChunks: Number.POSITIVE_INFINITY }
  function makeEnd(): LoopbackEnd & {
    peer: LoopbackEnd | null
    frames: ListenerSet<[Frame]>
    chunks: ListenerSet<[BlobChunkHeader, Uint8Array]>
    closed: ListenerSet<[string, boolean]>
    isClosed: boolean
  } {
    const end = {
      kind,
      limits,
      sent: [] as LoopbackEnd['sent'],
      buffered: 0,
      peer: null as LoopbackEnd | null,
      frames: new ListenerSet<[Frame]>(),
      chunks: new ListenerSet<[BlobChunkHeader, Uint8Array]>(),
      closed: new ListenerSet<[string, boolean]>(),
      isClosed: false,
      bufferedBytes: () => end.buffered,
      send(frame: Frame) {
        if (end.isClosed) return
        end.sent.push(frame)
        const peer = end.peer as unknown as ReturnType<typeof makeEnd> | null
        queueMicrotask(() => peer?.frames.emit(frame))
      },
      sendBlobChunk(chunk: BlobChunkHeader, bytes: Uint8Array) {
        if (end.isClosed) return
        end.sent.push({ chunk, bytes: bytes.slice() })
        const peer = end.peer as unknown as ReturnType<typeof makeEnd> | null
        queueMicrotask(() => peer?.chunks.emit(chunk, bytes.slice()))
      },
      onFrame: (l: (f: Frame) => void) => end.frames.add(l),
      onBlobChunk: (l: (h: BlobChunkHeader, b: Uint8Array) => void) => end.chunks.add(l),
      onClosed: (l: (reason: string, retryable: boolean) => void) => end.closed.add(l),
      close() {
        if (end.isClosed) return
        end.isClosed = true
        end.closed.emit('closed', false)
        const peer = end.peer as unknown as ReturnType<typeof makeEnd> | null
        if (peer && !peer.isClosed) {
          peer.isClosed = true
          queueMicrotask(() => peer.closed.emit('port-closed', false))
        }
      },
    }
    return end
  }
  const client = makeEnd()
  const server = makeEnd()
  client.peer = server
  server.peer = client
  return { client, server }
}

// ---- a tiny protocol client for the tests ---------------------------------------

export class TestClient {
  private nextId = 1
  private readonly pending = new Map<string, (res: ResFrame) => void>()
  readonly events: EvtFrame[] = []
  readonly frames: Frame[] = []
  readonly chunks: Array<{ header: BlobChunkHeader; bytes: Uint8Array }> = []

  constructor(readonly transport: FrameTransport) {
    transport.onFrame(frame => {
      this.frames.push(frame)
      if (frame.kind === 'res') this.pending.get(frame.id)?.(frame)
      if (frame.kind === 'evt') this.events.push(frame)
    })
    transport.onBlobChunk((header, bytes) => this.chunks.push({ header, bytes }))
  }

  async hello(overrides: Partial<HelloFrame> = {}): Promise<Frame> {
    const done = this.nextFrame(f => f.kind === 'welcome' || f.kind === 'bye')
    this.transport.send({
      kind: 'hello',
      v: RUNTIME_PROTOCOL_VERSION,
      client: { clientId: 'client-A', kind: 'desktop-shell' },
      auth: { mode: 'local' },
      ...overrides,
    })
    return done
  }

  /** The `pair` handshake (websocket): hello → challenge → auth, answered with the correct proof. */
  async pairHello(pairing: Pairing, overrides: Partial<HelloFrame> = {}): Promise<Frame> {
    const challenged = this.nextFrame(f => f.kind === 'challenge' || f.kind === 'bye')
    const client = { clientId: 'client-A', kind: 'browser' as const, ...overrides.client }
    this.transport.send({
      kind: 'hello',
      v: RUNTIME_PROTOCOL_VERSION,
      client,
      auth: { mode: 'pair', pairId: pairing.pairId },
      ...overrides,
    })
    const challenge = await challenged
    if (challenge.kind !== 'challenge') return challenge
    const done = this.nextFrame(f => f.kind === 'welcome' || f.kind === 'bye')
    this.transport.send({ kind: 'auth', proof: pairProof(pairing.secret, challenge.nonce, client.clientId) })
    return done
  }

  request(route: string, payload?: unknown, id = `r${this.nextId++}`): Promise<ResFrame> & { id: string } {
    const promise = new Promise<ResFrame>(resolve => this.pending.set(id, resolve))
    this.transport.send({ kind: 'req', id, route: route as never, payload })
    return Object.assign(promise, { id })
  }

  nextFrame(match: (f: Frame) => boolean): Promise<Frame> {
    return new Promise(resolve => {
      const unsubscribe = this.transport.onFrame(frame => {
        if (match(frame)) {
          unsubscribe()
          resolve(frame)
        }
      })
    })
  }

  /** Wait until `count` events for `topicId` have arrived. */
  async eventsFor(topicId: string, count: number): Promise<EvtFrame[]> {
    for (let i = 0; i < 50; i += 1) {
      const got = this.events.filter(e => e.topic === topicId)
      if (got.length >= count) return got
      await flush()
    }
    throw new Error(`only ${this.events.filter(e => e.topic === topicId).length} events for ${topicId}`)
  }
}

export async function flush(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await new Promise<void>(resolve => setTimeout(resolve, 0))
}

// ---- rig -------------------------------------------------------------------------

export function makeContext(overrides: Partial<RuntimeContext> = {}): RuntimeContext {
  const webUiBridge: WebUiBridgeContext = {
    homeDir: '/home/t',
    fs: {} as RuntimeFs,
    broadcastEvent: vi.fn(),
    directBridge: null,
  }
  return {
    fs: {} as RuntimeFs,
    host: null,
    homeDir: '/home/t',
    publish: () => 0,
    connections: () => [],
    webUiBridge,
    ...overrides,
  }
}

export function makeRig(options: {
  loopback?: LoopbackOptions
  broker?: TopicBroker
  registry?: CapabilityRegistry
  context?: RuntimeContext
  now?: () => number
  resumeRetentionMs?: number
  pairings?: PairingTable
  beforeRequest?: () => Promise<void>
} = {}) {
  const registry = options.registry ?? new CapabilityRegistry()
  const broker = options.broker ?? new TopicBroker()
  const context = options.context ?? makeContext()
  context.publish = (id, payload, opts) => broker.publish(id, payload, opts)
  let nextId = 1
  const hub = new ConnectionHub({
    registry,
    broker,
    context,
    runtimeVersion: 'test-1',
    bootstrap: () => ({ homeDir: context.homeDir, platform: 'test', pathSep: '/' }),
    createId: () => `id-${nextId++}`,
    now: options.now,
    resumeRetentionMs: options.resumeRetentionMs,
    ...(options.pairings ? { pairings: options.pairings } : {}),
    ...(options.beforeRequest ? { beforeRequest: options.beforeRequest } : {}),
  })
  context.connections = () => hub.list()
  const ends = loopback(options.loopback)
  const handle = hub.attach(ends.server)
  const client = new TestClient(ends.client)
  return { hub, registry, broker, context, ends, handle, client }
}
