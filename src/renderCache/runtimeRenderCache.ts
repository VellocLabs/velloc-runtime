/**
 * The realm's render-cache purge policy (P-3): installed once a host port with
 * the `appInfo.purgeRenderCaches` primitive is attached, read by the runtime
 * hub's capability through `currentRenderCachePolicy`. No policy: the topic
 * says `available: false` and `renderCache.purgeNow` answers `host_unavailable`.
 */
import type { BrowserBridgeTransport } from '../browser/bridge/browserBridgeProtocol'
import { createNativePrimitives } from '../browser/bridge/nativePrimitives'
import type { BrowserHostManifest } from '../browser/bridge/protocol/manifest'
import {
  RENDER_CACHE_PURGE_LEVEL,
  RENDER_CACHE_PURGE_TARGETS,
  RenderCachePolicy,
  type RenderCachePolicyDeps,
} from './RenderCachePolicy'

export const RENDER_CACHE_PRIMITIVE = 'appInfo.purgeRenderCaches'

let policy: RenderCachePolicy | null = null
const listeners = new Set<() => void>()

/** Set (or, with `null`, clear) the policy; listeners hear of the change. */
export function configureRenderCachePolicy(next: RenderCachePolicy | null): void {
  if (policy && policy !== next) policy.dispose()
  policy = next
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch (error) {
      console.warn('[render-cache] a change listener failed:', error)
    }
  }
}

export function currentRenderCachePolicy(): RenderCachePolicy | null {
  return policy
}

export function onRenderCachePolicyChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export type RuntimeRenderCacheDeps = Pick<RenderCachePolicyDeps, 'isAnyBusy' | 'idlePurgeEnabled'> & {
  /** Read per purge, so a replaced port is used. */
  transport(): BrowserBridgeTransport | null
  manifest(): Pick<BrowserHostManifest, 'capabilities' | 'primitives'> | null
  createRequestId(): string
}

/**
 * Starts the policy unless one runs; returns why it did not start, or null.
 * Safe to call on every port attach.
 */
export function installRuntimeRenderCache(deps: RuntimeRenderCacheDeps): string | null {
  if (policy) return null
  const manifest = deps.manifest()
  if (!manifest?.primitives?.includes(RENDER_CACHE_PRIMITIVE)) return 'host_unsupported'
  if (!deps.transport()) return 'no_transport'
  const next = new RenderCachePolicy({
    isAnyBusy: deps.isAnyBusy,
    idlePurgeEnabled: deps.idlePurgeEnabled,
    purge: async () => {
      const transport = deps.transport()
      if (!transport) throw new Error('render cache purge: no host port')
      const primitives = createNativePrimitives({
        transport,
        createRequestId: deps.createRequestId,
        manifest: deps.manifest() ?? undefined,
      })
      return primitives.appInfo.purgeRenderCaches({
        targets: [...RENDER_CACHE_PURGE_TARGETS],
        level: RENDER_CACHE_PURGE_LEVEL,
      })
    },
  })
  configureRenderCachePolicy(next)
  next.start()
  return null
}
