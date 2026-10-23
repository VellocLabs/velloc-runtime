import type { DirectPortBridgeTransport } from '../bridge/DirectPortBridgeTransport'
import type { BrowserHostManifest } from '../bridge/protocol/manifest'
import { createBridgeRoute } from '../bridge/protocol/core'
import { lendProviderHostSources } from '../../mods/provider/providerHostSources'
import { fetchManagedBinaryRegistry } from '../../utils/binaryRegistry'
import { createBrowserFsOperations } from '../../utils/BrowserFsOperations'
import {
  processFs,
  type RuntimeFs,
} from '../../utils/fs/runtimeFs'
import { readUserLayer } from '../../settings/settingsStore'
import {
  makeBridgeSecretSealer,
  sealPersistedProviderApiKeys,
} from '../bridge/adapter/providersBridgeAdapter'
import {
  hostListShowsProviderSetUp,
  seedOpencodeZenProvider,
} from './seedOpencodeZen'
import { NEXUS_MODEL_CONFIG } from '../../config/nexusModelConfig'
import { serializeNexusModelConfig } from '../../config/nexusModelConfigWire'
import { setCustomProviderRecords } from '../../config/customProviderRegistry'
import {
  publishListingsChanged,
  setRuntimeProviderConfigs,
  withRuntimeProviderBaseUrls,
} from '../../models/drivers/runtimeProviders'
import { withProviderUserAgents } from '../../config/providerUserAgent'
import { withProviderSecretMirror } from '../../config/providerSecrets'
import { withConcreteDefaultModels } from '../../models/drivers/modelEntryCatalog'
import type { NexusProviderConfig } from '../../settings/settingsTypes'
import { publishProviderBaseUrlsFromConfigs } from '../../models/endpoints/endpointTrust'
import { refreshBrokerProviderBaseUrls } from './brokerProviderView'
import {
  initializeRoutineRuntime,
  type RoutineRuntimeHandle,
} from '../../routines/routineRuntime'
import { getRoutineRegistry } from '../../routines/RoutineRegistry'
import type {
  CanDeliverRoutineToSession,
  DeliverRoutineToSession,
} from '../../routines/SessionDeliveryRunner'
import { reconcileNightlyTidyCron } from '../../routines/nightlyTidyCron'
import { parseMemoryMaintenance } from '../../memory/memoryPaths'
import {
  TeamRegistry,
  setTeamRegistry,
} from '../../team/TeamRegistry'
import type {
  NotificationEvent,
  NotificationSink,
} from '../../routines/NotificationHub'
import type { RoutineCoordinator } from './RoutineCoordinator'
import { installRuntimeRenderCache } from '../../renderCache/runtimeRenderCache'
import { readIdlePurgeEnabled } from '../../renderCache/idlePurgeFlag'
import { TerminalService, type CliConversationStore } from '../../terminal/TerminalService'

export interface ManagerBootServicesHost {
  getDirectBridgeTransport(): DirectPortBridgeTransport | null
  createBridgeRequestId(): string
  getHomeDir(): string | null
  /** The host's home, asked before storage is up (the probe storage itself
   *  awaits); null when the host does not answer. Absent: only `getHomeDir`. */
  resolveHomeDir?(): Promise<string | null>
  /** The most recently attached window's locale, if any window has said. */
  getLocale?(): string | undefined
  /** Every session's plugins load again (a plugin's `requires` was met or lost). */
  reloadPluginsOnAllSessions?(): void
  /** The host half of the init payload the desktop page published, if any
   *  (a provider mod's `$.provider.device()` reads the user agent and locale). */
  getHostEnvironment?(): { userAgent?: string; locale?: string } | null
  /** The host manifest from the latest init payload, if any (F-30 reads `primitives`). */
  getHostManifest?(): Pick<BrowserHostManifest, 'capabilities' | 'primitives'> | null
  storageRoot(): string | null
  spawnHeadlessSession: RoutineCoordinator['spawnHeadlessSession']
  deliverRoutineToSession: DeliverRoutineToSession
  canDeliverRoutineToSession: CanDeliverRoutineToSession
  scheduleSummary(): void
  /** Some session is running a turn (the render-cache purge waits for none). */
  isAnySessionBusy?(): boolean
  /** Where a session's terminal starts (F-31): its worktree when it runs in one, else its project
   *  root; undefined for a session the runtime does not hold. Absent: no terminal can be created. */
  getSessionCwd?(sessionId: string): string | undefined
  /** Where a CLI session's conversation id is kept (F-34). Absent: no CLI can be started. */
  cliConversations?: CliConversationStore
  trace(event: string, data?: Record<string, unknown>): void
}

/**
 * Owns manager-wide services that boot after storage and the direct bridge are
 * available. None of these responsibilities participate in session routing.
 */
export class ManagerBootServices {
  private managerFs: RuntimeFs | null = null
  private routineRuntimeHandle: RoutineRuntimeHandle | null = null
  private teamRegistryBooted = false
  private providerModsBoot: Promise<void> | null = null
  private modelCatalogInstalled = false
  private readonly directBridgeWaiters = new Set<
    (transport: DirectPortBridgeTransport) => void
  >()
  /**
   * The runtime's terminals (F-31), on the runtime's host port: the port and
   * the manifest are read per call, so a replaced port is the one used and
   * no long-lived service is stranded on a disposed transport.
   */
  readonly terminals: TerminalService

  constructor(private readonly host: ManagerBootServicesHost) {
    this.terminals = new TerminalService({
      host: () => ({
        transport: host.getDirectBridgeTransport(),
        manifest: host.getHostManifest?.() ?? null,
      }),
      createRequestId: () => host.createBridgeRequestId(),
      sessionCwd: sessionId => host.getSessionCwd?.(sessionId),
      cliConversations: host.cliConversations,
    })
  }

  onStorageReady(): void {
    void this.bootRoutineRuntimeOnce()
    void this.bootTeamRuntimeOnce()
    void this.publishProviderConfigsAtBoot()
    void this.bootProviderModsOnce()
    void this.installModelCatalogOnce()
    void this.publishBinaryRegistryAtBoot()
  }

  onDirectTransportAttached(transport: DirectPortBridgeTransport): void {
    this.managerFs = null
    // Every host port needs the catalog, not just the first: each window's
    // guest brings its own port service, and a newer one replaces this.
    void this.publishModelCatalog(transport)
    // The team registry needs a transport (below); if storage became ready
    // before one existed, this is the retry. Idempotent.
    void this.bootTeamRuntimeOnce()
    // …and so does the provider-mod scan: it reads plugins through the fs. It
    // starts here, not at storage ready, so the plugin launchers are published
    // before the first window subscribes (F-25).
    void this.bootProviderModsOnce()
    // …and the model catalog (its cache lives under the home, read by the fs).
    void this.installModelCatalogOnce()
    // Client auto-update (F-30) needs the port and the manifest; retried per port and per manifest until it starts.
    void this.installAppUpdate()
    // The render-cache purge policy needs the port and the manifest too.
    this.installRenderCache()
    // …and the terminals: availability follows the manifest's primitives and the
    // shell list is asked of each new port.
    this.terminals.refreshHost()
    const waiters = [...this.directBridgeWaiters]
    this.directBridgeWaiters.clear()
    for (const resolve of waiters) {
      resolve(transport)
    }
  }

  /** The host manifest may have arrived after the port: retry what gates on it. */
  onHostManifestChanged(): void {
    this.terminals.refreshHost()
    if (!this.host.getDirectBridgeTransport()) return
    void this.installAppUpdate()
    this.installRenderCache()
  }

  /** The host port went away: the streams it carried died with it. */
  onDirectTransportDetached(): void {
    this.terminals.hostGone()
  }

  getManagerFs(): RuntimeFs {
    const transport = this.host.getDirectBridgeTransport()
    if (!transport) {
      return processFs()
    }
    if (!this.managerFs) {
      this.managerFs = createBrowserFsOperations({
        transport,
        createRequestId: () => this.host.createBridgeRequestId(),
        initialCwd: '.',
      })
    }
    return this.managerFs
  }

  /**
   * Stable fs facade for long-lived services. Every method invocation resolves
   * the current transport-bound manager fs, so replacing the direct port does
   * not strand a routine registry on a disposed adapter.
   */
  private createTransportResolvingFs(): RuntimeFs {
    return new Proxy({} as RuntimeFs, {
      get: (_target, property) => {
        const current = this.getManagerFs()
        const value = Reflect.get(current as object, property)
        if (typeof value !== 'function') {
          return value
        }
        return (...args: unknown[]) => {
          const latest = this.getManagerFs()
          const method = Reflect.get(latest as object, property)
          return Reflect.apply(method, latest, args)
        }
      },
    })
  }

  /**
   * Model catalog (F-28): point the hub's catalog capability (the Model data
   * settings row) at the realm's one catalog service, the same one `$.catalog`
   * reads. Nothing is fetched here: the built-in rows' figures are read
   * from what the cache or the bundle snapshot holds, passively. The fs resolves the current port on every call, so a reconnect does
   * not strand the long-lived service on a disposed transport. Once only.
   */
  private async installModelCatalogOnce(): Promise<void> {
    if (this.modelCatalogInstalled) return
    const homeDir = this.host.getHomeDir()
    if (!homeDir || !this.host.getDirectBridgeTransport()) return
    this.modelCatalogInstalled = true
    try {
      const { installRuntimeModelCatalog, getRuntimeModelCatalog } = await import('../../catalog/runtimeModelCatalog')
      const deps = {
        homeDir,
        fs: this.createTransportResolvingFs(),
        transport: () => this.host.getDirectBridgeTransport(),
      }
      installRuntimeModelCatalog(deps)
      // Built-in providers read the figures their rows leave unset from the
      // catalog (config/nexusModelConfig/catalogFigures.ts). The first read
      // starts now; the catalog fetch waits for it. When figures change, the
      // host gets the model config again and the surfaces re-read.
      const { startBuiltinCatalogFill } = await import('../../catalog/builtinCatalogFill')
      startBuiltinCatalogFill({
        catalog: getRuntimeModelCatalog(deps),
        publish: async providerIds => {
          const transport = this.host.getDirectBridgeTransport()
          if (transport) await this.publishModelCatalog(transport)
          await publishListingsChanged(providerIds)
        },
        report: line => console.warn(line),
      })
    } catch (error) {
      this.modelCatalogInstalled = false
      console.warn('[ManagerBootServices] model catalog install failed:', error instanceof Error ? error.message : error)
    }
  }

  private installRenderCache(): void {
    const skipped = installRuntimeRenderCache({
      transport: () => this.host.getDirectBridgeTransport(),
      manifest: () => this.host.getHostManifest?.() ?? null,
      createRequestId: () => this.host.createBridgeRequestId(),
      isAnyBusy: () => this.host.isAnySessionBusy?.() ?? false,
      idlePurgeEnabled: async () => {
        const homeDir = this.host.getHomeDir()
        if (!homeDir) return true
        return readIdlePurgeEnabled(homeDir, this.getManagerFs())
      },
    })
    if (skipped) this.host.trace('render_cache.skipped', { reason: skipped })
  }

  private async installAppUpdate(): Promise<void> {
    try {
      const { installRuntimeAppUpdate } = await import('../../appUpdate/runtimeAppUpdate')
      const skipped = await installRuntimeAppUpdate({
        transport: () => this.host.getDirectBridgeTransport(),
        manifest: () => this.host.getHostManifest?.() ?? null,
        createRequestId: () => this.host.createBridgeRequestId(),
      })
      if (skipped) this.host.trace('app_update.skipped', { reason: skipped })
    } catch (error) {
      console.warn('[ManagerBootServices] app update install failed:', error instanceof Error ? error.message : error)
    }
  }

  /**
   * Provider mods (F-27): scan the person's plugins and register the
   * providers they add. Manifests only — no worker starts, and a realm with
   * no provider plugin never loads the runtime's code. Needs the fs and the
   * home, not storage: it starts as soon as a transport is attached. Once
   * only; a boot that found no home is retried by the next trigger.
   */
  private bootProviderModsOnce(): Promise<void> {
    if (this.providerModsBoot) return this.providerModsBoot
    if (!this.host.getDirectBridgeTransport()) return Promise.resolve()
    const boot = this.bootProviderMods()
    this.providerModsBoot = boot
    return boot
  }

  private async bootProviderMods(): Promise<void> {
    const homeDir =
      this.host.getHomeDir() ?? (await this.host.resolveHomeDir?.().catch(() => null)) ?? null
    if (!homeDir || !this.host.getDirectBridgeTransport()) {
      this.providerModsBoot = null
      return
    }
    // What a provider module's nouns reach for, read when they are called.
    lendProviderHostSources({
      transport: () => this.host.getDirectBridgeTransport(),
      hostEnvironment: () => this.host.getHostEnvironment?.() ?? null,
    })
    try {
      const { bootProviderMods } = await import('../../mods/provider/providerModBoot')
      await bootProviderMods({
        homeDir,
        fs: this.createTransportResolvingFs(),
        transport: () => this.host.getDirectBridgeTransport(),
        locale: () => this.host.getLocale?.(),
        onRequirementsChanged: () => this.host.reloadPluginsOnAllSessions?.(),
      })
    } catch (error) {
      this.host.trace('providerMods.boot_failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private async publishProviderConfigsAtBoot(): Promise<void> {
    const transport = this.host.getDirectBridgeTransport()
    const homeDir = this.host.getHomeDir()
    if (!transport || !homeDir) {
      return
    }
    try {
      // First run: give a profile with no provider the keyless OpenCode Zen
      // free tier. Best-effort and once per profile; ahead of the load so
      // this boot already publishes it, and of the sealing, which seals it.
      // The host is asked too: a provider held only in the broker pref is
      // invisible to settings.json but is still the user's setup.
      // A no-op while Zen is switched off (`OPENCODE_ZEN_ENABLED`).
      await seedOpencodeZenProvider(homeDir, this.getManagerFs(), async () => {
        const res = await transport.request({
          id: this.host.createBridgeRequestId(),
          route: createBridgeRoute('providerAuth', 'list'),
          payload: {},
        })
        if (!res.ok) {
          throw new Error(`${res.error.code}: ${res.error.message}`)
        }
        return hostListShowsProviderSetUp(res.result.providers ?? [])
      }).catch(() => {})
      const { settings } = await readUserLayer(homeDir, this.getManagerFs())
      const providers = settings.providers
      // Migration: seal any plaintext api key still on disk (a settings.json
      // from before sealing existed, or one edited by hand) BEFORE the
      // configs are published anywhere. No-op when every key is already
      // sealed, which is every boot after the first.
      const userConfigs = await sealPersistedProviderApiKeys({
        homeDir,
        fs: this.getManagerFs(),
        encryptSecret: makeBridgeSecretSealer(
          req => transport.request(req),
          () => this.host.createBridgeRequestId(),
        ),
      })
      setCustomProviderRecords(userConfigs)
      setRuntimeProviderConfigs(userConfigs)

      // Stream guards are curated catalog properties, not settings fields.
      const configs: Record<string, NexusProviderConfig> = {}
      for (const provider of NEXUS_MODEL_CONFIG.providers) {
        const streamGuard: Record<string, number> = {}
        if (provider.streamIdleTimeoutSeconds !== undefined) {
          streamGuard.streamIdleTimeoutSeconds =
            provider.streamIdleTimeoutSeconds
        }
        if (provider.maxConcurrentStreams !== undefined) {
          streamGuard.maxConcurrentStreams = provider.maxConcurrentStreams
        }
        configs[provider.providerId] = {
          ...(userConfigs[provider.providerId] ?? {}),
          ...streamGuard,
        } as NexusProviderConfig
      }
      for (const [id, config] of Object.entries(userConfigs)) {
        if (!(id in configs)) {
          configs[id] = config
        }
      }
      publishProviderBaseUrlsFromConfigs(configs)
      if (Object.keys(configs).length === 0) {
        return
      }
      await transport.request({
        id: this.host.createBridgeRequestId(),
        route: createBridgeRoute('model', 'publishProviderConfigs'),
        payload: {
          configs: withConcreteDefaultModels(
            withRuntimeProviderBaseUrls(withProviderSecretMirror(withProviderUserAgents(configs))),
          ),
          ...(providers?.activeProviderId
            ? { activeProviderId: providers.activeProviderId }
            : {}),
        },
      })
    } catch {
      // Best-effort — never block worker boot on broker synchronization.
    }
    // After the publish, so the broker's answer already has settings.json
    // overlaid: what remains is what only the broker holds.
    await refreshBrokerProviderBaseUrls(transport, this.host.createBridgeRequestId())
  }

  private async publishBinaryRegistryAtBoot(): Promise<void> {
    const transport = await this.waitForDirectBridgeTransport(30_000)
    if (!transport) {
      return
    }
    try {
      const registry = await fetchManagedBinaryRegistry()
      if (!registry) {
        return
      }
      await transport.request({
        id: this.host.createBridgeRequestId(),
        route: createBridgeRoute('model', 'publishBinaryRegistry'),
        payload: registry,
      })
    } catch {
      // Best-effort — the host keeps its compiled-in registry.
    }
  }

  /**
   * Push the curated model catalog (`NEXUS_MODEL_CONFIG`) to the host on every host port; it is the
   * catalog session selections are checked against. Published by the runtime, not a client.
   */
  private async publishModelCatalog(
    transport: DirectPortBridgeTransport,
  ): Promise<void> {
    try {
      await transport.request({
        id: this.host.createBridgeRequestId(),
        route: createBridgeRoute('model', 'publishCatalog'),
        payload: { catalog: serializeNexusModelConfig(NEXUS_MODEL_CONFIG) },
      })
    } catch {
      // Best-effort: an older host without the route leaves the popup on its
      // prefs-cached copy.
    }
  }

  private waitForDirectBridgeTransport(
    timeoutMs: number,
  ): Promise<DirectPortBridgeTransport | null> {
    const current = this.host.getDirectBridgeTransport()
    if (current) {
      return Promise.resolve(current)
    }
    return new Promise(resolve => {
      let settled = false
      let timeout: ReturnType<typeof setTimeout> | undefined
      let onAttach: (transport: DirectPortBridgeTransport) => void
      const finish = (transport: DirectPortBridgeTransport | null): void => {
        if (settled) {
          return
        }
        settled = true
        if (timeout !== undefined) {
          clearTimeout(timeout)
        }
        this.directBridgeWaiters.delete(onAttach)
        resolve(transport)
      }
      onAttach = transport => finish(transport)
      timeout = setTimeout(() => finish(null), timeoutMs)
      this.directBridgeWaiters.add(onAttach)
    })
  }

  private async bootRoutineRuntimeOnce(): Promise<void> {
    if (this.routineRuntimeHandle) {
      return
    }
    const storagePath = this.host.storageRoot()
    if (!storagePath || !this.host.getDirectBridgeTransport()) {
      return
    }
    const fs = this.createTransportResolvingFs()
    try {
      this.routineRuntimeHandle = await initializeRoutineRuntime({
        fs,
        storageBasePath: storagePath,
        spawnHeadlessSession: params =>
          this.host.spawnHeadlessSession(params),
        sessionDelivery: {
          deliver: params => this.host.deliverRoutineToSession(params),
          canDeliver: sessionId =>
            this.host.canDeliverRoutineToSession(sessionId),
        },
        notificationSinks: this.buildNotificationSinks(),
        logEvent: (event, data) => this.host.trace(event, data),
      })
      try {
        const registry = getRoutineRegistry()
        const homeDir = this.host.getHomeDir()
        if (registry && homeDir) {
          const { settings } = await readUserLayer(homeDir, fs)
          await reconcileNightlyTidyCron({
            registry,
            mode: parseMemoryMaintenance(settings.memoryMaintenance),
          })
        }
      } catch (error) {
        this.host.trace('nexus_nightly_tidy_cron_boot_reconcile_failed', {
          error: error instanceof Error ? error.message : String(error),
        })
      }
    } catch (error) {
      this.host.trace('nexus_routine_runtime_boot_failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /**
   * The team registry is a manager-owned singleton, so it uses the manager's own transport-resolving fs,
   * never the shared process slot a disposed session can leave on a dead transport.
   */
  private async bootTeamRuntimeOnce(): Promise<void> {
    if (this.teamRegistryBooted) {
      return
    }
    const storagePath = this.host.storageRoot()
    // Gated on the transport like `bootRoutineRuntimeOnce`: the resolving fs
    // falls back to the process slot while there is none, and a registry
    // loaded through that fallback is the bug this method exists to avoid.
    if (!storagePath || !this.host.getDirectBridgeTransport()) {
      return
    }
    this.teamRegistryBooted = true
    try {
      const registry = await TeamRegistry.load(
        this.createTransportResolvingFs(),
        storagePath,
      )
      setTeamRegistry(registry)
    } catch (error) {
      this.teamRegistryBooted = false
      this.host.trace('nexus_team_runtime_boot_failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private buildNotificationSinks(): NotificationSink {
    return {
      inApp: (event: NotificationEvent) => {
        this.host.trace('nexus_routine_notify_inapp', {
          routineId: event.routine.id,
          status: event.status,
          sessionId: event.sessionId,
        })
        this.host.scheduleSummary()
      },
      logEvent: (event, data) => this.host.trace(event, data),
    }
  }
}
