/**
 * Plugin enable/disable state: the `enabledPlugins` map in
 * `~/.velloc/settings.json`. Absent or `true` is enabled; only an explicit
 * `false` disables. Re-enabling clears the entry to keep the file sparse.
 */

import type { RuntimeFs } from '../utils/fs/runtimeFs'
import {
  readLayer,
  updateSectionInSource,
} from '../settings/settingsStore'
import type { SettingsPathContext } from '../settings/settingsStore'
import type { PluginInstallKey } from './registryFormats'

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Is the plugin currently enabled?
 *
 * Default-on semantics: an INSTALLED plugin is enabled unless the user has
 * `true` when the settings entry is `undefined` OR `true`, `false` only on
 * explicit `false`).
 */
export async function isPluginEnabled(
  ctx: SettingsPathContext,
  fs: RuntimeFs,
  pluginId: PluginInstallKey,
): Promise<boolean> {
  const { settings } = await readLayer('userSettings', ctx, fs)
  const map = settings.enabledPlugins ?? {}
  const value = map[pluginId]
  return value !== false
}

/** Snapshot of the full enabled-plugins map. */
export async function getEnabledPluginsMap(
  ctx: SettingsPathContext,
  fs: RuntimeFs,
): Promise<Record<string, boolean>> {
  const { settings } = await readLayer('userSettings', ctx, fs)
  return { ...(settings.enabledPlugins ?? {}) }
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Set the explicit enabled state of a plugin. `true` writes `true`; `false`
 * writes `false`; `null` CLEARS the override (back to default-on).
 */
export async function setPluginEnabled(
  ctx: SettingsPathContext,
  fs: RuntimeFs,
  pluginId: PluginInstallKey,
  value: boolean | null,
): Promise<void> {
  await updateSectionInSource(
    'userSettings',
    ctx,
    fs,
    'enabledPlugins',
    prev => {
      const next: Record<string, boolean> = { ...(prev ?? {}) }
      if (value === null) {
        delete next[pluginId]
      } else {
        next[pluginId] = value
      }
      if (Object.keys(next).length === 0) return undefined
      return next
    },
  )
}

/**
 * Bulk-update the enabled-plugins map with a patch. Same patch semantics as
 * `setPluginEnabled` but applied to many ids in one atomic settings-file write.
 */
export async function applyEnabledPluginsPatch(
  ctx: SettingsPathContext,
  fs: RuntimeFs,
  patch: Record<string, boolean | null>,
): Promise<void> {
  if (Object.keys(patch).length === 0) return
  await updateSectionInSource(
    'userSettings',
    ctx,
    fs,
    'enabledPlugins',
    prev => {
      const next: Record<string, boolean> = { ...(prev ?? {}) }
      for (const [id, value] of Object.entries(patch)) {
        if (value === null) {
          delete next[id]
        } else if (typeof value === 'boolean') {
          next[id] = value
        }
      }
      if (Object.keys(next).length === 0) return undefined
      return next
    },
  )
}
