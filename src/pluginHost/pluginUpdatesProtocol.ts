/**
 * Security: marketplace plugin updates on the runtime protocol (F-14). Clients
 * read topic `plugins/updates` (`observe`) and ask through the
 * `pluginUpdates.*` actions, all `full`: a check re-fetches marketplaces (as
 * `plugins.refreshMarketplace`), an update or rollback writes code to the
 * host's disk, and the auto-update switch lets the runtime do that unattended.
 * A remote client (at most `manager`) reads the state only.
 */
import type { ScopeMode } from '../browser/runtimeProtocol'
import type { PluginUpdatesSnapshot } from './pluginUpdates'

export const PLUGIN_UPDATES_CAPABILITY = 'pluginUpdates'
export const PLUGIN_UPDATES_TOPIC = 'plugins/updates'
/** The `type` of the snapshot and of every delta. */
export const PLUGIN_UPDATES_EVENT = 'state'

export const PLUGIN_UPDATES_ACTION_SCOPES = {
  check: 'full',
  update: 'full',
  rollback: 'full',
  setAutoUpdate: 'full',
} as const satisfies Record<string, ScopeMode>
export type PluginUpdatesAction = keyof typeof PLUGIN_UPDATES_ACTION_SCOPES

export type PluginUpdatesState = PluginUpdatesSnapshot

export type PluginUpdatesCheckPayload = { force?: boolean }
export type PluginUpdatesPluginPayload = { identifier: string }
export type PluginUpdatesAutoPayload = { on: boolean }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const hasOnly = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).every(key => keys.includes(key))

export function isPluginUpdatesCheckPayload(value: unknown): value is PluginUpdatesCheckPayload {
  if (value === undefined || value === null) return true
  return isRecord(value) && hasOnly(value, ['force']) && (value.force === undefined || typeof value.force === 'boolean')
}

export function isPluginUpdatesPluginPayload(value: unknown): value is PluginUpdatesPluginPayload {
  return (
    isRecord(value) &&
    hasOnly(value, ['identifier']) &&
    typeof value.identifier === 'string' &&
    value.identifier.length > 0 &&
    value.identifier.length <= 300
  )
}

export function isPluginUpdatesAutoPayload(value: unknown): value is PluginUpdatesAutoPayload {
  return isRecord(value) && hasOnly(value, ['on']) && typeof value.on === 'boolean'
}
