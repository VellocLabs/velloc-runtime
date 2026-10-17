/**
 * Plugin loader entry point: `loadPluginContributions` loads all enabled plugins
 * and flattens them into each subsystem's contributions.
 */

import type { MCPServerConfigWithName } from '../mcp/types'
import type { NexusMcpServerLaunchConfig } from '../mcp/nativeBridge'
import type { PluginMcpServerOwner } from '../mcp/serverOrigin'
import type { RuntimeConfig } from '../runtime/interfaces/RuntimeConfig'
import { gatherPlugins } from './loadPlugins'
import { PLUGIN_DESCRIPTION_KEY, readPluginLocaleText } from './pluginLocaleText'
import {
  resolvePluginMcpServer,
  type PluginConfigsMap,
  type PluginMcpScope,
  type PluginMcpServer,
  type PluginProviderKeysMap,
  type PluginSecretWrite,
} from './pluginMcpUserConfig'
import type { ActivePlugin, PluginLoadIssue } from './pluginModel'
import { splitByRequirements, type ProviderGateState, type UnmetRequirement } from './pluginRequirements'
import type { InstalledPluginsFile } from './registryFormats'

export type PluginContributions = {
  /** Enabled plugins (allowlisted). */
  plugins: ActivePlugin[]
  /** Discovered-but-not-enabled plugins (present on disk, not allowlisted).
   *  Surfaced by the `/plugins` command so users can see what's available. */
  disabled: ActivePlugin[]
  /** Enabled by the person but held back by `requires` (`pluginRequirements.ts`):
   *  none of their components take effect. Empty unless `requirements` was given. */
  waiting: Array<{ plugin: ActivePlugin; unmet: UnmetRequirement[] }>
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
  /** The plugin each server above comes from, by server name and track. */
  mcpServerPlugins: PluginMcpServerOwner[]
  /** The sensitive options the servers above carry placeholders for, to
   *  store before they launch (`storePluginSecrets`), and the ids of the
   *  plugins whose stored values these are. */
  mcpSecrets: { writes: PluginSecretWrite[]; pluginIds: string[] }
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
  /** settings.json `pluginConfigs`: each plugin's options, for
   *  `${user_config.KEY}` in its MCP servers. Absent: defaults alone. */
  pluginConfigs?: PluginConfigsMap
  /** settings.json `providers.configs`: the keys stored for the plugins' own
   *  providers, for `${provider_key.KEY}` in their MCP servers. Absent: none. */
  providerKeys?: PluginProviderKeysMap
  /** The provider state the `requires` gate reads. Absent: no plugin is gated. */
  requirements?: ProviderGateState
}): Promise<PluginContributions> {
  const { enabled: gathered, disabled, errors: gatheredErrors } = await gatherPlugins(params)
  const described = params.fs && params.locale ? await describeInLocale(gathered, params.fs, params.locale) : gathered
  const { effective: enabled, waiting } = params.requirements
    ? splitByRequirements(described, params.requirements)
    : { effective: described, waiting: [] }

  const pluginSkillDirs: Array<{
    dirPath: string
    pluginName: string
    kind: 'commands' | 'skills'
  }> = []
  const pluginAgentDirs: Array<{ dirPath: string; pluginName: string }> = []
  const mcpServers: MCPServerConfigWithName[] = []
  const nativeMcpServers: Array<{ id: string; config: NexusMcpServerLaunchConfig }> = []
  const mcpServerPlugins: PluginMcpServerOwner[] = []
  const secretWrites: PluginSecretWrite[] = []
  const pluginIds: string[] = []
  const errors = [...gatheredErrors]
  const mcpScope = {
    getEnv: (varName: string) => params.runtimeConfig.getEnv(varName),
    ...(params.pluginConfigs ? { configs: params.pluginConfigs } : {}),
    ...(params.providerKeys ? { providers: params.providerKeys } : {}),
  }
  const addServer = (plugin: ActivePlugin, name: string, server: PluginMcpServer) => {
    const resolved = resolvePluginMcpServer(plugin, name, server, mcpScope)
    if (!resolved.ok) {
      errors.push({
        type: 'mcp-config-invalid',
        source: plugin.source,
        plugin: plugin.name,
        serverName: name,
        validationError: resolved.reason,
      })
      return
    }
    secretWrites.push(...resolved.secrets)
    if (resolved.kind === 'native') nativeMcpServers.push({ id: name, config: resolved.config })
    else mcpServers.push({ name, ...resolved.config })
    mcpServerPlugins.push({ name, plugin: plugin.name, track: resolved.kind })
  }

  for (const plugin of enabled) {
    pluginIds.push(plugin.installIdentifier ?? `${plugin.name}@inline`)
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

    // The plugin root, `${user_config.KEY}` and env placeholders are resolved
    // before a server is handed to the pool (`resolvePluginMcpServer`).
    for (const [name, config] of Object.entries(plugin.mcpServers ?? {})) {
      addServer(plugin, name, { kind: 'browser', config })
    }
    for (const [name, config] of Object.entries(plugin.nativeMcpServers ?? {})) {
      addServer(plugin, name, { kind: 'native', config })
    }
  }

  return {
    plugins: enabled,
    disabled,
    waiting,
    pluginSkillDirs,
    pluginAgentDirs,
    mcpServers,
    nativeMcpServers,
    mcpServerPlugins,
    mcpSecrets: { writes: secretWrites, pluginIds },
    errors,
  }
}

/**
 * One server of one plugin's manifest, resolved exactly as
 * `loadPluginContributions` resolves it for the pool — `$.mcp.connect`
 * (mods/modMcp.ts) connects "one of the MCP servers this plugin's own
 * manifest lists" by its key. Undefined when the plugin lists no such server;
 * `refused` with the reason when it lists one that cannot start.
 */
export function pluginMcpServer(
  plugin: Pick<ActivePlugin, 'name' | 'path' | 'installIdentifier' | 'manifest' | 'providers' | 'mcpServers' | 'nativeMcpServers'>,
  key: string,
  scope: PluginMcpScope,
):
  | { kind: 'browser'; entry: MCPServerConfigWithName }
  | { kind: 'native'; id: string; config: NexusMcpServerLaunchConfig }
  | { kind: 'refused'; reason: string }
  | undefined {
  const browser = plugin.mcpServers && Object.hasOwn(plugin.mcpServers, key) ? plugin.mcpServers[key] : undefined
  const native = plugin.nativeMcpServers && Object.hasOwn(plugin.nativeMcpServers, key) ? plugin.nativeMcpServers[key] : undefined
  const server: PluginMcpServer | undefined = browser
    ? { kind: 'browser', config: browser }
    : native ? { kind: 'native', config: native } : undefined
  if (!server) return undefined
  const resolved = resolvePluginMcpServer(plugin, key, server, scope)
  if (!resolved.ok) return { kind: 'refused', reason: resolved.reason }
  return resolved.kind === 'native'
    ? { kind: 'native', id: key, config: resolved.config }
    : { kind: 'browser', entry: { name: key, ...resolved.config } }
}
