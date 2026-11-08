/**
 * Builds the realm's one `AppBackgroundRuntime` (F-40), imported only once an
 * app with a background module is published: the module loaders, the per-plugin
 * store and build store under `~/.velloc/mods`, `$.http.fetch` over the host.
 */

import { ensureDirRecursive } from '../../pluginHost/writeExtracted'
import { readUserLayer } from '../../settings/settingsStore'
import { fileModBuildStore } from '../modBuildStore'
import { fileModStore } from '../modStore'
import { createProviderModHttp } from '../provider/nouns/providerNounDeps'
import { providerModsDir, providerModuleLoaders } from '../provider/providerModuleLoaders'
import { AppBackgroundRuntime } from './AppBackgroundRuntime'
import type { AppBackgroundBootDeps } from './appBackgroundBoot'

export function createAppBackgroundRuntime(deps: AppBackgroundBootDeps & { report: (line: string) => void }): AppBackgroundRuntime {
  const { fs, homeDir, report } = deps
  const modsDir = providerModsDir(homeDir)
  const storeFs = {
    readFile: (path: string, o: { encoding: string }) => fs.readFile(path, o),
    writeFile: (path: string, data: string, o?: { encoding?: string }) => fs.writeFile(path, data, o),
    ensureDir: (dir: string) => ensureDirRecursive(fs, dir),
  }
  const loaders = providerModuleLoaders({ homeDir, fs, report })
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
    report,
    ...(deps.locale ? { locale: deps.locale } : {}),
  })
}
