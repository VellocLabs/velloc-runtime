/**
 * Security: provider mod updates on the runtime protocol. Clients read topic
 * `plugins/providerUpdates` (`observe`) and ask through the `providerUpdates.*`
 * actions, all `full`: they fetch and write code, or switch which module serves
 * a provider. A remote client (at most `manager`) cannot reach them. The topic
 * carries declared metadata only.
 */
import type { ScopeMode } from '../browser/runtimeProtocol'
import type { ProviderModUpdateStatus } from './providerModUpdates'

export const PROVIDER_UPDATES_CAPABILITY = 'providerUpdates'
export const PROVIDER_UPDATES_TOPIC = 'plugins/providerUpdates'
/** The `type` of the snapshot and of every delta. */
export const PROVIDER_UPDATES_EVENT = 'state'

export const PROVIDER_UPDATES_ACTION_SCOPES = {
  check: 'full',
  consent: 'full',
  decline: 'full',
  rollback: 'full',
  baseline: 'full',
} as const satisfies Record<string, ScopeMode>
export type ProviderUpdatesAction = keyof typeof PROVIDER_UPDATES_ACTION_SCOPES

/** The whole state, published on every change. */
export type ProviderUpdatesState = {
  plugins: ProviderModUpdateStatus[]
}

export type ProviderUpdatesCheckPayload = { pluginId?: string }
export type ProviderUpdatesVersionPayload = { pluginId: string; version: string }
export type ProviderUpdatesPluginPayload = { pluginId: string }

export type ProviderUpdatesCheckResult = ProviderUpdatesState
export type ProviderUpdatesStatusResult = { status: ProviderModUpdateStatus }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 300

/** A payload names the fields it knows and nothing else. */
function hasOnly(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key))
}

export function isProviderUpdatesCheckPayload(value: unknown): value is ProviderUpdatesCheckPayload {
  if (value === undefined || value === null) return true
  return isRecord(value) && hasOnly(value, ['pluginId']) && (value.pluginId === undefined || isId(value.pluginId))
}

export function isProviderUpdatesVersionPayload(value: unknown): value is ProviderUpdatesVersionPayload {
  return isRecord(value) && hasOnly(value, ['pluginId', 'version']) && isId(value.pluginId) && isId(value.version)
}

export function isProviderUpdatesPluginPayload(value: unknown): value is ProviderUpdatesPluginPayload {
  return isRecord(value) && hasOnly(value, ['pluginId']) && isId(value.pluginId)
}
