/**
 * Render-cache purge on the runtime protocol: the `renderCache/status` topic and
 * `renderCache.purgeNow`; shapes and scope in `renderCache/renderCacheProtocol.ts`
 * (P-3). Client activity reported through presence re-arms the idle purge.
 */
import { wireError, type TopicId } from '../runtimeProtocol'
import {
  isRenderCachePurgeNowPayload,
  RENDER_CACHE_ACTION_SCOPES,
  RENDER_CACHE_CAPABILITY,
  RENDER_CACHE_STATUS_EVENT,
  RENDER_CACHE_STATUS_TOPIC,
  type RenderCacheState,
} from '../../renderCache/renderCacheProtocol'
import type { RenderCachePolicy } from '../../renderCache/RenderCachePolicy'
import {
  currentRenderCachePolicy,
  onRenderCachePolicyChanged,
} from '../../renderCache/runtimeRenderCache'
import { scopeAllows, type CapabilityRegistry } from './CapabilityRegistry'
import type { PresenceTable } from './presence'
import type { TopicBroker } from './TopicBroker'
import type { SnapshotPage, TopicProvider } from './types'

export type RenderCacheCapabilityOptions = {
  /** Default: the realm's policy. */
  getPolicy?: () => RenderCachePolicy | null
  /** Default: the realm's change feed. */
  onPolicyChanged?: (listener: () => void) => () => void
}

export function registerRenderCacheCapability(
  registry: CapabilityRegistry,
  broker: TopicBroker,
  presence: PresenceTable,
  options: RenderCacheCapabilityOptions = {},
): { dispose(): void } {
  const getPolicy = options.getPolicy ?? currentRenderCachePolicy
  const state = (): RenderCacheState => {
    const policy = getPolicy()
    if (!policy) return { available: false }
    return { ...policy.getState(), visible: presence.anyVisible() }
  }

  const provider: TopicProvider = {
    matches: (id: TopicId) => id === RENDER_CACHE_STATUS_TOPIC,
    authorize: (_id, conn) => scopeAllows(conn.scope.mode, 'observe'),
    async *snapshot(): AsyncIterable<SnapshotPage> {
      yield { type: RENDER_CACHE_STATUS_EVENT, payload: state() }
    },
  }
  broker.registerProvider(provider)

  const publish = (): void => {
    if (broker.subscribersOf(RENDER_CACHE_STATUS_TOPIC as TopicId).length === 0) return
    broker.publish(RENDER_CACHE_STATUS_TOPIC as TopicId, state(), { type: RENDER_CACHE_STATUS_EVENT })
  }

  registry.registerCapability({
    cap: RENDER_CACHE_CAPABILITY,
    actions: {
      purgeNow: { scope: RENDER_CACHE_ACTION_SCOPES.purgeNow, guard: isRenderCachePurgeNowPayload },
    },
    handle: async request => {
      if (request.route.act !== 'purgeNow') {
        throw wireError('unknown_route', `renderCache has no action '${request.route.act}'`)
      }
      const policy = getPolicy()
      if (!policy) throw wireError('host_unavailable', 'renderCache: this host cannot purge render caches')
      try {
        return await policy.purgeNow()
      } catch (error) {
        throw wireError('host_unavailable', `renderCache: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
  })

  const unwatchActivity = presence.onActivity(() => {
    // The policy publishes its own state; visibility is ours to publish.
    const policy = getPolicy()
    if (policy) policy.noteActivity()
    else publish()
  })

  let unwatchPolicy: (() => void) | null = null
  const watch = (): void => {
    unwatchPolicy?.()
    const policy = getPolicy()
    unwatchPolicy = policy ? policy.onStateChange(() => publish()) : null
    publish()
  }
  const unwatchHolder = (options.onPolicyChanged ?? onRenderCachePolicyChanged)(watch)
  watch()
  return {
    dispose() {
      unwatchActivity()
      unwatchHolder()
      unwatchPolicy?.()
    },
  }
}
