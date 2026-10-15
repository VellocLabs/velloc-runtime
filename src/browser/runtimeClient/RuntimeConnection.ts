/**
 * Contract: the client side of the UI ⇄ Runtime protocol (P-3), one per
 * `FrameTransport`. Handshake, pending requests (timeouts, `cancel` on abort),
 * topic subscriptions (first listener subscribes, last unsubscribes; a `seq` gap
 * re-subscribes with `since`, or the broker answers with a `resync` snapshot),
 * blob assembly (`ack` per chunk) and `putBlob` uploads. No `serve()`.
 * Reconnect is the connection's job, not the transport's: on a retryable close
 * it calls `reconnect.createTransport` and resumes with `hello.resume`, keeping
 * the same object, subscriptions and `watchLinkState`. Without `reconnect` (a
 * MessagePort) it dies with its port.
 */
import {
  RUNTIME_PROTOCOL_VERSION,
  SYS_PUT_BLOB_ROUTE,
  TOPICS_SUBSCRIBE_ROUTE,
  TOPICS_UNSUBSCRIBE_ROUTE,
  routeKey,
  wireError,
  type BlobChunkHeader,
  type BlobRef,
  type ByeCode,
  type ClientDescriptor,
  type EvtForm,
  type EvtFrame,
  type Frame,
  type HelloAuth,
  type ResFrame,
  type Route,
  type RouteKey,
  type ScopeMode,
  type TopicId,
  type WelcomeFrame,
  type WireError,
} from '../runtimeProtocol'
import {
  SYS_PING_ROUTE,
} from '../runtimeProtocol'
import { pairProof } from '../runtimeProtocol/pairProof'
import { BlobSendLoop, type FrameTransport, type Unsubscribe } from '../runtimeTransport'

export type ConnectionState =
  | { status: 'connecting' }
  | { status: 'ready'; welcome: WelcomeFrame }
  /**
   * The wire went away on a connection that had been `ready`, and a retry is
   * scheduled. Subscriptions are held; requests reject immediately (retryable)
   * rather than queueing, because a request made now would carry no guarantee
   * about which side of the gap it lands on. `lastWelcome` is the grant this
   * connection HAD — what the UI keeps rendering while the wire is down.
   */
  | {
      status: 'reconnecting'
      attempt: number
      lastWelcome: WelcomeFrame
      /**
       * The transport close reason that opened this gap (`ws-4001` when the
       * desktop panel is shut), absent when it was not a transport close. The
       * banner reads it to name WHICH of the two reconnecting states this
       * is; the retry cadence is decided separately, below.
       */
      reason?: string
      /**
       * When the next attempt dials (epoch ms) — what the remote's offline
       * overlay counts down to. At or before `Date.now()` an attempt is due or
       * already on the wire.
       */
      nextAttemptAt: number
    }
  | {
      status: 'closed'
      code: ByeCode | 'transport'
      /**
       * For a `transport` close that came from the wire: the transport's own
       * reason (`ws-4003` = the listener was disabled, the one FINAL close
       * code). Without it every dead wire looks alike and the connect screen
       * can only say "failed".
       */
      reason?: string
    }

export type TopicEvent<T = unknown> = {
  topic: TopicId
  seq: number
  type?: string
  form: EvtForm
  more?: true
  /**
   * Set on a `snapshot` (every page of it) that arrives on a subscription
   * which has ALREADY delivered events: the broker only re-snapshots a topic
   * it is holding to recover a gap (a lagging subscriber, a `since` the replay
   * ring no longer covers, a resume the runtime refused), so the listener
   * missed deltas. A topic whose snapshot is `null` has to refetch its state
   * by request. Never set on the first snapshot of a subscription.
   */
  resync?: true
  payload: T
}

export type RequestOptions = { timeoutMs?: number; signal?: AbortSignal }

/** What `request()` rejects with when the runtime answered `ok:false` (or the wire failed). */
export class RuntimeRequestError extends Error {
  readonly code: WireError['code']
  readonly retryable: boolean
  readonly data: unknown

  constructor(readonly wire: WireError, route: string) {
    super(`${route}: ${wire.code} — ${wire.message}`)
    this.name = 'RuntimeRequestError'
    this.code = wire.code
    this.retryable = wire.retryable
    this.data = wire.data
  }
}

export function isRuntimeRequestError(error: unknown): error is RuntimeRequestError {
  return error instanceof RuntimeRequestError
}

export interface RuntimeConnection {
  readonly state: ConnectionState
  readonly welcome: WelcomeFrame | null
  watchLinkState(listener: (state: ConnectionState) => void): Unsubscribe
  request<R = unknown>(route: Route | RouteKey, payload?: unknown, opts?: RequestOptions): Promise<R>
  /** Subscribing holds the topic: the first listener subscribes on the wire, the last unsubscribes. */
  subscribe<T = unknown>(topic: TopicId, listener: (event: TopicEvent<T>) => void): Unsubscribe
  /**
   * Waits `timeoutMs` (default `requestTimeoutMs`; `0` = no deadline) for the
   * bytes; rejects at once, retryable, while `reconnecting`.
   */
  readBlob(ref: BlobRef, opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<Uint8Array>
  /**
   * Upload bytes: announce them (`sys.putBlob`), push the chunks, and resolve
   * with the `BlobRef` once they are all on the wire — ready to name in a
   * request (`fsx.commitUpload`). Needs `control` scope.
   */
  putBlob(bytes: Uint8Array, meta?: { mime?: string }, opts?: { signal?: AbortSignal }): Promise<BlobRef>
  can(cap: string, act?: string): boolean
  /**
   * While `reconnecting`: dial now, cutting a backoff wait short. With a dial
   * already on the wire it is a no-op for `STALE_DIAL_MS`, then abandons it as
   * hung and dials afresh. Restarts the backoff (published as attempt 0).
   * A no-op in every other state.
   */
  reconnectNow(): void
  close(): void
}

export type ConnectRuntimeOptions = {
  transport: FrameTransport
  client: ClientDescriptor
  /** Defaults to `{ mode: 'local' }` — the only mode a MessagePort accepts. */
  auth?: HelloAuth
  /**
   * The pairing secret for `auth.mode === 'pair'` (base64url). Used ONLY
   * locally to answer the `challenge` — it is never sent on the wire. Ignored
   * for other modes.
   */
  pairSecret?: string
  /** Ask for less than the auth mode grants (`hello.scopeCeiling`); the hub clamps down, never up. */
  scopeCeiling?: ScopeMode
  /**
   * Websocket heartbeat timings (`sys.ping` every `intervalMs`, two `timeoutMs`
   * misses = dead). Tests shrink these. Ignored off a websocket.
   */
  heartbeat?: { intervalMs?: number; timeoutMs?: number }
  /** Default per-request timeout. Default 30 s. */
  requestTimeoutMs?: number
  /**
   * How long to wait for `welcome`. Default 10 s. `0` waits indefinitely —
   * right for a MessagePort to this page's own SharedWorker, which answers as
   * soon as its module graph has loaded: a cold start can take longer than
   * any fixed budget, and a timed-out connection is closed for good.
   */
  handshakeTimeoutMs?: number
  /**
   * Reconnect-and-resume across a dead wire. Remote clients pass
   * it; a MessagePort connection does not, and behaves exactly as before.
   *
   * `createTransport` builds a FRESH transport — a new `WebSocket` wrapped in
   * `createWebSocketTransport`. It is called once per attempt; throwing counts
   * as a failed attempt and the backoff continues.
   */
  reconnect?: {
    createTransport: () => FrameTransport
    /** First delay, doubling to `maxDelayMs`. Default 500 ms. */
    baseDelayMs?: number
    /** Backoff ceiling. Default 15 s. */
    maxDelayMs?: number
    /**
     * When set, attempt `n` waits exactly `delayLadderMs[n - 1]`, and every
     * attempt past the end waits its last step — unjittered, and in place of
     * both the doubling ladder and the slow cadence. For a client that tells
     * its user when the next try is (the remote's offline overlay counts it
     * down): the number they read is the number they get. `reconnectNow()`
     * starts it over from the first step.
     */
    delayLadderMs?: readonly number[]
    /** Injected for tests; default `Math.random`. */
    random?: () => number
  }
}

export class RuntimeConnectionClosedError extends Error {
  /**
   * `reason` is the transport close reason (`ws-4001` …) when the wire named
   * why it died. It rides the MESSAGE — not just a field — because the remote
   * boot's failure mapping (remoteBoot's stateForFailure) parses
   * `error.message + ' ' + error.code`: a bare `(transport)` collapses a
   * `ws-4001` (desktop panel closed) into the generic 'failed' screen instead
   * of the 'runtime_offline' one the user can act on.
   */
  constructor(
    readonly code: ByeCode | 'transport',
    readonly reason?: string,
  ) {
    super(
      reason
        ? `runtime connection closed (${code}): ${reason}`
        : `runtime connection closed (${code})`,
    )
    this.name = 'RuntimeConnectionClosedError'
  }
}

type Pending = {
  route: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout> | null
  cleanup: () => void
}

type Subscription = {
  listeners: Set<(event: TopicEvent) => void>
  lastSeq: number | null
  resubscribing: boolean
  /** Some event has reached the listeners: a later snapshot is a recovery (`TopicEvent.resync`). */
  delivered: boolean
  /**
   * While a paged snapshot is arriving (its last page had `more`): whether it
   * is a resync, so every page carries the first page's verdict. Its pages
   * share one seq, which the `seq === lastSeq` rule would otherwise read as
   * "nothing missed" from the second page on. `null` outside a paged snapshot.
   */
  snapshotResync: boolean | null
}

type BlobWaiter = {
  resolve: (bytes: Uint8Array) => void
  reject: (error: Error) => void
  /** Re-arms the waiter's idle deadline; called as each chunk lands. */
  touch: () => void
  /** Clears the waiter's deadline and abort listener; called on every settle path. */
  cleanup: () => void
}

type BlobAssembly = {
  chunks: Map<number, Uint8Array>
  total: number | null
  waiters: BlobWaiter[]
  /** Set once the blob is complete with nobody reading it; evicted on expiry or by the byte cap. */
  orphanedAt: number | null
  bytes: number
  /**
   * When the assembly was opened (first chunk or first reader). A PARTIAL
   * assembly — no `last` chunk yet, nobody waiting — has no `orphanedAt`, so
   * this is what lets `evictOrphans` drop one whose sender went away.
   */
  startedAt: number
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000
/** 0.5 s doubling to 15 s, jittered (F-24). */
const DEFAULT_RECONNECT_BASE_MS = 500
const DEFAULT_RECONNECT_MAX_MS = 15_000
/**
 * `runtime_offline` (the desktop panel is closed) and `too_many_clients` are
 * not transient blips — hammering them changes nothing, so they get one fixed,
 * slow cadence instead of the doubling ladder.
 */
const SLOW_RETRY_MS = 5_000
/**
 * How long a reconnect dial may be on the wire before `reconnectNow` treats it
 * as hung and dials over it. A healthy dial — LAN or relay — answers well
 * inside this; below it, a second press would only race the first.
 */
export const STALE_DIAL_MS = 3_000
/**
 * The relay is up and the DESKTOP PANEL is closed — there is no runtime behind
 * the wire. Distinct from every other close: it is the one the UI can name to
 * the user as an action they can take ("open the desktop"), and it is the most
 * likely way a v1 runtime dies. 4004 (`too_many_clients`)
 * shares the slow cadence but NOT this meaning — the desktop is reachable
 * there, so it must not borrow the copy.
 */
export const DESKTOP_OFFLINE_CLOSE_REASON = 'ws-4001'
const SLOW_RETRY_CLOSE_REASONS: ReadonlySet<string> = new Set([
  DESKTOP_OFFLINE_CLOSE_REASON,
  'ws-4004',
])
/**
 * Byes that mean "do not come back": the grant is gone (`unauthorized`),
 * another client took this identity (`replaced`), or the two ends cannot speak
 * (`protocol_too_old` / `protocol_too_new` — the page must reload to change
 * that). `shutting_down` is NOT here: the runtime restarting is exactly the
 * case resume exists for.
 */
const FINAL_BYE_CODES: ReadonlySet<ByeCode> = new Set<ByeCode>([
  'unauthorized',
  'replaced',
  'protocol_too_old',
  'protocol_too_new',
  'runtime_unavailable',
])
/** A websocket connection pings every 20 s; two 10 s timeouts = dead (F-24). */
const KEEPALIVE_EVERY_MS = 20_000
const PING_TIMEOUT_MS = 10_000
/** A complete blob nobody has read is kept this long for a late `readBlob`, then dropped. */
const ORPHAN_BLOB_TTL_MS = 30_000
/**
 * A PARTIAL assembly nobody is waiting on (chunks arrived, no `last`, every
 * reader gave up) is dropped this long after it opened. Without it such an
 * assembly had neither `orphanedAt` nor `total` and was never evicted.
 */
const STALE_PARTIAL_BLOB_TTL_MS = 60_000
/** Total bytes of unread complete blobs kept per connection; the oldest go first. */
const ORPHAN_BLOB_CAP_BYTES = 32 * 1024 * 1024

export function connectRuntime(options: ConnectRuntimeOptions): Promise<RuntimeConnection> {
  const connection = new RuntimeConnectionImpl(options)
  return connection.handshake()
}

class RuntimeConnectionImpl implements RuntimeConnection {
  state: ConnectionState = { status: 'connecting' }
  welcome: WelcomeFrame | null = null
  private readonly stateListeners = new Set<(state: ConnectionState) => void>()
  private readonly pending = new Map<string, Pending>()
  private readonly subscriptions = new Map<TopicId, Subscription>()
  private readonly blobs = new Map<string, BlobAssembly>()
  private blobSends: BlobSendLoop
  /**
   * Cleanups belonging to the CURRENT transport: its three listeners, the
   * handshake timer, the heartbeat interval. Dropped and rebuilt on every
   * swap — which is the whole reason this is separate from the object's own
   * lifetime. Before WP-6 there was one list for both, so a transport swap
   * would either have left the old timers running against a dead wire or torn
   * down the object with them.
   */
  private wiring: Unsubscribe[] = []
  /** The transport in use right now; replaced on reconnect. */
  private transport: FrameTransport
  private nextId = 1
  private handshakeResolve: ((connection: RuntimeConnection) => void) | null = null
  private handshakeReject: ((error: Error) => void) | null = null
  /** Set once a welcome has ever arrived — what `hello.resume` names. */
  private lastWelcome: WelcomeFrame | null = null
  private redialTimer: ReturnType<typeof setTimeout> | null = null
  /** When the reconnect attempt now on the wire dialled; `null` when none is. */
  private dialStartedAt: number | null = null
  private attempt = 0
  /**
   * The transport close reason that STARTED the current reconnect episode, or
   * `null` when the gap began some other way (a `bye`). Published on the
   * `reconnecting` state so the banner can tell "the desktop panel is closed"
   * from "the wire blipped" — the two reconnecting states.
   */
  private reconnectReason: string | null = null
  /**
   * The topic set the last `hello.resume` carried. A resumed welcome re-subscribes
   * nothing itself, so it is reconciled against this: held topics missing from it
   * are subscribed, members no longer held unsubscribed. `null` outside a resume.
   */
  private lastResumeTopics: Set<TopicId> | null = null

  constructor(private readonly options: ConnectRuntimeOptions) {
    this.transport = options.transport
    this.blobSends = new BlobSendLoop(this.transport)
    this.wireTransport()
  }

  /** Attach this object's handlers to `this.transport`. One call per transport. */
  private wireTransport(): void {
    const transport = this.transport
    this.wiring.push(
      transport.onFrame(frame => this.onFrame(frame)),
      transport.onBlobChunk((header, bytes) => this.onBlobChunk(header, bytes)),
      transport.onClosed((reason, retryable) => this.onTransportClosed(reason, retryable)),
    )
  }

  /** Drop every per-transport listener and timer. The object stays alive. */
  private unwire(): void {
    for (const unsubscribe of this.wiring) unsubscribe()
    this.wiring = []
  }

  handshake(): Promise<RuntimeConnection> {
    return new Promise<RuntimeConnection>((resolve, reject) => {
      this.handshakeResolve = resolve
      this.handshakeReject = reject
      this.sendHello()
    })
  }

  /**
   * Send `hello` on the current transport and arm the handshake deadline.
   * Called for the first connect and for every reconnect attempt; on a
   * reconnect it carries `resume` and the failure path is a retry, not a close.
   */
  private sendHello(): void {
    const resuming = this.state.status === 'reconnecting'
    const timeoutMs = this.options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS
    if (timeoutMs > 0) {
      const timer = setTimeout(() => {
        if (this.state.status === 'connecting') {
          this.markClosed('transport')
          this.transport.close()
          return
        }
        if (this.state.status === 'reconnecting') {
          // The new wire never answered: drop it and schedule the next attempt.
          // Unwire BEFORE closing: a transport reports its own close
          // synchronously, and `onTransportClosed` would count it as a second
          // failed attempt (or, reported final, close the connection).
          this.unwire()
          this.transport.close()
          this.queueRedial(null)
        }
      }, timeoutMs)
      this.wiring.push(() => clearTimeout(timer))
    }
    // pairSecret NEVER goes on the wire: the hello carries only the pairId,
    // and the secret is used locally to answer the challenge.
    this.transport.send({
      kind: 'hello',
      v: RUNTIME_PROTOCOL_VERSION,
      client: this.options.client,
      auth: this.options.auth ?? { mode: 'local' },
      ...(this.options.scopeCeiling !== undefined ? { scopeCeiling: this.options.scopeCeiling } : {}),
      ...(resuming && this.lastWelcome ? { resume: this.resumeRequest(this.lastWelcome) } : {}),
    })
  }

  /**
   * The resume request: connection id and each held topic's `lastSeq`. A topic
   * with no event yet is left out (`since: 0` would never replay its snapshot);
   * `onResumeWelcome` subscribes it fresh.
   */
  private resumeRequest(welcome: WelcomeFrame): { connectionId: string; topics: Record<TopicId, number> } {
    const topics: Record<TopicId, number> = {}
    const named = new Set<TopicId>()
    for (const [id, subscription] of this.subscriptions) {
      if (subscription.lastSeq === null) continue
      topics[id] = subscription.lastSeq
      named.add(id)
    }
    this.lastResumeTopics = named
    return { connectionId: welcome.connectionId, topics }
  }

  // ---- state ---------------------------------------------------------------------

  watchLinkState(listener: (state: ConnectionState) => void): Unsubscribe {
    this.stateListeners.add(listener)
    return () => {
      this.stateListeners.delete(listener)
    }
  }

  private setState(state: ConnectionState): void {
    this.state = state
    for (const listener of Array.from(this.stateListeners)) {
      // A listener is the UI's code, not ours: one that throws must neither
      // starve the listeners after it nor unwind into the caller — which is
      // the reconnect schedule itself, halfway through arming its next dial.
      try {
        listener(state)
      } catch (error) {
        console.error('[RuntimeConnection] state listener threw', error)
      }
    }
  }

  private markClosed(code: ByeCode | 'transport', reason?: string): void {
    if (this.state.status === 'closed') return
    this.dialStartedAt = null
    this.setState(reason ? { status: 'closed', code, reason } : { status: 'closed', code })
    const error = new RuntimeConnectionClosedError(code, reason)
    this.handshakeReject?.(error)
    this.handshakeReject = null
    this.handshakeResolve = null
    this.clearReconnectTimer()
    this.reconnectReason = null
    this.lastResumeTopics = null
    this.failInFlight(error, false)
    this.subscriptions.clear()
    this.unwire()
  }

  /**
   * Reject everything waiting on the wire. `retryable` says whether the caller
   * may sensibly try again: true while reconnecting (the connection is coming
   * back), false once closed for good.
   */
  private failInFlight(error: Error, retryable: boolean): void {
    for (const pending of Array.from(this.pending.values())) {
      pending.cleanup()
      const wire = wireError('cancelled', error.message)
      pending.reject(new RuntimeRequestError({ ...wire, retryable }, pending.route))
    }
    this.pending.clear()
    for (const blob of this.blobs.values()) {
      for (const waiter of blob.waiters) {
        waiter.cleanup()
        waiter.reject(error)
      }
    }
    this.blobs.clear()
    this.blobSends.clear(error)
  }

  private clearReconnectTimer(): void {
    if (this.redialTimer === null) return
    clearTimeout(this.redialTimer)
    this.redialTimer = null
  }

  // ---- reconnect ------------------------------------------------------

  /**
   * The wire is gone: closed when there is no `reconnect` option, the close is
   * final, or the connection never reached `ready` (a failed handshake is not
   * retried behind the caller's back); otherwise reconnecting.
   */
  private onTransportClosed(reason: string, retryable: boolean): void {
    if (this.state.status === 'closed') return
    if (this.state.status === 'reconnecting') {
      // A retry wire closed before its welcome (the relay refusing the dial
      // with 4001, a listener switched off with 4003). Act on it now rather
      // than waiting out the handshake deadline: a final close ends the
      // connection, anything else schedules the next attempt at the cadence
      // THIS close names.
      this.unwire()
      if (!retryable) {
        this.markClosed('transport', reason)
        return
      }
      this.queueRedial(reason)
      return
    }
    if (!this.options.reconnect || !retryable || !this.lastWelcome || this.state.status !== 'ready') {
      this.markClosed('transport', reason)
      return
    }
    this.enterReconnecting(reason)
  }

  private enterReconnecting(reason: string | null): void {
    this.unwire()
    this.attempt = 0
    // Remembered for the whole episode, not just the first attempt: the banner
    // asks WHY this gap started, and a failed retry is not a new answer to
    // that. Without it the UI would name the desktop-offline state once and
    // then silently fall back to the generic "reconnecting" on attempt 2 —
    // which is the state the user actually sits in.
    this.reconnectReason = reason
    // In-flight work cannot survive the gap — but it IS worth retrying, so it
    // is rejected retryable. Subscriptions are deliberately NOT cleared: they
    // are what `hello.resume` is made of.
    this.failInFlight(new RuntimeConnectionClosedError('transport'), true)
    this.queueRedial(reason)
  }

  private queueRedial(reason: string | null): void {
    // Closed is final: `markClosed` has rejected the caller's work and dropped
    // the subscriptions, so a late caller must not bring the object back.
    if (this.state.status === 'closed') return
    const reconnect = this.options.reconnect
    if (!reconnect || !this.lastWelcome) {
      this.markClosed('transport')
      return
    }
    this.dialStartedAt = null
    this.attempt += 1
    const random = reconnect.random ?? Math.random
    const base = reconnect.baseDelayMs ?? DEFAULT_RECONNECT_BASE_MS
    const max = reconnect.maxDelayMs ?? DEFAULT_RECONNECT_MAX_MS
    let delay: number
    const ladder = reconnect.delayLadderMs
    if (ladder !== undefined && ladder.length > 0) {
      delay = ladder[Math.min(this.attempt, ladder.length) - 1]
    } else if (reason !== null && SLOW_RETRY_CLOSE_REASONS.has(reason)) {
      // A fixed slow cadence, unjittered: the answer is "the desktop is not
      // there", and it changes when the user acts, not when we retry harder.
      delay = SLOW_RETRY_MS
    } else {
      const ceiling = Math.min(base * 2 ** (this.attempt - 1), max)
      // Full jitter over [ceiling/2, ceiling): spreads a fleet of clients that
      // all lost the same relay, without ever waiting longer than the ceiling.
      delay = ceiling / 2 + random() * (ceiling / 2)
    }
    // Armed BEFORE the publish: the publish runs UI listeners, and nothing
    // they do may leave the connection with no next attempt at all.
    this.clearReconnectTimer()
    this.redialTimer = setTimeout(() => {
      this.redialTimer = null
      this.tryReconnect()
    }, delay)
    // Published once the delay is known, so the state names when the next
    // dial is — the overlay's countdown reads it.
    this.publishReconnecting(Date.now() + delay)
  }

  private publishReconnecting(nextAttemptAt: number): void {
    if (!this.lastWelcome) return
    this.setState({
      status: 'reconnecting',
      attempt: this.attempt,
      lastWelcome: this.lastWelcome,
      ...(this.reconnectReason !== null ? { reason: this.reconnectReason } : {}),
      nextAttemptAt,
    })
  }

  reconnectNow(): void {
    if (this.state.status !== 'reconnecting') return
    if (this.redialTimer === null) {
      // No wait to cut short. A dial on the wire is left alone while it is
      // young; past STALE_DIAL_MS it is hung, and so is a connection with
      // neither a timer nor a dial (nothing would ever try again): drop
      // whatever wire there is and dial afresh. Unwired first, so its close is
      // not counted as a failed attempt (see sendHello).
      if (this.dialStartedAt !== null && Date.now() - this.dialStartedAt < STALE_DIAL_MS) return
      this.unwire()
      this.transport.close()
    }
    this.clearReconnectTimer()
    // The user acted, so the backoff starts over: this dial is attempt 0, and
    // if it fails the next one waits the FIRST step again, not wherever the
    // ladder had climbed to. Republished so a countdown stops at once.
    this.attempt = 0
    this.publishReconnecting(Date.now())
    this.tryReconnect()
  }

  private tryReconnect(): void {
    if (this.state.status !== 'reconnecting') return
    const reconnect = this.options.reconnect
    if (!reconnect) return
    let transport: FrameTransport
    try {
      transport = reconnect.createTransport()
    } catch {
      // Constructing the socket threw (no network, bad URL): that is this
      // attempt failing, not the connection ending.
      this.queueRedial(null)
      return
    }
    this.transport = transport
    this.dialStartedAt = Date.now()
    this.blobSends = new BlobSendLoop(transport)
    this.wireTransport()
    this.sendHello()
  }

  /**
   * A welcome arrived on a reconnect. `resumed` decides how much has to be
   * rebuilt: the runtime either still holds this connection (replay from the
   * seqs we sent) or it does not (fresh id — re-subscribe every held topic and
   * take new snapshots, since the seq space is no longer comparable).
   */
  private onResumeWelcome(frame: WelcomeFrame): void {
    this.dialStartedAt = null
    this.attempt = 0
    this.reconnectReason = null
    this.welcome = frame
    this.lastWelcome = frame
    const resumed = this.lastResumeTopics
    this.lastResumeTopics = null
    // Taken BEFORE the publish: a `ready` listener that subscribes does so on
    // a live wire itself, and must not be subscribed a second time below.
    const heldAtWelcome = Array.from(this.subscriptions.keys())
    this.setState({ status: 'ready', welcome: frame })
    if (!frame.resumed) {
      for (const [id, subscription] of this.subscriptions) {
        subscription.lastSeq = null
        subscription.snapshotResync = null
        subscription.resubscribing = false
        this.sendSubscribe(id, undefined)
      }
    } else if (resumed) {
      // The runtime holds exactly the set the resume named. Reconcile it with
      // what is held NOW: anything (un)subscribed between the hello and this
      // welcome never reached the wire (see `lastResumeTopics`).
      for (const id of heldAtWelcome) {
        if (resumed.has(id)) continue
        const subscription = this.subscriptions.get(id)
        if (!subscription) continue
        subscription.lastSeq = null
        subscription.snapshotResync = null
        subscription.resubscribing = false
        this.sendSubscribe(id, undefined)
      }
      const dropped = Array.from(resumed).filter(id => !this.subscriptions.has(id))
      if (dropped.length > 0) {
        void this.request(TOPICS_UNSUBSCRIBE_ROUTE, { topics: dropped }).catch(() => {})
      }
    }
    this.beginKeepalive()
  }

  close(): void {
    if (this.state.status === 'closed') return
    // A deliberate close cancels any pending reconnect: the caller is done,
    // and a timer that fires afterwards would resurrect a dead object.
    this.clearReconnectTimer()
    this.transport.send({ kind: 'bye', code: 'shutting_down' })
    this.markClosed('shutting_down')
    this.transport.close()
  }

  // ---- heartbeat (websocket only) -------------------------------------------------

  /**
   * A websocket connection drives `sys.ping` every 20 s; the hub reaps a
   * connection silent past 60 s. Two consecutive ping timeouts (10 s each)
   * mean the wire is dead even if no close event arrived — close it so the
   * caller can reconnect-and-resume. MessagePort connections have their own
   * close event and never ping.
   */
  private beginKeepalive(): void {
    if (this.transport.kind !== 'websocket') return
    const intervalMs = this.options.heartbeat?.intervalMs ?? KEEPALIVE_EVERY_MS
    const timeoutMs = this.options.heartbeat?.timeoutMs ?? PING_TIMEOUT_MS
    let misses = 0
    // Captured so a ping that times out after a swap cannot tear down the
    // NEW wire: `unwire()` has already cleared this interval, but the
    // in-flight request's rejection can still arrive.
    const transport = this.transport
    const interval = setInterval(() => {
      if (this.state.status !== 'ready') return
      const t = Date.now()
      this.request(SYS_PING_ROUTE, { t }, { timeoutMs })
        .then(() => { misses = 0 })
        .catch(() => {
          misses += 1
          if (misses >= 2) {
            clearInterval(interval)
            if (this.transport !== transport) return
            // Dead wire with no close event. Go through the transport's own
            // close so the reconnect path is the same one a real close takes.
            transport.close()
            if (this.state.status === 'ready') this.markClosed('transport')
          }
        })
    }, intervalMs)
    // Per-TRANSPORT, so a swap re-arms it (the note WP-3 left for WP-6).
    this.wiring.push(() => clearInterval(interval))
  }

  can(cap: string, act?: string): boolean {
    const advert = this.welcome?.server.capabilities.find(entry => entry.cap === cap)
    if (!advert) return false
    return act === undefined || advert.acts.includes(act)
  }

  // ---- inbound -------------------------------------------------------------------

  private onFrame(frame: Frame): void {
    if (this.state.status === 'closed') return
    // While reconnecting only the handshake frames mean anything: `res`/`evt`
    // for the old connection were already rejected, and a straggler must not
    // resolve a request the caller has been told is gone.
    if (
      this.state.status === 'reconnecting' &&
      frame.kind !== 'welcome' &&
      frame.kind !== 'challenge' &&
      frame.kind !== 'bye'
    ) {
      return
    }
    switch (frame.kind) {
      case 'welcome':
        if (this.state.status === 'reconnecting') {
          this.onResumeWelcome(frame)
          return
        }
        if (this.state.status !== 'connecting') return
        this.welcome = frame
        this.lastWelcome = frame
        this.setState({ status: 'ready', welcome: frame })
        this.handshakeResolve?.(this)
        this.handshakeResolve = null
        this.handshakeReject = null
        this.beginKeepalive()
        return
      case 'challenge': {
        // Answer the pair handshake's nonce challenge. Valid while connecting
        // AND while reconnecting — a resume is a full handshake, so the pair
        // proof is demanded again on every new wire. Ignore it otherwise (a
        // stray or replayed challenge is noise).
        if (this.state.status !== 'connecting' && this.state.status !== 'reconnecting') return
        const auth = this.options.auth
        if (auth?.mode !== 'pair' || !this.options.pairSecret) return
        const proof = pairProof(this.options.pairSecret, frame.nonce, this.options.client.clientId)
        if (proof) this.transport.send({ kind: 'auth', proof })
        return
      }
      case 'bye':
        // `shutting_down` on a reconnectable connection is the runtime
        // restarting — exactly what resume is for. The rest are final.
        if (
          this.options.reconnect &&
          this.lastWelcome &&
          !FINAL_BYE_CODES.has(frame.code) &&
          (this.state.status === 'ready' || this.state.status === 'reconnecting')
        ) {
          if (this.state.status === 'reconnecting') {
            // The retry wire itself said goodbye: one failed attempt. Unwire
            // first so the close below is not counted again (see sendHello).
            this.unwire()
            this.transport.close()
            this.queueRedial(null)
            return
          }
          this.transport.close()
          if (this.state.status === 'ready') this.enterReconnecting(null)
          return
        }
        this.markClosed(frame.code)
        this.transport.close()
        return
      case 'res':
        this.onRes(frame)
        return
      case 'evt':
        this.onEvt(frame)
        return
      case 'ack':
        this.blobSends.onAck(frame)
        return
      case 'cancel':
        // Server-side cancel of a request we made: treat as cancelled.
        this.settle(frame.id, res => res.reject(new RuntimeRequestError(wireError('cancelled', 'cancelled by the runtime'), res.route)))
        return
      default:
        return
    }
  }

  private onRes(res: ResFrame): void {
    this.settle(res.id, pending => {
      if (res.ok) pending.resolve(res.result)
      else pending.reject(new RuntimeRequestError(res.error, pending.route))
    })
  }

  private settle(id: string, fn: (pending: Pending) => void): void {
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    pending.cleanup()
    fn(pending)
  }

  // ---- requests ------------------------------------------------------------------

  request<R = unknown>(route: Route | RouteKey, payload?: unknown, opts: RequestOptions = {}): Promise<R> {
    const key: RouteKey = typeof route === 'string' ? route : routeKey(route)
    if (this.state.status === 'closed') {
      return Promise.reject(new RuntimeRequestError(wireError('cancelled', 'connection closed'), key))
    }
    if (this.state.status === 'reconnecting') {
      // Fail fast and RETRYABLE rather than queue: the caller gets an answer
      // now and can decide, instead of a request hanging for the length of a
      // network outage and then landing on a connection with a different grant.
      return Promise.reject(
        new RuntimeRequestError(
          { ...wireError('cancelled', 'reconnecting to the runtime'), retryable: true },
          key,
        ),
      )
    }
    const id = `c${this.nextId++}`
    return new Promise<R>((resolve, reject) => {
      const timeoutMs = opts.timeoutMs ?? this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
      const onAbort = (): void => {
        this.cancel(id, wireError('cancelled', 'request aborted by the caller'))
      }
      const timer =
        timeoutMs > 0
          ? setTimeout(() => this.cancel(id, wireError('timeout', `no response within ${timeoutMs} ms`)), timeoutMs)
          : null
      opts.signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(id, {
        route: key,
        resolve: value => resolve(value as R),
        reject,
        timer,
        cleanup: () => {
          if (timer) clearTimeout(timer)
          opts.signal?.removeEventListener('abort', onAbort)
        },
      })
      try {
        this.transport.send({ kind: 'req', id, route: key, payload })
      } catch (error) {
        // The wire refused the frame synchronously (a socket already closing).
        // Settle NOW — leaving the entry would hold its timer and abort
        // listener until the deadline, which then sends a spurious `cancel`
        // for a request that never left this side.
        const message = error instanceof Error ? error.message : String(error)
        this.settle(id, p =>
          p.reject(
            new RuntimeRequestError(
              { ...wireError('cancelled', `transport send failed: ${message}`), retryable: true },
              p.route,
            ),
          ),
        )
        return
      }
      if (opts.signal?.aborted) onAbort()
    })
  }

  /** Give up on a request: tell the runtime (so its handler aborts) and reject locally. */
  private cancel(id: string, error: WireError): void {
    const pending = this.pending.get(id)
    if (!pending) return
    this.transport.send({ kind: 'cancel', id })
    this.settle(id, p => p.reject(new RuntimeRequestError(error, p.route)))
  }

  // ---- topics --------------------------------------------------------------------

  subscribe<T = unknown>(topic: TopicId, listener: (event: TopicEvent<T>) => void): Unsubscribe {
    let subscription = this.subscriptions.get(topic)
    const first = !subscription
    if (!subscription) {
      subscription = {
        listeners: new Set(),
        lastSeq: null,
        resubscribing: false,
        delivered: false,
        snapshotResync: null,
      }
      this.subscriptions.set(topic, subscription)
    }
    const typed = listener as (event: TopicEvent) => void
    subscription.listeners.add(typed)
    // While reconnecting there is no wire to send on: the topic rides the
    // next `hello.resume` (dialled later) or the reconciliation the resumed
    // welcome runs (dialled already — see `lastResumeTopics`).
    if (first && this.state.status !== 'reconnecting') this.sendSubscribe(topic, undefined)
    return () => {
      const current = this.subscriptions.get(topic)
      if (!current) return
      current.listeners.delete(typed)
      if (current.listeners.size === 0) {
        this.subscriptions.delete(topic)
        if (this.state.status !== 'closed' && this.state.status !== 'reconnecting') {
          void this.request(TOPICS_UNSUBSCRIBE_ROUTE, { topics: [topic] }).catch(() => {})
        }
      }
    }
  }

  private sendSubscribe(topic: TopicId, since: number | undefined): void {
    void this.request(TOPICS_SUBSCRIBE_ROUTE, {
      topics: [{ topic, ...(since !== undefined ? { since } : {}) }],
    })
      .catch(() => {
        // The subscription is refused (scope, unknown topic) or the connection
        // is gone; listeners simply never fire. `can()`-driven UI does not
        // subscribe to what it may not see, so this is the exceptional path.
      })
      .finally(() => {
        const subscription = this.subscriptions.get(topic)
        if (subscription) subscription.resubscribing = false
      })
  }

  private onEvt(evt: EvtFrame): void {
    const subscription = this.subscriptions.get(evt.topic)
    if (!subscription) return
    let resync = false
    if (evt.form === 'snapshot') {
      // A snapshot on a topic that has already delivered is the broker
      // recovering a gap — except one stamped with the very seq we hold in a
      // comparable seq space, which missed nothing. A non-resumed welcome
      // clears `lastSeq` (new seq space), so its snapshots always count.
      const continued = subscription.snapshotResync !== null && evt.seq === subscription.lastSeq
      resync = continued
        ? subscription.snapshotResync === true
        : subscription.delivered && !(subscription.lastSeq !== null && evt.seq === subscription.lastSeq)
      subscription.snapshotResync = evt.more ? resync : null
      subscription.lastSeq = evt.seq
    } else {
      subscription.snapshotResync = null
      const last = subscription.lastSeq
      if (last !== null) {
        if (evt.seq <= last) return // duplicate / replayed past what we have
        if (evt.seq > last + 1) {
          // A hole: re-subscribe from what we have; the broker replays or re-snapshots.
          if (!subscription.resubscribing) {
            subscription.resubscribing = true
            this.sendSubscribe(evt.topic, last)
          }
          return
        }
      }
      subscription.lastSeq = evt.seq
    }
    // A batch is unfolded here, so a listener never has to know whether the
    // runtime sent its deltas one frame at a time or all at once.
    const payloads = evt.form === 'deltas' && Array.isArray(evt.payload) ? evt.payload : [evt.payload]
    for (const payload of payloads) {
      const event: TopicEvent = {
        topic: evt.topic,
        seq: evt.seq,
        ...(evt.type !== undefined ? { type: evt.type } : {}),
        form: evt.form === 'deltas' ? 'delta' : evt.form,
        ...(evt.more ? { more: true } : {}),
        ...(resync ? { resync: true } : {}),
        payload,
      }
      subscription.delivered = true
      for (const listener of Array.from(subscription.listeners)) listener(event)
    }
  }

  // ---- blobs ---------------------------------------------------------------------

  private assemblyFor(id: string): BlobAssembly {
    let assembly = this.blobs.get(id)
    if (!assembly) {
      assembly = {
        chunks: new Map(),
        total: null,
        waiters: [],
        orphanedAt: null,
        bytes: 0,
        startedAt: Date.now(),
      }
      this.blobs.set(id, assembly)
    }
    return assembly
  }

  /**
   * Drop unread complete blobs past their TTL, then the oldest until under the
   * byte cap; and drop stale PARTIAL assemblies nobody is waiting on.
   */
  private evictOrphans(now: number): void {
    let total = 0
    const orphans: Array<[string, BlobAssembly]> = []
    for (const [id, assembly] of this.blobs) {
      if (assembly.orphanedAt === null) {
        if (assembly.waiters.length === 0 && now - assembly.startedAt >= STALE_PARTIAL_BLOB_TTL_MS) {
          this.blobs.delete(id)
        }
        continue
      }
      if (now - assembly.orphanedAt >= ORPHAN_BLOB_TTL_MS) {
        this.blobs.delete(id)
        continue
      }
      orphans.push([id, assembly])
      total += assembly.bytes
    }
    orphans.sort((a, b) => a[1].orphanedAt! - b[1].orphanedAt!)
    for (const [id, assembly] of orphans) {
      if (total <= ORPHAN_BLOB_CAP_BYTES) break
      this.blobs.delete(id)
      total -= assembly.bytes
    }
  }

  private onBlobChunk(header: BlobChunkHeader, bytes: Uint8Array): void {
    if (this.state.status === 'closed') return
    const assembly = this.assemblyFor(header.id)
    assembly.chunks.set(header.index, bytes)
    if (header.last) assembly.total = header.index + 1
    for (const waiter of assembly.waiters) waiter.touch()
    this.transport.send({ kind: 'ack', id: header.id, upTo: header.index })
    this.tryCompleteBlob(header.id, assembly)
  }

  private tryCompleteBlob(id: string, assembly: BlobAssembly): void {
    if (assembly.total === null || assembly.chunks.size < assembly.total) return
    let length = 0
    for (let i = 0; i < assembly.total; i += 1) length += assembly.chunks.get(i)?.byteLength ?? 0
    const out = new Uint8Array(length)
    let offset = 0
    for (let i = 0; i < assembly.total; i += 1) {
      const chunk = assembly.chunks.get(i)!
      out.set(chunk, offset)
      offset += chunk.byteLength
    }
    if (assembly.waiters.length === 0) {
      // Bytes arrived before anyone asked (the res was still being handled):
      // keep them assembled for a bounded time — a BlobRef the caller never
      // reads must not be a permanent allocation.
      assembly.chunks.clear()
      assembly.chunks.set(0, out)
      assembly.total = 1
      assembly.bytes = out.byteLength
      assembly.orphanedAt = Date.now()
      this.evictOrphans(assembly.orphanedAt)
      return
    }
    this.blobs.delete(id)
    for (const waiter of assembly.waiters) {
      waiter.cleanup()
      waiter.resolve(out)
    }
  }

  async putBlob(
    bytes: Uint8Array,
    meta: { mime?: string } = {},
    opts: { signal?: AbortSignal } = {},
  ): Promise<BlobRef> {
    const ref = await this.request<BlobRef>(
      SYS_PUT_BLOB_ROUTE,
      { bytes: bytes.byteLength, ...(meta.mime ? { mime: meta.mime } : {}) },
      opts.signal ? { signal: opts.signal } : {},
    )
    await this.blobSends.send(ref.$blob, bytes)
    return ref
  }

  readBlob(ref: BlobRef, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<Uint8Array> {
    const route = `blob:${ref.$blob}`
    if (this.state.status === 'closed') {
      return Promise.reject(new RuntimeConnectionClosedError(this.state.code))
    }
    if (this.state.status === 'reconnecting') {
      // Same answer as `request()`: the chunks of the old wire were dropped
      // with it, and nothing on the new one will carry this id. Fail fast and
      // retryable rather than wait forever.
      return Promise.reject(
        new RuntimeRequestError(
          { ...wireError('cancelled', 'reconnecting to the runtime'), retryable: true },
          route,
        ),
      )
    }
    this.evictOrphans(Date.now())
    const assembly = this.assemblyFor(ref.$blob)
    assembly.orphanedAt = null
    return new Promise<Uint8Array>((resolve, reject) => {
      const timeoutMs = opts.timeoutMs ?? this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
      // Take this reader off the assembly. A partial nobody else waits on is
      // left for `evictOrphans` (its `startedAt` bounds it); an empty one goes now.
      const withdraw = (): void => {
        const index = assembly.waiters.indexOf(waiter)
        if (index >= 0) assembly.waiters.splice(index, 1)
        if (assembly.waiters.length === 0 && assembly.chunks.size === 0) this.blobs.delete(ref.$blob)
      }
      const onAbort = (): void => {
        waiter.cleanup()
        withdraw()
        reject(new RuntimeRequestError(wireError('cancelled', 'readBlob aborted'), route))
      }
      // An IDLE deadline, not a total one: a large blob over a slow relay is
      // still progressing chunk by chunk, so every arriving chunk re-arms it
      // (`touch`). Only a blob that stops arriving times out.
      let timer: ReturnType<typeof setTimeout> | null = null
      const arm = (): void => {
        if (timer) clearTimeout(timer)
        timer =
          timeoutMs > 0
            ? setTimeout(() => {
                waiter.cleanup()
                withdraw()
                reject(
                  new RuntimeRequestError(wireError('timeout', `no blob chunk within ${timeoutMs} ms`), route),
                )
              }, timeoutMs)
            : null
      }
      const waiter: BlobWaiter = {
        resolve,
        reject,
        touch: arm,
        cleanup: () => {
          if (timer) clearTimeout(timer)
          timer = null
          opts.signal?.removeEventListener('abort', onAbort)
        },
      }
      arm()
      assembly.waiters.push(waiter)
      opts.signal?.addEventListener('abort', onAbort, { once: true })
      this.tryCompleteBlob(ref.$blob, assembly)
    })
  }
}
