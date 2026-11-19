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
import type { RouteRecipe } from '../../config/nexusModelConfig/routeRecipes'
import type { ProviderConnectivityIssue } from '../../utils/providerConnectivity'
import type { ProviderOutcomeEvent } from './providerOutcome'

/** The most targets one call may be sent to, the first included. */
export const ROUTE_HOPS_MAX = 8
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
  /** 1 for the first send of this call. */
  attempt: number
  lastFailure?: RouteFailure
  /** The session's context in tokens, as its usage meter counts it. Absent
   *  for a request that belongs to no session. */
  usage?: { contextTokens: number }
  /** The route the row was composed as, when the router's rows are routes. */
  recipe?: RouteRecipe
}

/** Send to this target; end the call now; or nothing, the platform's own path. */
export type RouteAnswer =
  | { provider: string; model: string; effort?: string }
  | { stop: true; message?: string }
  | undefined

/** What a router's module is told when a routed request is over. */
export type RouteOutcomeEvent = ProviderOutcomeEvent

export interface ProviderRouter {
  route(event: RouteEvent, signal: AbortSignal): Promise<RouteAnswer>
  /** An observer: returns at once, and what it returns is unread. */
  outcome?(event: RouteOutcomeEvent): void
}

/**
 * Who served a routed reply, recorded on the reply. `switchedFrom` is present
 * when the call moved off another target, or the target differs from the one
 * that served the session's previous reply.
 */
export type RoutedVia = {
  provider: string
  model: string
  switchedFrom?: { provider: string; model: string; reason: ProviderConnectivityIssue['kind'] }
}

/** A started stream failed and the router chose another target: the call is
 *  sent again at once, to `target`. */
export class RouteSwitchError extends Error {
  readonly target: { provider: string; model: string; effort?: string }
  override readonly cause: unknown

  constructor(target: { provider: string; model: string; effort?: string }, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause))
    this.name = 'RouteSwitchError'
    this.target = target
    this.cause = cause
  }
}

/** The router ended the call: nothing is sent again. */
export class RouteStopError extends Error {
  override readonly cause: unknown

  constructor(cause: unknown, message?: string) {
    super(message ?? (cause instanceof Error ? cause.message : String(cause)))
    this.name = 'RouteStopError'
    this.cause = cause
  }
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

export type ProviderRouterBounds = { readonly routesTo: RoutesTo }

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
