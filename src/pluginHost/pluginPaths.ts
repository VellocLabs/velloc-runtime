/**
 * Local plugin loader — on-disk locations.
 *
 * Mirrors `src/mcp/paths.ts`. Plugins live under `.velloc/plugins/<name>/`
 * in the user home and the project cwd, each carrying a manifest at
 * `.claude-plugin/plugin.json`. The `.claude-plugin/plugin.json` path is
 */

import type { RuntimeConfig } from '../runtime/interfaces/RuntimeConfig'
import { joinRuntimePath } from '../utils/runtimePaths'
import { RUNTIME_DIR_NAME } from '../branding/runtimeDir'

const NEXUS_DIR = RUNTIME_DIR_NAME
const PLUGINS_DIR = 'plugins'
const PLUGIN_MANIFEST_DIR = '.claude-plugin'
const PLUGIN_MANIFEST_FILE = 'plugin.json'
const ENABLED_PLUGINS_FILE = 'enabled-plugins.json'

/**
 * `<home>/.velloc/plugins`, or null. Production must pass `homeDir`: the
 * SharedWorker env has no `HOME`; the env read is the fallback.
 */
export function getUserPluginsRoot(
  runtimeConfig: RuntimeConfig,
  homeDir?: string,
): string | null {
  const resolvedHome =
    homeDir
    ?? runtimeConfig.getEnv('HOME')
    ?? runtimeConfig.getEnv('USERPROFILE')
    ?? null
  if (!resolvedHome) {
    return null
  }
  return joinRuntimePath(resolvedHome, NEXUS_DIR, PLUGINS_DIR)
}

/** `<cwd>/.velloc/plugins`. */
export function getProjectPluginsRoot(cwd: string): string {
  return joinRuntimePath(cwd, NEXUS_DIR, PLUGINS_DIR)
}

/** `<pluginDir>/.claude-plugin/plugin.json`. */
export function getPluginManifestPath(pluginDir: string): string {
  return joinRuntimePath(pluginDir, PLUGIN_MANIFEST_DIR, PLUGIN_MANIFEST_FILE)
}

/** `<cwd>/.velloc/enabled-plugins.json` — persisted enable/disable choices. */
export function getEnabledPluginsConfigPath(cwd: string): string {
  return joinRuntimePath(cwd, NEXUS_DIR, ENABLED_PLUGINS_FILE)
}

/**
 * `<home>/.velloc/enabled-plugins.json`: the USER-scope allowlist, unioned with
 * the project one.
 */
export function getUserEnabledPluginsConfigPath(homeDir: string): string {
  return joinRuntimePath(homeDir, NEXUS_DIR, ENABLED_PLUGINS_FILE)
}
