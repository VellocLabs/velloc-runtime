/**
 * The Customize page on the runtime protocol: topic `customizePage/status` and
 * `customizePage.show` / `customizePage.navigate`; shapes and scopes in
 * `customize/customizePageProtocol.ts` (F-35). The tab and its page channel
 * are the runtime's: every host call goes over the runtime's own port.
 */
import { wireError, type TopicId, type WireError } from '../runtimeProtocol'
import {
  CUSTOMIZE_PAGE_ACTION_SCOPES,
  CUSTOMIZE_PAGE_CAPABILITY,
  CUSTOMIZE_PAGE_STATUS_EVENT,
  CUSTOMIZE_PAGE_STATUS_TOPIC,
  CUSTOMIZE_PAGE_TOPIC_SCOPE,
  isCustomizePageUrlPayload,
} from '../../customize/customizePageProtocol'
import { CustomizePageError, type CustomizePageService } from '../../customize/CustomizePageService'
import { scopeAllows, type CapabilityRegistry } from './CapabilityRegistry'
import type { TopicBroker } from './TopicBroker'
import type { SnapshotPage, TopicProvider } from './types'

function asWireError(error: unknown): WireError {
  if (error instanceof CustomizePageError) {
    return wireError(error.code === 'not_shown' ? 'conflict' : 'host_unavailable', `customizePage: ${error.message}`)
  }
  return wireError('host_unavailable', `customizePage: ${error instanceof Error ? error.message : String(error)}`)
}

export function registerCustomizePageCapability(
  registry: CapabilityRegistry,
  broker: TopicBroker,
  service: CustomizePageService,
): { dispose(): void } {
  const provider: TopicProvider = {
    matches: (id: TopicId) => id === CUSTOMIZE_PAGE_STATUS_TOPIC,
    authorize: (_id, conn) => scopeAllows(conn.scope.mode, CUSTOMIZE_PAGE_TOPIC_SCOPE),
    async *snapshot(): AsyncIterable<SnapshotPage> {
      yield { type: CUSTOMIZE_PAGE_STATUS_EVENT, payload: service.getState() }
    },
  }
  broker.registerProvider(provider)

  const unwatch = service.onStateChange(() => {
    if (broker.subscribersOf(CUSTOMIZE_PAGE_STATUS_TOPIC as TopicId).length === 0) return
    broker.publish(CUSTOMIZE_PAGE_STATUS_TOPIC as TopicId, service.getState(), { type: CUSTOMIZE_PAGE_STATUS_EVENT })
  })

  registry.registerCapability({
    cap: CUSTOMIZE_PAGE_CAPABILITY,
    actions: {
      show: { scope: CUSTOMIZE_PAGE_ACTION_SCOPES.show, guard: isCustomizePageUrlPayload },
      navigate: { scope: CUSTOMIZE_PAGE_ACTION_SCOPES.navigate, guard: isCustomizePageUrlPayload },
    },
    handle: async request => {
      const { url } = request.payload as { url: string }
      try {
        if (request.route.act === 'show') return await service.show(url)
        if (request.route.act === 'navigate') {
          await service.navigate(url)
          return { ok: true }
        }
      } catch (error) {
        throw asWireError(error)
      }
      throw wireError('unknown_route', `customizePage has no action '${request.route.act}'`)
    },
  })

  return {
    dispose() {
      unwatch()
      service.dispose()
    },
  }
}
