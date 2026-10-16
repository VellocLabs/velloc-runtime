/**
 * ConnectionHub — one `ClientConnection` per attached transport: handshake, granted scope, dispatch
 * with scope / session / payload checks ahead of the handler, `cancel`, hub built-ins, blobs and resume.
 * Security: trust comes from the transport, never the client. `auth.mode:'local'` is accepted only
 * on a MessagePort and grants `full`; `pair` only on a WebSocket against a live pairing, proved by
 * HMAC over a server nonce. An unsupported `hello.v` gets a `bye`.
 */
import {
  RUNTIME_PROTOCOL_VERSION,
  SYS_PING_ROUTE,
  SYS_PUT_BLOB_ROUTE,
  TOPICS_SUBSCRIBE_ROUTE,
  TOPICS_UNSUBSCRIBE_ROUTE,
  isSysPingPayload,
  isSysPutBlobPayload,
  isTopicsSubscribePayload,
  isTopicsUnsubscribePayload,
  parseRouteKey,
  routeKey,
  wireError,
  type BlobChunkHeader,
  type BlobRef,
  type ByeCode,
  type EvtFrame,
  type Frame,
  type HelloFrame,
  type ReqFrame,
  type ResFrame,
  type ResumeRequest,
  type Route,
  type Scope,
  type ScopeMode,
  type TopicId,
  type WelcomeFrame,
} from '../runtimeProtocol'
import {
  BlobSendLoop,
  type FrameTransport,
  type FrameTransportKind,
  type Unsubscribe,
} from '../runtimeTransport'
import { constantTimeEqual, pairProof } from '../runtimeProtocol/pairProof'
import type { Pairing, PairingTable } from './pairingTable'
import { BlobInbox, type BlobInboxLimits } from './BlobInbox'
import { CapabilityRegistry, scopeAllows } from './CapabilityRegistry'
import { toWireError } from './errors'
import type { TopicBroker, TopicSubscriber } from './TopicBroker'
import type { BlobOffers, ConnectionInfo, HandlerRequest, RuntimeContext } from './types'

export type ConnectionHubOptions = {
  registry: CapabilityRegistry
  broker: TopicBroker
  context: RuntimeContext
  /** What `welcome.server.runtimeVersion` reports. */
  runtimeVersion: string
  /** `welcome.bootstrap` for a fresh (non-resumed) connection. */
  bootstrap(): WelcomeFrame['bootstrap']
  /** Awaited before a capability request is handed to its handler (after the scope checks). Must not throw. */
  beforeRequest?(): Promise<void>
  /** How long a closed connection's id stays resumable. Default 5 minutes. */
  resumeRetentionMs?: number
  now?(): number
  createId?(): string
  log?(message: string): void
  /** Per-connection upload budget (`sys.putBlob`). */
  blobInboxLimits?: BlobInboxLimits
  /** A connection that completed its handshake is gone (closed, dropped or replaced). Per-connection state dies here. */
  onConnectionClosed?: (info: ConnectionInfo) => void
  /**
   * A connection completed its handshake and is now in `list()`. The mirror
   * of `onConnectionClosed`: without it the desktop's connected-device list
   * (F-24, `remote/state.connections`) would only ever learn that devices
   * LEFT — a device that joins publishes nothing, so the list would sit on
   * the snapshot taken when remote access was last configured.
   */
  onConnectionOpened?: (info: ConnectionInfo) => void
  /**
   * Every accepted `hello` (after the version + auth gates, before welcome).
   * RuntimeHub uses it to learn the build the booting page reported
   * (`hello.client.build`) so `runtime.getBuildEntry` can name the immutable
   * entry this runtime is running. First-writer-wins there.
   */
  onHelloBuild?: (hello: HelloFrame) => void
  /** Remote-access pairings; a `pair` hello over a websocket is looked up here.
   * Absent → every `pair` is `unauthorized`. */
  pairings?: PairingTable
  /** Milliseconds a challenged connection has to answer `auth` — and a websocket has to send `hello`. Default 10 s. */
  challengeTimeoutMs?: number
  /** Milliseconds a websocket connection may go without a frame before reaping. Default 60 s. */
  heartbeatTimeoutMs?: number
  /** How often the reaper sweeps. Default 20 s. Tests set it small or drive sweepNow() directly. */
  heartbeatSweepMs?: number
}

export type AttachOptions = {
  /** Panel the port belongs to, when the attach message knew it; `hello.client.panelId` wins. */
  panelId?: string
}

export type ConnectionHandle = {
  /** Set once the handshake completed. */
  info(): ConnectionInfo | null
  close(code: ByeCode): void
}

const LOCAL_SCOPE: Scope = { mode: 'full', sessions: 'all' }

/** A challenged connection has 10 s to answer `auth` (the default for `challengeTimeoutMs`). */
const CHALLENGE_TIMEOUT_MS = 10_000
/**
 * At most 10 pair handshake ATTEMPTS per pairId per minute. An
 * attempt is counted when its challenge is issued, not when it fails —
 * counting failures alone let N concurrent legs each collect a challenge
 * (and a free guess) before the first of them had failed.
 */
const PAIR_MAX_ATTEMPTS_PER_MINUTE = 10
/** How often the heartbeat reaper sweeps. */
const HEARTBEAT_SWEEP_MS = 20_000

/**
 * `hello.scopeCeiling`: a client may ask for LESS than the transport grants,
 * never more. The desktop guest connects under the `?rtScope=` mode (manager,
 * control or observe) so the scope table is exercised without a remote client.
 * The codec has already rejected an unknown mode by the
 * time this runs.
 */
function clampScope(granted: Scope, ceiling: ScopeMode | undefined): Scope {
  if (ceiling === undefined || ceiling === granted.mode) return granted
  // `scopeAllows(granted, ceiling)` is "granted ranks at or above ceiling": only then is it a clamp.
  if (!scopeAllows(granted.mode, ceiling)) return granted
  return { mode: ceiling, sessions: granted.sessions }
}

/**
 * A closed connection's resumable identity. `resume` must match on ALL of
 * `clientId`, the pairing it was granted under and the transport kind: the
 * clientId alone is published to managers on `remote/state`, so binding on
 * it only let any other paired device claim a dropped connection inside the
 * retention window. `topics` are what its replay rings were kept for, so
 * they can be released when the entry dies unclaimed.
 */
type Retained = {
  clientId: string
  pairId: string | null
  transport: FrameTransportKind
  topics: readonly TopicId[]
  expiresAt: number
}

/** A handler's offered bytes, pushed once its `res` is out. */
type BlobOffer = { id: string; bytes: Uint8Array }

function defaultCreateId(): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  return uuid ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** Per-process leg counter: how the pair rate limiter tells one challenged leg from another. */
let nextLegId = 0

export class ConnectionHub {
  private readonly connections = new Map<string, ClientConnection>()
  private readonly retained = new Map<string, Retained>()
  private readonly resumeRetentionMs: number
  readonly now: () => number
  readonly createId: () => string
  readonly log: (message: string) => void

  constructor(readonly options: ConnectionHubOptions) {
    this.resumeRetentionMs = options.resumeRetentionMs ?? 5 * 60_000
    this.now = options.now ?? (() => Date.now())
    this.createId = options.createId ?? defaultCreateId
    this.log = options.log ?? (() => {})
    this.challengeTimeoutMs = options.challengeTimeoutMs ?? CHALLENGE_TIMEOUT_MS
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 60_000
    // Heartbeat reaper: a websocket connection that has been silent
    // past heartbeatTimeoutMs is a dead remote — the client drives `sys.ping`,
    // so silence means gone. Challenged connections past their deadline are
    // reaped here too. MessagePort connections are excluded: the port's own
    // close event is their liveness signal.
    this.keepaliveTimer = setInterval(
      () => this.reapSilent(), options.heartbeatSweepMs ?? HEARTBEAT_SWEEP_MS)
    // Never keep a host process alive for the sweep (Node in tests).
    if (typeof this.keepaliveTimer === 'object' && this.keepaliveTimer && 'unref' in this.keepaliveTimer) {
      ;(this.keepaliveTimer as { unref?: () => void }).unref?.()
    }
  }

  attach(transport: FrameTransport, attachOptions: AttachOptions = {}): ConnectionHandle {
    const connection = new ClientConnection(this, transport, attachOptions)
    // Track from birth so the reaper can time out a challenge that is never answered.
    this.pendingConnections.add(connection)
    return {
      info: () => connection.info,
      close: code => connection.close(code),
    }
  }

  list(): readonly ConnectionInfo[] {
    return Array.from(this.connections.values(), connection => connection.info!).filter(Boolean)
  }

  closeAll(code: ByeCode): void {
    for (const connection of Array.from(this.connections.values())) connection.close(code)
  }

  /**
   * Close every connection — the ready ones and those still in their
   * handshake — and stop the heartbeat reaper. The hub is done after this:
   * the interval it started in the constructor is the one thing `closeAll`
   * alone leaves running.
   */
  dispose(code: ByeCode = 'shutting_down'): void {
    this.closeAll(code)
    for (const connection of Array.from(this.pendingConnections)) connection.close(code)
    clearInterval(this.keepaliveTimer)
    this.releaseRetained(Array.from(this.retained.values()))
    this.retained.clear()
  }

  // ---- called by ClientConnection --------------------------------------------

  /**
   * `true` when `hello.resume` names a connection this hub retained for the
   * same client, under the same pairing, over the same kind of transport.
   * Claiming releases the rings kept for topics the resume does not name:
   * the client is not coming back for those.
   */
  claimResume(
    resume: ResumeRequest,
    clientId: string,
    pairId: string | null,
    transport: FrameTransportKind,
  ): boolean {
    this.pruneRetained()
    const retained = this.retained.get(resume.connectionId)
    if (!retained) return false
    if (retained.clientId !== clientId || retained.pairId !== pairId || retained.transport !== transport) {
      return false
    }
    this.retained.delete(resume.connectionId)
    const wanted = new Set(Object.keys(resume.topics))
    for (const topic of retained.topics) {
      if (!wanted.has(topic)) this.options.broker.releaseRing(topic)
    }
    // A live connection with that id (the old transport not yet closed) is replaced.
    this.connections.get(resume.connectionId)?.close('replaced')
    return true
  }

  register(connection: ClientConnection): void {
    // It is `ready` now, so the pending set (which the reaper uses for
    // handshake/challenge deadlines) must let it go — from here the heartbeat
    // rule in `connections` is what governs it.
    this.pendingConnections.delete(connection)
    this.connections.set(connection.info!.connectionId, connection)
    this.options.onConnectionOpened?.(connection.info!)
  }

  /**
   * A ready connection is gone. `held` are the topics the broker just
   * dropped it from; their replay rings are kept while the connection is
   * resumable (and released with the retained entry), released now when it
   * is not — unless `keepRings`, the `replaced` case, where the successor
   * is about to re-subscribe with `since` against those very rings.
   */
  unregister(
    connection: ClientConnection,
    resumable: boolean,
    held: readonly TopicId[] = [],
    keepRings = false,
  ): void {
    const info = connection.info
    if (!info) return
    if (this.connections.get(info.connectionId) === connection) {
      this.connections.delete(info.connectionId)
    }
    if (resumable) {
      this.retained.set(info.connectionId, {
        clientId: info.clientId,
        pairId: connection.pairingId,
        transport: info.transport,
        topics: held,
        expiresAt: this.now() + this.resumeRetentionMs,
      })
    } else if (!keepRings) {
      for (const topic of held) this.options.broker.releaseRing(topic)
    }
  }

  /** Retained entries past their window die here — and take their replay rings with them. */
  private pruneRetained(): void {
    const now = this.now()
    const expired: Retained[] = []
    for (const [id, retained] of this.retained) {
      if (retained.expiresAt <= now) {
        this.retained.delete(id)
        expired.push(retained)
      }
    }
    this.releaseRetained(expired)
  }

  private releaseRetained(entries: readonly Retained[]): void {
    for (const retained of entries) {
      for (const topic of retained.topics) this.options.broker.releaseRing(topic)
    }
  }

  // ---- pair handshake support -------------------------------------------

  /** A fresh 32-byte random nonce (base64url) for a `challenge`. */
  createNonce(): string {
    const buf = new Uint8Array(32)
    globalThis.crypto.getRandomValues(buf)
    let binary = ''
    for (const b of buf) binary += String.fromCharCode(b)
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  }

  /**
   * Max pair handshake attempts per pairId per minute (hygiene; the secret is
   * 32 bytes). An attempt is a leg that was issued a challenge; a leg that
   * then fails is re-stamped at the failure, so it stays counted for a full
   * minute after its guess. `except` leaves one leg's own attempt out — the
   * check a challenged leg runs on its `auth` must not count itself, or the
   * tenth concurrent honest leg could never complete.
   */
  isPairRateLimited(pairId: string, except?: number): boolean {
    const windowStart = this.now() - 60_000
    const attempts = this.pairAttempts.get(pairId)
    if (!attempts) return false
    let count = 0
    for (const [leg, at] of attempts) {
      if (at < windowStart) attempts.delete(leg)
      else if (leg !== except) count += 1
    }
    if (attempts.size === 0) this.pairAttempts.delete(pairId)
    return count >= PAIR_MAX_ATTEMPTS_PER_MINUTE
  }

  /** A challenge went out for `leg` (or its answer failed): the attempt counts from now. */
  notePairAttempt(pairId: string, leg: number): void {
    const attempts = this.pairAttempts.get(pairId) ?? new Map<number, number>()
    attempts.set(leg, this.now())
    this.pairAttempts.set(pairId, attempts)
  }

  notePairSuccess(pairId: string): void {
    this.pairAttempts.delete(pairId)
  }

  /**
   * Revoke a pairing and drop every connection it granted — READY ones and
   * mid-handshake (`challenged`) ones alike. Dropping the challenged ones is
   * not just tidiness: without it a connection that was challenged before the
   * revoke stays parked, and the revoke would only be caught when its `auth`
   * arrives. `unauthorized` is not resumable (close()'s own rule), so a revoked
   * remote cannot resume either.
   */
  revokePairing(pairId: string): boolean {
    const revoked = this.options.pairings?.revoke(pairId) ?? false
    if (!revoked) return false
    for (const connection of Array.from(this.connections.values())) {
      if (connection.pairingId === pairId) connection.close('unauthorized')
    }
    for (const connection of Array.from(this.pendingConnections)) {
      if (connection.pairingId === pairId) connection.close('unauthorized')
    }
    return true
  }

  /** pairId → (leg id → when its attempt last counted). Ids, not connections: the table outlives them. */
  private readonly pairAttempts = new Map<string, Map<number, number>>()
  /** Milliseconds a challenged connection has to answer `auth`; also bounds a websocket that never says `hello`. */
  readonly challengeTimeoutMs: number
  private readonly heartbeatTimeoutMs: number
  private readonly keepaliveTimer: ReturnType<typeof setInterval>
  /** Test hook: run one heartbeat/challenge sweep now (the interval calls this). */
  sweepNow(): void {
    this.reapSilent()
  }

  private reapSilent(): void {
    const now = this.now()
    for (const connection of Array.from(this.connections.values())) {
      connection.reapIfSilent(now, this.heartbeatTimeoutMs)
    }
    // Also reap connections that never reached `ready` — one still in
    // `handshake` (a websocket that opened and never spoke) and one
    // `challenged` past its deadline are both invisible to `connections`.
    for (const connection of Array.from(this.pendingConnections)) {
      connection.reapIfSilent(now, this.heartbeatTimeoutMs)
    }
    // And retained identities past their window: `claimResume` pruned them
    // only when someone next tried to resume, so a runtime nobody resumed on
    // kept every dropped connection's entry (and replay rings) for good.
    this.pruneRetained()
  }

  /** Not-yet-ready connections (handshake / challenged), for the reaper. `register` drops one from here. */
  readonly pendingConnections = new Set<ClientConnection>()
}

class ClientConnection implements TopicSubscriber {
  info: ConnectionInfo | null = null
  conn!: ConnectionInfo

  /** The pairId this connection was granted under (pair handshake), else null. */
  get pairingId(): string | null {
    return this.pairing?.pairId ?? null
  }

  /**
   * The heartbeat / challenge reaper. A websocket connection silent past
   * `heartbeatTimeoutMs` is a dead remote (the client pings); a challenged one
   * past its own deadline never proved the secret; one still in `handshake`
   * past that same window never even started. MessagePort connections are
   * excluded — the port's close event is their liveness signal.
   */
  reapIfSilent(now: number, heartbeatTimeoutMs: number): void {
    if (this.state === 'closed') return
    if (this.state === 'challenged') {
      if (this.challengeDeadline !== null && now > this.challengeDeadline) {
        this.closeUnauthorized()
      }
      return
    }
    if (this.transport.kind !== 'websocket') return
    if (this.state === 'handshake') {
      // Opened and never said `hello`. There is no `lastFrameAt` to measure
      // from, so the birth stamp bounds it: a socket that cannot start the
      // handshake inside the window a challenge gets is not a client, and its
      // `ClientConnection` would otherwise sit in `pendingConnections` for the
      // life of the runtime.
      if (now - this.birthAt > this.hub.challengeTimeoutMs) this.close('unauthorized')
      return
    }
    if (this.lastFrameAt > 0 && now - this.lastFrameAt > heartbeatTimeoutMs) {
      // teardown(true): a silent remote may reconnect and resume.
      this.teardown(true)
      this.transport.close()
    }
  }
  private state: 'handshake' | 'challenged' | 'ready' | 'closed' = 'handshake'
  private readonly inflight = new Map<string, AbortController>()
  private readonly blobSends: BlobSendLoop
  private readonly inbox: BlobInbox
  private readonly unsubscribes: Unsubscribe[] = []
  /** Pair handshake state: set by onHello, consumed by onAuth. */
  private pairing: Pairing | null = null
  private pendingHello: HelloFrame | null = null
  private nonce: string | null = null
  private challengeDeadline: number | null = null
  /** Last inbound frame time; the heartbeat reaper reads it (websocket only). */
  private lastFrameAt: number = 0
  /** Attach time. Bounds a websocket that opens and never sends `hello` (there is no `lastFrameAt` yet). */
  private readonly birthAt: number
  /** This leg's key in the hub's pair-attempt table. */
  private readonly legId = ++nextLegId

  constructor(
    private readonly hub: ConnectionHub,
    private readonly transport: FrameTransport,
    private readonly attachOptions: AttachOptions,
  ) {
    this.birthAt = hub.now()
    this.blobSends = new BlobSendLoop(transport)
    this.inbox = new BlobInbox(hub.options.blobInboxLimits, hub.now, transport.limits.chunkBytes)
    this.unsubscribes.push(
      transport.onFrame(frame => this.onFrame(frame)),
      transport.onBlobChunk((header, bytes) => this.onBlobChunk(header, bytes)),
      transport.onClosed(() => this.teardown(true)),
    )
  }

  // ---- TopicSubscriber -------------------------------------------------------

  send(evt: EvtFrame): void {
    if (this.state !== 'ready') return
    this.transport.send(evt)
  }

  bufferedBytes(): number {
    return this.transport.bufferedBytes()
  }

  // ---- lifecycle -------------------------------------------------------------

  close(code: ByeCode): void {
    if (this.state === 'closed') return
    this.transport.send({ kind: 'bye', code })
    // `replaced`: the successor resumes against this connection's rings.
    this.teardown(code !== 'replaced' && code !== 'unauthorized', code === 'replaced')
    this.transport.close()
  }

  // Every pair-handshake failure closes identically — never reveal WHICH check
  // failed (unknown pairId, expired, revoked, rate-limited, bad proof).
  private closeUnauthorized(): void {
    // A challenged leg was already counted when its challenge went out; the
    // failure re-stamps it so it stays in the window a full minute from now.
    if (this.pairing) this.hub.notePairAttempt(this.pairing.pairId, this.legId)
    this.close('unauthorized')
  }

  /** The `auth` answer to a `challenge`. On success this becomes `welcome`. */
  private onAuth(frame: { kind: 'auth'; proof: string }): void {
    const challenged = this.pairing
    const hello = this.pendingHello
    const nonce = this.nonce
    if (!challenged || !hello || nonce === null) return this.closeUnauthorized()
    if (this.challengeDeadline !== null && this.hub.now() > this.challengeDeadline) {
      return this.closeUnauthorized()
    }
    // Re-look the pairing up rather than trusting the object `onHello` saved:
    // it may have been REVOKED — or have EXPIRED — in the window between the
    // challenge and this answer, and `lookup` is the one authority on both
    // (it returns null for either). Granting here off the stale object would
    // hand out a live connection on a pairing the user has just killed.
    const pairing = this.hub.options.pairings?.lookup(challenged.pairId) ?? null
    if (!pairing) return this.closeUnauthorized()
    // The budget is checked again here, this leg's own attempt left out: a
    // guess is spent at the proof, and a leg parked since before the other
    // legs spent the minute's budget gets no free one.
    if (this.hub.isPairRateLimited(pairing.pairId, this.legId)) return this.closeUnauthorized()
    const expected = pairProof(pairing.secret, nonce, hello.client.clientId)
    if (!expected || !constantTimeEqual(frame.proof, expected)) {
      return this.closeUnauthorized()
    }
    // Proof good — grant the pairing's scope (clamped by the client's ceiling)
    // and complete the handshake exactly as a local hello would. `resume` is
    // honoured from the saved hello.
    this.hub.notePairSuccess(pairing.pairId)
    const resume = hello.resume
    const resumed =
      resume !== undefined &&
      this.hub.claimResume(resume, hello.client.clientId, pairing.pairId, this.transport.kind)
    const connectionId = resumed ? resume.connectionId : this.hub.createId()
    const panelId = hello.client.panelId ?? this.attachOptions.panelId
    this.conn = {
      connectionId,
      clientId: hello.client.clientId,
      kind: hello.client.kind,
      scope: clampScope(pairing.scope, hello.scopeCeiling),
      transport: this.transport.kind,
      ...(panelId !== undefined ? { panelId } : {}),
      // A remote page states its browser; this machine's own shell sends
      // none, so the field is simply absent for it (F-24 device list).
      ...(hello.client.userAgent !== undefined
        ? { userAgent: hello.client.userAgent }
        : {}),
      connectedAt: this.hub.now(),
    }
    this.info = this.conn
    this.state = 'ready'
    pairing.connections += 1
    pairing.lastSeenAt = this.hub.now()
    this.hub.register(this)

    const welcome: WelcomeFrame = {
      kind: 'welcome',
      v: RUNTIME_PROTOCOL_VERSION,
      connectionId,
      resumed,
      scope: this.conn.scope,
      server: {
        runtimeVersion: this.hub.options.runtimeVersion,
        capabilities: this.hub.options.registry.advertise(this.conn.scope),
      },
      ...(resumed ? {} : { bootstrap: this.hub.options.bootstrap() }),
    }
    this.transport.send(welcome)

    if (resumed && resume) this.resubscribe(resume)
  }

  /** The topics a resumed hello asks to continue, each from its `since`. */
  private resubscribe(resume: ResumeRequest): void {
    for (const [topic, since] of Object.entries(resume.topics)) {
      if (this.hub.options.broker.authorize(topic, this.conn) !== 'ok') continue
      this.hub.options.broker.subscribe(this, topic, since).catch(error => {
        this.hub.log(`[runtimeHub] resume snapshot for '${topic}' failed: ${String(error)}`)
      })
    }
  }

  /** `keepRings`: leave the replay rings of the topics this connection held for a successor (`replaced`). */
  private teardown(resumable: boolean, keepRings = false): void {
    if (this.state === 'closed') return
    const wasReady = this.state === 'ready'
    this.state = 'closed'
    // Only a connection that reached `ready` ever incremented the counter
    // (onAuth, after the proof). Decrementing for a failed handshake would let
    // a bad-proof attempt cancel out a live connection's count, and
    // `remote/state` would under-report who is connected.
    if (wasReady && this.pairing) this.pairing.connections = Math.max(0, this.pairing.connections - 1)
    this.hub.pendingConnections.delete(this)
    for (const unsubscribe of this.unsubscribes) unsubscribe()
    for (const controller of this.inflight.values()) controller.abort()
    this.inflight.clear()
    const gone = wireError('cancelled', 'connection closed')
    this.blobSends.clear(gone)
    this.inbox.clear(gone)
    if (wasReady && this.info) {
      this.hub.options.onConnectionClosed?.(this.info)
      const held = this.hub.options.broker.removeConnection(this.info.connectionId)
      this.hub.unregister(this, resumable, held, keepRings)
    }
  }

  // ---- inbound ---------------------------------------------------------------

  private onFrame(frame: Frame): void {
    if (this.state === 'closed') return
    this.lastFrameAt = this.hub.now()
    if (this.state === 'handshake') {
      if (frame.kind === 'hello') {
        this.onHello(frame)
      } else {
        this.close('unauthorized')
      }
      return
    }
    if (this.state === 'challenged') {
      // Only the `auth` answer is valid here; anything else fails closed and
      // indistinguishably (failure is a closed `bye.code` set).
      if (frame.kind === 'auth') {
        this.onAuth(frame)
      } else {
        this.closeUnauthorized()
      }
      return
    }
    switch (frame.kind) {
      case 'req':
        void this.onReq(frame)
        return
      case 'cancel':
        this.onCancel(frame.id)
        return
      case 'ack':
        this.blobSends.onAck(frame)
        return
      case 'bye':
        // The client said goodbye on purpose: nothing to resume.
        this.teardown(false)
        this.transport.close()
        return
      default:
        // `res` answers a server-initiated request (none in this phase);
        // handshake frames after the handshake are noise.
        this.hub.log(`[runtimeHub] ignoring ${frame.kind} frame on a ready connection`)
    }
  }

  private onHello(hello: HelloFrame): void {
    if (hello.v < RUNTIME_PROTOCOL_VERSION) return this.close('protocol_too_old')
    if (hello.v > RUNTIME_PROTOCOL_VERSION) return this.close('protocol_too_new')

    if (hello.auth.mode === 'pair') {
      // `pair` is the remote handshake: only over a WebSocket, only with a live
      // pairing. Issue a nonce challenge; the client proves the secret in `auth`.
      if (this.transport.kind !== 'websocket') return this.closeUnauthorized()
      const pairing = this.hub.options.pairings?.lookup(hello.auth.pairId) ?? null
      if (!pairing) return this.closeUnauthorized()
      if (this.hub.isPairRateLimited(hello.auth.pairId)) return this.closeUnauthorized()
      // Counted as the challenge goes out, so N legs opened at once share the
      // minute's budget instead of each collecting a challenge of its own.
      this.hub.notePairAttempt(pairing.pairId, this.legId)
      this.pairing = pairing
      this.pendingHello = hello
      this.nonce = this.hub.createNonce()
      this.state = 'challenged'
      this.challengeDeadline = this.hub.now() + this.hub.challengeTimeoutMs
      this.transport.send({ kind: 'challenge', nonce: this.nonce })
      return
    }

    // `local` is the desktop's own handshake and is accepted only on a port.
    if (hello.auth.mode !== 'local' || this.transport.kind !== 'message-port') {
      // `local` off a port is a lie.
      return this.close('unauthorized')
    }

    // The runtime's identity is the build that STARTED it. A SharedWorker has
    // no document to read its own nexus-build-time meta, so the booting page
    // reports it via hello.client.build. The hub records it first-writer-wins
    // (a later window may run a newer page against an older worker).
    this.hub.options.onHelloBuild?.(hello)

    const resume = hello.resume
    const resumed =
      resume !== undefined &&
      this.hub.claimResume(resume, hello.client.clientId, null, this.transport.kind)
    const connectionId = resumed ? resume.connectionId : this.hub.createId()
    const panelId = hello.client.panelId ?? this.attachOptions.panelId
    this.conn = {
      connectionId,
      clientId: hello.client.clientId,
      kind: hello.client.kind,
      scope: clampScope(LOCAL_SCOPE, hello.scopeCeiling),
      transport: this.transport.kind,
      ...(panelId !== undefined ? { panelId } : {}),
      // A remote page states its browser; this machine's own shell sends
      // none, so the field is simply absent for it (F-24 device list).
      ...(hello.client.userAgent !== undefined
        ? { userAgent: hello.client.userAgent }
        : {}),
      connectedAt: this.hub.now(),
    }
    this.info = this.conn
    this.state = 'ready'
    this.hub.register(this)

    const welcome: WelcomeFrame = {
      kind: 'welcome',
      v: RUNTIME_PROTOCOL_VERSION,
      connectionId,
      resumed,
      scope: this.conn.scope,
      server: {
        runtimeVersion: this.hub.options.runtimeVersion,
        capabilities: this.hub.options.registry.advertise(this.conn.scope),
      },
      ...(resumed ? {} : { bootstrap: this.hub.options.bootstrap() }),
    }
    this.transport.send(welcome)

    if (resumed && resume) this.resubscribe(resume)
  }

  private async onReq(req: ReqFrame): Promise<void> {
    if (this.inflight.has(req.id)) {
      this.respond({ kind: 'res', id: req.id, ok: false, error: wireError('conflict', `request id '${req.id}' is already in flight`) })
      return
    }
    const controller = new AbortController()
    this.inflight.set(req.id, controller)
    const offered: BlobOffer[] = []
    try {
      const result = await this.dispatch(req, controller.signal, offered)
      if (!this.settle(req.id)) return
      this.respond({ kind: 'res', id: req.id, ok: true, result })
      for (const blob of offered) {
        // Nobody awaits a push: a connection that dies mid-send simply drops it.
        this.blobSends.send(blob.id, blob.bytes).catch(() => {})
      }
    } catch (error) {
      if (!this.settle(req.id)) return
      this.respond({ kind: 'res', id: req.id, ok: false, error: toWireError(error) })
    }
  }

  /** Remove the id from the inflight table; `false` if a cancel already answered it. */
  private settle(id: string): boolean {
    if (this.state === 'closed') return false
    return this.inflight.delete(id)
  }

  private async dispatch(
    req: ReqFrame,
    signal: AbortSignal,
    offered: BlobOffer[],
  ): Promise<unknown> {
    const route = parseRouteKey(req.route)
    if (!route) throw wireError('unknown_route', `malformed route '${req.route}'`)
    const key = routeKey(route)

    if (key === TOPICS_SUBSCRIBE_ROUTE) return this.subscribeTopics(req.payload)
    if (key === TOPICS_UNSUBSCRIBE_ROUTE) return this.unsubscribeTopics(req.payload)
    if (key === SYS_PING_ROUTE) {
      if (!isSysPingPayload(req.payload)) throw wireError('bad_payload', 'sys.ping wants { t: number }')
      return { t: req.payload.t }
    }
    if (key === SYS_PUT_BLOB_ROUTE) return this.putBlob(req.payload)

    const entry = this.hub.options.registry.resolve(route.cap, route.act)
    if (!entry) throw wireError('unknown_route', `no capability serves '${key}'`)
    if (!scopeAllows(this.conn.scope.mode, entry.spec.scope)) {
      throw wireError('forbidden_scope', `'${key}' needs scope '${entry.spec.scope}'`)
    }
    if (entry.spec.sessionOf && this.conn.scope.sessions !== 'all') {
      const sessionId = entry.spec.sessionOf(req.payload)
      if (sessionId === undefined || !this.conn.scope.sessions.includes(sessionId)) {
        throw wireError('forbidden_scope', `'${key}' is outside this connection's sessions`)
      }
    }
    await this.hub.options.beforeRequest?.()
    if (entry.spec.guard && !(await entry.spec.guard(req.payload, this.conn, this.hub.options.context))) {
      throw wireError('bad_payload', `'${key}' rejected the payload`)
    }

    const request: HandlerRequest = {
      id: req.id,
      route,
      payload: req.payload,
      conn: this.conn,
      signal,
      blobs: this.blobOffers(offered),
    }
    return entry.handle(request, this.hub.options.context)
  }

  /** `sys.putBlob`: reserve an inbound blob; the client pushes its chunks under the returned id. */
  private putBlob(payload: unknown): BlobRef {
    if (!scopeAllows(this.conn.scope.mode, 'control')) {
      throw wireError('forbidden_scope', `'${SYS_PUT_BLOB_ROUTE}' needs scope 'control'`)
    }
    if (!isSysPutBlobPayload(payload)) {
      throw wireError('bad_payload', 'sys.putBlob wants { bytes: number, mime?: string }')
    }
    const id = this.hub.createId()
    this.inbox.expect(id, payload.bytes)
    return { $blob: id, bytes: payload.bytes, ...(payload.mime ? { mime: payload.mime } : {}) }
  }

  private async subscribeTopics(payload: unknown): Promise<undefined> {
    if (!isTopicsSubscribePayload(payload)) {
      throw wireError('bad_payload', 'topics.subscribe wants { topics: [{ topic, since? }] }')
    }
    const broker = this.hub.options.broker
    for (const { topic } of payload.topics) {
      const verdict = broker.authorize(topic, this.conn)
      if (verdict === 'not_found') throw wireError('not_found', `no provider serves topic '${topic}'`, { topic })
      if (verdict === 'forbidden') throw wireError('forbidden_scope', `topic '${topic}' is outside this connection's scope`, { topic })
    }
    // The `res` confirms; data follows as `evt`. Snapshots are produced after
    // the confirmation is on its way — the client treats the two as a stream.
    for (const { topic, since } of payload.topics) {
      void broker.subscribe(this, topic, since).catch(error => {
        this.hub.log(`[runtimeHub] snapshot for '${topic}' failed: ${String(error)}`)
      })
    }
    return undefined
  }

  private async unsubscribeTopics(payload: unknown): Promise<undefined> {
    if (!isTopicsUnsubscribePayload(payload)) {
      throw wireError('bad_payload', 'topics.unsubscribe wants { topics: [topic] }')
    }
    for (const topic of payload.topics) {
      this.hub.options.broker.unsubscribe(this.conn.connectionId, topic)
    }
    return undefined
  }

  private onCancel(id: string): void {
    const controller = this.inflight.get(id)
    if (!controller) return
    this.inflight.delete(id)
    controller.abort()
    this.respond({ kind: 'res', id, ok: false, error: wireError('cancelled', 'request cancelled') })
  }

  private respond(res: ResFrame): void {
    if (this.state !== 'ready') return
    this.transport.send(res)
  }

  // ---- blobs -----------------------------------------------------------------

  private blobOffers(offered: BlobOffer[]): BlobOffers {
    return {
      offer: (bytes, meta): BlobRef => {
        const id = this.hub.createId()
        offered.push({ id, bytes })
        return { $blob: id, bytes: bytes.byteLength, ...(meta?.mime ? { mime: meta.mime } : {}) }
      },
      receive: (ref, signal) => this.inbox.receive(ref.$blob, signal),
    }
  }

  private onBlobChunk(header: BlobChunkHeader, bytes: Uint8Array): void {
    if (this.state !== 'ready') return
    if (!this.inbox.accept(header, bytes)) {
      this.hub.log(`[runtimeHub] dropping a chunk for unannounced blob '${header.id}'`)
      return
    }
    this.transport.send({ kind: 'ack', id: header.id, upTo: header.index })
  }
}

export type { Route, TopicId }
