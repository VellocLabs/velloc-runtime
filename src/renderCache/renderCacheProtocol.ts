/**
 * Render-cache purge on the runtime protocol (P-3). Clients read topic
 * `renderCache/status` (`observe`; times and process counts, nothing personal)
 * and ask `renderCache.purgeNow` at `manager`: it makes the desktop's renderers
 * and GPU process re-decode and re-upload, a cost a viewer must not impose.
 */
import type { ScopeMode } from '../browser/runtimeProtocol'
import type { RenderCacheTarget } from '../browser/bridge/protocol/appInfo'

export const RENDER_CACHE_CAPABILITY = 'renderCache'
export const RENDER_CACHE_STATUS_TOPIC = 'renderCache/status'
/** The `type` of the snapshot and of every delta. */
export const RENDER_CACHE_STATUS_EVENT = 'state'

export const RENDER_CACHE_ACTION_SCOPES = {
  purgeNow: 'manager',
} as const satisfies Record<string, ScopeMode>

export type RenderCachePurgeReason = 'idle' | 'manual'

export type RenderCachePurgeRecord = {
  at: number
  reason: RenderCachePurgeReason
  purged: RenderCacheTarget[]
  throttled: RenderCacheTarget[]
  guestProcesses: number
  gpuProcesses: number
}

/**
 * The whole state, published on every change. `available` is false while this
 * runtime has no purge policy (an older host without the primitive).
 */
export type RenderCacheState = {
  available: boolean
  /** The idle purge is on (settings `features`); a manual purge works either way. */
  idlePurge?: boolean
  /** Quiet time, in ms, before the idle purge. */
  idleMs?: number
  /** Some client reports its page visible. */
  visible?: boolean
  purges?: number
  last?: RenderCachePurgeRecord
  lastError?: string
}

/** `purgeNow` takes nothing; anything else is refused. */
export function isRenderCachePurgeNowPayload(value: unknown): boolean {
  if (value === undefined || value === null) return true
  return typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0
}
