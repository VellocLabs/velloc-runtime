/**
 * A plugin's `userConfig` values: `pluginConfigs.<id>.options` in
 * `~/.velloc/settings.json`, keyed `<name>@<marketplace>` or `<name>@inline`;
 * a change reloads every session's plugins (F-25).
 */

import type { RuntimeFs } from '../utils/fs/runtimeFs'
import { readLayer, updateSectionInSource } from '../settings/settingsStore'
import type { SettingsPathContext } from '../settings/settingsStore'
import type { NexusPluginConfig } from '../settings/settingsTypes'
import { isModProviderId } from '../mods/provider/providerManifest'

/** Every plugin's stored options, by plugin id. */
export async function getPluginConfigsMap(
  ctx: SettingsPathContext,
  fs: RuntimeFs,
): Promise<Record<string, NexusPluginConfig>> {
  const { settings } = await readLayer('userSettings', ctx, fs)
  return { ...(settings.pluginConfigs ?? {}) }
}

/** Whether the user settings were read from the file, not defaulted after
 *  a missing, malformed or unreadable one. */
export async function userSettingsReadFromFile(ctx: SettingsPathContext, fs: RuntimeFs): Promise<boolean> {
  return (await readLayer('userSettings', ctx, fs)).source === 'file'
}

/**
 * The sealed key and owner of every provider mod's stored entry
 * (`providers.configs`), for `${provider_key.KEY}` in a plugin's MCP servers.
 * Security: runtime-only; never handed to a client.
 */
export async function getPluginProviderKeys(
  ctx: SettingsPathContext,
  fs: RuntimeFs,
): Promise<Record<string, { apiKey?: string; modOwner?: string }>> {
  const { settings } = await readLayer('userSettings', ctx, fs)
  const out: Record<string, { apiKey?: string; modOwner?: string }> = {}
  for (const [id, config] of Object.entries(settings.providers?.configs ?? {})) {
    if (!isModProviderId(id)) continue
    out[id] = {
      ...(config.apiKey ? { apiKey: config.apiKey } : {}),
      ...(config.modOwner ? { modOwner: config.modOwner } : {}),
    }
  }
  return out
}

/**
 * Write one plugin's options (replacing what was stored for it), or clear
 * them with `null`. `plugin` is its id. An empty map clears the section.
 */
export async function setPluginOptions(
  ctx: SettingsPathContext,
  fs: RuntimeFs,
  plugin: string,
  options: Record<string, string | number | boolean | readonly string[]> | null,
  /** Names whose stored value stays (a sensitive field left blank: the
   *  client only saw it masked). Absent from `options`, present here. */
  keep: readonly string[] = [],
): Promise<void> {
  await updateSectionInSource('userSettings', ctx, fs, 'pluginConfigs', prev => {
    const next: Record<string, NexusPluginConfig> = { ...(prev ?? {}) }
    const stored = next[plugin]?.options ?? {}
    const merged: Record<string, string | number | boolean | readonly string[]> = { ...(options ?? {}) }
    for (const name of keep) {
      if (!(name in merged) && stored[name] !== undefined) merged[name] = stored[name]
    }
    if (Object.keys(merged).length === 0) {
      delete next[plugin]
    } else {
      next[plugin] = { ...(next[plugin] ?? {}), options: merged }
    }
    return Object.keys(next).length === 0 ? undefined : next
  })
}

/**
 * Write ONE option of one plugin (`$.config.set`), the others kept. Returns
 * whether anything changed: a value equal to the stored one writes nothing
 */
export async function setPluginOption(
  ctx: SettingsPathContext,
  fs: RuntimeFs,
  plugin: string,
  field: string,
  value: string | number | boolean | readonly string[],
): Promise<boolean> {
  let changed = false
  await updateSectionInSource('userSettings', ctx, fs, 'pluginConfigs', prev => {
    const next: Record<string, NexusPluginConfig> = { ...(prev ?? {}) }
    const stored = next[plugin]?.options ?? {}
    if (JSON.stringify(stored[field]) === JSON.stringify(value)) return prev
    changed = true
    next[plugin] = { ...(next[plugin] ?? {}), options: { ...stored, [field]: value } }
    return next
  })
  return changed
}
