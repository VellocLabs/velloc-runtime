/**
 * Contract: the `ProviderRouter` of a router provider whose module is a
 * provider mod (F-27). `route` raises `provider.route` in the module that owns
 * the provider and hands back its answer as given: the answer is untrusted,
 * and checking it is the resolution step's. `outcome` raises
 * `provider.outcome` and is never awaited.
 *
 * Security: on the first send of a call (attempt 1, no failure yet) a module
 * that cannot start, throws or overruns rejects with the runtime's error, and
 * an answer of nothing is `undefined`; the resolution step ends either one
 * unsent, naming `provider.route`. After a failure the same cases are
 * `undefined`, "no answer".
 */
import type { ProviderRouter, RouteAnswer, RouteEvent, RouteOutcomeEvent } from '../../models/drivers/providerRouter'
import type { ProviderSeamRuntime } from './providerSeamAdapter'
import { providerStateOf } from '../../models/drivers/providerHealthLedger'
import type { Peer, PeersTableFor, ProviderState } from './nouns/providerPeersTypes'

type CallPeers = { table: readonly Peer[]; failed: Set<string> }

/** The table as `provider.route` gets it: a brand mark is for drawing, never for a routing choice. */
function withoutIcons(table: readonly Peer[]): Peer[] {
  return table.map(peer => {
    if (peer.icon === undefined) return peer
    const { icon: _icon, ...rest } = peer
    return rest
  })
}

/**
 * The router for `providerId`. `peersTableFor` is read once per call, on its
 * first ask, and that table is handed to every later ask of the call, with
 * the `state` of each member that failed earlier in the call read again from
 * `stateOf`. Another call's table is never touched.
 */
export function createModProviderRouter(
  runtime: ProviderSeamRuntime,
  providerId: string,
  peersTableFor: PeersTableFor,
  stateOf: (instanceId: string, nowMs: number) => ProviderState = providerStateOf,
): ProviderRouter {
  // A call is one request context object: the resolution step hands the same
  // one to every ask of a call.
  const peersOfCall = new WeakMap<object, CallPeers>()

  const peersFor = (event: RouteEvent): readonly Peer[] => {
    const key = event.requestContext as object
    const held = peersOfCall.get(key)
    if (!held || event.attempt === 1) {
      const table = withoutIcons(peersTableFor(providerId))
      peersOfCall.set(key, { table, failed: new Set() })
      return table
    }
    if (event.lastFailure) held.failed.add(event.lastFailure.provider)
    if (held.failed.size === 0) return held.table
    const nowMs = Date.now()
    return held.table.map(peer => (held.failed.has(peer.id) ? { ...peer, state: stateOf(peer.id, nowMs) } : peer))
  }

  async function route(event: RouteEvent, signal: AbortSignal): Promise<RouteAnswer> {
    const firstSend = event.attempt === 1 && event.lastFailure === undefined
    try {
      // A cold start is paid before the hook's own budget starts.
      await runtime.whenLoaded(providerId, signal)
      const outcome = await runtime.call<RouteAnswer>(
        providerId,
        'provider.route',
        {
          model: event.model,
          requestContext: event.requestContext,
          callId: event.callId,
          attempt: event.attempt,
          request: event.request,
          ...(event.lastFailure ? { lastFailure: event.lastFailure } : {}),
          ...(event.usage ? { usage: event.usage } : {}),
          peers: peersFor(event),
        },
        { signal },
      )
      const answer = outcome.raised ? outcome.value : undefined
      return answer === null ? undefined : answer
    } catch (error) {
      if (signal.aborted || firstSend) throw error
      return undefined
    }
  }

  // Raised only once the module is known to hook it: an observer never starts a worker.
  function outcome(event: RouteOutcomeEvent): void {
    if (runtime.hasHook(providerId, 'provider.outcome') !== true) return
    runtime
      .call<void>(providerId, 'provider.outcome', event as unknown as Record<string, unknown>, { core: () => undefined })
      .catch(() => undefined)
  }

  return { route, outcome }
}
