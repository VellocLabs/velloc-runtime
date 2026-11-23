/**
 * Contract: a router provider (F-27) owns no endpoint. It chooses a target
 * for each request and never sends: the request goes out as the target
 * provider's own, with the target's credentials, codec and hooks. This file
 * holds what a router is asked, what it may answer, and the registry the
 * model-route resolution reads.
 *
 * Security: a router's answer is untrusted. A target is used only when it is
 * a provider that is set up, is not a router, and is inside the router's
 * `routesTo`; the check is the resolution step's, not the router's.
 */
import type { BridgeModelRequestContext } from '../../browser/bridge/browserBridgeProtocol'
import { getProviderErrorFields, type ProviderConnectivityIssue, type ProviderErrorFields } from '../../utils/providerConnectivity'
import type { ProviderPolicy } from './providerPolicy'
import type { ProviderOutcomeEvent } from './providerOutcome'

/** The target answers one call may take for each distinct target its router
 *  names, a provider and model pair; a target named at a broken reply counts. A
 *  call's bound grows with those names, so a route of any size is walked, and a
 *  router that keeps naming the same ones runs out. */
export const ROUTE_SENDS_PER_TARGET = 4
/** A router's own time to answer one `route`, ms. */
export const ROUTE_BUDGET_MS = 2_000

/**
 * The providers a router may send through: any provider the person set up,
 * or the listed provider definitions.
 */
export type RoutesTo = '*' | readonly string[]

/** One send that failed, as the router is told. */
export type RouteFailure = {
  /** The target the send went to: a provider instance id and its model. */
  provider: string
  model: string
  /** The HTTP status, when there was one. */
  status?: number
  /** The verdict after the target's own error rules and classify hook ran. */
  verdict: ProviderConnectivityIssue
  message: string
  retryAfterMs?: number
  /** Bytes of a reply had reached the reader. */
  streamStarted: boolean
}

export type RouteEvent = {
  /** The router's own row id. */
  model: string
  requestContext: BridgeModelRequestContext
  /** One id for every ask of a call: the first send, and each ask after a
   *  failed send. Another call has another id. */
  callId: string
  /** 1 for the first send of this call. */
  attempt: number
  /** What the request asks of the model that serves it. `tools`: it carries
   *  tool definitions. `images`, `documents`: its messages carry such parts;
   *  a target that states no support for a kind is sent placeholders. */
  request: { tools: boolean; images: boolean; documents: boolean }
  lastFailure?: RouteFailure
  /** The session's context in tokens, as its usage meter counts it. Absent
   *  for a request that belongs to no session. */
  usage?: { contextTokens: number }
}

/** Send to this target; end the call now; or nothing, the platform's own path. */
export type RouteAnswer =
  | { provider: string; model: string; effort?: string }
  | { stop: true; message?: string }
  | undefined

/** What a router's module is told when a routed request is over. `callId`
 *  is the id the call's `provider.route` events carry. */
export type RouteOutcomeEvent = ProviderOutcomeEvent & { callId: string }

export interface ProviderRouter {
  route(event: RouteEvent, signal: AbortSignal): Promise<RouteAnswer>
  /** An observer: returns at once, and what it returns is unread. */
  outcome?(event: RouteOutcomeEvent): void
}

/**
 * Who served a routed reply, recorded on the reply. `switchedFrom` is present
 * when the call moved off another target, or the target differs from the one
 * that served the session's previous reply. `reason` is the verdict of the
 * failed send the call moved off; absent when no send of the call failed.
 */
export type RoutedVia = {
  provider: string
  model: string
  /** The member's display name and thinking tiers as the runtime lists them, so a reader needs no catalog row for it. */
  label?: string
  tiers?: string[]
  defaultTier?: string
  switchedFrom?: { provider: string; model: string; reason?: ProviderConnectivityIssue['kind'] }
}

/** A started stream failed and the router chose another target: the call is
 *  sent again at once, to `target`. It reads as its cause does, status and
 *  declared verdict included. */
export class RouteSwitchError extends Error {
  readonly target: { provider: string; model: string; effort?: string }
  override readonly cause: unknown
  readonly httpStatus?: number
  readonly retryAfterMs?: number
  readonly declared?: ProviderErrorFields['declared']

  constructor(target: { provider: string; model: string; effort?: string }, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause))
    this.name = 'RouteSwitchError'
    this.target = target
    this.cause = cause
    const fields = getProviderErrorFields(cause)
    if (fields.httpStatus !== undefined) this.httpStatus = fields.httpStatus
    if (fields.retryAfterMs !== undefined) this.retryAfterMs = fields.retryAfterMs
    if (fields.declared !== undefined) this.declared = fields.declared
  }
}

/**
 * The router ended the call: nothing is sent again. Without a message of the
 * router's own it reads as its cause does, status and declared verdict
 * included.
 */
export class RouteStopError extends Error {
  override readonly cause: unknown
  readonly httpStatus?: number
  readonly retryAfterMs?: number
  readonly declared?: ProviderErrorFields['declared']

  constructor(cause: unknown, message?: string) {
    super(message ?? (cause instanceof Error ? cause.message : String(cause)))
    this.name = 'RouteStopError'
    this.cause = cause
    if (message !== undefined) return
    const fields = getProviderErrorFields(cause)
    if (fields.httpStatus !== undefined) this.httpStatus = fields.httpStatus
    if (fields.retryAfterMs !== undefined) this.retryAfterMs = fields.retryAfterMs
    if (fields.declared !== undefined) this.declared = fields.declared
  }
}

/**
 * A router's decision about a failed stream, as the stream's terminal error
 * chunk carries it to the reader.
 */
export type RouteErrorMark =
  | { switch: { provider: string; model: string; effort?: string } }
  | { stop: true; message?: string }

/** The error a marked error chunk stands for; undefined for an unmarked one. */
export function routeErrorOf(mark: unknown, cause: Error): RouteSwitchError | RouteStopError | undefined {
  if (typeof mark !== 'object' || mark === null) return undefined
  const m = mark as { switch?: unknown; stop?: unknown; message?: unknown }
  if (m.stop === true) return new RouteStopError(cause, typeof m.message === 'string' ? m.message : undefined)
  const target = m.switch as { provider?: unknown; model?: unknown; effort?: unknown } | undefined
  if (!target || typeof target.provider !== 'string' || typeof target.model !== 'string') return undefined
  return new RouteSwitchError(
    { provider: target.provider, model: target.model, ...(typeof target.effort === 'string' ? { effort: target.effort } : {}) },
    cause,
  )
}

/**
 * Whether a provider is inside a router's boundary. `routesTo` names provider
 * DEFINITIONS, so every instance of a listed definition is inside. The one
 * place this is decided.
 */
export function insideRoutesTo(routesTo: RoutesTo, peer: { readonly definition: string }): boolean {
  return routesTo === '*' || routesTo.includes(peer.definition)
}

// ── registry ────────────────────────────────────────────────────────────────

export type ProviderRouterBounds = {
  readonly routesTo: RoutesTo
  /** The router's declared retry policy: a request that goes through the
   *  router is retried under it, whichever target serves it. */
  readonly retry?: ProviderPolicy['retry']
}

type Registered = { router: ProviderRouter; bounds: ProviderRouterBounds }

const routers = new Map<string, Registered>()

/** Plug `router` in for the router provider `providerId`; returns the unplug
 *  (a no-op once another router replaced it). */
export function registerProviderRouter(
  providerId: string,
  router: ProviderRouter,
  bounds: ProviderRouterBounds,
): () => void {
  const entry: Registered = { router, bounds }
  routers.set(providerId, entry)
  return () => {
    if (routers.get(providerId) === entry) routers.delete(providerId)
  }
}

export function providerRouterFor(providerId: string): ProviderRouter | undefined {
  return routers.get(providerId)?.router
}

export function providerRouterBoundsFor(providerId: string): ProviderRouterBounds | undefined {
  return routers.get(providerId)?.bounds
}

export function unregisterProviderRouter(providerId: string): void {
  routers.delete(providerId)
}

/** Test hook. */
export function resetProviderRouters(): void {
  routers.clear()
}
