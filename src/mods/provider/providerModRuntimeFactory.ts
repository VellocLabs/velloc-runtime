/**
 * Builds the realm's one `ProviderModRuntime`, imported only once an enabled plugin
 * carries a provider: load (read, compile, scan, `$.store`) and work (`$.provider`,
 * `$.http.fetch`, `$.catalog`) wiring, plus the deleted-session ender.
 */

import { runtimeProviderConfigs } from '../../models/drivers/runtimeProviders'
import { getPluginConfigsMap } from '../../pluginHost/pluginConfigs'
import { readUserLayer } from '../../settings/settingsStore'
import { ensureDirRecursive } from '../../pluginHost/writeExtracted'
import type { RuntimeFs } from '../../utils/fs/runtimeFs'
import { fileModStore } from '../modStore'
import { ProviderModRuntime } from './ProviderModRuntime'
import { providerModsDir, providerModuleLoaders } from './providerModuleLoaders'
import { startCatalogRelisting } from './catalogRelisting'
import {
  isProviderSetUp,
  onRuntimeProviderConfigsChanged,
  publishListingsChanged,
  refreshRuntimeProviderModels,
  runtimeProviderConfigsLoaded,
} from '../../models/drivers/runtimeProviders'
import {
  createProviderJobScheduler,
  setProviderJobScheduler,
  type ProviderJobEvent,
  type ProviderJobScheduler,
} from './providerJobScheduler'
import { getRuntimeModelCatalog } from '../../catalog/runtimeModelCatalog'
import { catalogReaderOf, createProviderCatalogNoun } from './nouns/providerCatalogNoun'
import { createProviderModHttp, createProviderNounSet } from './nouns/providerNounDeps'
import { providerHostSources } from './providerHostSources'
import { getProviderModHost, onProviderModRegistered } from './providerModHost'
import { createSessionEnder, setProviderSessionEnder } from './providerSessionEnd'
import { providerSeamListener } from './providerSeamWiring'
import { fileModBuildStore } from '../modBuildStore'
import { pluginOwnFileReader } from './pluginOwnFiles'

export type ProviderModRuntimeFactoryDeps = {
  homeDir: string
  fs: RuntimeFs
  report: (line: string) => void
  /** The language every provider event carries (`e.locale`). */
  locale?: () => string | undefined
}

export function createProviderModRuntime(deps: ProviderModRuntimeFactoryDeps): ProviderModRuntime {
  const { fs, homeDir, report } = deps
  const modsDir = providerModsDir(homeDir)
  const storeFs = {
    readFile: (path: string, o: { encoding: string }) => fs.readFile(path, o),
    writeFile: (path: string, data: string, o?: { encoding?: string }) => fs.writeFile(path, data, o),
    ensureDir: (dir: string) => ensureDirRecursive(fs, dir),
  }
  const sources = (): ReturnType<typeof providerHostSources> => providerHostSources()
  const registrationOf = (providerId: string) => {
    const registration = getProviderModHost()
      .registered()
      .find(entry => entry.providerId === providerId)
    return registration
      ? { manifest: registration.manifest, ...(registration.configId !== undefined ? { configId: registration.configId } : {}) }
      : undefined
  }
  const nouns = createProviderNounSet({
    homeDir,
    fs,
    report,
    sources,
    registrationOf,
    storedConfigOf: providerId => runtimeProviderConfigs()[providerId],
    readOptions: async configId => (await getPluginConfigsMap({ homeDir }, fs))[configId]?.options,
  })

  // `$.catalog`: the realm's model catalog, read-only. Built lazily; nothing
  // is fetched until a module asks.
  const modelCatalog = getRuntimeModelCatalog({ homeDir, fs, transport: () => sources().transport?.() ?? null })
  const catalog = createProviderCatalogNoun(catalogReaderOf(modelCatalog))
  // When the catalog's data for a provider a module read changed, that
  // module's listing is run again (F-28 section 7) - the runtime's ordinary
  // listing path, so a failure keeps the rows already shown.
  startCatalogRelisting({
    onCatalogUpdated: listener => modelCatalog.onUpdated(listener),
    providerIds: () => getProviderModHost().registered().map(entry => entry.providerId),
    readKeysOf: catalog.readKeysOf,
    relist: async providerId => {
      const transport = sources().transport?.()
      if (!transport || !isProviderSetUp(providerId)) return false
      return (await refreshRuntimeProviderModels(transport, providerId, { force: true })).ok
    },
    publish: publishListingsChanged,
    report,
  })

  // Every provider a plugin registers gets the request seam, so its hooks run
  // on every request it makes (and a provider whose hooks cannot be attached
  // fails closed), and - when it states id rules - its id mapper, which keeps
  // its maps with the session. Providers already registered are replayed.
  onProviderModRegistered(providerSeamListener(report, nouns.ids))

  // Read, compile and scan are the update service's admission too.
  const loaders = providerModuleLoaders({ homeDir, fs, report })
  const runtime = new ProviderModRuntime({
    readModule: loaders.readModule,
    ...(loaders.compile ? { compile: loaders.compile } : {}),
    ...(loaders.scan ? { scan: loaders.scan } : {}),
    store: plugin => fileModStore(modsDir, plugin, storeFs, { report }),
    // Unchanged modules are not read, compiled or scanned again (`modBuildStore.ts`).
    builds: fileModBuildStore(fs, modsDir, { ensureDir: dir => ensureDirRecursive(fs, dir) }),
    providerNouns: nouns.table,
    catalogNouns: catalog.table,
    readPluginFile: pluginOwnFileReader(fs),
    http: createProviderModHttp({
      transport: () => sources().transport?.() ?? null,
      denyRules: async () => {
        const deny = (await readUserLayer(homeDir, fs)).settings.permissions?.deny
        return deny && deny.length > 0 ? { userSettings: [...deny] } : undefined
      },
    }),
    report,
    ...(deps.locale ? { locale: deps.locale } : {}),
  })
  setProviderSessionEnder(
    createSessionEnder({
      runtime,
      providerIds: () => getProviderModHost().registered().map(entry => entry.providerId),
      end: nouns.endProviderSession,
      report,
    }),
  )

  // The declared jobs: planned from the registrations and the set-up state,
  // each run a `provider.job` call that loads the module on demand.
  const jobs = createProviderJobScheduler({
    providers: () =>
      getProviderModHost()
        .registered()
        .map(entry => ({ providerId: entry.providerId, jobs: entry.manifest.jobs ?? [] })),
    connected: isProviderSetUp,
    ready: runtimeProviderConfigsLoaded,
    run: (providerId, e, options) => raiseProviderJob(runtime, providerId, e, options),
    report: line => report(`jobs: ${line}`),
  })
  const unfollow = [followProviderRegistrations(jobs), onRuntimeProviderConfigsChanged(() => jobs.sync())]
  setProviderJobScheduler({
    ...jobs,
    dispose: () => {
      for (const stop of unfollow) stop()
      jobs.dispose()
    },
  })
  return runtime
}

/**
 * Sync the jobs on every registration and removal. A removal syncs after the
 * current task: a plugin registered again is detached and attached with no
 * await between, so its jobs keep their state across the swap.
 */
export function followProviderRegistrations(
  jobs: Pick<ProviderJobScheduler, 'sync'>,
  subscribe: (listener: () => () => void) => () => void = onProviderModRegistered,
): () => void {
  return subscribe(() => {
    jobs.sync()
    return () => queueMicrotask(() => jobs.sync())
  })
}

/**
 * One `provider.job` call. Resolves false when the module does not hook the
 * event. A hook that threw, ran out of its budget or handed on with
 * `next(e)` reaches the core, which is reported as a failed run.
 */
export async function raiseProviderJob(
  runtime: Pick<ProviderModRuntime, 'call'>,
  providerId: string,
  e: ProviderJobEvent,
  options: { budgetMs: number; signal: AbortSignal },
): Promise<boolean> {
  let unanswered = false
  const outcome = await runtime.call<void>(providerId, 'provider.job', e, {
    signal: options.signal,
    budgetMs: options.budgetMs,
    core: () => {
      unanswered = true
    },
  })
  if (unanswered) throw new Error('the provider.job hook failed or ran out of time')
  return outcome.raised
}
