/**
 * Model catalog on the runtime protocol. Clients read topic `catalog/status`
 * (`observe`; public facts only) and ask `catalog.refresh` at `manager`: it
 * makes the host hit the network but carries no user data, code or credential.
 */
import type { ScopeMode } from '../browser/runtimeProtocol'
import type { CatalogStatus } from './types'

export const CATALOG_CAPABILITY = 'catalog'
export const CATALOG_STATUS_TOPIC = 'catalog/status'
/** The `type` of the snapshot and of every delta. */
export const CATALOG_STATUS_EVENT = 'state'

export const CATALOG_ACTION_SCOPES = {
  refresh: 'manager',
} as const satisfies Record<string, ScopeMode>
export type CatalogAction = keyof typeof CATALOG_ACTION_SCOPES

/** The whole state, published on every change. `status` is absent while the runtime has no catalog service. */
export type CatalogStatusState = {
  available: boolean
  status?: CatalogStatus
}

export type CatalogRefreshResult = CatalogStatusState

/** `refresh` takes nothing; anything else is refused. */
export function isCatalogRefreshPayload(value: unknown): boolean {
  if (value === undefined || value === null) return true
  return typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0
}

const SOURCES = ['live', 'cache', 'snapshot', 'none']

/** A payload from the topic that is the shape a page reads, or null. */
export function readCatalogStatusState(value: unknown): CatalogStatusState | null {
  if (!value || typeof value !== 'object') return null
  const v = value as { available?: unknown; status?: unknown }
  if (typeof v.available !== 'boolean') return null
  if (v.status === undefined) return { available: v.available }
  const s = v.status as Partial<CatalogStatus> | null
  if (!s || typeof s !== 'object' || typeof s.source !== 'string' || !SOURCES.includes(s.source)) return null
  if (typeof s.models !== 'number') return null
  return { available: v.available, status: s as CatalogStatus }
}
