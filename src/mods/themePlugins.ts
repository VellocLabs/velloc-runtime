/**
 * The theme plugins a person has, and switching them off (F-25, F-35).
 *
 * A plugin is a theme plugin when it has set a theme (settings `mods.themeMods`)
 * or when it is an install of a theme listing of the built-in marketplace
 * (`listingInstalls`), so a theme added from the directory counts before it
 * first runs. Runs in the runtime; clients reach it through `themeMods.*`.
 */
import { BUILTIN_MARKETPLACE_KEY } from '../pluginHost/builtinMarketplace'
import { readCachedManifest } from '../pluginHost/builtinMarketplaceSeed'
import { applyEnabledPluginsPatch } from '../pluginHost/enabledPlugins'
import { loadEnabledPlugins } from '../pluginHost/enabledStore'
import { loadInstalledPlugins } from '../pluginHost/installedRegistry'
import { setLocalPluginEnabled } from '../pluginHost/localPluginRemove'
import { listingInstalls } from '../pluginHost/themeListing'
import { readLayerFresh } from '../settings/settingsStore'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import { basenameRuntimePath, dirnameRuntimePath, normalizeRuntimePath } from '../utils/runtimePaths'
import type { ThemeModEntry } from './themeMods'

export type ThemePluginsDeps = {
  homeDir: string
  fs: RuntimeFs
  /** Every open session loads its plugins again; called once after a change. */
  reload: () => void
}

/**
 * Every theme plugin by install: `id` is `<name>@<marketplace>`,
 * `<name>@builtin` or `<name>@inline` (then `root` is its folder). A recorded
 * marketplace install that is no longer installed is left out.
 */
export async function knownThemePlugins(homeDir: string, fs: RuntimeFs): Promise<ThemeModEntry[]> {
  const [{ settings }, { registry }, manifest] = await Promise.all([
    readLayerFresh('userSettings', { homeDir }, fs),
    loadInstalledPlugins({ homeDir }, fs),
    readCachedManifest({ homeDir }, fs).catch(() => null),
  ])
  const installed = registry.plugins
  const out = new Map<string, ThemeModEntry>()
  for (const mod of settings.mods?.themeMods ?? []) {
    const inline = mod.id.endsWith('@inline')
    if (inline ? !mod.root : !mod.id.endsWith('@builtin') && !Object.hasOwn(installed, mod.id)) continue
    out.set(inline ? `inline:${mod.root}` : mod.id, mod)
  }
  for (const listing of manifest?.plugins ?? []) {
    if (!listing.theme) continue
    for (const id of listingInstalls(installed, listing, BUILTIN_MARKETPLACE_KEY)) {
      if (Object.hasOwn(installed, id) && !out.has(id)) out.set(id, { plugin: listing.name, id })
    }
  }
  return [...out.values()]
}

async function localEnabled(root: string, fs: RuntimeFs): Promise<boolean> {
  const folder = normalizeRuntimePath(root)
  const base = dirnameRuntimePath(dirnameRuntimePath(dirnameRuntimePath(folder)))
  const names = await loadEnabledPlugins(base, fs).catch(() => null)
  return names?.includes(basenameRuntimePath(folder)) ?? false
}

/**
 * Switches off every enabled theme plugin except those named `keep`, then
 * reloads the open sessions once. How many were switched off; a folder that
 * cannot be written is passed by.
 */
export async function turnOffThemePlugins(deps: ThemePluginsDeps, keep?: string): Promise<number> {
  const { homeDir, fs } = deps
  const known = (await knownThemePlugins(homeDir, fs)).filter(mod => mod.plugin !== keep)
  if (known.length === 0) return 0
  const { settings } = await readLayerFresh('userSettings', { homeDir }, fs)
  const enabled = settings.enabledPlugins ?? {}
  const patch: Record<string, boolean> = {}
  let turnedOff = 0
  for (const mod of known) {
    if (mod.id.endsWith('@inline')) {
      if (!mod.root || !(await localEnabled(mod.root, fs))) continue
      try {
        await setLocalPluginEnabled(mod.root, false, fs)
        turnedOff += 1
      } catch {
        // A folder outside the plugin roots is not switched from here.
      }
    } else if (enabled[mod.id] !== false && !Object.hasOwn(patch, mod.id)) {
      patch[mod.id] = false
      turnedOff += 1
    }
  }
  await applyEnabledPluginsPatch({ homeDir }, fs, patch)
  if (turnedOff > 0) deps.reload()
  return turnedOff
}

/**
 * With *Only one at a time* on (settings `mods.singleThemeMod`) and `plugin`
 * a theme plugin, switches off every other one. Never rejects; how many it
 * switched off.
 */
export async function keepOneThemePlugin(deps: ThemePluginsDeps, plugin: string): Promise<number> {
  try {
    const { settings } = await readLayerFresh('userSettings', { homeDir: deps.homeDir }, deps.fs)
    if (settings.mods?.singleThemeMod !== true) return 0
    const known = await knownThemePlugins(deps.homeDir, deps.fs)
    if (!known.some(mod => mod.plugin === plugin)) return 0
    return await turnOffThemePlugins(deps, plugin)
  } catch {
    return 0
  }
}
