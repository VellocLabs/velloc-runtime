/**
 * Contract: the built-in marketplace job (F-14). Runs once per runtime boot
 * and then daily, never awaited by boot. Content: a missing marketplace
 * folder is downloaded; otherwise the origin's `index.json` is read at most
 * once per 24 h, and at once when the client version differs from the one
 * recorded at the last read (an upgrade installed over the profile; a host
 * without a version keeps the daily rhythm). The tarball is downloaded again
 * only when its `buildId` changed, after which the installed built-in
 * plugins are upgraded through the update service. Reconcile: every listing
 * the channel shows that was never seeded is installed, disabled when
 * `onByDefault` is false; a provider plugin left on is consented to at that
 * install through `consentProviders` and stays off without it (F-27); a
 * listing already installed by hand is only recorded. A seeded id is never
 * installed again, so an uninstall sticks. Every failure is reported and
 * retried at the next run. A profile with the `features` flag
 * `builtinMarketplace.autoInstall` set to false runs nothing.
 * State: `~/.velloc/plugins/builtin_marketplace.json`; an unreadable file
 * stops the run (never a reinstall of everything).
 */

import type { UpdateChannel } from '../branding/updateChannels'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import { pluginBlockReason } from './blocklist'
import {
  BUILTIN_MARKETPLACE_KEY,
  builtinMarketplaceIndexUrl,
} from './builtinMarketplace'
import { setPluginEnabled } from './enabledPlugins'
import { setupPlugin } from './installSteps'
import { getInstalledPlugin } from './installedRegistry'
import {
  fetchCatalog,
  listingsVisibleOn,
  loadKnownMarketplaces,
  parseMarketplaceManifest,
} from './marketplaces'
import {
  builtinMarketplaceStateFilePath,
  getMarketplaceManifestPath,
  pluginsRoot,
  type PluginInstallPathContext,
} from './pluginDirs'
import { joinPluginRef } from './pluginRef'
import type { PluginUpdateService } from './pluginUpdates'
import type { CatalogListing, MarketplaceCatalog } from './registryFormats'

/** How long the last index read stays fresh. */
export const BUILTIN_MARKETPLACE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

export type BuiltinSeedRecord = { at: string; channel: UpdateChannel }

export type BuiltinSeedState = {
  version: 1
  /** `index.json` `buildId` of the content on disk, when the origin said. */
  buildId?: string
  /** When `index.json` was last read successfully. */
  lastCheckedAt?: string
  /** The client version at the last successful `index.json` read. */
  clientVersion?: string
  seeded: Record<string, BuiltinSeedRecord>
}

/** What the origin's `index.json` states; only these fields are read. */
export type BuiltinMarketplaceIndex = { buildId: string; sha256?: string }

export type BuiltinSeedDeps = {
  homeDir: string
  fs: RuntimeFs
  fetchImpl: () => typeof fetch
  channel: () => UpdateChannel
  /** `false` runs nothing. */
  autoInstall: () => Promise<boolean>
  /** Upgrades the installed built-in plugins after new content lands. */
  updates?: Pick<PluginUpdateService, 'syncMarketplace'>
  /** Every open session reloads its plugins. */
  reloadPluginsOnAllSessions?: () => void
  /** Records the consent baseline of a provider plugin this job installed on
   *  and registers its providers. Absent: such a plugin stays held off. */
  consentProviders?: (pluginId: string) => Promise<void>
  /** The host's own version; absent, or failing, when the host has none. */
  clientVersion?: () => Promise<string | undefined>
  now?: () => string
  report?: (line: string) => void
}

export type BuiltinSeedOutcome = {
  /** False when the flag is off or the state file is unreadable. */
  ran: boolean
  /** The tarball was downloaded in this run. */
  fetched: boolean
  installed: string[]
  updated: string[]
  /** Blocked listings, and ones that were already installed by hand. */
  skipped: string[]
  failed: string[]
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

const emptyState = (): BuiltinSeedState => ({ version: 1, seeded: {} })

/**
 * The state on disk: a fresh one when the file is missing, `null` when it is
 * present but unreadable.
 */
export async function readBuiltinSeedState(
  ctx: PluginInstallPathContext,
  fs: RuntimeFs,
): Promise<BuiltinSeedState | null> {
  let raw: string
  try {
    raw = String(await fs.readFile(builtinMarketplaceStateFilePath(ctx), { encoding: 'utf-8' }))
  } catch {
    return emptyState()
  }
  try {
    const parsed = JSON.parse(raw) as Partial<BuiltinSeedState> | null
    if (!parsed || typeof parsed !== 'object') return null
    const seeded: Record<string, BuiltinSeedRecord> = {}
    const rawSeeded = parsed.seeded
    if (rawSeeded && typeof rawSeeded === 'object' && !Array.isArray(rawSeeded)) {
      for (const [id, record] of Object.entries(rawSeeded as Record<string, Partial<BuiltinSeedRecord>>)) {
        if (!record || typeof record.at !== 'string') continue
        seeded[id] = { at: record.at, channel: record.channel === 'beta' ? 'beta' : 'stable' }
      }
    }
    return {
      version: 1,
      ...(typeof parsed.buildId === 'string' ? { buildId: parsed.buildId } : {}),
      ...(typeof parsed.lastCheckedAt === 'string' ? { lastCheckedAt: parsed.lastCheckedAt } : {}),
      ...(typeof parsed.clientVersion === 'string' ? { clientVersion: parsed.clientVersion } : {}),
      seeded,
    }
  } catch {
    return null
  }
}

async function writeBuiltinSeedState(
  ctx: PluginInstallPathContext,
  fs: RuntimeFs,
  state: BuiltinSeedState,
): Promise<void> {
  try {
    await fs.mkdir(pluginsRoot(ctx))
  } catch {
    // already there
  }
  await fs.writeFile(builtinMarketplaceStateFilePath(ctx), `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf-8' })
}

/** The cached manifest, or null when the marketplace was never downloaded. */
async function readCachedManifest(
  ctx: PluginInstallPathContext,
  fs: RuntimeFs,
): Promise<MarketplaceCatalog | null> {
  let raw: string
  try {
    raw = String(await fs.readFile(getMarketplaceManifestPath(ctx, BUILTIN_MARKETPLACE_KEY), { encoding: 'utf-8' }))
  } catch {
    return null
  }
  return parseMarketplaceManifest(raw, BUILTIN_MARKETPLACE_KEY)
}

/** `index.json` from the origin; throws when unreachable or malformed. */
export async function readBuiltinMarketplaceIndex(
  url: string,
  fetchImpl: typeof fetch,
): Promise<BuiltinMarketplaceIndex> {
  const response = await fetchImpl(url, { cache: 'no-store' })
  if (!response.ok) throw new Error(`index.json: HTTP ${response.status}`)
  const parsed = (await response.json()) as Partial<BuiltinMarketplaceIndex> | null
  if (!parsed || typeof parsed.buildId !== 'string' || parsed.buildId === '') {
    throw new Error('index.json: no buildId')
  }
  return {
    buildId: parsed.buildId,
    ...(typeof parsed.sha256 === 'string' ? { sha256: parsed.sha256.toLowerCase() } : {}),
  }
}

export async function seedBuiltinMarketplace(deps: BuiltinSeedDeps): Promise<BuiltinSeedOutcome> {
  const ctx: PluginInstallPathContext = { homeDir: deps.homeDir }
  const { fs } = deps
  const now = deps.now ?? (() => new Date().toISOString())
  const report = deps.report ?? (line => console.warn(`[builtin-marketplace] ${line}`))
  const outcome: BuiltinSeedOutcome = { ran: false, fetched: false, installed: [], updated: [], skipped: [], failed: [] }

  if (!(await deps.autoInstall())) return outcome
  const state = await readBuiltinSeedState(ctx, fs)
  if (!state) {
    report('the state file is unreadable; nothing installed this run')
    return outcome
  }
  outcome.ran = true
  const { registry } = await loadKnownMarketplaces(ctx, fs, now())
  const entry = registry[BUILTIN_MARKETPLACE_KEY]
  if (!entry) {
    report('the built-in marketplace is not registered')
    return outcome
  }
  const indexUrl = builtinMarketplaceIndexUrl(entry.source)
  const clientVersion = await currentClientVersion(deps)
  const clientChanged = clientVersion !== undefined && clientVersion !== state.clientVersion
  const stampCheck = () => {
    state.lastCheckedAt = now()
    if (clientVersion !== undefined) state.clientVersion = clientVersion
  }

  // Content: download when absent; otherwise ask the origin daily, or at
  // once after a client upgrade, whether its build changed.
  let manifest = await readCachedManifest(ctx, fs)
  let contentChanged = false
  if (manifest === null) {
    let index: BuiltinMarketplaceIndex | null = null
    if (indexUrl) {
      try {
        index = await readBuiltinMarketplaceIndex(indexUrl, deps.fetchImpl())
      } catch (error) {
        report(`index.json not read (${errorText(error)}); downloading without a build id`)
      }
    }
    try {
      manifest = (await fetchCatalog(ctx, fs, BUILTIN_MARKETPLACE_KEY, now(), deps.fetchImpl(), {
        ...(index?.sha256 ? { sha256: index.sha256 } : {}),
      })).marketplace
    } catch (error) {
      report(`the marketplace could not be downloaded: ${errorText(error)}`)
      return outcome
    }
    outcome.fetched = true
    if (index) {
      state.buildId = index.buildId
      stampCheck()
    }
    await writeBuiltinSeedState(ctx, fs, state)
  } else if (indexUrl && (clientChanged || isStale(state.lastCheckedAt, now()))) {
    let index: BuiltinMarketplaceIndex
    try {
      index = await readBuiltinMarketplaceIndex(indexUrl, deps.fetchImpl())
    } catch (error) {
      report(`index.json not read: ${errorText(error)}`)
      index = { buildId: '' }
    }
    if (index.buildId !== '') {
      if (index.buildId === state.buildId) {
        stampCheck()
        await writeBuiltinSeedState(ctx, fs, state)
      } else {
        try {
          manifest = (await fetchCatalog(ctx, fs, BUILTIN_MARKETPLACE_KEY, now(), deps.fetchImpl(), {
            ...(index.sha256 ? { sha256: index.sha256 } : {}),
          })).marketplace
          outcome.fetched = true
          contentChanged = true
          state.buildId = index.buildId
          stampCheck()
          await writeBuiltinSeedState(ctx, fs, state)
        } catch (error) {
          report(`the new marketplace build could not be downloaded: ${errorText(error)}`)
        }
      }
    }
  }

  if (contentChanged && deps.updates) {
    try {
      const synced = await deps.updates.syncMarketplace(BUILTIN_MARKETPLACE_KEY, manifest.plugins)
      outcome.updated.push(...synced.updated)
      outcome.failed.push(...synced.failed)
    } catch (error) {
      report(`the installed plugins were not upgraded: ${errorText(error)}`)
    }
  }

  // Reconcile: install what the channel shows and was never seeded.
  const channel = deps.channel()
  for (const listing of listingsVisibleOn(manifest.plugins, channel)) {
    const id = joinPluginRef(listing.name, BUILTIN_MARKETPLACE_KEY)
    if (state.seeded[id]) continue
    if (pluginBlockReason(id)) {
      outcome.skipped.push(id)
      continue
    }
    const record: BuiltinSeedRecord = { at: now(), channel }
    if (await getInstalledPlugin(ctx, fs, id)) {
      state.seeded[id] = record
      await writeBuiltinSeedState(ctx, fs, state)
      outcome.skipped.push(id)
      continue
    }
    let awaitsConsent: boolean
    try {
      awaitsConsent = await installListing(ctx, fs, listing, id, deps.fetchImpl(), now())
    } catch (error) {
      report(`'${id}' was not installed: ${errorText(error)}`)
      outcome.failed.push(id)
      continue
    }
    state.seeded[id] = record
    await writeBuiltinSeedState(ctx, fs, state)
    outcome.installed.push(id)
    if (awaitsConsent && deps.consentProviders) {
      await consentAtInstall(ctx, fs, id, deps.consentProviders, report)
    }
  }

  if (outcome.installed.length > 0) deps.reloadPluginsOnAllSessions?.()
  return outcome
}

async function installListing(
  ctx: PluginInstallPathContext,
  fs: RuntimeFs,
  listing: CatalogListing,
  id: string,
  fetchImpl: typeof fetch,
  nowIso: string,
): Promise<boolean> {
  const { heldForConsent } = await setupPlugin(ctx, fs, BUILTIN_MARKETPLACE_KEY, listing.name, { fetchImpl, nowIso })
  if (listing.onByDefault === false) {
    await setPluginEnabled({ homeDir: ctx.homeDir }, fs, id, false)
    return false
  }
  return heldForConsent
}

/**
 * Security: the built-in catalog stands in for the person's first consent to
 * a provider plugin it lists on. The hold is lifted before the baseline is
 * recorded, so the registration that follows sees it on; if recording fails
 * the hold returns and the person consents in Settings as for any plugin.
 * A later version that asks for more still waits for their consent (F-27).
 */
async function consentAtInstall(
  ctx: PluginInstallPathContext,
  fs: RuntimeFs,
  id: string,
  consentProviders: (pluginId: string) => Promise<void>,
  report: (line: string) => void,
): Promise<void> {
  const settingsCtx = { homeDir: ctx.homeDir }
  try {
    await setPluginEnabled(settingsCtx, fs, id, null)
    await consentProviders(id)
  } catch (error) {
    report(`'${id}' stays off until it is approved: ${errorText(error)}`)
    await setPluginEnabled(settingsCtx, fs, id, false).catch(() => {})
  }
}

async function currentClientVersion(deps: BuiltinSeedDeps): Promise<string | undefined> {
  if (!deps.clientVersion) return undefined
  try {
    const version = await deps.clientVersion()
    return typeof version === 'string' && version.length > 0 ? version : undefined
  } catch {
    return undefined
  }
}

function isStale(lastCheckedAt: string | undefined, nowIso: string): boolean {
  if (lastCheckedAt === undefined) return true
  const last = Date.parse(lastCheckedAt)
  if (Number.isNaN(last)) return true
  return Date.parse(nowIso) - last >= BUILTIN_MARKETPLACE_CHECK_INTERVAL_MS
}
