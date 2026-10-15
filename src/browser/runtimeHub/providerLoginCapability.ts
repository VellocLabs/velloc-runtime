/**
 * Security: provider sign-in on the runtime protocol (`providers/login`, `providerLogin.*`), all
 * `manager`: the actions write a provider's credentials and the topic carries device codes and sign-in
 * URLs. No callback runs in a client; a secret answer goes to the module for that one step and is
 * never published back.
 */
import type { TopicId } from '../runtimeProtocol'
import { wireError } from '../runtimeProtocol'
import {
  PROVIDER_LOGIN_CAPABILITY,
  PROVIDER_LOGIN_TOPIC,
  isLoginId,
  isLoginProviderId,
  type ProviderLoginAnswerPayload,
} from '../../mods/provider/login/loginProtocol'
import { CredentialRefusal, type ProviderCredentials } from '../../mods/provider/login/providerCredentials'
import { scopeAllows, type CapabilityRegistry } from './CapabilityRegistry'
import type { TopicBroker } from './TopicBroker'
import type { SnapshotPage, TopicProvider } from './types'

function refused(error: unknown): never {
  if (error instanceof CredentialRefusal) throw wireError(error.code, error.message)
  throw error
}

export function registerProviderLoginCapability(
  registry: CapabilityRegistry,
  broker: TopicBroker,
  service: ProviderCredentials,
): () => void {
  broker.registerProvider(providerLoginTopicProvider(service))
  const unsubscribe = service.subscribe(state => broker.publish(PROVIDER_LOGIN_TOPIC as TopicId, state, { type: 'state' }))
  registry.registerCapability({
    cap: PROVIDER_LOGIN_CAPABILITY,
    actions: {
      start: { scope: 'manager' },
      answer: { scope: 'manager' },
      cancel: { scope: 'manager' },
      signOut: { scope: 'manager' },
    },
    handle: async request => {
      const payload = (request.payload ?? {}) as Record<string, unknown>
      try {
        switch (request.route.act) {
          case 'start': {
            if (!isLoginProviderId(payload.providerId)) {
              throw wireError('bad_payload', 'providerLogin.start: providerId must be a provider id')
            }
            return service.startLogin(payload.providerId)
          }
          case 'answer':
            // Payload problems are the service's (`answerPayloadProblem`).
            return service.answer(payload as unknown as ProviderLoginAnswerPayload)
          case 'cancel': {
            if (!isLoginId(payload.loginId)) throw wireError('bad_payload', 'providerLogin.cancel: loginId must be a login id')
            service.cancel(payload.loginId)
            return { ok: true }
          }
          case 'signOut': {
            if (!isLoginProviderId(payload.providerId)) {
              throw wireError('bad_payload', 'providerLogin.signOut: providerId must be a provider id')
            }
            await service.signOut(payload.providerId)
            return { ok: true }
          }
          default:
            throw wireError('unknown_route', `providerLogin has no action '${request.route.act}'`)
        }
      } catch (error) {
        return refused(error)
      }
    },
  })
  return unsubscribe
}

function providerLoginTopicProvider(service: ProviderCredentials): TopicProvider {
  return {
    matches: (id: TopicId) => id === PROVIDER_LOGIN_TOPIC,
    authorize: (_id, conn) => scopeAllows(conn.scope.mode, 'manager'),
    async *snapshot(): AsyncIterable<SnapshotPage> {
      yield { payload: service.state(), type: 'state' }
    },
  }
}
