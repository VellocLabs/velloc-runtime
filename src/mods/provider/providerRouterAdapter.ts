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
import type { Peer, PeersTableFor } from './nouns/providerPeersTypes'

/**
 * The router for `providerId`. `peersTableFor` is read once per call, on its
 * first ask, and the same table is handed to every later ask of that call.
 */
export function createModProviderRouter(
  runtime: ProviderSeamRuntime,
  providerId: string,
  peersTableFor: PeersTableFor,
): ProviderRouter {
  // A call is one request context object: the resolution step hands the same
  // one to every ask of a call.
  const peersOfCall = new WeakMap<object, readonly Peer[]>()

  const peersFor = (event: RouteEvent): readonly Peer[] => {
    const key = event.requestContext as object
    const held = peersOfCall.get(key)
    if (held && event.attempt > 1) return held
    const peers = peersTableFor(providerId)
    peersOfCall.set(key, peers)
    return peers
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
          attempt: event.attempt,
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
