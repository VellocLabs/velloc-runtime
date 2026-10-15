/**
 * Model catalog on the runtime protocol: the `catalog/status` topic and `catalog.refresh`; shapes and
 * scope in `catalog/catalogProtocol.ts`. The runtime fetches through its own transport (P-3).
 */
import { wireError, type TopicId } from '../runtimeProtocol'
import {
  CATALOG_ACTION_SCOPES,
  CATALOG_CAPABILITY,
  CATALOG_STATUS_EVENT,
  CATALOG_STATUS_TOPIC,
  isCatalogRefreshPayload,
  type CatalogStatusState,
} from '../../catalog/catalogProtocol'
import { acquireModelCatalog, onModelCatalogSourceChanged } from '../../catalog/modelCatalogHolder'
import type { ModelCatalog } from '../../catalog/modelCatalog'
import { scopeAllows, type CapabilityRegistry } from './CapabilityRegistry'
import type { TopicBroker } from './TopicBroker'
import type { SnapshotPage, TopicProvider } from './types'

export type CatalogCapabilityOptions = {
  /** Default: the holder's getter. */
  getService?: () => Promise<ModelCatalog | undefined>
  /** Default: the holder's change feed. */
  onSourceChanged?: (listener: () => void) => () => void
  report?: (line: string) => void
}

export function registerCatalogCapability(
  registry: CapabilityRegistry,
  broker: TopicBroker,
  options: CatalogCapabilityOptions = {},
): { publish(): Promise<void>; dispose(): void } {
  const getService = options.getService ?? acquireModelCatalog
  const report = options.report ?? (line => console.warn(`[model-catalog] ${line}`))

  const state = async (): Promise<CatalogStatusState> => {
    try {
      const service = await getService()
      return service ? { available: true, status: await service.status() } : { available: false }
    } catch (error) {
      report(`the status could not be read: ${error instanceof Error ? error.message : String(error)}`)
      return { available: false }
    }
  }

  const provider: TopicProvider = {
    matches: (id: TopicId) => id === CATALOG_STATUS_TOPIC,
    authorize: (_id, conn) => scopeAllows(conn.scope.mode, 'observe'),
    async *snapshot(): AsyncIterable<SnapshotPage> {
      yield { type: CATALOG_STATUS_EVENT, payload: await state() }
    },
  }
  broker.registerProvider(provider)

  const hasReaders = (): boolean => broker.subscribersOf(CATALOG_STATUS_TOPIC as TopicId).length > 0
  const publishState = (payload: CatalogStatusState): void => {
    broker.publish(CATALOG_STATUS_TOPIC as TopicId, payload, { type: CATALOG_STATUS_EVENT })
  }
  const publish = async (): Promise<void> => {
    // Nobody is reading: a later subscriber's snapshot reads afresh.
    if (!hasReaders()) return
    publishState(await state())
  }

  registry.registerCapability({
    cap: CATALOG_CAPABILITY,
    actions: {
      refresh: { scope: CATALOG_ACTION_SCOPES.refresh, guard: isCatalogRefreshPayload },
    },
    handle: async request => {
      if (request.route.act !== 'refresh') {
        throw wireError('unknown_route', `catalog has no action '${request.route.act}'`)
      }
      const service = await getService()
      if (!service) throw wireError('host_unavailable', 'catalog: model data is not available in this runtime')
      // refresh() never throws; a failure is the status's lastError.
      const result: CatalogStatusState = { available: true, status: await service.refresh() }
      if (hasReaders()) publishState(result)
      return result
    },
  })

  const unsubscribe = (options.onSourceChanged ?? onModelCatalogSourceChanged)(() => {
    void publish()
  })
  return { publish, dispose: unsubscribe }
}
