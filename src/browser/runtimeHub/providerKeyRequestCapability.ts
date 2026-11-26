/**
 * Security: the platform's key requests on the runtime protocol
 * (`providers/keyRequests`, `providerKeyRequest.*`), all `manager`: the
 * answer writes a provider's credential. The key rides the answer action to
 * the runtime's own store step and is never published back.
 */
import type { TopicId } from '../runtimeProtocol'
import { wireError } from '../runtimeProtocol'
import {
  PROVIDER_KEY_REQUEST_CAPABILITY,
  PROVIDER_KEY_REQUEST_TOPIC,
  isKeyRequestId,
  readRequestedKey,
} from '../../mods/provider/keyRequest/keyRequestProtocol'
import type { ProviderKeyRequests } from '../../mods/provider/keyRequest/providerKeyRequests'
import { scopeAllows, type CapabilityRegistry } from './CapabilityRegistry'
import type { TopicBroker } from './TopicBroker'
import type { SnapshotPage, TopicProvider } from './types'

export function registerProviderKeyRequestCapability(
  registry: CapabilityRegistry,
  broker: TopicBroker,
  service: ProviderKeyRequests,
): () => void {
  broker.registerProvider(topicProvider(service))
  const unsubscribe = service.subscribe(state => broker.publish(PROVIDER_KEY_REQUEST_TOPIC as TopicId, state, { type: 'state' }))
  registry.registerCapability({
    cap: PROVIDER_KEY_REQUEST_CAPABILITY,
    actions: {
      answer: { scope: 'manager' },
      cancel: { scope: 'manager' },
    },
    handle: async request => {
      const payload = (request.payload ?? {}) as Record<string, unknown>
      if (!isKeyRequestId(payload.requestId)) {
        throw wireError('bad_payload', `providerKeyRequest.${request.route.act}: requestId must be a request id`)
      }
      switch (request.route.act) {
        case 'answer': {
          const key = readRequestedKey(payload.key)
          if (key === undefined) throw wireError('bad_payload', 'providerKeyRequest.answer: key must be a non-empty text')
          return { accepted: service.answer(payload.requestId, key) }
        }
        case 'cancel':
          service.cancel(payload.requestId)
          return { ok: true }
        default:
          throw wireError('unknown_route', `providerKeyRequest has no action '${request.route.act}'`)
      }
    },
  })
  return unsubscribe
}

function topicProvider(service: ProviderKeyRequests): TopicProvider {
  return {
    matches: (id: TopicId) => id === PROVIDER_KEY_REQUEST_TOPIC,
    authorize: (_id, conn) => scopeAllows(conn.scope.mode, 'manager'),
    async *snapshot(): AsyncIterable<SnapshotPage> {
      yield { payload: service.state(), type: 'state' }
    },
  }
}
