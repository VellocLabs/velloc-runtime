/**
 * Server-side interfaces of the UI ⇄ Runtime protocol. Security: the hub checks scope, session
 * binding and payload shape BEFORE a handler runs, so handlers never re-implement authorization.
 */
import type { RuntimeFs } from '../../utils/fs/runtimeFs'
import type {
  BrowserBridgeError,
  BrowserBridgeRoute,
} from '../bridge/protocol/core'
import type { WebUiBridgeContext } from '../worker/webUiBridge/registry'
import type {
  BlobRef,
  ClientKind,
  EvtForm,
  Route,
  Scope,
  ScopeMode,
  TopicId,
} from '../runtimeProtocol'
import type { FrameTransportKind } from '../runtimeTransport'

export type ConnectionInfo = {
  readonly connectionId: string
  readonly clientId: string
  readonly kind: ClientKind
  readonly scope: Scope
  readonly transport: FrameTransportKind
  readonly panelId?: string
  /** `hello.client.userAgent` — a remote page's browser string, for the
   *  desktop's connected-device list (F-24). Absent for this machine's own
   *  shell, which never sends one. */
  readonly userAgent?: string
  /** When the handshake completed (`hub.now()`), so the device list can say
   *  how long a device has been connected. */
  readonly connectedAt: number
}

/**
 * How a handler moves bytes. Out: offer them, put the returned
 * `BlobRef` in the result, and the hub pushes the chunks after the `res`
 * frame; offers made by a request that fails are discarded. In: `receive` a
 * `BlobRef` the client announced with `sys.putBlob` on this connection — it
 * resolves once every chunk is in, and consumes the blob.
 */
export type BlobOffers = {
  offer(bytes: Uint8Array, meta?: { mime?: string }): BlobRef
  receive(ref: BlobRef, signal?: AbortSignal): Promise<Uint8Array>
}

export type HandlerRequest<P = unknown> = {
  readonly id: string
  readonly route: Route
  readonly payload: P
  readonly conn: ConnectionInfo
  /** Aborted by a `cancel` frame for this id, or by the connection going away. */
  readonly signal: AbortSignal
  readonly blobs: BlobOffers
}

/** The C++ direct bridge as the hub sees it — one request shape, no policy table. */
export interface HostBridge {
  request(
    route: BrowserBridgeRoute,
    payload: unknown,
  ): Promise<{ ok: true; result: unknown } | { ok: false; error: BrowserBridgeError }>
}

export type PublishOptions = { type?: string; form?: EvtForm }

/**
 * What handlers get. `fs` and `host` follow the replaceable direct transport
 * (`RuntimeHub.handleDirectTransportChanged`), so handlers read them per call
 * and never capture them.
 */
export interface RuntimeContext {
  fs: RuntimeFs
  host: HostBridge | null
  /** Upgraded once from the first attach that carries one; never downgraded to empty. */
  homeDir: string
  publish(topic: TopicId, payload: unknown, opts?: PublishOptions): number
  connections(): readonly ConnectionInfo[]
  /**
   * Strangler seam: the context the ten settings adapters under
   * `bridge/adapter/` were written against. Its `broadcastEvent` reaches both
   * the legacy WebUI ports and the broker. Goes away when those adapters are
   * rewritten against `RuntimeContext` directly.
   */
  readonly webUiBridge: WebUiBridgeContext
}

/**
 * Who may build on an action. `internal` (the default when absent) is this
 * app's own client surface: its payload may change with any refactor.
 * `beta` is offered to third-party clients without a compatibility promise;
 * `stable` is a promise — fields are only ever added. Marking one is a
 * deliberate act, pinned by `runtime-api-surface-guard.test.ts`.
 */
export type ApiStability = 'internal' | 'beta' | 'stable'

export const API_STABILITIES: readonly ApiStability[] = ['internal', 'beta', 'stable']

export type ActionSpec = {
  scope: ScopeMode
  /** Absent = `internal`. See `ApiStability`. */
  stability?: ApiStability
  /** Session-bound action: the session id the payload names, judged against `scope.sessions`. */
  sessionOf?: (payload: unknown) => string | undefined
  /**
   * Payload guard; a failure is answered with `bad_payload` before the handler
   * runs. It also gets the calling connection and the runtime context, for a
   * payload whose admissibility depends on the grant (the search targets),
   * and may answer asynchronously (one that must resolve the host home).
   */
  guard?: (payload: unknown, conn: ConnectionInfo, ctx: RuntimeContext) => boolean | Promise<boolean>
}

export type CapabilityHandler = (
  request: HandlerRequest,
  ctx: RuntimeContext,
) => Promise<unknown>

/** A capability the runtime implements itself. */
export type CapabilityDefinition = {
  cap: string
  actions: Record<string, ActionSpec>
  handle: CapabilityHandler
}

/**
 * A capability forwarded to C++: `req` → scope check → `ctx.host.request` →
 * result returned as-is, except the fields named in `binaryResultFields`,
 * which become `BlobRef`s with their bytes pushed as chunks. The table of
 * these IS the audit point for what a client may ask the host to do — there
 * is no wildcard forwarding.
 */
export type HostProxySpec = {
  cap: string
  actions: Record<string, ActionSpec>
  binaryResultFields?: Partial<Record<string, readonly string[]>>
}

export type SnapshotPage = { type?: string; payload: unknown }

export interface TopicProvider {
  matches(topic: TopicId): boolean
  authorize(topic: TopicId, conn: ConnectionInfo): boolean
  /**
   * The current state for a new subscriber (or one whose `since` fell out of
   * the replay ring). Yield several pages for a large state; the broker sends
   * all but the last with `more: true`. Yielding nothing is fine for a
   * delta-only topic — the broker then sends one empty snapshot so the client
   * still learns the topic's current `seq`.
   */
  snapshot(topic: TopicId, conn: ConnectionInfo, since?: number): AsyncIterable<SnapshotPage>
  /**
   * Narrow a delta to ONE connection, or `undefined` to withhold it (it still takes a seq: a typeless
   * `null` delta is sent). Absent: every subscriber gets every delta.
   */
  project?(topic: TopicId, conn: ConnectionInfo, evt: { type?: string; payload: unknown }): unknown
  /**
   * A connection subscribed; `first` is true when it is the topic's only
   * subscriber — the moment a provider that fronts a push source (a session's
   * worker events, the tracer) starts that source. Called after the subscriber
   * is registered and before its snapshot is produced.
   */
  onSubscribe?(topic: TopicId, conn: ConnectionInfo, first: boolean): void
  /** A connection left (unsubscribe or close); `last` is true when nobody is left on the topic. */
  onUnsubscribe?(topic: TopicId, conn: ConnectionInfo, last: boolean): void
}
