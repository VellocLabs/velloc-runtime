/**
 * Security: provider usage on the runtime protocol. The `providers/usage` topic is `observe` (never a
 * key); `providerUsage.refresh` is `control` (an outbound request with the user's key).
 */
import type { TopicId } from '../runtimeProtocol'
import { wireError } from '../runtimeProtocol'
import type { BrowserBridgeTransport } from '../bridge/browserBridgeProtocol'
import {
  PROVIDER_USAGE_CAPABILITY,
  PROVIDER_USAGE_TOPIC,
} from '../../models/usage/providerUsageState'
import {
  providerUsageState,
  refreshProviderUsage,
  setProviderUsagePublisher,
} from '../../models/drivers/providerUsageService'
import { scopeAllows, type CapabilityRegistry } from './CapabilityRegistry'
import type { TopicBroker } from './TopicBroker'
import type { SnapshotPage, TopicProvider } from './types'

export function registerProviderUsageCapability(
  registry: CapabilityRegistry,
  broker: TopicBroker,
  transport: () => BrowserBridgeTransport | null,
): void {
  setProviderUsagePublisher(state =>
    broker.publish(PROVIDER_USAGE_TOPIC as TopicId, state, { type: 'state' }),
  )
  broker.registerProvider(providerUsageTopicProvider())
  registry.registerCapability({
    cap: PROVIDER_USAGE_CAPABILITY,
    actions: {
      refresh: { scope: 'control' },
    },
    handle: async request => {
      if (request.route.act !== 'refresh') {
        throw wireError('unknown_route', `providerUsage has no action '${request.route.act}'`)
      }
      const payload = (request.payload ?? {}) as { providerId?: unknown; force?: unknown }
      if (typeof payload.providerId !== 'string' || payload.providerId.length === 0) {
        throw wireError('bad_payload', 'providerUsage.refresh: providerId must be a non-empty string')
      }
      const bridge = transport()
      if (!bridge) throw wireError('host_unavailable', 'providerUsage.refresh: no host transport')
      const entry = await refreshProviderUsage(bridge, payload.providerId, {
        force: payload.force === true,
      })
      return entry ?? null
    },
  })
}

function providerUsageTopicProvider(): TopicProvider {
  return {
    matches: (id: TopicId) => id === PROVIDER_USAGE_TOPIC,
    authorize: (_id, conn) => scopeAllows(conn.scope.mode, 'observe'),
    async *snapshot(): AsyncIterable<SnapshotPage> {
      yield { payload: providerUsageState(), type: 'state' }
    },
  }
}
