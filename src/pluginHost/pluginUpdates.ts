/**
 * Contract: marketplace plugin update service (F-14). Covers user-scope plugins
 * installed from a registered marketplace or straight from the plugin
 * directory (F-35); project and local scopes, folder plugins and provider
 * plugins (their own consent flow, F-27) are left out.
 *
 * `check` refreshes each marketplace that has a covered plugin — for
 * directory installs, their records' reviewed commits — and records an
 * offer where the listing is newer than the installed record. `update`
 * installs the offered version into its own version directory and switches
 * `installed_plugins.json` to it; the old directory is kept as the rollback
 * target. A failure is recorded and the installed version stays. `autoUpdate`
 * runs only when the `pluginAutoUpdate` setting is on and installs offers for
 * enabled plugins, skipping a version the person rolled back from.
 * `syncMarketplace` is the same round for one marketplace whatever the
 * setting says, over listings the caller already downloaded: the built-in
 * marketplace's own releases (F-14).
 * State: `~/.velloc/plugins/plugin_updates.json`.
 */

import type { RuntimeFs } from '../utils/fs/runtimeFs'
import { joinRuntimePath } from '../utils/runtimePaths'
import { pluginBlockReason } from './blocklist'
import { getEnabledPluginsMap } from './enabledPlugins'
import { refreshDirectoryListings } from './directoryInstall'
import { DIRECTORY_CATALOG_KEY } from './directoryListings'
import { setupPlugin } from './installSteps'
import { loadInstalledPlugins, recordPluginSetup } from './installedRegistry'
import { fetchCatalog, loadKnownMarketplaces } from './marketplaces'
import {
  getMarketplaceContentDir,
  pluginUpdatesFilePath,
  pluginsRoot,
  type PluginInstallPathContext,
} from './pluginDirs'
import { getPluginManifestPath } from './pluginPaths'
import { joinPluginRef, splitPluginRef } from './pluginRef'
import { isNewerPluginVersion } from './pluginVersionCompare'
import { manifestDeclaresProviders } from './providerPluginConsent'
import type { CatalogListing, PluginSetupRecord } from './registryFormats'

/** How long a check stays fresh for a non-forced `check`. */
export const PLUGIN_UPDATE_CHECK_MAX_AGE_MS = 30 * 60 * 1000

export type PluginUpdateOffer = { version: string }

/** A failed update, kept until the next success. `reason` is log text shown
 *  as given; it is not a catalog string. */
export type PluginUpdateFailure = { at: string; reason: string; version?: string }

export type PluginUpdateApplied = { version: string; at: string; auto: boolean }

type PreviousInstall = Pick<PluginSetupRecord, 'version' | 'installPath' | 'installedAt' | 'gitCommitSha'>

type PluginUpdateRecord = {
  offer?: PluginUpdateOffer
  failure?: PluginUpdateFailure
  applied?: PluginUpdateApplied
  previous?: PreviousInstall
  /** A version rolled back from: offered, never installed automatically. */
  skipped?: string
}

type PluginUpdatesFile = {
  lastCheckedAt?: string
  unreachable?: UnreachableMarketplace[]
  plugins: Record<string, PluginUpdateRecord>
}

export type UnreachableMarketplace = { marketplace: string; reason: string }

export type PluginUpdateStateKind = 'up-to-date' | 'available' | 'failed' | 'unchecked'

/** One covered plugin, as the settings page shows it. */
export type PluginUpdateStatus = {
  identifier: string
  version?: string
  state: PluginUpdateStateKind
  offer?: PluginUpdateOffer
  failure?: PluginUpdateFailure
  applied?: PluginUpdateApplied
  rollbackVersion?: string
}

export type PluginUpdatesSnapshot = {
  autoUpdate: boolean
  checking: boolean
  lastCheckedAt?: string
  unreachable: UnreachableMarketplace[]
  plugins: PluginUpdateStatus[]
}

export type PluginUpdateServiceDeps = {
  homeDir: string
  fs: RuntimeFs
  fetchImpl: () => typeof fetch
  readAutoUpdate: () => Promise<boolean>
  writeAutoUpdate: (on: boolean) => Promise<void>
  /** Every open session reloads its plugins. */
  reloadPluginsOnAllSessions?: () => void
  now?: () => string
  report?: (line: string) => void
}

export type PluginUpdateService = {
  snapshot(): Promise<PluginUpdatesSnapshot>
  /** Refreshes the marketplaces unless the last check is younger than
   *  `PLUGIN_UPDATE_CHECK_MAX_AGE_MS` and covered every plugin installed now;
   *  `force` always refreshes. */
  check(options?: { force?: boolean }): Promise<PluginUpdatesSnapshot>
  update(identifier: string): Promise<PluginUpdateStatus>
  rollback(identifier: string): Promise<PluginUpdateStatus>
  setAutoUpdate(on: boolean): Promise<PluginUpdatesSnapshot>
  /** One background round: nothing when the setting is off. */
  autoUpdate(options?: { force?: boolean }): Promise<void>
  /** Offers for `marketplace`'s plugins from `listings` (a fresh download
   *  when omitted), then every offer installed, the setting notwithstanding;
   *  explicit-off plugins and a rolled-back version are left alone. */
  syncMarketplace(marketplace: string, listings?: readonly CatalogListing[]): Promise<{ updated: string[]; failed: string[] }>
  subscribe(listener: () => void): () => void
}

type Covered = { identifier: string; name: string; marketplace: string; record: PluginSetupRecord }

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

async function readJson(fs: RuntimeFs, path: string): Promise<unknown> {
  try {
    return JSON.parse(String(await fs.readFile(path, { encoding: 'utf-8' })))
  } catch {
    return null
  }
}

function parseFile(raw: unknown): PluginUpdatesFile {
  const value = raw as Partial<PluginUpdatesFile> | null
  const plugins = value && typeof value.plugins === 'object' && value.plugins && !Array.isArray(value.plugins)
    ? (value.plugins as Record<string, PluginUpdateRecord>)
    : {}
  return {
    ...(typeof value?.lastCheckedAt === 'string' ? { lastCheckedAt: value.lastCheckedAt } : {}),
    unreachable: Array.isArray(value?.unreachable) ? value.unreachable : [],
    plugins,
  }
}

/** The version the listing would install, when it says. A plugin kept inside
 *  the marketplace repo answers with its own manifest's version. */
async function offeredVersion(
  ctx: PluginInstallPathContext,
  fs: RuntimeFs,
  marketplace: string,
  listing: CatalogListing,
): Promise<string | undefined> {
  if (listing.source.source === 'local') {
    const dir = joinRuntimePath(getMarketplaceContentDir(ctx, marketplace), listing.source.path.replace(/^\.\//, ''))
    const version = (await readJson(fs, getPluginManifestPath(dir)) as { version?: unknown } | null)?.version
    if (typeof version === 'string' && version.trim() !== '') return version
  }
  return listing.version
}

/** The offer a listing makes over the installed record, if any. */
async function offerOf(
  ctx: PluginInstallPathContext,
  fs: RuntimeFs,
  covered: Covered,
  listing: CatalogListing,
): Promise<PluginUpdateOffer | undefined> {
  const installed = covered.record.version
  const offered = await offeredVersion(ctx, fs, covered.marketplace, listing)
  if (offered && installed) return isNewerPluginVersion(offered, installed) ? { version: offered } : undefined
  const source = listing.source
  if ('sha' in source && source.sha && covered.record.gitCommitSha) {
    const pinned = source.sha
    const have = covered.record.gitCommitSha
    return have.startsWith(pinned) || pinned.startsWith(have) ? undefined : { version: pinned.slice(0, 12) }
  }
  if (source.source === 'https' && source.sha256 && covered.record.origin?.sha256) {
    return source.sha256 === covered.record.origin.sha256 ? undefined : { version: source.sha256.slice(0, 12) }
  }
  return undefined
}

export function createPluginUpdateService(deps: PluginUpdateServiceDeps): PluginUpdateService {
  const ctx: PluginInstallPathContext = { homeDir: deps.homeDir }
  const { fs } = deps
  const now = deps.now ?? (() => new Date().toISOString())
  const report = deps.report ?? (line => console.warn(`[plugin-updates] ${line}`))
  const listeners = new Set<() => void>()
  let checking: Promise<PluginUpdatesSnapshot> | null = null
  let writes: Promise<unknown> = Promise.resolve()

  const notify = () => {
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch (error) {
        report(`a change listener failed: ${errorText(error)}`)
      }
    }
  }

  const readFile = async () => parseFile(await readJson(fs, pluginUpdatesFilePath(ctx)))

  /** Serialized read-modify-write of the state file. */
  const mutate = <T>(change: (file: PluginUpdatesFile) => T | Promise<T>): Promise<T> => {
    const run = writes.then(async () => {
      const file = await readFile()
      const result = await change(file)
      try {
        await fs.mkdir(pluginsRoot(ctx))
      } catch {
        // already there
      }
      await fs.writeFile(pluginUpdatesFilePath(ctx), `${JSON.stringify(file, null, 2)}\n`, { encoding: 'utf-8' })
      return result
    })
    writes = run.catch(() => undefined)
    return run
  }

  const covered = async (): Promise<Covered[]> => {
    const { registry } = await loadInstalledPlugins(ctx, fs)
    const { registry: known } = await loadKnownMarketplaces(ctx, fs, now())
    const out: Covered[] = []
    for (const [identifier, records] of Object.entries(registry.plugins)) {
      const { name, marketplace } = splitPluginRef(identifier)
      if (!marketplace || !(marketplace in known || marketplace === DIRECTORY_CATALOG_KEY)) continue
      const record = records.find(entry => entry.scope === 'user')
      if (!record) continue
      if (manifestDeclaresProviders(await readJson(fs, getPluginManifestPath(record.installPath)))) continue
      out.push({ identifier, name, marketplace, record })
    }
    return out
  }

  const statusOf = (plugin: Covered, record: PluginUpdateRecord | undefined, checked: boolean): PluginUpdateStatus => {
    const state: PluginUpdateStateKind = record?.failure
      ? 'failed'
      : record?.offer
        ? 'available'
        : checked
          ? 'up-to-date'
          : 'unchecked'
    return {
      identifier: plugin.identifier,
      ...(plugin.record.version ? { version: plugin.record.version } : {}),
      state,
      ...(record?.offer ? { offer: record.offer } : {}),
      ...(record?.failure ? { failure: record.failure } : {}),
      ...(record?.applied ? { applied: record.applied } : {}),
      ...(record?.previous?.version ? { rollbackVersion: record.previous.version } : {}),
    }
  }

  const snapshot = async (): Promise<PluginUpdatesSnapshot> => {
    const [file, plugins, autoUpdate] = await Promise.all([readFile(), covered(), deps.readAutoUpdate()])
    return {
      autoUpdate,
      checking: checking !== null,
      ...(file.lastCheckedAt ? { lastCheckedAt: file.lastCheckedAt } : {}),
      unreachable: file.unreachable ?? [],
      plugins: plugins.map(plugin => statusOf(plugin, file.plugins[plugin.identifier], file.lastCheckedAt !== undefined)),
    }
  }

  type CheckScope = {
    /** Only this marketplace's plugins; the others' records are untouched. */
    marketplace?: string
    /** Its listings, in place of a download. */
    listings?: readonly CatalogListing[]
  }

  const runCheck = async (scope: CheckScope = {}): Promise<PluginUpdatesSnapshot> => {
    const plugins = (await covered()).filter(plugin => scope.marketplace === undefined || plugin.marketplace === scope.marketplace)
    const byMarketplace = new Map<string, Covered[]>()
    for (const plugin of plugins) byMarketplace.set(plugin.marketplace, [...(byMarketplace.get(plugin.marketplace) ?? []), plugin])
    const offers = new Map<string, PluginUpdateOffer | undefined>()
    const unreachable: UnreachableMarketplace[] = []
    for (const [marketplace, members] of byMarketplace) {
      let listings: readonly CatalogListing[]
      try {
        listings = scope.listings && marketplace === scope.marketplace
          ? scope.listings
          : marketplace === DIRECTORY_CATALOG_KEY
            ? await refreshDirectoryListings(ctx, fs, members.map(member => member.name), deps.fetchImpl())
            : (await fetchCatalog(ctx, fs, marketplace, now(), deps.fetchImpl())).marketplace.plugins
      } catch (error) {
        unreachable.push({ marketplace, reason: errorText(error) })
        continue
      }
      for (const plugin of members) {
        const listing = listings.find(entry => entry.name === plugin.name)
        offers.set(plugin.identifier, listing ? await offerOf(ctx, fs, plugin, listing) : undefined)
      }
    }
    await mutate(file => {
      if (scope.marketplace === undefined) {
        file.lastCheckedAt = now()
        file.unreachable = unreachable
      } else {
        file.unreachable = [...(file.unreachable ?? []).filter(entry => entry.marketplace !== scope.marketplace), ...unreachable]
      }
      for (const plugin of plugins) file.plugins[plugin.identifier] ??= {}
      for (const [identifier, offer] of offers) {
        const record = (file.plugins[identifier] ??= {})
        if (offer) {
          if (record.failure && record.failure.version !== offer.version) delete record.failure
          record.offer = offer
        } else {
          delete record.offer
          delete record.failure
        }
      }
      if (scope.marketplace === undefined) {
        for (const identifier of Object.keys(file.plugins)) {
          if (!plugins.some(plugin => plugin.identifier === identifier)) delete file.plugins[identifier]
        }
      }
    })
    return snapshot()
  }

  const check = async (options: { force?: boolean } = {}): Promise<PluginUpdatesSnapshot> => {
    if (checking) return checking
    if (!options.force) {
      const file = await readFile()
      const last = file.lastCheckedAt
      const fresh = last !== undefined && Date.parse(now()) - Date.parse(last) < PLUGIN_UPDATE_CHECK_MAX_AGE_MS
      const unseen = (await covered()).some(plugin => !(plugin.identifier in file.plugins))
      if (fresh && !unseen) return snapshot()
    }
    const run = runCheck()
    checking = run
    notify()
    try {
      return await run
    } finally {
      checking = null
      notify()
    }
  }

  const findCovered = async (identifier: string): Promise<Covered> => {
    const plugin = (await covered()).find(entry => entry.identifier === identifier)
    if (!plugin) throw new Error(`'${identifier}' is not a marketplace plugin installed for this user`)
    return plugin
  }

  const install = async (identifier: string, auto: boolean): Promise<PluginUpdateStatus> => {
    const plugin = await findCovered(identifier)
    const blocked = pluginBlockReason(joinPluginRef(plugin.name, plugin.marketplace))
    if (blocked) throw new Error(blocked)
    const offer = (await readFile()).plugins[identifier]?.offer
    const before = plugin.record
    try {
      const result = await setupPlugin(ctx, fs, plugin.marketplace, plugin.name, { nowIso: now(), fetchImpl: deps.fetchImpl() })
      const at = now()
      await mutate(file => {
        const record = (file.plugins[identifier] ??= {})
        delete record.offer
        delete record.failure
        record.applied = { version: result.entry.version ?? offer?.version ?? '', at, auto }
        if (result.entry.installPath !== before.installPath) {
          record.previous = {
            installPath: before.installPath,
            ...(before.version ? { version: before.version } : {}),
            ...(before.installedAt ? { installedAt: before.installedAt } : {}),
            ...(before.gitCommitSha ? { gitCommitSha: before.gitCommitSha } : {}),
          }
        }
      })
    } catch (error) {
      await mutate(file => {
        const record = (file.plugins[identifier] ??= {})
        record.failure = { at: now(), reason: errorText(error), ...(offer ? { version: offer.version } : {}) }
      })
      notify()
      throw error
    }
    deps.reloadPluginsOnAllSessions?.()
    notify()
    const after = await findCovered(identifier)
    return statusOf(after, (await readFile()).plugins[identifier], true)
  }

  const rollback = async (identifier: string): Promise<PluginUpdateStatus> => {
    const plugin = await findCovered(identifier)
    const previous = (await readFile()).plugins[identifier]?.previous
    if (!previous) throw new Error(`'${identifier}' has no earlier version to go back to`)
    const present = await fs.readdir(previous.installPath).then(entries => entries.length > 0, () => false)
    if (!present) throw new Error(`the earlier version of '${identifier}' is no longer on disk`)
    const from = plugin.record.version
    await recordPluginSetup(ctx, fs, identifier, { ...previous, scope: 'user', lastUpdated: now() })
    await mutate(file => {
      const record = (file.plugins[identifier] ??= {})
      delete record.previous
      delete record.applied
      delete record.failure
      if (from) {
        record.skipped = from
        record.offer = { version: from }
      }
    })
    deps.reloadPluginsOnAllSessions?.()
    notify()
    return statusOf(await findCovered(identifier), (await readFile()).plugins[identifier], true)
  }

  /** Installs every available offer in `state`, for `marketplace`'s plugins
   *  when given; explicit-off plugins and a rolled-back version are skipped. */
  const installOffers = async (
    state: PluginUpdatesSnapshot,
    marketplace?: string,
  ): Promise<{ updated: string[]; failed: string[] }> => {
    const enabled = await getEnabledPluginsMap({ homeDir: deps.homeDir }, fs)
    const file = await readFile()
    const updated: string[] = []
    const failed: string[] = []
    for (const status of state.plugins) {
      if (marketplace !== undefined && splitPluginRef(status.identifier).marketplace !== marketplace) continue
      if (status.state !== 'available' || !status.offer) continue
      if (enabled[status.identifier] === false) continue
      if (file.plugins[status.identifier]?.skipped === status.offer.version) continue
      try {
        await install(status.identifier, true)
        updated.push(status.identifier)
      } catch (error) {
        failed.push(status.identifier)
        report(`'${status.identifier}' was not updated: ${errorText(error)}`)
      }
    }
    return { updated, failed }
  }

  const autoUpdate = async (options: { force?: boolean } = {}): Promise<void> => {
    if (!(await deps.readAutoUpdate())) return
    await installOffers(await check(options))
  }

  const syncMarketplace = async (
    marketplace: string,
    listings?: readonly CatalogListing[],
  ): Promise<{ updated: string[]; failed: string[] }> => {
    const state = await runCheck({ marketplace, ...(listings ? { listings } : {}) })
    return installOffers(state, marketplace)
  }

  return {
    snapshot,
    check,
    update: identifier => install(identifier, false),
    rollback,
    async setAutoUpdate(on) {
      await deps.writeAutoUpdate(on)
      notify()
      return snapshot()
    },
    autoUpdate,
    syncMarketplace,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

export type PluginUpdateScheduleOptions = {
  firstDelayMs?: number
  intervalMs?: number
  setTimer?: (run: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  report?: (line: string) => void
}

/** Background rounds: the first after `firstDelayMs` (2 min), then every
 *  `intervalMs` (6 h). A round does nothing while the setting is off.
 *  Returns the stop. */
export function startPluginUpdateSchedule(
  service: Pick<PluginUpdateService, 'autoUpdate'>,
  options: PluginUpdateScheduleOptions = {},
): () => void {
  const setTimer =
    options.setTimer ??
    ((run, ms) => {
      const handle = setTimeout(run, ms)
      // A pending round never keeps a host process alive.
      ;(handle as { unref?: () => void }).unref?.()
      return handle
    })
  const clearTimer = options.clearTimer ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>))
  const report = options.report ?? (line => console.warn(`[plugin-updates] ${line}`))
  const interval = options.intervalMs ?? 6 * 60 * 60 * 1000
  let stopped = false
  let handle: unknown
  const round = async () => {
    try {
      await service.autoUpdate()
    } catch (error) {
      report(`the update round failed: ${errorText(error)}`)
    }
    if (!stopped) handle = setTimer(() => void round(), interval)
  }
  handle = setTimer(() => void round(), options.firstDelayMs ?? 2 * 60 * 1000)
  return () => {
    stopped = true
    clearTimer(handle)
  }
}
