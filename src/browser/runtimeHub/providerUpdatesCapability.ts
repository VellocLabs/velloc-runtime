/**
 * Provider mod updates on the runtime protocol; shapes and scopes in
 * `pluginHost/providerUpdatesProtocol.ts`. The runtime does the work; a client sends only a plugin id and a version.
 */
import { wireError, type TopicId } from '../runtimeProtocol'
import {
  PROVIDER_UPDATES_ACTION_SCOPES,
  PROVIDER_UPDATES_CAPABILITY,
  PROVIDER_UPDATES_EVENT,
  PROVIDER_UPDATES_TOPIC,
  isProviderUpdatesCheckPayload,
  isProviderUpdatesPluginPayload,
  isProviderUpdatesVersionPayload,
  type ProviderUpdatesCheckPayload,
  type ProviderUpdatesPluginPayload,
  type ProviderUpdatesState,
  type ProviderUpdatesVersionPayload,
} from '../../pluginHost/providerUpdatesProtocol'
import {
  acquireProviderModUpdateService,
  onProviderModUpdatesChanged,
} from '../../pluginHost/providerModUpdateHolder'
import type { ProviderModUpdateService } from '../../pluginHost/providerModUpdates'
import { scopeAllows, type CapabilityRegistry } from './CapabilityRegistry'
import type { TopicBroker } from './TopicBroker'
import type { SnapshotPage, TopicProvider } from './types'

export type ProviderUpdatesCapabilityOptions = {
  /** Default: the realm's holder (`providerModUpdateHolder.ts`). */
  acquire?: () => Promise<ProviderModUpdateService | null>
  /** Default: the holder's change feed. */
  onChanged?: (listener: () => void) => () => void
  report?: (line: string) => void
}

export function registerProviderUpdatesCapability(
  registry: CapabilityRegistry,
  broker: TopicBroker,
  options: ProviderUpdatesCapabilityOptions = {},
): { publish(): Promise<void>; dispose(): void } {
  const acquire = options.acquire ?? acquireProviderModUpdateService
  const report = options.report ?? (line => console.warn(`[provider-mod-updates] ${line}`))

  const state = async (): Promise<ProviderUpdatesState> => {
    try {
      const service = await acquire()
      return { plugins: service ? await service.status() : [] }
    } catch (error) {
      report(`the status could not be read: ${error instanceof Error ? error.message : String(error)}`)
      return { plugins: [] }
    }
  }
  const service = async (): Promise<ProviderModUpdateService> => {
    const found = await acquire()
    if (!found) throw wireError('host_unavailable', 'providerUpdates: no provider mod is installed')
    return found
  }

  const provider: TopicProvider = {
    matches: (id: TopicId) => id === PROVIDER_UPDATES_TOPIC,
    authorize: (_id, conn) => scopeAllows(conn.scope.mode, 'observe'),
    async *snapshot(): AsyncIterable<SnapshotPage> {
      yield { type: PROVIDER_UPDATES_EVENT, payload: await state() }
    },
  }
  broker.registerProvider(provider)

  registry.registerCapability({
    cap: PROVIDER_UPDATES_CAPABILITY,
    actions: {
      check: { scope: PROVIDER_UPDATES_ACTION_SCOPES.check, guard: isProviderUpdatesCheckPayload },
      consent: { scope: PROVIDER_UPDATES_ACTION_SCOPES.consent, guard: isProviderUpdatesVersionPayload },
      decline: { scope: PROVIDER_UPDATES_ACTION_SCOPES.decline, guard: isProviderUpdatesVersionPayload },
      rollback: { scope: PROVIDER_UPDATES_ACTION_SCOPES.rollback, guard: isProviderUpdatesPluginPayload },
      baseline: { scope: PROVIDER_UPDATES_ACTION_SCOPES.baseline, guard: isProviderUpdatesPluginPayload },
    },
    handle: async request => {
      const act = request.route.act
      const payload = (request.payload ?? {}) as Record<string, string | undefined>
      try {
        switch (act) {
          case 'check': {
            const { pluginId } = payload as ProviderUpdatesCheckPayload
            const found = await service()
            return { plugins: await found.checkNow(pluginId) } satisfies ProviderUpdatesState
          }
          case 'consent': {
            const { pluginId, version } = payload as ProviderUpdatesVersionPayload
            return { status: await (await service()).recordConsent(pluginId, version) }
          }
          case 'decline': {
            const { pluginId, version } = payload as ProviderUpdatesVersionPayload
            return { status: await (await service()).decline(pluginId, version) }
          }
          case 'rollback': {
            const { pluginId } = payload as ProviderUpdatesPluginPayload
            return { status: await (await service()).rollback(pluginId) }
          }
          case 'baseline': {
            const { pluginId } = payload as ProviderUpdatesPluginPayload
            return { status: await (await service()).recordInitialConsent(pluginId) }
          }
          default:
            throw wireError('unknown_route', `providerUpdates has no action '${act}'`)
        }
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && 'retryable' in error) throw error
        // A call that cannot apply (nothing parked, nothing to roll back, not
        // an installed provider mod): the person sees the service's own words.
        throw wireError('conflict', error instanceof Error ? error.message : String(error))
      }
    },
  })

  const publish = async (): Promise<void> => {
    // Nobody is reading: a later subscriber's snapshot reads afresh.
    if (broker.subscribersOf(PROVIDER_UPDATES_TOPIC as TopicId).length === 0) return
    broker.publish(PROVIDER_UPDATES_TOPIC as TopicId, await state(), { type: PROVIDER_UPDATES_EVENT })
  }
  const unsubscribe = (options.onChanged ?? onProviderModUpdatesChanged)(() => {
    void publish()
  })
  return { publish, dispose: unsubscribe }
}
