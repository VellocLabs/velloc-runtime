/**
 * Contract: the resolution step for a router provider (F-27). One call's
 * request is put to the provider's router, the answer is checked, and the
 * request goes on as the target's own. Above this step the request is the
 * router's (its provider id, its model row); below it the target's (spec,
 * `ModelProvider`, seam, pool, id mapper). The first send of a call needs a usable answer and fails closed
 * without one. After a failed send, no usable answer leaves the failure to
 * the target's own recovery and the caller's retries, and a retry of the call
 * stays on the target it was last sent to.
 *
 * Security: the router's answer is untrusted and checked on every ask
 * (providerRouteAnswer.ts). A target's `provider` is an opaque instance id.
 */
import type {
  BridgeModelRequestContext,
  BridgeModelRequestPayload,
  BrowserBridgeTransport,
} from '../../browser/bridge/browserBridgeProtocol'
import { entryId } from '../../config/nexusModelConfig/modelEntries'
import { resolveModelId } from '../../config/nexusModelConfig/modelEntryResolution'
import { findConfiguredModel } from '../../config/nexusModelConfig/findConfiguredModel'
import { getProviderDefinition } from '../../config/nexusModelConfig/providers'
import { THINKING_TIER_ORDER } from '../../config/nexusModelConfig/providers/shared/listing'
import { buildThinkingBodyExtension } from '../../config/nexusModelConfig/thinkingTierParams'
import type { RuntimeConfig } from '../../runtime/interfaces/RuntimeConfig'
import { traceLine } from '../../utils/debugLog'
import { resolveProviderSpec } from './driverRegistry'
import type { ProviderSpec } from './driverTypes'
import { ProviderConfigError, type ModelProvider } from './modelProvider'
import { verdictOfFailure, type FailureEvent } from './providerClassify'
import { recordProviderVerdict } from './providerHealthLedger'
import { OUTCOME_CALL_FIELD } from './providerOutcome'
import { thinkingTierOf } from './providerRequestSeam'
import { checkRouteAnswer, type CheckedRouteAnswer, type RouteAnswerFacts, type RouteTarget } from './providerRouteAnswer'
import { acceptRouteTarget, routeCallOf, sendRouteTo, type RouteCall } from './providerRouteCall'
import {
  providerRouterFor,
  ROUTE_HOPS_MAX,
  type ProviderRouter,
  type ProviderRouterBounds,
  type RouteEvent,
  type RouteFailure,
} from './providerRouter'
import type { RouteDecision, RouteLeg, RoutedSend, StreamRouting } from './routedStream'
import type { RequestLogRow } from '../usage/requestLogStore'
import { recordRequest } from '../usage/requestLogWriter'
import { isProviderSetUp, mergedModels, providerEntries } from './runtimeProviders'

const NO_REQUEST_CONTEXT: BridgeModelRequestContext = { purpose: 'other', querySource: '' }

// One object per call: a router may key what it keeps about a call on it.
const contextOfCall = new WeakMap<object, BridgeModelRequestContext>()
function requestContextOf(call: object, payload: BridgeModelRequestPayload): BridgeModelRequestContext {
  if (payload.requestContext) return payload.requestContext
  let context = contextOfCall.get(call)
  if (!context) {
    context = { ...NO_REQUEST_CONTEXT }
    contextOfCall.set(call, context)
  }
  return context
}

export type RouteResolutionDeps = {
  runtimeConfig?: RuntimeConfig
  providerFor(spec: ProviderSpec): ModelProvider
  /** The bridge the call came on; its request-log rows are written through it. */
  logVia?: BrowserBridgeTransport
}

function knownModel(provider: string, model: string): boolean {
  return mergedModels(provider).some(listed => listed.id === model)
    || providerEntries(provider).some(entry => entry.id === model || entryId(entry) === model)
}

/** A router is never a target: one is plugged in for the id, or its
 *  definition says so. */
function isRouter(provider: string): boolean {
  return providerRouterFor(provider) !== undefined || getProviderDefinition(provider)?.router === true
}

/**
 * The tier a target is sent: `tier` when the target lists it or lists none,
 * else the listed tier nearest it in the runtime's order, the lower on a tie.
 */
export function tierForTarget(tier: string | undefined, listed: readonly string[] | undefined): string | undefined {
  if (!tier || !listed || listed.length === 0 || listed.includes(tier)) return tier
  const order = THINKING_TIER_ORDER as readonly string[]
  const at = order.indexOf(tier)
  if (at < 0) return undefined
  let best: string | undefined
  let bestDistance = Infinity
  for (const candidate of order) {
    if (!listed.includes(candidate)) continue
    const distance = Math.abs(order.indexOf(candidate) - at)
    if (distance < bestDistance) {
      best = candidate
      bestDistance = distance
    }
  }
  return best
}

/** The tiers the picker offers for a target: its catalog row's, else its listing's. */
function listedTiers(provider: string, model: string): readonly string[] | undefined {
  return findConfiguredModel(provider, model)?.availableThinkingTiers
    ?? mergedModels(provider).find(listed => listed.id === model)?.thinkingTiers
}

/** What a reader shows for a member: its name, the tiers it offers and the one it starts at. */
export function routeMemberFacts(provider: string, model: string): { label?: string; tiers?: string[]; defaultTier?: string } {
  const row = findConfiguredModel(provider, model)
  const listed = mergedModels(provider).find(each => each.id === model)
  const tiers = listedTiers(provider, model)
  const defaultTier = row?.defaultThinkingTier ?? listed?.defaultThinkingTier
  return {
    ...(listed?.name ? { label: listed.name } : {}),
    ...(tiers && tiers.length > 0 ? { tiers: [...tiers] } : {}),
    ...(defaultTier ? { defaultTier } : {}),
  }
}

const text = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * The request-log row of one send of a routed call. The sends of a call share
 * the call's id, the one its route events carry, and count their hops from 1;
 * a send to another target than the
 * one before it names that target and the verdict kind that moved the call.
 */
export function logRowOf(
  routerId: string,
  rowModel: string,
  sessionId: string | undefined,
  call: RouteCall,
  send: RoutedSend,
): RequestLogRow {
  const logged = (call.logged ??= { sends: 0 })
  logged.sends += 1
  const before = logged.last
  const moved = before && (before.provider !== send.target.provider || before.model !== send.model)
  const verdict = send.failure ? verdictOfFailure(send.failure) : null
  const failureKind = send.outcome === 'failed' ? (verdict?.kind ?? 'error') : undefined
  logged.last = { provider: send.target.provider, model: send.model, ...(failureKind ? { kind: failureKind } : {}) }
  const httpStatus = send.failure?.httpStatus ?? verdict?.status
  return {
    startedMs: send.startedMs,
    durationMs: send.durationMs,
    ...(sessionId ? { sessionId } : {}),
    callId: call.logCallId,
    hop: logged.sends,
    provider: send.target.provider,
    model: send.model,
    router: { provider: routerId, row: rowModel },
    ...(moved ? { switchedFrom: { provider: before.provider, model: before.model, kind: before.kind ?? 'error' } } : {}),
    usage: send.usage,
    outcome: send.outcome,
    ...(failureKind ? { failureKind } : {}),
    ...(send.outcome === 'failed' && httpStatus !== undefined ? { httpStatus } : {}),
  }
}

/** The routing of one call to the router provider `routerId`. */
export function routeCall(
  routerId: string,
  router: ProviderRouter,
  bounds: ProviderRouterBounds,
  payload: BridgeModelRequestPayload,
  deps: RouteResolutionDeps,
): StreamRouting {
  const call = routeCallOf(payload)
  const rowModel = payload.model ?? ''
  const facts: RouteAnswerFacts = {
    routesTo: bounds.routesTo,
    isSetUp: isProviderSetUp,
    isRouter,
    // One instance per definition: an instance's definition is its own id.
    definitionOf: provider => provider,
    serves: (provider, model) =>
      resolveProviderSpec(provider, deps.runtimeConfig, resolveModelId(provider, model)) !== undefined,
    knownModel,
  }

  const event = (): RouteEvent => ({
    model: rowModel,
    requestContext: requestContextOf(call, payload),
    callId: call.id,
    attempt: call.sends + 1,
    request: { tools: (payload.tools?.length ?? 0) > 0 },
    ...(call.lastFailure ? { lastFailure: call.lastFailure } : {}),
    ...(call.contextTokens !== undefined ? { usage: { contextTokens: call.contextTokens } } : {}),
  })

  /** The router's checked answer; a hook that throws is a refusal. */
  async function ask(signal: AbortSignal): Promise<CheckedRouteAnswer> {
    if (call.hops >= ROUTE_HOPS_MAX) {
      return { kind: 'refused', reason: `the call was already routed ${ROUTE_HOPS_MAX} times` }
    }
    try {
      return checkRouteAnswer(await router.route(event(), signal), facts)
    } catch (error) {
      return { kind: 'refused', reason: `the hook failed: ${text(error)}` }
    }
  }

  function legFor(target: RouteTarget): RouteLeg {
    const model = resolveModelId(target.provider, target.model)
    const spec = resolveProviderSpec(target.provider, deps.runtimeConfig, model)
    if (!spec) throw new ProviderConfigError(`no runtime driver serves the provider ${target.provider}`)
    // The tier the call asked for is written by the target's own mapper. The
    // caller's open outcome call is the router's, so each target's stream
    // tells its own provider how its request ended.
    const { [OUTCOME_CALL_FIELD]: _call, providerBodyExtension: _extension, ...rest } =
      payload as BridgeModelRequestPayload & Record<string, unknown>
    const tier = tierForTarget(target.effort ?? thinkingTierOf(payload), listedTiers(target.provider, model))
    const extension = buildThinkingBodyExtension(target.provider, tier, payload.maxOutputTokens ?? 0, model)
    const sent = {
      ...rest,
      providerId: target.provider,
      model,
      ...(tier ? { thinkingTier: tier } : {}),
      ...(extension ? { providerBodyExtension: extension } : {}),
    } as BridgeModelRequestPayload
    return { target, provider: deps.providerFor(spec), payload: sent, model }
  }

  function failureOf(failure: FailureEvent, streamStarted: boolean): RouteFailure | undefined {
    const target = call.target
    const verdict = verdictOfFailure(failure)
    if (!target || !verdict) return undefined
    const retryAfterMs = failure.retryAfterSeconds !== undefined && failure.retryAfterSeconds >= 0
      ? failure.retryAfterSeconds * 1000
      : verdict.retryAfterMs
    return {
      provider: target.provider,
      model: target.model,
      ...(failure.httpStatus !== undefined ? { status: failure.httpStatus } : {}),
      verdict,
      message: failure.message ?? '',
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      streamStarted,
    }
  }

  return {
    model: rowModel,
    async resolve(signal) {
      call.decided = undefined
      const answer = await ask(signal)
      if (answer.kind === 'stop') {
        call.switchTo = undefined
        call.decided = { stop: true, ...(answer.message !== undefined ? { message: answer.message } : {}) }
        return { stop: answer.message !== undefined ? { message: answer.message } : {} }
      }
      if (answer.kind === 'target') {
        acceptRouteTarget(call, answer.target, true)
        return { leg: legFor(answer.target) }
      }
      const reason = answer.kind === 'refused' ? `its answer was refused: ${answer.reason}` : 'it named no target'
      // A send after a broken reply goes where the router moved it.
      const switched = call.switchTo
      if (switched) {
        traceLine(`[providers] ${routerId}: provider.route was not applied (${reason}); the call goes to ${switched.provider}, chosen at the failure`, { level: 'warn' })
        sendRouteTo(call, switched)
        return { leg: legFor(switched) }
      }
      // A retry of a call that was already sent stays where it was.
      if (call.target && call.sends > 0) {
        traceLine(`[providers] ${routerId}: provider.route was not applied (${reason}); the call stays on ${call.target.provider}`, { level: 'warn' })
        call.sends += 1
        return { leg: legFor(call.target) }
      }
      call.decided = { stop: true }
      throw new ProviderConfigError(`provider.route of ${routerId}: ${reason}; the request was not sent`)
    },
    async after(failure, streamStarted, signal): Promise<RouteDecision> {
      const failed = failureOf(failure, streamStarted)
      // A failure nothing classifies is not put to the router.
      if (!failed) return { kind: 'none' }
      call.lastFailure = failed
      recordProviderVerdict(failed.provider, failed.model, failed.verdict, Date.now())
      const answer = await ask(signal)
      if (answer.kind === 'stop') {
        call.decided = { stop: true, ...(answer.message !== undefined ? { message: answer.message } : {}) }
        return { kind: 'stop', ...(answer.message !== undefined ? { message: answer.message } : {}) }
      }
      if (answer.kind === 'target') {
        // Once a reply has started the call is sent again by its caller, and
        // that send is resolved, and counted, on its own.
        acceptRouteTarget(call, answer.target, !streamStarted)
        if (streamStarted) call.decided = { switch: { ...answer.target } }
        return { kind: 'switch', leg: legFor(answer.target) }
      }
      if (answer.kind === 'refused') {
        traceLine(`[providers] ${routerId}: provider.route was not applied after a failure (${answer.reason})`, { level: 'warn' })
      }
      return { kind: 'none' }
    },
    sent(send) {
      recordRequest(logRowOf(routerId, rowModel, payload.requestContext?.sessionId, call, send), deps.logVia)
    },
    ended(ending) {
      if (!router.outcome || !ending.target) return
      const verdict = ending.failure ? verdictOfFailure(ending.failure) : null
      router.outcome({
        provider: routerId,
        model: rowModel,
        callId: call.id,
        target: { provider: ending.target.provider, model: ending.target.model },
        ok: ending.ok,
        ...(ending.failure?.httpStatus !== undefined ? { status: ending.failure.httpStatus } : {}),
        ...(verdict ? { verdict } : {}),
        ...(ending.usage ? { usage: ending.usage } : {}),
        attempts: call.sends,
        durationMs: ending.durationMs,
      })
    },
  }
}
