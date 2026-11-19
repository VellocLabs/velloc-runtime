/**
 * Contract: the `ProviderRouter` of a router provider whose module is a
 * provider mod (F-27). `route` raises `provider.route` in the module that owns
 * the provider and hands back its answer as given: the answer is untrusted,
 * and checking it is the resolution step's. `outcome` raises
 * `provider.outcome` and is never awaited.
 *
 * Security: on the first send of a call (attempt 1, no failure yet) a module
 * that cannot start, throws, overruns or names nothing rejects with an error
 * naming the hook, so the request is not sent: a router never lets a request
 * go out unrouted. After a failure the same cases are "no answer".
 */
import type { ProviderRouter, RouteAnswer, RouteEvent, RouteOutcomeEvent } from '../../models/drivers/providerRouter'
import type { ProviderSeamRuntime } from './providerSeamAdapter'
import type { Peer, PeersTableFor } from './nouns/providerPeersTypes'

/** The error a first send fails closed with. */
export class ProviderRouteHookError extends Error {
  constructor(
    readonly providerId: string,
    reason: string,
  ) {
    super(`The provider.route hook of the provider ${providerId} failed, so the request was not sent: ${reason}`)
    this.name = 'ProviderRouteHookError'
  }
}

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

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
      if (answer === undefined || answer === null) {
        if (firstSend) throw new ProviderRouteHookError(providerId, 'it named no target')
        return undefined
      }
      return answer
    } catch (error) {
      if (signal.aborted) throw error
      if (firstSend) {
        throw error instanceof ProviderRouteHookError ? error : new ProviderRouteHookError(providerId, reasonOf(error))
      }
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
