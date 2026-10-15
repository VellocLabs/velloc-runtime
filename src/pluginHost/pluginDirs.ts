/**
 * Plugin install layout under `~/.velloc/plugins/`: `known_marketplaces.json`,
 * `installed_plugins.json`, one dir per marketplace, and
 * `cache/<marketplace>/<plugin>/<version>/` version slots.
 */

import { joinPath } from '../memory/memoryPaths'
import { NEXUS_DIR_NAME } from '../settings/settingSources'

/** Subdirectory under `~/.velloc/` that owns the plugin install state.
 */
export const PLUGINS_DIR_NAME = 'plugins'

/** Filename for the marketplace registry — what marketplaces are added
 */
export const KNOWN_MARKETPLACES_FILE_NAME = 'known_marketplaces.json'

/**
 *  `installed_plugins.json`. */
export const INSTALLED_PLUGINS_FILE_NAME = 'installed_plugins.json'

/** The provider mods' update state (what was checked, parked for consent,
 *  the rollback target). Lives beside `installed_plugins.json`. */
export const PROVIDER_MOD_UPDATES_FILE_NAME = 'provider_mod_updates.json'

/** The marketplace plugins' update state (offers, failures, the rollback
 *  target). Lives beside `installed_plugins.json`. */
export const PLUGIN_UPDATES_FILE_NAME = 'plugin_updates.json'

/** `~/.velloc/plugins/builtin_marketplace.json` — the built-in seeder's state. */
export const BUILTIN_MARKETPLACE_STATE_FILE_NAME = 'builtin_marketplace.json'

/** Subdirectory holding the extracted contents of each known
 */
export const MARKETPLACES_CACHE_DIR_NAME = 'marketplaces'

/** Subdirectory holding extracted plugin payloads, keyed by
 */
export const PLUGINS_CACHE_DIR_NAME = 'cache'

export const PLUGIN_MANIFEST_FILE_NAME = 'plugin.json'

export const MARKETPLACE_MANIFEST_FILE_NAME = 'marketplace.json'

/**
 *  nexus's `~/.velloc/plugins/...` slot unmodified, so the subdir name
 *  has to match for the loader to find the manifest. */
export const PLUGIN_MANIFEST_DIR_NAME = '.claude-plugin'

/**
 * Context for resolving every plugin-install path; same shape as
 * `SettingsPathContext`. Reads only `homeDir`.
 */
export type PluginInstallPathContext = {
  /** User home directory. Required for user-scope plugin paths. */
  homeDir: string
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

export function pluginsRoot(ctx: PluginInstallPathContext): string {
  return joinPath(ctx.homeDir, NEXUS_DIR_NAME, PLUGINS_DIR_NAME)
}

/**
 *  `catalogCacheRoot()`. */
export function catalogCacheRoot(
  ctx: PluginInstallPathContext,
): string {
  return joinPath(pluginsRoot(ctx), MARKETPLACES_CACHE_DIR_NAME)
}

/** Absolute path of `~/.velloc/plugins/known_marketplaces.json`.
 */
export function getKnownMarketplacesFilePath(
  ctx: PluginInstallPathContext,
): string {
  return joinPath(pluginsRoot(ctx), KNOWN_MARKETPLACES_FILE_NAME)
}

/** Absolute path of `~/.velloc/plugins/installed_plugins.json`.
 */
export function registryFilePath(
  ctx: PluginInstallPathContext,
): string {
  return joinPath(pluginsRoot(ctx), INSTALLED_PLUGINS_FILE_NAME)
}

/** Absolute path of `~/.velloc/plugins/provider_mod_updates.json`. */
export function providerModUpdatesFilePath(
  ctx: PluginInstallPathContext,
): string {
  return joinPath(pluginsRoot(ctx), PROVIDER_MOD_UPDATES_FILE_NAME)
}

/** Absolute path of `~/.velloc/plugins/plugin_updates.json`. */
export function pluginUpdatesFilePath(ctx: PluginInstallPathContext): string {
  return joinPath(pluginsRoot(ctx), PLUGIN_UPDATES_FILE_NAME)
}

/** Absolute path of `~/.velloc/plugins/builtin_marketplace.json`. */
export function builtinMarketplaceStateFilePath(ctx: PluginInstallPathContext): string {
  return joinPath(pluginsRoot(ctx), BUILTIN_MARKETPLACE_STATE_FILE_NAME)
}

// ---------------------------------------------------------------------------
// inside the marketplace manager / plugin loader as needed)
// ---------------------------------------------------------------------------

/** Absolute path of `~/.velloc/plugins/marketplaces/<name>/`. The extracted
 *  call site as `join(cacheDir, catalogKey)`. */
export function getMarketplaceContentDir(
  ctx: PluginInstallPathContext,
  catalogKey: string,
): string {
  return joinPath(catalogCacheRoot(ctx), catalogKey)
}

/** Absolute path of a marketplace's manifest file (after extraction). */
export function getMarketplaceManifestPath(
  ctx: PluginInstallPathContext,
  catalogKey: string,
): string {
  return joinPath(
    getMarketplaceContentDir(ctx, catalogKey),
    PLUGIN_MANIFEST_DIR_NAME,
    MARKETPLACE_MANIFEST_FILE_NAME,
  )
}

/** Absolute path of `~/.velloc/plugins/cache/<marketplace>/<plugin>/<version>/`.
 *  similar helper named `getVersionedCachePath` on `pluginLoader.ts`. */
export function getPluginVersionCacheDir(
  ctx: PluginInstallPathContext,
  catalogKey: string,
  pluginName: string,
  version: string,
): string {
  return joinPath(
    pluginsRoot(ctx),
    PLUGINS_CACHE_DIR_NAME,
    catalogKey,
    pluginName,
    version,
  )
}

/** Absolute path of a plugin's manifest within its version cache slot. */
export function getPluginVersionManifestPath(
  ctx: PluginInstallPathContext,
  catalogKey: string,
  pluginName: string,
  version: string,
): string {
  return joinPath(
    getPluginVersionCacheDir(ctx, catalogKey, pluginName, version),
    PLUGIN_MANIFEST_DIR_NAME,
    PLUGIN_MANIFEST_FILE_NAME,
  )
}
