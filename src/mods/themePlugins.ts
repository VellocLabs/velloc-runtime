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
import type { ThemeModEntry, ThemePluginRow } from './themeMods'

export type ThemePluginsDeps = {
  homeDir: string
  fs: RuntimeFs
  /** Every open session loads its plugins again; called once after a change. */
  reload: () => void
  /** A directory plugin switched off, by its folder's name. */
  onFolderOff?: (folder: string) => void
}

/**
 * Every theme plugin by install: `id` is `<name>@<marketplace>`,
 * `<name>@builtin` or `<name>@inline` (then `root` is its folder). A recorded
 * marketplace install that is no longer installed is left out.
 */
export async function knownThemePlugins(homeDir: string, fs: RuntimeFs): Promise<ThemeModEntry[]> {
  return (await readThemePlugins(homeDir, fs)).known
}

async function readThemePlugins(
  homeDir: string,
  fs: RuntimeFs,
): Promise<{ known: ThemeModEntry[]; enabled: Record<string, boolean> }> {
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
  return { known: [...out.values()], enabled: settings.enabledPlugins ?? {} }
}

async function localEnabled(root: string, fs: RuntimeFs): Promise<boolean> {
  const folder = normalizeRuntimePath(root)
  const base = dirnameRuntimePath(dirnameRuntimePath(dirnameRuntimePath(folder)))
  const names = await loadEnabledPlugins(base, fs).catch(() => null)
  return names?.includes(basenameRuntimePath(folder)) ?? false
}

/** Every known theme plugin and whether it is enabled now. */
export async function themePluginRows(homeDir: string, fs: RuntimeFs): Promise<ThemePluginRow[]> {
  const { known, enabled } = await readThemePlugins(homeDir, fs)
  const out: ThemePluginRow[] = []
  for (const mod of known) {
    const on = mod.id.endsWith('@inline') ? !!mod.root && (await localEnabled(mod.root, fs)) : enabled[mod.id] !== false
    out.push({ ...mod, enabled: on })
  }
  return out
}

/**
 * Switches off every enabled theme plugin except those named `keep`, then
 * reloads the open sessions once, also when a later write fails after some
 * were switched off. How many were switched off; a folder that cannot be
 * written is passed by.
 */
export async function turnOffThemePlugins(deps: ThemePluginsDeps, keep?: string): Promise<number> {
  const known = await knownThemePlugins(deps.homeDir, deps.fs)
  const { settings } = await readLayerFresh('userSettings', { homeDir: deps.homeDir }, deps.fs)
  return switchOff(deps, known.filter(mod => mod.plugin !== keep), settings.enabledPlugins ?? {})
}

async function switchOff(
  deps: ThemePluginsDeps,
  mods: readonly ThemeModEntry[],
  enabled: Readonly<Record<string, unknown>>,
): Promise<number> {
  const { homeDir, fs } = deps
  const patch: Record<string, boolean> = {}
  let written = 0
  try {
    for (const mod of mods) {
      if (mod.id.endsWith('@inline')) {
        if (!mod.root || !(await localEnabled(mod.root, fs))) continue
        try {
          await setLocalPluginEnabled(mod.root, false, fs)
          written += 1
          deps.onFolderOff?.(basenameRuntimePath(normalizeRuntimePath(mod.root)))
        } catch {
          // A folder outside the plugin roots is not switched from here.
        }
      } else if (enabled[mod.id] !== false && !Object.hasOwn(patch, mod.id)) {
        patch[mod.id] = false
      }
    }
    const marketplace = Object.keys(patch).length
    if (marketplace > 0) {
      await applyEnabledPluginsPatch({ homeDir }, fs, patch)
      written += marketplace
    }
  } finally {
    if (written > 0) deps.reload()
  }
  return written
}

const sameFolder = (a: string, b: string) => normalizeRuntimePath(a).toLowerCase() === normalizeRuntimePath(b).toLowerCase()

/**
 * With *Only one at a time* on (settings `mods.singleThemeMod`) and the plugin
 * just switched on a theme plugin, switches off every other one. A directory
 * plugin is named by its folder (`root`), since its folder and its own name can
 * differ. Never rejects; how many it switched off.
 */
export async function keepOneThemePlugin(
  deps: ThemePluginsDeps,
  which: { plugin: string } | { root: string },
): Promise<number> {
  try {
    const { settings } = await readLayerFresh('userSettings', { homeDir: deps.homeDir }, deps.fs)
    if (settings.mods?.singleThemeMod !== true) return 0
    const known = await knownThemePlugins(deps.homeDir, deps.fs)
    const self = known.find(mod =>
      'root' in which ? mod.id.endsWith('@inline') && !!mod.root && sameFolder(mod.root, which.root) : mod.plugin === which.plugin,
    )
    if (!self) return 0
    return await switchOff(deps, known.filter(mod => mod.plugin !== self.plugin), settings.enabledPlugins ?? {})
  } catch {
    return 0
  }
}
