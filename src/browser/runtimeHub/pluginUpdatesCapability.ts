/**
 * Marketplace plugin updates on the runtime protocol (F-14); shapes and scopes
 * in `pluginHost/pluginUpdatesProtocol.ts`. The runtime fetches and installs;
 * a client sends only a plugin id or the auto-update switch. Also runs the
 * background schedule (nothing while the setting is off) and the built-in
 * marketplace job (`pluginHost/builtinMarketplaceSeed.ts`): a few seconds
 * after start, every half minute until the host names a home, then daily.
 */
import { wireError, type TopicId } from '../runtimeProtocol'
import {
  PLUGIN_UPDATES_ACTION_SCOPES,
  PLUGIN_UPDATES_CAPABILITY,
  PLUGIN_UPDATES_EVENT,
  PLUGIN_UPDATES_TOPIC,
  isPluginUpdatesAutoPayload,
  isPluginUpdatesCheckPayload,
  isPluginUpdatesPluginPayload,
  type PluginUpdatesAutoPayload,
  type PluginUpdatesCheckPayload,
  type PluginUpdatesPluginPayload,
  type PluginUpdatesState,
} from '../../pluginHost/pluginUpdatesProtocol'
import {
  createPluginUpdateService,
  startPluginUpdateSchedule,
  type PluginUpdateScheduleOptions,
  type PluginUpdateService,
  type PluginUpdateServiceDeps,
} from '../../pluginHost/pluginUpdates'
import { createBridgeBackedFetch } from '../../pluginHost/bridgeBackedFetch'
import { BUILTIN_MARKETPLACE_AUTO_INSTALL_FLAG } from '../../pluginHost/builtinMarketplace'
import {
  BUILTIN_MARKETPLACE_CHECK_INTERVAL_MS,
  seedBuiltinMarketplace,
  type BuiltinSeedOutcome,
} from '../../pluginHost/builtinMarketplaceSeed'
import type { UpdateChannel } from '../../branding/updateChannels'
import { readLayerFresh, updateSectionInSource } from '../../settings/settingsStore'
import type { RuntimeFs } from '../../utils/fs/runtimeFs'
import type { BrowserBridgeTransport } from '../bridge/protocol/core'
import { createBridgeRoute } from '../bridge/protocol/core'
import { scopeAllows, type CapabilityRegistry } from './CapabilityRegistry'
import type { TopicBroker } from './TopicBroker'
import type { SnapshotPage, TopicProvider } from './types'

export type PluginUpdatesCapabilityOptions = {
  /** Where the runtime stands now. */
  context: () => { fs: RuntimeFs; directBridge: BrowserBridgeTransport | null }
  /** The host user's home; rejects while the host cannot say. */
  resolveHome: () => Promise<string>
  reloadPluginsOnAllSessions?: () => void
  /** Default: the production service over the context. */
  createService?: (deps: Pick<PluginUpdateServiceDeps, 'homeDir' | 'fs'>) => PluginUpdateService
  /** `false` starts no background schedule (tests). */
  schedule?: PluginUpdateScheduleOptions | false
  /** The built-in marketplace job; absent or `false` runs none. */
  builtinMarketplace?: BuiltinMarketplaceJobOptions | false
  report?: (line: string) => void
}

export type BuiltinMarketplaceJobOptions = {
  channel: () => UpdateChannel
  /** Default: settings.json `features[builtinMarketplace.autoInstall] !== false`. */
  autoInstall?: () => Promise<boolean>
  /** The first consent to a provider plugin the catalog installs on; absent
   *  leaves it held off. */
  consentProviders?: (pluginId: string, at: { homeDir: string; fs: RuntimeFs }) => Promise<void>
  /** Schedule knobs (tests): the first attempt, the retry while the host has
   *  no home folder yet, the interval between runs. */
  firstDelayMs?: number
  retryDelayMs?: number
  intervalMs?: number
  setTimer?: (run: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  onRun?: (outcome: BuiltinSeedOutcome) => void
}

function productionService(
  deps: Pick<PluginUpdateServiceDeps, 'homeDir' | 'fs'>,
  directBridge: () => BrowserBridgeTransport | null,
  reloadPluginsOnAllSessions: (() => void) | undefined,
): PluginUpdateService {
  const settingsCtx = { homeDir: deps.homeDir }
  return createPluginUpdateService({
    ...deps,
    fetchImpl: () => {
      const transport = directBridge()
      if (!transport) return globalThis.fetch.bind(globalThis)
      return createBridgeBackedFetch({
        transport,
        createRequestId: () => `plugin-update-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
      }) as typeof fetch
    },
    readAutoUpdate: async () =>
      (await readLayerFresh('userSettings', settingsCtx, deps.fs)).settings.pluginAutoUpdate === true,
    writeAutoUpdate: async on => {
      await updateSectionInSource('userSettings', settingsCtx, deps.fs, 'pluginAutoUpdate', () => (on ? true : undefined))
    },
    ...(reloadPluginsOnAllSessions ? { reloadPluginsOnAllSessions } : {}),
  })
}

/**
 * Runs `attempt` after `firstDelayMs`; `'not-ready'` retries after
 * `retryDelayMs`, anything else schedules the next run after `intervalMs`.
 * Returns the stop.
 */
export function startBuiltinMarketplaceSchedule(
  attempt: () => Promise<'ran' | 'not-ready'>,
  options: Pick<BuiltinMarketplaceJobOptions, 'firstDelayMs' | 'retryDelayMs' | 'intervalMs' | 'setTimer' | 'clearTimer'> & {
    report: (line: string) => void
  },
): () => void {
  const setTimer =
    options.setTimer ??
    ((run, ms) => {
      const handle = setTimeout(run, ms)
      ;(handle as { unref?: () => void }).unref?.()
      return handle
    })
  const clearTimer = options.clearTimer ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>))
  const retry = options.retryDelayMs ?? 30_000
  const interval = options.intervalMs ?? BUILTIN_MARKETPLACE_CHECK_INTERVAL_MS
  let stopped = false
  let handle: unknown
  const round = async () => {
    let next = interval
    try {
      if ((await attempt()) === 'not-ready') next = retry
    } catch (error) {
      options.report(`the built-in marketplace run failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!stopped) handle = setTimer(() => void round(), next)
  }
  handle = setTimer(() => void round(), options.firstDelayMs ?? 5_000)
  return () => {
    stopped = true
    clearTimer(handle)
  }
}

export function registerPluginUpdatesCapability(
  registry: CapabilityRegistry,
  broker: TopicBroker,
  options: PluginUpdatesCapabilityOptions,
): { publish(): Promise<void>; dispose(): void } {
  const report = options.report ?? (line => console.warn(`[plugin-updates] ${line}`))
  const build =
    options.createService ??
    (deps => productionService(deps, () => options.context().directBridge, options.reloadPluginsOnAllSessions))
  let built: { homeDir: string; fs: RuntimeFs; service: PluginUpdateService; unsubscribe: () => void } | null = null

  /** The service over the current context; null while the home folder is unknown. */
  const current = async (): Promise<PluginUpdateService | null> => {
    const homeDir = await options.resolveHome().catch(() => '')
    if (!homeDir) return null
    const { fs } = options.context()
    if (built && built.homeDir === homeDir && built.fs === fs) return built.service
    built?.unsubscribe()
    const service = build({ homeDir, fs })
    built = { homeDir, fs, service, unsubscribe: service.subscribe(() => void publish()) }
    return service
  }
  const service = async (): Promise<PluginUpdateService> => {
    const found = await current()
    if (!found) throw wireError('host_unavailable', 'pluginUpdates: the host did not report a home folder')
    return found
  }
  const state = async (): Promise<PluginUpdatesState> => {
    const empty: PluginUpdatesState = { autoUpdate: false, checking: false, unreachable: [], plugins: [] }
    try {
      return (await (await current())?.snapshot()) ?? empty
    } catch (error) {
      report(`the status could not be read: ${error instanceof Error ? error.message : String(error)}`)
      return empty
    }
  }

  const provider: TopicProvider = {
    matches: (id: TopicId) => id === PLUGIN_UPDATES_TOPIC,
    authorize: (_id, conn) => scopeAllows(conn.scope.mode, 'observe'),
    async *snapshot(): AsyncIterable<SnapshotPage> {
      yield { type: PLUGIN_UPDATES_EVENT, payload: await state() }
    },
  }
  broker.registerProvider(provider)

  registry.registerCapability({
    cap: PLUGIN_UPDATES_CAPABILITY,
    actions: {
      check: { scope: PLUGIN_UPDATES_ACTION_SCOPES.check, guard: isPluginUpdatesCheckPayload },
      update: { scope: PLUGIN_UPDATES_ACTION_SCOPES.update, guard: isPluginUpdatesPluginPayload },
      rollback: { scope: PLUGIN_UPDATES_ACTION_SCOPES.rollback, guard: isPluginUpdatesPluginPayload },
      setAutoUpdate: { scope: PLUGIN_UPDATES_ACTION_SCOPES.setAutoUpdate, guard: isPluginUpdatesAutoPayload },
    },
    handle: async request => {
      const act = request.route.act
      try {
        switch (act) {
          case 'check': {
            const payload = (request.payload ?? {}) as PluginUpdatesCheckPayload
            return await (await service()).check({ force: payload.force === true })
          }
          case 'update':
            return { status: await (await service()).update((request.payload as PluginUpdatesPluginPayload).identifier) }
          case 'rollback':
            return { status: await (await service()).rollback((request.payload as PluginUpdatesPluginPayload).identifier) }
          case 'setAutoUpdate': {
            const { on } = request.payload as PluginUpdatesAutoPayload
            const found = await service()
            const next = await found.setAutoUpdate(on)
            // Switching on runs a round now rather than at the next tick.
            if (on) void found.autoUpdate({ force: true }).catch(error => report(`the update round failed: ${String(error)}`))
            return next
          }
          default:
            throw wireError('unknown_route', `pluginUpdates has no action '${act}'`)
        }
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && 'retryable' in error) throw error
        throw wireError('conflict', error instanceof Error ? error.message : String(error))
      }
    },
  })

  const publish = async (): Promise<void> => {
    if (broker.subscribersOf(PLUGIN_UPDATES_TOPIC as TopicId).length === 0) return
    broker.publish(PLUGIN_UPDATES_TOPIC as TopicId, await state(), { type: PLUGIN_UPDATES_EVENT })
  }

  const stopSchedule =
    options.schedule === false
      ? () => undefined
      : startPluginUpdateSchedule(
          { autoUpdate: async () => (await current())?.autoUpdate() },
          { report, ...(options.schedule ?? {}) },
        )

  // The built-in marketplace job: the update service upgrades what is
  // installed, the seeder installs what is new. Both over the same home.
  const job = options.builtinMarketplace
  const runBuiltinJob = async (): Promise<'ran' | 'not-ready'> => {
    if (!job) return 'ran'
    const service = await current()
    if (!service || !built) return 'not-ready'
    const { homeDir, fs } = built
    const outcome = await seedBuiltinMarketplace({
      homeDir,
      fs,
      fetchImpl: () => {
        const transport = options.context().directBridge
        if (!transport) return globalThis.fetch.bind(globalThis)
        return createBridgeBackedFetch({
          transport,
          createRequestId: () => `builtin-marketplace-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
        }) as typeof fetch
      },
      channel: job.channel,
      clientVersion: async () => {
        const transport = options.context().directBridge
        if (!transport) return undefined
        const response = await transport.request({
          id: `builtin-marketplace-version-${Date.now().toString(36)}`,
          route: createBridgeRoute('appInfo', 'getVersionInfo'),
          payload: {},
        })
        if (!response.ok) return undefined
        const { appVersion } = response.result as { appVersion?: unknown }
        return typeof appVersion === 'string' && appVersion.length > 0 ? appVersion : undefined
      },
      autoInstall:
        job.autoInstall ??
        (async () =>
          (await readLayerFresh('userSettings', { homeDir }, fs)).settings.features?.[BUILTIN_MARKETPLACE_AUTO_INSTALL_FLAG] !== false),
      updates: service,
      ...(options.reloadPluginsOnAllSessions ? { reloadPluginsOnAllSessions: options.reloadPluginsOnAllSessions } : {}),
      ...(job.consentProviders
        ? { consentProviders: (pluginId: string) => job.consentProviders!(pluginId, { homeDir, fs }) }
        : {}),
      report: line => report(`builtin marketplace: ${line}`),
    })
    job.onRun?.(outcome)
    if (outcome.installed.length > 0 || outcome.updated.length > 0) void publish()
    return 'ran'
  }
  const stopBuiltinJob =
    !job || options.schedule === false
      ? () => undefined
      : startBuiltinMarketplaceSchedule(runBuiltinJob, { ...job, report })

  return {
    publish,
    dispose() {
      stopSchedule()
      stopBuiltinJob()
      built?.unsubscribe()
      built = null
    },
  }
}
