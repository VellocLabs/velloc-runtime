/**
 * Plugin loader entry point: `loadPluginContributions` loads all enabled plugins
 * and flattens them into each subsystem's contributions.
 */

import type { MCPServerConfigWithName } from '../mcp/types'
import type { NexusMcpServerLaunchConfig } from '../mcp/nativeBridge'
import type { RuntimeConfig } from '../runtime/interfaces/RuntimeConfig'
import { gatherPlugins } from './loadPlugins'
import { PLUGIN_DESCRIPTION_KEY, readPluginLocaleText } from './pluginLocaleText'
import {
  substituteNativePluginMcpVars,
  substitutePluginMcpVars,
} from './substituteMcpVars'
import type { ActivePlugin, PluginLoadIssue } from './pluginModel'
import type { InstalledPluginsFile } from './registryFormats'

export type PluginContributions = {
  /** Enabled plugins (allowlisted). */
  plugins: ActivePlugin[]
  /** Discovered-but-not-enabled plugins (present on disk, not allowlisted).
   *  Surfaced by the `/plugins` command so users can see what's available. */
  disabled: ActivePlugin[]
  /** Plugin skill + command directories (auto-detected `skills/` & `commands/`
   *  plus manifest-declared dirs), each tagged with the contributing plugin
   *  (`visitMarkdownFiles`) but keeps `skills/` trees top-level-only, so the
   *  loader needs to know which shape a directory came from. */
  pluginSkillDirs: Array<{
    dirPath: string
    pluginName: string
    kind: 'commands' | 'skills'
  }>
  pluginAgentDirs: Array<{ dirPath: string; pluginName: string }>
  mcpServers: MCPServerConfigWithName[]
  nativeMcpServers: Array<{ id: string; config: NexusMcpServerLaunchConfig }>
  errors: PluginLoadIssue[]
}

/** Each plugin with its description in `locale` where its files have one. */
async function describeInLocale(
  plugins: ActivePlugin[],
  fs: import('../utils/fs/runtimeFs').RuntimeFs,
  locale: string,
): Promise<ActivePlugin[]> {
  return Promise.all(
    plugins.map(async plugin => {
      if (!plugin.path) return plugin
      const description = await readPluginLocaleText(fs, plugin.path, locale, PLUGIN_DESCRIPTION_KEY)
      return description === undefined ? plugin : { ...plugin, manifest: { ...plugin.manifest, description } }
    }),
  )
}

export async function loadPluginContributions(params: {
  cwd: string
  runtimeConfig: RuntimeConfig
  enabledPlugins?: string[]
  /** Bridge-resolved user home, forwarded to `gatherPlugins` so the
   *  user-scope plugin root resolves in production (the worker env has no
   *  `HOME`/`USERPROFILE`). */
  homeDir?: string
  /** Marketplace install registry. When present, every
   *  entry's `installPath` is loaded as a plugin alongside the legacy
   *  directory-walk plugins. Caller resolves it via
   *  `loadMarketplaceInstallState({ homeDir })`. */
  installRegistry?: InstalledPluginsFile
  /** settings.json's `enabledPlugins` map (sparse). Drives
   *  the enable/disable check for marketplace plugins; default-on
   *  semantics (absent key = enabled). */
  enabledPluginIdentifiers?: Record<string, boolean>
  /** THIS runtime's fs, forwarded to `gatherPlugins`; omitted → the
   *  realm-global slot (tests). */
  fs?: import('../utils/fs/runtimeFs').RuntimeFs
  /** The page's language: a plugin whose `locales/` file for it carries
   *  `plugin.description` is described in it (`pluginLocaleText.ts`); the
   *  manifest's own English otherwise. Needs `fs`. */
  locale?: string
}): Promise<PluginContributions> {
  const { enabled: gathered, disabled, errors } = await gatherPlugins(params)
  const enabled = params.fs && params.locale ? await describeInLocale(gathered, params.fs, params.locale) : gathered

  const pluginSkillDirs: Array<{
    dirPath: string
    pluginName: string
    kind: 'commands' | 'skills'
  }> = []
  const pluginAgentDirs: Array<{ dirPath: string; pluginName: string }> = []
  const mcpServers: MCPServerConfigWithName[] = []
  const nativeMcpServers: Array<{ id: string; config: NexusMcpServerLaunchConfig }> = []

  for (const plugin of enabled) {
    // A plugin's `commands/` and `skills/` directories both feed the
    // skill/command list (a plugin command surfaces as a model-invocable
    const skillDirs = [plugin.skillsPath, ...(plugin.skillsPaths ?? [])].filter(
      (dir): dir is string => typeof dir === 'string',
    )
    for (const dirPath of skillDirs) {
      pluginSkillDirs.push({ dirPath, pluginName: plugin.name, kind: 'skills' })
    }
    const commandDirs = [
      plugin.commandFolder,
      ...(plugin.commandFolders ?? []),
    ].filter((dir): dir is string => typeof dir === 'string')
    for (const dirPath of commandDirs) {
      pluginSkillDirs.push({ dirPath, pluginName: plugin.name, kind: 'commands' })
    }

    const agentDirs = [
      plugin.agentsPath,
      ...(plugin.agentsPaths ?? []),
    ].filter((dir): dir is string => typeof dir === 'string')
    for (const dirPath of agentDirs) {
      pluginAgentDirs.push({ dirPath, pluginName: plugin.name })
    }

    if (plugin.mcpServers) {
      for (const [name, config] of Object.entries(plugin.mcpServers)) {
        // the url + each header value before the server is handed to the pool.
        // ${CLAUDE_PLUGIN_ROOT} → plugin.path, general ${NAME}/${NAME:-default}
        // ${user_config.X} / ${CLAUDE_PLUGIN_DATA} / ${CLAUDE_PROJECT_DIR} are
        // intentionally not resolved on this path (see substituteMcpVars.ts).
        const resolved = substitutePluginMcpVars(config, {
          pluginRoot: plugin.path,
          getEnv: varName => params.runtimeConfig.getEnv(varName),
        })
        mcpServers.push({ name, ...resolved })
      }
    }
    if (plugin.nativeMcpServers) {
      for (const [name, config] of Object.entries(plugin.nativeMcpServers)) {
        const resolved = substituteNativePluginMcpVars(config, {
          pluginRoot: plugin.path,
          getEnv: varName => params.runtimeConfig.getEnv(varName),
        })
        nativeMcpServers.push({
          id: name,
          config: resolved,
        })
      }
    }
  }

  return {
    plugins: enabled,
    disabled,
    pluginSkillDirs,
    pluginAgentDirs,
    mcpServers,
    nativeMcpServers,
    errors,
  }
}

/**
 * One server of one plugin's manifest, `${…}` substituted exactly as
 * `loadPluginContributions` substitutes it for the pool — `$.mcp.connect`
 * (mods/modMcp.ts) connects "one of the MCP servers this plugin's own
 * manifest lists" by its key. Undefined when the plugin lists no such server.
 */
export function pluginMcpServer(
  plugin: Pick<ActivePlugin, 'path' | 'mcpServers' | 'nativeMcpServers'>,
  key: string,
  getEnv: (name: string) => string | undefined,
):
  | { kind: 'browser'; entry: MCPServerConfigWithName }
  | { kind: 'native'; id: string; config: NexusMcpServerLaunchConfig }
  | undefined {
  const browser = plugin.mcpServers && Object.hasOwn(plugin.mcpServers, key) ? plugin.mcpServers[key] : undefined
  if (browser) {
    return {
      kind: 'browser',
      entry: { name: key, ...substitutePluginMcpVars(browser, { pluginRoot: plugin.path, getEnv }) },
    }
  }
  const native = plugin.nativeMcpServers && Object.hasOwn(plugin.nativeMcpServers, key) ? plugin.nativeMcpServers[key] : undefined
  if (native) {
    return {
      kind: 'native',
      id: key,
      config: substituteNativePluginMcpVars(native, { pluginRoot: plugin.path, getEnv }),
    }
  }
  return undefined
}
