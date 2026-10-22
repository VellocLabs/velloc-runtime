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
import type { PluginProviderKeysMap } from './pluginMcpUserConfig'
import { modSlotStates } from '../mods/modSlotRegistry'
import { loadInstalledPlugins } from './installedRegistry'
import { listLocalPlugins } from './localPluginList'
import { getPluginManifestPath } from './pluginPaths'
import { checkPluginDescriptor } from './manifestValidator'

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
 * The sealed key, named credentials and owner of each provider mod's entry
 * (`providers.configs`), for provider_key/provider_secret in plugin MCP servers.
 * Security: runtime-only; never handed to a client.
 */
export async function getPluginProviderKeys(
  ctx: SettingsPathContext,
  fs: RuntimeFs,
): Promise<PluginProviderKeysMap> {
  const { settings } = await readLayer('userSettings', ctx, fs)
  const out: Record<string, PluginProviderKeysMap[string]> = {}
  for (const [id, config] of Object.entries(settings.providers?.configs ?? {})) {
    if (!isModProviderId(id)) continue
    out[id] = {
      ...(config.apiKey ? { apiKey: config.apiKey } : {}),
      ...(config.modOwner ? { modOwner: config.modOwner } : {}),
      ...(config.secrets ? { secrets: { ...config.secrets } } : {}),
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
  /** When scoped to a page, only these omitted fields are removed. */
  replaceFields?: ReadonlySet<string>,
): Promise<void> {
  await updateSectionInSource('userSettings', ctx, fs, 'pluginConfigs', prev => {
    const next: Record<string, NexusPluginConfig> = { ...(prev ?? {}) }
    const stored = next[plugin]?.options ?? {}
    const merged: Record<string, string | number | boolean | readonly string[]> = { ...(options ?? {}) }
    const preserved = new Set(keep)
    if (replaceFields) {
      for (const name of Object.keys(stored)) if (!replaceFields.has(name)) preserved.add(name)
    }
    for (const name of preserved) {
      if (!Object.hasOwn(merged, name) && stored[name] !== undefined) {
        Object.defineProperty(merged, name, { value: stored[name], enumerable: true, configurable: true, writable: true })
      }
    }
    if (Object.keys(merged).length === 0) {
      delete next[plugin]
    } else {
      next[plugin] = { ...(next[plugin] ?? {}), options: merged }
    }
    return Object.keys(next).length === 0 ? undefined : next
  })
}

/** Fields the Plugins page owns, independent of the enabled provider registry.
 * Prefer current disk manifests (including disabled installs); active mod rows
 * cover built-ins and plugins whose directory is not discoverable here. If no
 * metadata is available, omission is not authority to delete stored options. */
async function pluginPageFields(
  ctx: SettingsPathContext, fs: RuntimeFs, plugin: string, projects: readonly string[],
): Promise<ReadonlySet<string>> {
  const active = modSlotStates().flatMap(session => session.mods)
    .filter(row => row.provenance === plugin)
  const paths = new Set(active.flatMap(row => row.root ? [row.root] : []))
  const { registry } = await loadInstalledPlugins({ homeDir: ctx.homeDir }, fs)
  for (const entry of registry.plugins[plugin] ?? []) paths.add(entry.installPath)
  if (plugin.endsWith('@inline')) {
    const roots = await listLocalPlugins({ homeDir: ctx.homeDir, projects, fs })
    for (const entry of roots.flatMap(root => root.plugins)) {
      if (`${entry.name}@inline` === plugin) paths.add(entry.path)
    }
  }
  const fields = new Set<string>()
  let found = false
  for (const path of paths) {
    try {
      const { manifest } = checkPluginDescriptor(JSON.parse(await fs.readFile(getPluginManifestPath(path), { encoding: 'utf-8' })))
      if (!manifest) continue
      found = true
      for (const name of Object.keys(manifest.userConfig ?? {})) fields.add(name)
    } catch {
      // Unavailable metadata must never turn a page save into a full reset.
    }
  }
  if (!found) {
    for (const row of active) for (const name of Object.keys(row.config?.fields ?? {})) fields.add(name)
  }
  return fields
}

/** Replace/reset only top-level userConfig. All other omitted shared options
 * (provider settings, signin.* answers, unknown fields) survive under the lock.
 * Explicit values still replace stored ones and `keep` retains masked fields. */
export async function setPluginPageOptions(
  ctx: SettingsPathContext,
  fs: RuntimeFs,
  plugin: string,
  options: Parameters<typeof setPluginOptions>[3],
  keep: readonly string[] = [],
  projects: readonly string[] = [],
): Promise<void> {
  const fields = await pluginPageFields(ctx, fs, plugin, projects)
  await setPluginOptions(ctx, fs, plugin, options, keep, fields)
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
