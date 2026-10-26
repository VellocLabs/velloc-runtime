/**
 * The MCP servers the person's enabled user-scope plugins declare, for the
 * MCP settings page's read-only list (F-10). Reads manifests only: nothing
 * is resolved or launched, and no option value is returned.
 */
import { launchTransportKind } from '../mcp/nativeBridge'
import type { McpServerTransportKind } from '../mcp/serverOrigin'
import type { RuntimeConfig } from '../runtime/interfaces/RuntimeConfig'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import { getEnabledPluginsMap } from './enabledPlugins'
import { loadEffectiveEnabledPlugins } from './enabledStore'
import { gatherPlugins, loadMarketplaceInstallState } from './loadPlugins'
import { splitByRequirements } from './pluginRequirements'
import { runtimeProviderGate } from './providerGate'
import type { ActivePlugin } from './pluginModel'

export type PluginMcpServerListing = {
  name: string
  plugin: string
  transport?: McpServerTransportKind
  /** An http server's URL, for its sign-in (F-10); absent while it names a
   *  plugin option, so no option value is returned. */
  url?: string
}

function listedUrl(url: string | undefined): { url: string } | Record<string, never> {
  return url && !url.includes('${') ? { url } : {}
}

/** The loader reads environment variables only to find a home; it is given. */
const NO_ENV = { getEnv: () => undefined } as unknown as RuntimeConfig

/** Each server of each plugin, sorted by plugin then server name. */
export function pluginMcpServerListings(
  plugins: ReadonlyArray<Pick<ActivePlugin, 'name' | 'mcpServers' | 'nativeMcpServers'>>,
): PluginMcpServerListing[] {
  const listings: PluginMcpServerListing[] = []
  for (const plugin of plugins) {
    for (const [name, config] of Object.entries(plugin.mcpServers ?? {})) {
      listings.push({
        name,
        plugin: plugin.name,
        transport: config.type,
        ...(config.type === 'http' ? listedUrl(config.url) : {}),
      })
    }
    for (const [name, config] of Object.entries(plugin.nativeMcpServers ?? {})) {
      const transport = launchTransportKind(config)
      listings.push({
        name,
        plugin: plugin.name,
        ...(transport ? { transport } : {}),
        ...(transport === 'http' ? listedUrl(config.url) : {}),
      })
    }
  }
  const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
  return listings.sort((a, b) => order(a.plugin, b.plugin) || order(a.name, b.name))
}

export async function listPluginMcpServers(deps: {
  homeDir: string
  fs: RuntimeFs
}): Promise<PluginMcpServerListing[]> {
  const { homeDir, fs } = deps
  const [{ installRegistry }, enabledIds, enabledDirs] = await Promise.all([
    loadMarketplaceInstallState({ homeDir }, fs),
    getEnabledPluginsMap({ homeDir }, fs),
    loadEffectiveEnabledPlugins({ cwd: homeDir, homeDir, fs }),
  ])
  const scan = await gatherPlugins({
    cwd: homeDir,
    runtimeConfig: NO_ENV,
    homeDir,
    fs,
    installRegistry,
    enabledPluginIdentifiers: enabledIds,
    ...(enabledDirs ? { enabledPlugins: enabledDirs } : {}),
  })
  // A plugin waiting on `requires` starts no server, so it lists none.
  return pluginMcpServerListings(splitByRequirements(scan.enabled, runtimeProviderGate()).effective)
}
