/**
 * Client auto-update on the runtime protocol: the `appUpdate/status` topic and
 * `appUpdate.relaunch`; shapes and scope in `appUpdate/appUpdateProtocol.ts` (F-30).
 */
import { wireError, type TopicId } from '../runtimeProtocol'
import {
  APP_UPDATE_ACTION_SCOPES,
  APP_UPDATE_CAPABILITY,
  APP_UPDATE_STATUS_EVENT,
  APP_UPDATE_STATUS_TOPIC,
  isAppUpdateRelaunchPayload,
  type AppUpdateState,
} from '../../appUpdate/appUpdateProtocol'
import { currentAppUpdateService, onAppUpdateServiceChanged } from '../../appUpdate/appUpdateHolder'
import type { AppUpdateService } from '../../appUpdate/AppUpdateService'
import { scopeAllows, type CapabilityRegistry } from './CapabilityRegistry'
import type { TopicBroker } from './TopicBroker'
import type { SnapshotPage, TopicProvider } from './types'

export type AppUpdateCapabilityOptions = {
  /** Default: the holder's service. */
  getService?: () => AppUpdateService | null
  /** Default: the holder's change feed. */
  onServiceChanged?: (listener: () => void) => () => void
}

export function registerAppUpdateCapability(
  registry: CapabilityRegistry,
  broker: TopicBroker,
  options: AppUpdateCapabilityOptions = {},
): { dispose(): void } {
  const getService = options.getService ?? currentAppUpdateService
  const state = (): AppUpdateState => getService()?.getState() ?? { available: false }

  const provider: TopicProvider = {
    matches: (id: TopicId) => id === APP_UPDATE_STATUS_TOPIC,
    authorize: (_id, conn) => scopeAllows(conn.scope.mode, 'observe'),
    async *snapshot(): AsyncIterable<SnapshotPage> {
      yield { type: APP_UPDATE_STATUS_EVENT, payload: state() }
    },
  }
  broker.registerProvider(provider)

  const publish = (payload: AppUpdateState): void => {
    if (broker.subscribersOf(APP_UPDATE_STATUS_TOPIC as TopicId).length === 0) return
    broker.publish(APP_UPDATE_STATUS_TOPIC as TopicId, payload, { type: APP_UPDATE_STATUS_EVENT })
  }

  registry.registerCapability({
    cap: APP_UPDATE_CAPABILITY,
    actions: {
      relaunch: { scope: APP_UPDATE_ACTION_SCOPES.relaunch, guard: isAppUpdateRelaunchPayload },
    },
    handle: async request => {
      if (request.route.act !== 'relaunch') {
        throw wireError('unknown_route', `appUpdate has no action '${request.route.act}'`)
      }
      const service = getService()
      if (!service) throw wireError('host_unavailable', 'appUpdate: updates are not available in this runtime')
      if (service.getState().phase !== 'ready') {
        throw wireError('conflict', 'appUpdate: no installed update is waiting for a restart')
      }
      await service.relaunch()
      return { ok: true }
    },
  })

  let unwatchService: (() => void) | null = null
  const watch = (): void => {
    unwatchService?.()
    const service = getService()
    unwatchService = service ? service.onStateChange(publish) : null
    publish(state())
  }
  const unwatchHolder = (options.onServiceChanged ?? onAppUpdateServiceChanged)(watch)
  watch()
  return {
    dispose() {
      unwatchHolder()
      unwatchService?.()
    },
  }
}
