import type { BrowserRuntimeConfig } from '../../config/BrowserRuntimeConfig'
import { loadEffectiveEnabledPlugins } from '../../pluginHost/enabledStore'
import type { RuntimeFs } from '../../utils/fs/runtimeFs'

/**
 * The marketplace install registry + settings.json's
 * `enabledPlugins` map, so marketplace-installed
 * plugins (under `~/.velloc/plugins/cache/...`) are discovered
 * alongside legacy directory-walk plugins. Failure here is
 * non-fatal — marketplace state simply isn't loaded for this
 * session and the legacy plugin path keeps working.
 */
export async function loadMarketplaceDiscovery(
  settingsHome: () => string,
  installedFs: RuntimeFs,
): Promise<{
  installRegistry: import('../../pluginHost/registryFormats').InstalledPluginsFile | undefined
  enabledPluginIdentifiers: Record<string, boolean> | undefined
}> {
  let installRegistry: import('../../pluginHost/registryFormats').InstalledPluginsFile
    | undefined
  let enabledPluginIdentifiers: Record<string, boolean> | undefined
  try {
    const homeDir = settingsHome()
    const fs = installedFs
    const installState = await import('../../pluginHost/loadPlugins')
      .then(m => m.loadMarketplaceInstallState({ homeDir }, installedFs))
    installRegistry = installState.installRegistry
    const enabledPluginsModule = await import(
      '../../pluginHost/enabledPlugins'
    )
    enabledPluginIdentifiers = await enabledPluginsModule.getEnabledPluginsMap(
      { homeDir }, fs,
    )
  } catch (e) {
    console.warn(
      `[createBrowserRuntime] marketplace plugin discovery skipped: ${e instanceof Error ? e.message : String(e)}`,
    )
  }
  return { installRegistry, enabledPluginIdentifiers }
}

export type SessionPluginRescanInput = {
  settingsHome: () => string
  installedFs: RuntimeFs
  resolvedProjectRoot: string
  runtimeConfig: BrowserRuntimeConfig
  homeDir: string | undefined
  enabledPlugins: string[] | undefined
}

/**
 * `/plugins enable <name>` of a folder copied in after this session
 * loaded: the same discovery as boot and reload, read off the disk now.
 */
export async function rescanSessionPlugins({
  settingsHome,
  installedFs,
  resolvedProjectRoot,
  runtimeConfig,
  homeDir,
  enabledPlugins,
}: SessionPluginRescanInput) {
  const [loader, enabledStore] = await Promise.all([
    import('../../pluginHost/loadPlugins'),
    import('../../pluginHost/enabledPlugins'),
  ])
  const pathCtx = { homeDir: settingsHome() }
  const [installState, enabledIds, allowlist] = await Promise.all([
    loader.loadMarketplaceInstallState(pathCtx, installedFs).catch(() => undefined),
    enabledStore.getEnabledPluginsMap(pathCtx, installedFs).catch(() => undefined),
    loadEffectiveEnabledPlugins({ cwd: resolvedProjectRoot, fs: installedFs, homeDir }),
  ])
  return loader.gatherPlugins({
    cwd: resolvedProjectRoot,
    runtimeConfig,
    homeDir,
    fs: installedFs,
    enabledPlugins: allowlist ?? enabledPlugins,
    installRegistry: installState?.installRegistry,
    enabledPluginIdentifiers: enabledIds,
  })
}
