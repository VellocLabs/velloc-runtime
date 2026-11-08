/**
 * Builds the realm's one `AppBackgroundRuntime` (F-40), imported only once an
 * app with a background module is published: the module loaders, the per-plugin
 * store and build store under `~/.velloc/mods`, `$.http.fetch` over the host,
 * `$.mcp` as a pool per module over the host's MCP primitives.
 */

import { MCPPool } from '../../mcp/pool'
import { getMcpHost, hostServesWorkerMcp } from '../../mcp/mcpHost'
import { createWorkerMcpOperations } from '../../mcp/workerServers'
import { getPluginConfigsMap, getPluginProviderKeys } from '../../pluginHost/pluginConfigs'
import { ensureDirRecursive } from '../../pluginHost/writeExtracted'
import { readUserLayer } from '../../settings/settingsStore'
import { fileModBuildStore } from '../modBuildStore'
import { fileModStore } from '../modStore'
import { createProviderModHttp } from '../provider/nouns/providerNounDeps'
import { providerModsDir, providerModuleLoaders } from '../provider/providerModuleLoaders'
import { AppBackgroundRuntime } from './AppBackgroundRuntime'
import type { AppBackgroundBootDeps } from './appBackgroundBoot'
import { createAppBackgroundMcp } from './appBackgroundMcp'

export function createAppBackgroundRuntime(deps: AppBackgroundBootDeps & { report: (line: string) => void }): AppBackgroundRuntime {
  const { fs, homeDir, report } = deps
  const modsDir = providerModsDir(homeDir)
  const storeFs = {
    readFile: (path: string, o: { encoding: string }) => fs.readFile(path, o),
    writeFile: (path: string, data: string, o?: { encoding?: string }) => fs.writeFile(path, data, o),
    ensureDir: (dir: string) => ensureDirRecursive(fs, dir),
  }
  const loaders = providerModuleLoaders({ homeDir, fs, report })
  // Security: a background module's servers are a plugin's, so none may be on
  // loopback or a private network; stdio servers run over the host's
  // primitives only where the host serves them.
  const nativeBridge = () => {
    const host = getMcpHost()
    if (!host || !hostServesWorkerMcp(host.manifest)) return undefined
    return createWorkerMcpOperations({
      resolveHost: () => getMcpHost(),
      createRequestId: () => crypto.randomUUID(),
      allowPrivateNetwork: () => false,
    })
  }
  return new AppBackgroundRuntime({
    readModule: loaders.readModule,
    ...(loaders.compile ? { compile: loaders.compile } : {}),
    ...(loaders.scan ? { scan: loaders.scan } : {}),
    builds: fileModBuildStore(fs, modsDir, { ensureDir: dir => ensureDirRecursive(fs, dir) }),
    store: plugin => fileModStore(modsDir, plugin, storeFs, { report }),
    http: createProviderModHttp({
      transport: () => deps.transport(),
      denyRules: async () => {
        const deny = (await readUserLayer(homeDir, fs)).settings.permissions?.deny
        return deny && deny.length > 0 ? { userSettings: [...deny] } : undefined
      },
    }),
    fs,
    mcp: ref =>
      createAppBackgroundMcp({
        owner: ref.mcpOwner,
        folder: ref.folder,
        scope: async () => ({
          configs: await getPluginConfigsMap({ homeDir }, fs),
          providers: await getPluginProviderKeys({ homeDir }, fs),
        }),
        createPool: ({ cwd }) => {
          const bridge = nativeBridge()
          return new MCPPool({
            cwd,
            fs,
            projectServers: false,
            ...(bridge ? { nativeBridge: bridge, loadNativeServers: async () => [] } : {}),
          })
        },
        report,
      }),
    report,
    ...(deps.locale ? { locale: deps.locale } : {}),
  })
}
