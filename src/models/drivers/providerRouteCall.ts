/**
 * What the resolution step remembers about one call to a router provider
 * (F-27): how many sends it made, the last one that failed, and who serves it.
 *
 * Contract: kept beside the call's payload object, never in it. A call's
 * retries send the same payload object, so they find the same record; a new
 * call starts a new one. Nothing here is serialized or reaches the host.
 */
import { newRequestLogCallId } from '../usage/requestLogStore'
import { ROUTE_SENDS_PER_TARGET, routeErrorOf, type RouteErrorMark, type RoutedVia, type RouteFailure } from './providerRouter'
import type { RouteTarget } from './providerRouteAnswer'

export type RouteCall = {
  /** The call's id, as a router's module is told it: `logCallId` as text. */
  id: string
  /** The same id as the request log stores it. */
  logCallId: number
  /** Sends made to a target. The next send is attempt `sends + 1`. */
  sends: number
  /** Target answers accepted, the first included. */
  hops: number
  /** The distinct targets among them, each a provider and model pair. */
  targets: Set<string>
  lastFailure?: RouteFailure
  /** The target of the latest send. */
  target?: RouteTarget
  /** The failed target the call last moved off, and that failure's verdict. */
  movedFrom?: NonNullable<RoutedVia['switchedFrom']>
  /** The session's context in tokens when the call began. */
  contextTokens?: number
  /** The target the router chose after a reply broke off; the call's next
   *  send goes there when the router names none at that send. */
  switchTo?: RouteTarget
  /** The router's decision about the call's latest send, while it stands. */
  decided?: RouteErrorMark
  /** The call in the request log: the sends written so far, and the latest
   *  of them with the verdict kind it failed with. */
  logged?: { sends: number; last?: { provider: string; model: string; kind?: string } }
}

const calls = new WeakMap<object, RouteCall>()

export function routeCallOf(payload: object): RouteCall {
  let call = calls.get(payload)
  if (!call) {
    const logCallId = newRequestLogCallId()
    call = { id: String(logCallId), logCallId, sends: 0, hops: 0, targets: new Set() }
    calls.set(payload, call)
  }
  return call
}

/** A copy of a call's payload (the blocking route's) belongs to the same call. */
export function shareRouteCall(copy: object, original: object): void {
  const call = calls.get(original)
  if (call) calls.set(copy, call)
}

/** The identity of a target: its provider and model. */
const targetKey = (target: { provider: string; model: string }): string => JSON.stringify([target.provider, target.model])

const sameTarget = (a: { provider: string; model: string }, b: { provider: string; model: string }): boolean =>
  targetKey(a) === targetKey(b)

/** A target answer was accepted, and with `sent` the request goes to it;
 *  without, it is the target of the call's next send. */
export function acceptRouteTarget(call: RouteCall, target: RouteTarget, sent: boolean): void {
  call.hops += 1
  call.targets.add(targetKey(target))
  if (sent) sendRouteTo(call, target)
  else call.switchTo = target
}

/**
 * Whether the call has taken every target answer it may: as many as
 * `ROUTE_SENDS_PER_TARGET` for each distinct target it was given. Its router
 * is asked no more; what is left of the call is its target's own recovery and
 * the caller's waits.
 */
export function routeHopsUsed(call: RouteCall): boolean {
  return call.hops > 0 && call.hops >= ROUTE_SENDS_PER_TARGET * call.targets.size
}

/** The call's next send goes to `target`. */
export function sendRouteTo(call: RouteCall, target: RouteTarget): void {
  call.switchTo = undefined
  const failed = call.lastFailure
  if (failed && !sameTarget(failed, target)) {
    call.movedFrom = { provider: failed.provider, model: failed.model, reason: failed.verdict.kind }
  }
  call.target = target
  call.sends += 1
}

/**
 * The router's decision about the call's latest send, as the error it stands
 * for; undefined for a call that went through no router or has none. Read by
 * a route whose error crosses as text.
 */
export function routeErrorOfCall(payload: object, cause: Error): Error | undefined {
  const decided = calls.get(payload)?.decided
  return decided ? routeErrorOf(decided, cause) : undefined
}

/**
 * Who served the call's reply, for the reply's record. `previous` is the
 * record of the session's reply before this one, when it was routed.
 * Undefined for a call that went through no router.
 */
export function routedViaOf(payload: object, previous?: RoutedVia): RoutedVia | undefined {
  const call = calls.get(payload)
  const target = call?.target
  if (!call || !target) return undefined
  const via: RoutedVia = { provider: target.provider, model: target.model }
  if (call.movedFrom) return { ...via, switchedFrom: { ...call.movedFrom } }
  if (previous && !sameTarget(previous, target)) {
    return { ...via, switchedFrom: { provider: previous.provider, model: previous.model } }
  }
  return via
}
