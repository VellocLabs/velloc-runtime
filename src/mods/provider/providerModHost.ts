/**
 * Owns the realm's ONE `ProviderModRuntime` and keeps it, the provider registry and
 * the settings.json entries in step with the installed plugins. Lazy: the runtime's
 * code loads only when an enabled plugin carries a provider, and no sync starts a
 * worker. `onProviderModRegistered` is the one hook point for attaching to a
 * registered provider.
 */

import { reapplyProviderCatalog } from '../../config/customProviderRegistry'
import {
  markModProviderScanComplete,
  registerModProviderDefinition,
  setDisabledModProviderIds,
  unregisterModProviderDefinition,
} from '../../config/nexusModelConfig/providers'
import type { ProviderCodeListing } from '../../config/nexusModelConfig/providerDefinition'
import {
  adoptModProvider,
  hasStoredModProviderConfigs,
  modProviderOwner,
  onRuntimeProviderConfigsLoaded,
  publishModProvidersChanged,
} from '../../models/drivers/runtimeProviders'
import type { ActivePlugin } from '../../pluginHost/pluginModel'
import { pluginConfigId } from '../modSlot'
import { modProviderDefinition, safeIconSvg, type ModProviderDefinitionOptions } from './modProviderDefinition'
import type { ProviderManifest, ResolvedProvider } from './providerManifest'
// A TYPE only: the runtime's code must stay out of a realm with no provider mod.
import type { ProviderModRuntime, ProviderModuleRef } from './ProviderModRuntime'

/** The facts about a plugin that the host reads. */
export type ProviderPluginFacts = Pick<ActivePlugin, 'name' | 'path' | 'source'> &
  Partial<Pick<ActivePlugin, 'providers' | 'installIdentifier' | 'manifest'>>

/**
 * The module refs of one plugin's providers, for `ProviderModRuntime.register`.
 * A provider mod's module is not a hooks module: it comes from `providers`
 * alone, and one module that several providers name is ONE ref owning them all.
 */
export function providerModuleRefs(plugin: ProviderPluginFacts): ProviderModuleRef[] {
  const byModule = new Map<string, ResolvedProvider[]>()
  for (const provider of plugin.providers ?? []) {
    const list = byModule.get(provider.modulePath) ?? []
    list.push(provider)
    byModule.set(provider.modulePath, list)
  }
  const version = plugin.manifest?.version
  const description = plugin.manifest?.description
  return [...byModule.entries()].map(([path, providers]) => ({
    plugin: plugin.name,
    path,
    root: plugin.path,
    ...(version !== undefined ? { version } : {}),
    ...(description !== undefined ? { description } : {}),
    provenance: pluginConfigId(plugin),
    providers: providers.map(provider => provider.id),
  }))
}

/** A plugin that is a source of GLOBAL provider mods: installed for the
 *  person (user directory or marketplace), not a project's. */
export function isGlobalPluginSource(source: string): boolean {
  return source.startsWith('user:') || source.startsWith('marketplace:')
}

export type ProviderRegistration = {
  providerId: string
  plugin: string
  /** The plugin's id in settings.json `pluginConfigs` (`pluginConfigId`). */
  configId?: string
  manifest: ProviderManifest
  runtime: ProviderModRuntime
}

/** Runs for a registered provider; what it returns is called when that
 *  provider is replaced or removed. */
export type ProviderRegisteredListener = (registration: ProviderRegistration) => void | (() => void)

type ProviderModDefinitionUsage = NonNullable<ModProviderDefinitionOptions['usage']>

export type ProviderModHostOptions = {
  /** Builds the one runtime — the only place its code is imported. */
  createRuntime: () => Promise<ProviderModRuntime>
  /** A plugin file's text (an icon). */
  readText: (path: string) => Promise<string>
  /** `provider.models` for a provider. Absent: not connected. */
  listModels?: ProviderCodeListing['list']
  /** `provider.verify`, and `provider.usage` (reports / fetch). Absent: the
   *  core check, and no usage. */
  verify?: ProviderCodeListing['verify']
  usage?: ProviderModDefinitionUsage
  /**
   * A provider was registered AFTER the first scan (a plugin enabled or
   * updated while the app runs): list its models now if it has credentials
   * and no fresh listing. Never called at boot, so a catalog read after a
   * restart starts no worker. Rejections are logged.
   */
  refreshListing?: (providerId: string) => Promise<void>
  report: (line: string) => void
  /**
   * Whether the person approved a registry- or https-installed plugin's grant.
   * Asked at every sync for such a plugin (directory plugins are exempt); a
   * plugin it refuses registers nothing, whatever its enabled flag. Absent:
   * everything is approved.
   */
  consented?: (plugin: ProviderPluginFacts) => Promise<boolean>
  /** Test seams; the defaults are the runtime's. */
  adopt?: (providerId: string, version: string | undefined, owner: string) => Promise<void>
  ownerOf?: (providerId: string) => string | undefined
  publish?: () => Promise<void>
  hasStoredConfigs?: () => boolean
}

export type ProviderPluginScan = {
  enabled: readonly ProviderPluginFacts[]
  disabled: readonly ProviderPluginFacts[]
}

export type ProviderSyncResult = {
  /** Ids registered by this sync (new or changed plugins). */
  registered: string[]
  /** Ids unregistered by this sync. */
  removed: string[]
  /** The registry changed and the catalog was republished. */
  published: boolean
  /** Plugins whose providers could not be registered (their old registration,
   *  if any, still serves). Absent when none. */
  failed?: Array<{ plugin: string; reason: string }>
}

type Entry = {
  plugin: string
  signature: string
  ids: string[]
  version: string | undefined
}

/** What decides whether a plugin's providers must be registered again. */
function signatureOf(plugin: ProviderPluginFacts): string {
  return JSON.stringify({
    path: plugin.path,
    version: plugin.manifest?.version ?? null,
    providers: (plugin.providers ?? []).map(p => [p.id, p.manifest, p.modulePath, p.iconPath ?? null]),
  })
}

export class ProviderModHost {
  private options: ProviderModHostOptions | undefined
  private runtimeInstance: ProviderModRuntime | undefined
  private runtimeLoading: Promise<ProviderModRuntime> | undefined
  private readonly entries = new Map<string, Entry>()
  private readonly listeners = new Set<ProviderRegisteredListener>()
  private readonly registrations = new Map<string, ProviderRegistration>()
  /** What each registered provider's listeners asked to be called on removal. */
  private readonly cleanups = new Map<string, Array<() => void>>()
  private disabledKey = ''
  private scanned = false
  /** The scan the registrations were last brought to. */
  private lastScan: ProviderPluginScan | undefined
  private chain: Promise<unknown> = Promise.resolve()

  /** Give the host what it needs to build the runtime and read files. */
  configure(options: ProviderModHostOptions): void {
    this.options = options
    // The owners of the stored entries are known once settings.json is read:
    // a plugin registered before then is judged again.
    this.stopOwnerWatch?.()
    this.stopOwnerWatch = onRuntimeProviderConfigsLoaded(() => {
      if (this.lastScan && this.options) void this.sync(this.lastScan)
    })
  }

  private stopOwnerWatch: (() => void) | undefined

  isConfigured(): boolean {
    return this.options !== undefined
  }

  /** The runtime, once some provider plugin made it; never created by asking. */
  runtime(): ProviderModRuntime | undefined {
    return this.runtimeInstance
  }

  /** Every provider registered now. */
  registered(): ProviderRegistration[] {
    return [...this.registrations.values()]
  }

  /** The hook point (see the file's header). Returns the unsubscribe. */
  onRegistered(listener: ProviderRegisteredListener): () => void {
    this.listeners.add(listener)
    for (const registration of this.registrations.values()) this.attach(listener, registration)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private attach(listener: ProviderRegisteredListener, registration: ProviderRegistration): void {
    try {
      const cleanup = listener(registration)
      if (typeof cleanup === 'function') {
        const list = this.cleanups.get(registration.providerId) ?? []
        list.push(cleanup)
        this.cleanups.set(registration.providerId, list)
      }
    } catch (error) {
      this.options?.report(`${registration.providerId}: a registration listener failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private detach(providerId: string): void {
    this.registrations.delete(providerId)
    for (const cleanup of this.cleanups.get(providerId) ?? []) {
      try {
        cleanup()
      } catch (error) {
        this.options?.report(`${providerId}: a registration cleanup failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    this.cleanups.delete(providerId)
  }

  private async ensureRuntime(): Promise<ProviderModRuntime> {
    if (this.runtimeInstance) return this.runtimeInstance
    this.runtimeLoading ??= this.options!.createRuntime().then(
      runtime => {
        this.runtimeInstance = runtime
        return runtime
      },
      error => {
        this.runtimeLoading = undefined
        throw error
      },
    )
    return this.runtimeLoading
  }

  /**
   * Bring the registrations to the installed plugins: `scan.enabled`'s global
   * plugins with providers are registered (a new or changed one, again), a
   * plugin no longer there is taken away. Serialized: two syncs in quick
   * succession run one after the other. Never starts a worker.
   */
  sync(scan: ProviderPluginScan): Promise<ProviderSyncResult> {
    if (!this.options) return Promise.reject(new Error('the provider mod host is not configured'))
    const run = this.chain.then(() => this.syncNow(scan))
    this.chain = run.catch(() => undefined)
    return run
  }

  private async syncNow(scan: ProviderPluginScan): Promise<ProviderSyncResult> {
    const options = this.options!
    this.lastScan = scan
    const result: ProviderSyncResult = { registered: [], removed: [], published: false }

    // The plugins that supply providers, and the ids they claim.
    const wanted = new Map<string, ProviderPluginFacts>()
    const claimed = new Map<string, string>()
    const unapproved: ProviderPluginFacts[] = []
    for (const plugin of scan.enabled) {
      if (!plugin.providers?.length) continue
      if (!isGlobalPluginSource(plugin.source)) {
        options.report(`${plugin.name}: provider mods are global; a project plugin's providers are not registered`)
        continue
      }
      const clash = plugin.providers.find(provider => claimed.has(provider.id))
      if (clash) {
        options.report(`${plugin.name}: provider ${clash.id} is already provided by ${claimed.get(clash.id)}`)
        continue
      }
      if (plugin.source.startsWith('marketplace:') && options.consented && !(await options.consented(plugin))) {
        // Not approved yet: nothing of it runs, and it shows as switched off,
        // not as a missing plugin. (An earlier registration is taken away below.)
        options.report(`${plugin.name}: its providers wait for your approval and are not registered`)
        unapproved.push(plugin)
        continue
      }
      // Security: a provider's stored sign-in, secrets and keys stay with the
      // plugin that owns them; another plugin of the same name gets none.
      const ownerOf = options.ownerOf ?? modProviderOwner
      const configId = pluginConfigId(plugin)
      const foreign = plugin.providers.find(provider => {
        const owner = ownerOf(provider.id)
        return owner !== undefined && owner !== configId
      })
      if (foreign) {
        options.report(
          `${plugin.name}: provider ${foreign.id} holds the sign-in and keys of ${ownerOf(foreign.id)}, ` +
            'another plugin of the same name; it is not registered. Remove that provider in Settings to use this one',
        )
        unapproved.push(plugin)
        continue
      }
      for (const provider of plugin.providers) claimed.set(provider.id, plugin.name)
      wanted.set(plugin.name, plugin)
    }

    let changed = false

    // Take away what is no longer there.
    for (const [name, entry] of [...this.entries]) {
      if (wanted.has(name)) continue
      this.entries.delete(name)
      this.runtimeInstance?.unregister(name)
      for (const id of entry.ids) {
        this.detach(id)
        unregisterModProviderDefinition(id)
        result.removed.push(id)
      }
      changed = true
    }

    // Register what is new or changed.
    const adopted: Array<[string, string | undefined, string]> = []
    for (const [name, plugin] of wanted) {
      const signature = signatureOf(plugin)
      const previous = this.entries.get(name)
      if (previous?.signature === signature) continue
      const providers = plugin.providers!
      let runtime: ProviderModRuntime
      try {
        runtime = await this.ensureRuntime()
        // A plugin registered before is SWAPPED: the new version is admitted
        // first (a refusal leaves the old one serving) and then registered
        // beside the old, which drains (`ProviderModRuntime.register`).
        if (previous) await runtime.replace(name, providerModuleRefs(plugin))
        else runtime.register(name, providerModuleRefs(plugin))
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        options.report(`${name}: its providers were not registered: ${reason}`)
        ;(result.failed ??= []).push({ plugin: name, reason })
        continue
      }
      const version = plugin.manifest?.version
      const ids = providers.map(provider => provider.id)
      // Read before anything is detached: from the detach to the attach below
      // nothing awaits, so a request never finds a kept provider without its seam.
      const icons = new Map<string, string | undefined>()
      for (const provider of providers) icons.set(provider.id, await this.readIcon(provider))
      // The previous registration's providers that this one drops.
      for (const id of previous?.ids ?? []) {
        this.detach(id)
        if (!ids.includes(id)) unregisterModProviderDefinition(id)
      }
      for (const provider of providers) {
        const iconSvg = icons.get(provider.id)
        registerModProviderDefinition(
          modProviderDefinition({
            plugin: name,
            ...(version !== undefined ? { pluginVersion: version } : {}),
            pluginId: pluginConfigId(plugin),
            provider,
            ...(iconSvg !== undefined ? { iconSvg } : {}),
            isLoaded: () => this.isLoaded(provider.id),
            ...(options.listModels ? { list: options.listModels } : {}),
            ...(options.verify ? { verify: options.verify } : {}),
            ...(options.usage ? { usage: options.usage } : {}),
          }),
        )
        const registration: ProviderRegistration = {
          providerId: provider.id,
          plugin: name,
          configId: pluginConfigId(plugin),
          manifest: provider.manifest,
          runtime,
        }
        this.registrations.set(provider.id, registration)
        for (const listener of this.listeners) this.attach(listener, registration)
        result.registered.push(provider.id)
        adopted.push([provider.id, version, pluginConfigId(plugin)])
      }
      this.entries.set(name, { plugin: name, signature, ids, version })
      changed = true
    }

    // A disabled plugin's providers show nothing, and are not "missing".
    const disabledIds = [...scan.disabled, ...unapproved]
      .filter(plugin => isGlobalPluginSource(plugin.source))
      .flatMap(plugin => (plugin.providers ?? []).map(provider => provider.id))
      .filter(id => !claimed.has(id))
    const disabledKey = [...disabledIds].sort().join('\n')
    if (disabledKey !== this.disabledKey) {
      this.disabledKey = disabledKey
      changed = true
    }
    setDisabledModProviderIds(disabledIds)

    const first = !this.scanned
    this.scanned = true
    markModProviderScanComplete()

    // The catalog entries first: the write below publishes the provider
    // configs, and needs the providers it names to be in the catalog.
    if (changed) reapplyProviderCatalog()
    const adopt = options.adopt ?? adoptModProvider
    for (const [id, version, owner] of adopted) await adopt(id, version, owner)

    const hasStored = (options.hasStoredConfigs ?? hasStoredModProviderConfigs)()
    if (changed || (first && hasStored)) {
      await (options.publish ?? publishModProvidersChanged)()
      result.published = true
    }
    // A provider that came in while the app runs is listed now (never at
    // boot). Not awaited: the sync must not wait on a module's cold start.
    if (!first && options.refreshListing) {
      for (const [id] of adopted) {
        options.refreshListing(id).catch(error => {
          options.report(`${id}: its models could not be listed after it was added: ${error instanceof Error ? error.message : String(error)}`)
        })
      }
    }
    return result
  }

  /** The version a plugin's providers are registered at, if they are. */
  registeredVersion(pluginName: string): string | undefined {
    return this.entries.get(pluginName)?.version
  }

  /**
   * Swap ONE plugin to another version through the `sync` path; the old module keeps
   * serving its calls, then closes. Rejects when the new version is not admitted
   * (the old one stays registered).
   */
  async swapPlugin(plugin: ProviderPluginFacts): Promise<ProviderSyncResult> {
    const base = this.lastScan ?? { enabled: [], disabled: [] }
    const replace = (list: readonly ProviderPluginFacts[]): ProviderPluginFacts[] =>
      list.map(entry => (entry.name === plugin.name ? plugin : entry))
    const wasDisabled = base.disabled.some(entry => entry.name === plugin.name)
    const wasEnabled = base.enabled.some(entry => entry.name === plugin.name)
    const scan: ProviderPluginScan = wasDisabled
      ? { enabled: base.enabled, disabled: replace(base.disabled) }
      : { enabled: wasEnabled ? replace(base.enabled) : [...base.enabled, plugin], disabled: base.disabled }
    const result = await this.sync(scan)
    const failure = result.failed?.find(entry => entry.plugin === plugin.name)
    if (failure) throw new Error(failure.reason)
    return result
  }

  private isLoaded(providerId: string): boolean {
    return (
      this.runtimeInstance?.status().some(module => module.providers.includes(providerId) && module.state === 'ready') ?? false
    )
  }

  private async readIcon(provider: ResolvedProvider): Promise<string | undefined> {
    if (!provider.iconPath) return undefined
    try {
      const text = await this.options!.readText(provider.iconPath)
      const safe = safeIconSvg(text)
      if (safe === undefined) this.options!.report(`${provider.id}: its icon was not used (it is not a plain .svg mark)`)
      return safe
    } catch (error) {
      this.options!.report(`${provider.id}: its icon could not be read: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  /** Tear everything down (tests; the realm going away). */
  dispose(): void {
    for (const id of [...this.registrations.keys()]) this.detach(id)
    for (const entry of this.entries.values()) {
      this.runtimeInstance?.unregister(entry.plugin)
      for (const id of entry.ids) unregisterModProviderDefinition(id)
    }
    this.entries.clear()
    this.runtimeInstance?.dispose()
    this.runtimeInstance = undefined
    this.runtimeLoading = undefined
    this.disabledKey = ''
    this.scanned = false
    this.lastScan = undefined
    this.options = undefined
    this.stopOwnerWatch?.()
    this.stopOwnerWatch = undefined
  }
}

/** The one host of this realm. Unconfigured until the boot configures it. */
const host = new ProviderModHost()

export function getProviderModHost(): ProviderModHost {
  return host
}

/** See the file's header: the hook point for attaching to a registered provider. */
export function onProviderModRegistered(listener: ProviderRegisteredListener): () => void {
  return host.onRegistered(listener)
}
