/**
 * Security: provider status views on the runtime protocol (F-27). The
 * `providers/status` topic is `observe`: shaped, clamped values a module chose
 * to show, never a credential. `providerStatus.refresh` is `control` (it has
 * the runtime read the plugin's store again) and so is `providerStatus.runJob`
 * (it runs the provider's module, which may send a request with the user's
 * key). A client names a provider and a job; the runtime checks both against
 * the provider's manifest.
 */
import type { TopicId } from '../runtimeProtocol'
import { wireError } from '../runtimeProtocol'
import { onModStoreChange } from '../../mods/modStore'
import {
  PROVIDER_STATUS_CAPABILITY,
  PROVIDER_STATUS_TOPIC,
  type ProviderStatusRunJobResult,
} from '../../mods/provider/providerStatusState'
import {
  ProviderStatusActionError,
  noteProviderStoreChange,
  currentProviderStatus,
  refreshProviderStatus,
  runProviderStatusJob,
  setProviderStatusPublisher,
} from '../../mods/provider/providerStatusService'
import { scopeAllows, type CapabilityRegistry } from './CapabilityRegistry'
import type { TopicBroker } from './TopicBroker'
import type { SnapshotPage, TopicProvider } from './types'

const ID_MAX = 128

function idOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= ID_MAX ? value : undefined
}

export function registerProviderStatusCapability(registry: CapabilityRegistry, broker: TopicBroker): void {
  setProviderStatusPublisher(state => broker.publish(PROVIDER_STATUS_TOPIC as TopicId, state, { type: 'state' }))
  onModStoreChange(noteProviderStoreChange)
  broker.registerProvider(providerStatusTopicProvider())
  registry.registerCapability({
    cap: PROVIDER_STATUS_CAPABILITY,
    actions: {
      refresh: { scope: 'control' },
      runJob: { scope: 'control' },
    },
    handle: async request => {
      const act = request.route.act
      if (act !== 'refresh' && act !== 'runJob') {
        throw wireError('unknown_route', `providerStatus has no action '${act}'`)
      }
      const payload = (request.payload ?? {}) as { providerId?: unknown; job?: unknown }
      const providerId = idOf(payload.providerId)
      if (providerId === undefined) {
        throw wireError('bad_payload', `providerStatus.${act}: providerId must be a non-empty string`)
      }
      if (act === 'refresh') return (await refreshProviderStatus(providerId)) ?? null
      const job = idOf(payload.job)
      if (job === undefined) throw wireError('bad_payload', 'providerStatus.runJob: job must be a non-empty string')
      try {
        const result: ProviderStatusRunJobResult = { outcome: await runProviderStatusJob(providerId, job) }
        return result
      } catch (error) {
        if (error instanceof ProviderStatusActionError) throw wireError('bad_payload', `providerStatus.runJob: ${error.message}`)
        throw error
      }
    },
  })
}

function providerStatusTopicProvider(): TopicProvider {
  return {
    matches: (id: TopicId) => id === PROVIDER_STATUS_TOPIC,
    authorize: (_id, conn) => scopeAllows(conn.scope.mode, 'observe'),
    async *snapshot(): AsyncIterable<SnapshotPage> {
      yield { payload: await currentProviderStatus(), type: 'state' }
    },
  }
}
