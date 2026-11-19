/**
 * What the resolution step remembers about one call to a router provider
 * (F-27): how many sends it made, the last one that failed, and who serves it.
 *
 * Contract: kept beside the call's payload object, never in it. A call's
 * retries send the same payload object, so they find the same record; a new
 * call starts a new one. Nothing here is serialized or reaches the host.
 */
import type { RoutedVia, RouteFailure } from './providerRouter'
import type { RouteTarget } from './providerRouteAnswer'

export type RouteCall = {
  /** Sends made to a target. The next send is attempt `sends + 1`. */
  sends: number
  /** Target answers accepted, the first included. */
  hops: number
  lastFailure?: RouteFailure
  /** The target of the latest send. */
  target?: RouteTarget
  /** The failed target the call last moved off, and that failure's verdict. */
  movedFrom?: NonNullable<RoutedVia['switchedFrom']>
  /** The session's context in tokens when the call began. */
  contextTokens?: number
}

const calls = new WeakMap<object, RouteCall>()

export function routeCallOf(payload: object): RouteCall {
  let call = calls.get(payload)
  if (!call) {
    call = { sends: 0, hops: 0 }
    calls.set(payload, call)
  }
  return call
}

/** A copy of a call's payload (the blocking route's) belongs to the same call. */
export function shareRouteCall(copy: object, original: object): void {
  const call = calls.get(original)
  if (call) calls.set(copy, call)
}

const sameTarget = (a: { provider: string; model: string }, b: { provider: string; model: string }): boolean =>
  a.provider === b.provider && a.model === b.model

/** A target answer was accepted, and with `sent` the request goes to it. */
export function acceptRouteTarget(call: RouteCall, target: RouteTarget, sent: boolean): void {
  call.hops += 1
  if (!sent) return
  const failed = call.lastFailure
  if (failed && !sameTarget(failed, target)) {
    call.movedFrom = { provider: failed.provider, model: failed.model, reason: failed.verdict.kind }
  }
  call.target = target
  call.sends += 1
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
