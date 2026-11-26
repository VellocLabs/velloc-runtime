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
  runtimeProviderConfigs,
} from '../../models/drivers/runtimeProviders'
import type { ActivePlugin } from '../../pluginHost/pluginModel'
import type { NexusProviderConfig, ProviderConfigWriteOptions } from '../../settings/settingsTypes'
import { pluginConfigId } from '../modSlot'
import { modProviderDefinition, safeIconSvg, type ModProviderDefinitionOptions } from './modProviderDefinition'
import { clearProviderState } from '../../models/drivers/providerHealthLedger'
import { borrowTableOf, isBorrowable, orphanedBorrowedInstances } from './providerBorrows'
import { providerHostSources } from './providerHostSources'
import { planAutoCreatedInstances, storedInstanceIds, withStoredInstances } from './providerInstances'
import { INSTANCE_ID_RESERVE, PROVIDER_ID_MAX_LENGTH, type ProviderManifest, type ResolvedProvider } from './providerManifest'
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
    definitions: Object.fromEntries(
      providers.map(provider => [provider.id, { id: provider.definition ?? provider.id, key: provider.key }]),
    ),
    // One module's providers are all of one kind: the manifest check refuses a mix.
    ...(providers.some(provider => provider.manifest.kind === 'router') ? { kind: 'router' as const } : {}),
  }))
}

/** A plugin that is a source of GLOBAL provider mods: installed for the
 *  person (user directory or marketplace), not a project's. */
export function isGlobalPluginSource(source: string): boolean {
  return source.startsWith('user:') || source.startsWith('marketplace:')
}

export type ProviderRegistration = {
  /** The instance id. */
  providerId: string
  /** The definition the instance belongs to, and its key in the manifest. */
  definition: string
  definitionKey: string
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
  /**
   * What makes the instance of an `autoCreate` definition (RP-18). Absent:
   * none is made. Nothing is made before `ready` (the stored instances are
   * not known until settings.json is read), and a failed read or write makes
   * nothing: the next sync tries again.
   */
  autoCreate?: {
    ready: () => boolean
    /** The slots of the removed instances, per definition id. */
    retiredInstances: () => Promise<Readonly<Record<string, readonly string[]>>>
    /** The settings write path; it never makes the instance the active provider. */
    store: (providerId: string, config: NexusProviderConfig) => Promise<void>
    name: (provider: ResolvedProvider) => string
    now?: () => number
    random?: () => number
  }
  /** Test seams; the defaults are the runtime's. */
  adopt?: (providerId: string, version: string | undefined, owner: string) => Promise<void>
  ownerOf?: (providerId: string) => string | undefined
  publish?: () => Promise<void>
  hasStoredConfigs?: () => boolean
  storedConfigs?: () => Readonly<Record<string, NexusProviderConfig>>
  /** Removes a stored entry with its sealed values. Absent: the runtime's, when attached. */
  removeConfig?: (providerId: string) => Promise<void>
  /** Writes a stored entry. Absent: the runtime's, when attached. */
  writeConfig?: (providerId: string, config: NexusProviderConfig, options?: ProviderConfigWriteOptions) => Promise<void>
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
    providers: (plugin.providers ?? []).map(p => [p.id, p.manifest, p.modulePath, p.iconPath ?? null, p.managedBy ?? null]),
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
  /** Routers taken away while the app ran whose borrowed instances are not all removed yet. */
  private readonly departedRouters = new Set<string>()
  /** Definitions of plugins taken away while the app ran whose entries may still name a web profile. */
  private readonly departedDefinitions = new Set<string>()
  private chain: Promise<unknown> = Promise.resolve()

  /** Give the host what it needs to build the runtime and read files. */
  configure(options: ProviderModHostOptions): void {
    this.options = options
    // The owners of the stored entries are known once settings.json is read:
    // a plugin registered before then is judged again.
    this.stopOwnerWatch?.()
    this.stopOwnerWatch = onRuntimeProviderConfigsLoaded(() => void this.resync())
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

  /** Bring the registrations to the last scan again: a provider instance
   *  was stored or removed. Resolves undefined before the first scan. */
  resync(): Promise<ProviderSyncResult | undefined> {
    if (!this.options) return Promise.resolve(undefined)
    // The scan is read when the queued run starts, so a sync queued earlier
    // is not undone by an older scan.
    const run = this.chain.then(() => (this.lastScan && this.options ? this.syncNow(this.lastScan) : undefined))
    this.chain = run.catch(() => undefined)
    return run
  }

  private async syncNow(installed: ProviderPluginScan): Promise<ProviderSyncResult> {
    const options = this.options!
    const previousScan = this.lastScan
    this.lastScan = installed
    // One answer per plugin and sync, whichever step asks first.
    const approvals = new Map<string, Promise<boolean>>()
    const approved = (plugin: ProviderPluginFacts): Promise<boolean> => {
      const key = `${plugin.source}
${plugin.name}`
      let answer = approvals.get(key)
      if (!answer) {
        answer =
          plugin.source.startsWith('marketplace:') && options.consented ? options.consented(plugin) : Promise.resolve(true)
        approvals.set(key, answer)
      }
      return answer
    }
    const configs = await this.withAutoCreated(installed.enabled, approved)
    // One entry per instance from here on: a stored instance is registered,
    // disabled and taken away with its definition.
    // Every lent instance a global router could vouch for; the ones whose
    // router is not registered by this sync are dropped once that is known.
    const candidates = borrowTableOf(installed.enabled.filter(plugin => isGlobalPluginSource(plugin.source)))
    const borrows = (routerId: string, definitionId: string): boolean => candidates.get(routerId)?.has(definitionId) ?? false
    const perInstance = (plugin: ProviderPluginFacts): ProviderPluginFacts =>
      plugin.providers?.length
        ? { ...plugin, providers: withStoredInstances(plugin.providers, pluginConfigId(plugin), configs, options.report, borrows) }
        : plugin
    const scan: ProviderPluginScan = {
      enabled: installed.enabled.map(perInstance),
      disabled: installed.disabled.map(perInstance),
    }
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
      if (!(await approved(plugin))) {
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

    // Security: a lent instance is registered only while its router is, with
    // the definition in its `borrows`: approved, not clashing, not foreign.
    const lenders = borrowTableOf([...wanted.values()])
    for (const [name, plugin] of wanted) {
      const kept = plugin.providers!.filter(
        provider => provider.managedBy === undefined || (lenders.get(provider.managedBy)?.has(provider.definition ?? '') ?? false),
      )
      if (kept.length === plugin.providers!.length) continue
      for (const provider of plugin.providers!) if (!kept.includes(provider)) claimed.delete(provider.id)
      wanted.set(name, { ...plugin, providers: kept })
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
    const reclaimed: Array<[string, string | undefined, string]> = []
    for (const [name, plugin] of wanted) {
      const signature = signatureOf(plugin)
      const previous = this.entries.get(name)
      if (previous?.signature === signature) {
        // An entry that lost its owner (a write from a copy without it) is
        // this registrant's again, as at registration (F-14 `requires` reads it).
        const ownerOf = options.ownerOf ?? modProviderOwner
        for (const provider of plugin.providers!) {
          if (ownerOf(provider.id) === undefined) reclaimed.push([provider.id, previous.version, pluginConfigId(plugin)])
        }
        continue
      }
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
          definition: provider.definition ?? provider.id,
          definitionKey: provider.key,
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
    for (const [id, version, owner] of [...adopted, ...reclaimed]) await adopt(id, version, owner)

    const hasStored = (options.hasStoredConfigs ?? hasStoredModProviderConfigs)()
    if (changed || (first && hasStored)) {
      await (options.publish ?? publishModProvidersChanged)()
      result.published = true
    }
    await this.dropOrphanedBorrows(installed, previousScan, configs)
    await this.dropDepartedSignIns(installed, previousScan, configs)
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

  /**
   * The stored configs, with the instance of every `autoCreate` definition
   * that has none and had none stored first. Only for an enabled global
   * plugin the person approved and the registration below would take: the
   * same clash and owner refusals, in the same order.
   */
  private async withAutoCreated(
    enabled: readonly ProviderPluginFacts[],
    approved: (plugin: ProviderPluginFacts) => Promise<boolean>,
  ): Promise<Readonly<Record<string, NexusProviderConfig>>> {
    const options = this.options!
    const stored = options.storedConfigs ?? runtimeProviderConfigs
    const make = options.autoCreate
    if (!make || !make.ready()) return stored()
    const ownerOf = options.ownerOf ?? modProviderOwner
    let made: Record<string, NexusProviderConfig> = {}
    // Read at each use: an instance stored while this awaits counts.
    const current = (): Record<string, NexusProviderConfig> => ({ ...stored(), ...made })
    let retired: Readonly<Record<string, readonly string[]>> | undefined
    const claimed = new Set<string>()
    for (const plugin of enabled) {
      if (!plugin.providers?.length || !isGlobalPluginSource(plugin.source)) continue
      const own = plugin.providers.filter(provider => provider.manifest.managedBy === undefined).map(provider => provider.id)
      if (own.some(id => claimed.has(id))) continue
      const owner = pluginConfigId(plugin)
      try {
        if (!(await approved(plugin))) continue
        if (plugin.providers.some(provider => (ownerOf(provider.id) ?? owner) !== owner)) continue
        for (const id of own) claimed.add(id)
        const missing = plugin.providers.filter(
          provider => provider.manifest.autoCreate === true && storedInstanceIds(provider.id, owner, current()).length === 0,
        )
        if (missing.length === 0) continue
        retired ??= await make.retiredInstances()
        const plans = planAutoCreatedInstances({
          providers: missing,
          owner,
          configs: current(),
          retired,
          name: make.name,
          now: (make.now ?? Date.now)(),
          ...(make.random ? { random: make.random } : {}),
        })
        for (const plan of plans) {
          await make.store(plan.id, plan.config)
          made = { ...made, [plan.id]: plan.config }
        }
      } catch (error) {
        options.report(`${plugin.name}: its ready-made provider was not created: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return current()
  }

  /**
   * The provider definitions the router `routerId` manages, in manifest
   * order, each with the owner of its instances' entries. Empty for an id
   * that is not a registered router. A managed definition with no instance
   * has no registration, so this reads the plugin's manifest.
   */
  managedDefinitions(routerId: string): Array<{ provider: ResolvedProvider; owner: string }> {
    for (const plugin of this.lastScan?.enabled ?? []) {
      if (!this.entries.has(plugin.name)) continue
      const router = plugin.providers?.find(provider => provider.id === routerId && provider.manifest.kind === 'router')
      if (!router) continue
      const owner = pluginConfigId(plugin)
      return plugin.providers!.filter(provider => provider.manifest.managedBy === router.key).map(provider => ({ provider, owner }))
    }
    return []
  }

  /**
   * The provider definitions the router `routerId` may borrow and that are
   * there to borrow: registered providers of other plugins, no router and
   * none a router manages, each with the owner of its instances' entries.
   * In the order of the router's `borrows`.
   */
  borrowableDefinitions(routerId: string): Array<{ provider: ResolvedProvider; owner: string }> {
    const enabled = (this.lastScan?.enabled ?? []).filter(plugin => this.entries.has(plugin.name))
    const home = enabled.find(plugin => plugin.providers?.some(provider => provider.id === routerId))
    const router = home?.providers?.find(provider => provider.id === routerId)
    if (!home || router?.manifest.kind !== 'router') return []
    const out: Array<{ provider: ResolvedProvider; owner: string }> = []
    for (const id of router.manifest.borrows ?? []) {
      if (id.length + INSTANCE_ID_RESERVE > PROVIDER_ID_MAX_LENGTH) continue
      for (const plugin of enabled) {
        if (plugin === home) continue
        const provider = plugin.providers?.find(each => each.id === id)
        if (provider && isBorrowable(provider.manifest)) out.push({ provider, owner: pluginConfigId(plugin) })
      }
    }
    return out
  }

  /**
   * A router that was switched off, or taken away while the app ran, takes
   * the instances it borrowed with it: their entries and sealed values are
   * removed. A failed removal is reported and tried again at the next sync.
   */
  private async dropOrphanedBorrows(
    installed: ProviderPluginScan,
    previous: ProviderPluginScan | undefined,
    configs: Readonly<Record<string, NexusProviderConfig>>,
  ): Promise<void> {
    const options = this.options!
    const routersOf = (plugins: readonly ProviderPluginFacts[]): string[] =>
      plugins.flatMap(plugin => (plugin.providers ?? []).filter(p => p.manifest.kind === 'router').map(p => p.id))
    const present = new Set(routersOf(installed.enabled))
    const disabled = new Set(routersOf(installed.disabled).filter(id => !present.has(id)))
    for (const id of [...this.departedRouters]) if (present.has(id) || disabled.has(id)) this.departedRouters.delete(id)
    if (previous) {
      for (const id of routersOf([...previous.enabled, ...previous.disabled])) {
        if (!present.has(id) && !disabled.has(id)) this.departedRouters.add(id)
      }
    }
    const orphans = orphanedBorrowedInstances(configs, disabled, this.departedRouters)
    const remove = options.removeConfig ?? providerHostSources().removeProviderConfig
    const failed = new Set<string>()
    if (orphans.length > 0 && remove) {
      for (const id of orphans) {
        try {
          await remove(id)
          clearProviderState(id)
        } catch (error) {
          failed.add(configs[id]?.managedBy ?? '')
          options.report(`${id}: it was lent to a router that is gone and could not be removed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
    if (!remove) return
    for (const id of [...this.departedRouters]) if (!failed.has(id)) this.departedRouters.delete(id)
  }

  /**
   * A plugin taken away while the app ran keeps its stored entries, but none
   * of them counts as signed in through a web profile any more: each loses
   * that note, and the write path drops the account records only they kept.
   * A plugin that is merely disabled keeps it. A failed write is reported and
   * tried again at the next sync.
   */
  private async dropDepartedSignIns(
    installed: ProviderPluginScan,
    previous: ProviderPluginScan | undefined,
    configs: Readonly<Record<string, NexusProviderConfig>>,
  ): Promise<void> {
    const options = this.options!
    const definitionsOf = (scan: ProviderPluginScan): string[] =>
      [...scan.enabled, ...scan.disabled].flatMap(plugin => (plugin.providers ?? []).map(provider => provider.id))
    const here = new Set(definitionsOf(installed))
    for (const id of [...this.departedDefinitions]) if (here.has(id)) this.departedDefinitions.delete(id)
    if (previous) for (const id of definitionsOf(previous)) if (!here.has(id)) this.departedDefinitions.add(id)
    if (this.departedDefinitions.size === 0) return
    const write = options.writeConfig ?? providerHostSources().writeProviderConfig
    if (!write) return
    const stored = options.storedConfigs ?? runtimeProviderConfigs
    let failed = false
    for (const id of Object.keys(configs)) {
      // Read at each write: an entry removed since the sync began stays removed.
      const config = stored()[id]
      if (!config?.webProfile || !this.departedDefinitions.has(config.definition ?? id)) continue
      const { apiKey: _apiKey, hasApiKey: _hasApiKey, storedSecrets: _storedSecrets, secrets: _secrets, ...rest } = config
      try {
        await write(id, rest, { promote: false, webProfile: null })
      } catch (error) {
        failed = true
        options.report(`${id}: its plugin is gone and its web profile could not be let go: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (!failed) this.departedDefinitions.clear()
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
