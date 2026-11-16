/**
 * A session's live plugin reload (`/plugins enable|disable`, a Settings write): re-runs discovery,
 * swaps the plugin hooks, follows the MCP pool and the mods, and returns the new command / agent /
 * plugin-summary sets for the engine to swap in.
 */

import type { BrowserRuntimeConfig } from '../../config/BrowserRuntimeConfig'
import type { BrowserUserInputPipeline } from '../../input/submitUserInput'
import type { MCPPool } from '../../mcp/pool'
import type { McpServerOriginSources } from '../../mcp/serverOrigin'
import type { acquireSessionMCPPool } from '../../mcp'
import type { PluginContributions } from '../../pluginHost'
import type { PluginProviderKeysMap } from '../../pluginHost/pluginMcpUserConfig'
import type { TemplateConfig } from '../../prompting/templateParsing'
import type { ChromiumCommandMetadata } from '../../runtime/CommandTypes'
import type { AgentProfile, WorkingState } from '../../runtime/RuntimeTypes'
import type { RuntimeFs } from '../../utils/fs/runtimeFs'
import { loadPluginContributions } from '../../pluginHost'
import { loadEffectiveEnabledPlugins } from '../../pluginHost/enabledStore'
import { runtimeProviderGate } from '../../pluginHost/providerGate'
import { describePluginError } from '../../pluginHost/pluginModel'
import { registerPluginHooks } from '../../pluginHost/registerPluginHooks'
import { removeSessionHooksBySkillRoot } from '../../lifecycleHooks/sessionScopedHooks'
import { loadLocalPromptCommands } from '../../skillLibrary/skillDiscovery'
import { loadLocalAgents } from '../../agents/agentRegistry'
import { withBuiltInAgents } from '../../agents/builtInAgents'
import { pluginMcpOwnersInScope, pluginMcpServersInScope } from '../../mcp/sessionMcpScope'
import type { CreateBrowserRuntimeOptions } from './createAgentRuntime'

export type SessionPluginReloadInput = {
  options: { locale?: string }
  resolvedOptions: Pick<CreateBrowserRuntimeOptions, 'commands' | 'agents'> & { sessionId: string }
  resolvedProjectRoot: string
  resolvedCwd: string
  resolvedSessionId: string
  installedFs: RuntimeFs
  homeDir: string | undefined
  runtimeConfig: BrowserRuntimeConfig
  settingsHome: () => string
  enabledPlugins: string[] | undefined
  templateType: string
  sessionTemplate: { config: TemplateConfig } | undefined
  /** Shared with the session's skill allowlist; refilled by each reload. */
  sessionTypeDeniedNames: string[]
  coreState: {
    setAppState: (updater: (prev: WorkingState) => WorkingState) => void
    options: { commands?: ChromiumCommandMetadata[]; agents?: AgentProfile[] }
  }
  userInputPipeline: Pick<BrowserUserInputPipeline, 'updatePluginLoadResult'>
  mcpLease: Pick<Awaited<ReturnType<typeof acquireSessionMCPPool>>, 'topLevelSessionId'> | undefined
  mcpScope: Parameters<typeof pluginMcpServersInScope>[0]
  mcpPool: MCPPool
  mcpOrigins: McpServerOriginSources
  setPluginNativeServers: (contributions: PluginContributions) => void
  refreshMcpOffering: () => void
  storeMcpSecrets: (contributions: PluginContributions) => Promise<Set<string>>
  /** Re-reads the plugin options and provider keys, updating the session's copies. */
  refreshPluginConfigs: () => Promise<{
    pluginConfigs: Record<string, { options?: Record<string, unknown> }>
    providerKeys: PluginProviderKeysMap
  }>
  currentAppState: () => WorkingState
  hostedCommands: () => ChromiumCommandMetadata[]
  mcpCommands: () => ChromiumCommandMetadata[]
  applySkillAllowlist: <T extends { name: string; source: string }>(
    list: readonly T[],
  ) => { allowed: T[]; deniedNames: string[] }
  reportUnresolvedSkills: (loaded: readonly { name: string; source: string }[]) => void
  reportUnresolvedAgents: (roster: readonly { name?: unknown }[]) => void
  reconcileMods: (plugins: PluginContributions['plugins']) => Promise<void>
  /** The plugins loaded at boot, whose hooks the first reload drops. */
  activePluginPaths: string[]
}


  // Live reload for `/plugins enable|disable`: re-run discovery with the new
  // allowlist, re-register hooks, refresh the `/plugins` snapshot, and return
  // the new command / agent / plugin-summary sets for the engine to swap in.
  // The top-level session's reload also brings its MCP pool in line with the
  // new plugin set; this runtime's tool list is not rebuilt, so a server that
  // joins serves the next build.
export function createPluginReload(input: SessionPluginReloadInput) {
  const {
    options,
    resolvedOptions,
    resolvedProjectRoot,
    resolvedCwd,
    resolvedSessionId,
    installedFs,
    homeDir,
    runtimeConfig,
    settingsHome,
    enabledPlugins,
    templateType,
    sessionTemplate,
    sessionTypeDeniedNames,
    coreState,
    userInputPipeline,
    mcpLease,
    mcpScope,
    mcpPool,
    mcpOrigins,
    setPluginNativeServers,
    refreshMcpOffering,
    storeMcpSecrets,
    refreshPluginConfigs,
    currentAppState,
    hostedCommands,
    mcpCommands,
    applySkillAllowlist,
    reportUnresolvedSkills,
    reportUnresolvedAgents,
    reconcileMods,
  } = input
  // Track the active plugin paths so a live reload can drop their hooks
  // before registering the new set.
  let activePluginPaths = input.activePluginPaths
  return async (requestedEnabledPlugins?: string[]) => {
    // No list (a Settings write, `$.config.set`): the enabled files as they
    // are NOW, by the same rule as boot. Folder names — never the loaded
    // plugins' manifest names, which need not match their folders.
    const nextEnabledPlugins =
      requestedEnabledPlugins
      ?? (await loadEffectiveEnabledPlugins({ cwd: resolvedProjectRoot, fs: installedFs, homeDir }))
      ?? enabledPlugins
    // Re-resolve the marketplace registry + enabled-id map on
    // every reload. Mirrors the boot-time path above so a user toggling
    // a plugin via /plugin enable|disable AND /plugins enable|disable
    // in the same reload both see fresh state. Failure is non-fatal —
    // legacy reloads keep working.
    let reloadInstallRegistry:
      | import('../../pluginHost/registryFormats').InstalledPluginsFile
      | undefined
    let reloadEnabledIds: Record<string, boolean> | undefined
    try {
      const homeDir = settingsHome()
      const fs = installedFs
      const installState = await import('../../pluginHost/loadPlugins')
        .then(m => m.loadMarketplaceInstallState({ homeDir }, installedFs))
      reloadInstallRegistry = installState.installRegistry
      const enabledPluginsModule = await import(
        '../../pluginHost/enabledPlugins'
      )
      reloadEnabledIds = await enabledPluginsModule.getEnabledPluginsMap(
        { homeDir }, fs,
      )
    } catch (e) {
      console.warn(
        `[onReloadPlugins] marketplace plugin reload skipped: ${e instanceof Error ? e.message : String(e)}`,
      )
    }
    const { pluginConfigs: mcpPluginConfigs, providerKeys: mcpProviderKeys } = await refreshPluginConfigs()
    const reloadContributions = await loadPluginContributions({
      cwd: resolvedProjectRoot,
      fs: installedFs,
      runtimeConfig,
      homeDir,
      enabledPlugins: nextEnabledPlugins,
      installRegistry: reloadInstallRegistry,
      enabledPluginIdentifiers: reloadEnabledIds,
      pluginConfigs: mcpPluginConfigs,
      providerKeys: mcpProviderKeys,
      requirements: runtimeProviderGate(),
      ...(options.locale !== undefined ? { locale: options.locale } : {}),
    })
    for (const pluginError of reloadContributions.errors) {
      console.warn(`[plugins] ${describePluginError(pluginError)}`)
    }
    const changedMcpSecrets = await storeMcpSecrets(reloadContributions)
    if (mcpLease && mcpLease.topLevelSessionId === resolvedSessionId) {
      // The reloaded set, under the same scope the pool was built with.
      setPluginNativeServers(reloadContributions)
      mcpOrigins.pluginServers = pluginMcpOwnersInScope(mcpScope, reloadContributions.mcpServerPlugins)
      try {
        await mcpPool.followPluginReload(
          pluginMcpServersInScope(mcpScope, reloadContributions.mcpServers, reloadContributions.mcpServerPlugins),
          changedMcpSecrets,
        )
      } catch (err) {
        console.warn('[mcp] plugin server reload failed:', err)
      }
      refreshMcpOffering()
    }
    sessionTypeDeniedNames.length = 0
    const reloadedCommands =
      resolvedOptions.commands
      ?? (await loadLocalPromptCommands({
        cwd: resolvedCwd,
        fs: installedFs,
        runtimeConfig,
        homeDir,
        pluginSkillDirs: reloadContributions.pluginSkillDirs,
        onSessionTypeDenied: name => sessionTypeDeniedNames.push(name),
        templateConfig: sessionTemplate?.config,
        // Live WorkingState — bundled-skill `isEnabled` callbacks gate on
        // the current feature toggles from the settings file.
        appState: currentAppState(),
        // Session-type stays constant for the lifetime of the runtime —
        // forward the same value the initial load used so a `/plugins`
        // reload doesn't accidentally widen the bundled-skill set.
        templateType,
      })).concat(hostedCommands(), mcpCommands())
    const reloadedAgents = withBuiltInAgents(
      resolvedOptions.agents
      ?? (await loadLocalAgents({
        cwd: resolvedCwd,
        fs: installedFs,
        runtimeConfig,
        homeDir,
        pluginAgentDirs: reloadContributions.pluginAgentDirs,
      })),
    )
    // Swap hooks: drop the previously-active plugins' hooks, then register
    // the new set.
    for (const path of activePluginPaths) {
      removeSessionHooksBySkillRoot(
        coreState.setAppState,
        resolvedOptions.sessionId,
        path,
      )
    }
    registerPluginHooks({
      setAppState: coreState.setAppState,
      sessionId: resolvedOptions.sessionId,
      plugins: reloadContributions.plugins,
    })
    activePluginPaths = reloadContributions.plugins.map(plugin => plugin.path)
    // The mods follow the plugin set (F-25). Never fatal to the reload.
    try {
      await reconcileMods(reloadContributions.plugins)
    } catch (error) {
      console.warn(`[mods] reload: ${error instanceof Error ? error.message : String(error)}`)
    }
    // Provider mods are global, not this session's: the realm's host scans
    // the person's plugins again (a no-op until the manager's boot ran).
    void import('../../mods/provider/providerModBoot').then(m => m.reloadProviderMods())
    // Refresh the read-only `/plugins` snapshot.
    userInputPipeline.updatePluginLoadResult({
      enabled: reloadContributions.plugins,
      disabled: reloadContributions.disabled,
      errors: reloadContributions.errors,
    })
    // Swap the runtime options too (`getSlashCommands` reads them). The allowlist and the denied
    // names apply to the reloaded list as well.
    const { allowed: allowedReloaded, deniedNames: deniedReloaded } =
      applySkillAllowlist(reloadedCommands)
    reportUnresolvedSkills(reloadedCommands)
    reportUnresolvedAgents(reloadedAgents)
    coreState.options.commands = allowedReloaded
    coreState.options.agents = reloadedAgents
    return {
      commands: allowedReloaded,
      deniedSkillNames: deniedReloaded,
      agents: reloadedAgents,
      plugins: reloadContributions.plugins.map(plugin => ({
        name: plugin.name,
        description: plugin.manifest.description,
      })),
    }
  }
}
