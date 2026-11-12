/**
 * Builds the realm's one `AppBackgroundRuntime` (F-40), imported only once an
 * app with a background module is published: the module loaders, the per-plugin
 * store and build store under `~/.velloc/mods`, `$.http.fetch` over the host,
 * `$.mcp` as a pool per module over the host's MCP primitives, `$.app.analyze`
 * over the realm's headless spawn.
 */

import { MCPPool } from '../../mcp/pool'
import { getMcpHost, hostServesWorkerMcp } from '../../mcp/mcpHost'
import { createWorkerMcpOperations } from '../../mcp/workerServers'
import { createNativePrimitives } from '../../browser/bridge/nativePrimitives'
import { getPluginConfigsMap, getPluginProviderKeys } from '../../pluginHost/pluginConfigs'
import { storePluginSecrets, type PluginSecretWrite } from '../../pluginHost/pluginMcpUserConfig'
import { ensureDirRecursive } from '../../pluginHost/writeExtracted'
import { readUserLayer } from '../../settings/settingsStore'
import { fileModBuildStore } from '../modBuildStore'
import { fileModStore } from '../modStore'
import { createProviderModHttp } from '../provider/nouns/providerNounDeps'
import { providerModsDir, providerModuleLoaders } from '../provider/providerModuleLoaders'
import { AppBackgroundRuntime, type AppBackgroundRuntimeOptions } from './AppBackgroundRuntime'
import type { AppBackgroundBootDeps } from './appBackgroundBoot'
import { createAppBackgroundMcp } from './appBackgroundMcp'
import type { AppMcpStatusSource } from './appMcpStatus'
import { currentMcpOAuthService, onMcpOAuthServiceChanged } from '../../mcp/oauth/mcpOAuthHolder'

export function createAppBackgroundRuntime(
  deps: AppBackgroundBootDeps & { report: (line: string) => void } & Pick<AppBackgroundRuntimeOptions, 'onBadge' | 'onBusy' | 'onView'>,
): AppBackgroundRuntime {
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
  // A sensitive option reaches a server as a stored secret, as a session
  // stores it; never pruned here, since a session owns the full set.
  const storeSecrets = async (writes: PluginSecretWrite[]): Promise<void> => {
    const host = getMcpHost()
    if (!host) throw new Error('the host port is not attached')
    if (host.manifest && !host.manifest.capabilities.includes('secrets')) throw new Error('this host stores no secrets')
    const { secrets } = createNativePrimitives({ transport: host.transport, createRequestId: () => crypto.randomUUID(), ...(host.manifest ? { manifest: host.manifest } : {}) })
    await storePluginSecrets(writes, [], secrets, report, { prune: false })
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
        scope: async () => {
          const [configs, providers] = await Promise.all([getPluginConfigsMap({ homeDir }, fs), getPluginProviderKeys({ homeDir }, fs)])
          return { configs, providers }
        },
        getEnv: name => deps.env?.()?.[name],
        storeSecrets,
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
    mcpStatus: realmMcpStatus(),
    report,
    ...(deps.locale ? { locale: deps.locale } : {}),
    ...(deps.onBadge ? { onBadge: deps.onBadge } : {}),
    ...(deps.onBusy ? { onBusy: deps.onBusy } : {}),
    ...(deps.onView ? { onView: deps.onView } : {}),
    ...(deps.runAgent ? { runAgent: deps.runAgent } : {}),
  })
}

/** The realm's sign-in state, followed across the service being installed or replaced. */
export function realmMcpStatus(): AppMcpStatusSource {
  return {
    read: () => currentMcpOAuthService()?.getState() ?? null,
    onChange: listener => {
      let stopState = currentMcpOAuthService()?.onStateChange(() => listener())
      const stopHolder = onMcpOAuthServiceChanged(() => {
        stopState?.()
        stopState = currentMcpOAuthService()?.onStateChange(() => listener())
        listener()
      })
      return () => {
        stopState?.()
        stopHolder()
      }
    },
  }
}
