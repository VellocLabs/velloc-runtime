/**
 * Contract: provider mod update service. Online sources only fill a local
 * version directory; the active version is what `installed_plugins.json` points
 * at. An update is staged into its own directory and validated (a failure is
 * recorded, the active version stays); a grant no wider than the consented one
 * activates (old directory kept for rollback); a wider one parks as
 * `needs-consent` until `recordConsent`. A plugin with no consent on file is not
 * running and not checked. State: `~/.velloc/plugins/provider_mod_updates.json`.
 */

import type { RuntimeFs } from '../utils/fs/runtimeFs'
import type { ActivePlugin, PluginLoadIssue } from './pluginModel'
import { getProviderModHost } from '../mods/provider/providerModHost'
import { fetchCatalog, findCatalogPlugin } from './marketplaces'
import {
  DEFAULT_HTTPS_LIMITS,
  HttpsSourceError,
  assertHttpsUrl,
  downloadHttps,
  extractPluginArchive,
  readArchiveIdentity,
  sha256Of,
  writeVersionDir,
  type HttpsLimits,
} from './httpsSource'
import { fetchListingFiles } from './installSteps'
import { loadInstalledPlugins, recordPluginSetup } from './installedRegistry'
import { assemblePluginAt } from './loadPlugins'
import { providerModUpdatesFilePath, pluginsRoot, type PluginInstallPathContext } from './pluginDirs'
import { readStrictPluginRef } from './pluginRef'
import type { PluginSetupRecord } from './registryFormats'
import type { ExtractedFile } from './extract'
import { ensureDirRecursive } from './writeExtracted'
import { grantOf, widened, type Grant, type GrantDelta } from './providerGrant'

// ── state ──

export type PluginUpdateSource = { marketplace?: string; url?: string }

export type UpdateFailureKind =
  | 'fetch'
  | 'integrity'
  | 'invalid-archive'
  | 'invalid-manifest'
  | 'unsupported-provider-api'
  | 'no-providers'
  | 'name-mismatch'
  | 'source-missing'
  | 'admission'
  | 'activate'

/** A failed check or activation, kept until the next success. `reason` is log
 *  text for the page to show as given; it is not a catalog string. */
export type UpdateFailure = {
  at: string
  kind: UpdateFailureKind
  reason: string
  /** The version that failed, when it was known. */
  version?: string
}

export type PendingUpdate = {
  version: string
  installPath: string
  grant: Grant
  delta: GrantDelta
  stagedAt: string
  sha256?: string
  origin?: PluginSetupRecord['origin']
}

export type PluginUpdateRecord = {
  source?: PluginUpdateSource
  lastCheckedAt?: string
  /** The grant the person agreed to, with the version it belongs to. */
  consent?: { version: string; grant: Grant; at: string }
  /** The version that ran before the last switch: the rollback target. */
  previous?: { version: string; installPath: string; grant: Grant }
  pending?: PendingUpdate
  /** A version the person turned down (or rolled back from): not offered again. */
  skippedVersion?: string
  /** The digest of the last archive that needed no action, for an `updates.url`. */
  lastArchiveSha256?: string
  applied?: { version: string; at: string; silent: boolean }
  failure?: UpdateFailure
}

export type UpdateStateFile = { version: 1; plugins: Record<string, PluginUpdateRecord> }

export type ProviderModUpdateStatus = {
  /** `<name>@<catalog>` */
  pluginId: string
  state: 'no-source' | 'unchecked' | 'up-to-date' | 'needs-consent' | 'failed'
  source?: PluginUpdateSource
  activeVersion?: string
  lastCheckedAt?: string
  /** Whether the person has approved this plugin's grant (a consent baseline is
   *  on file). Until then the host registers none of its providers. */
  consented: boolean
  /** The grant of the version that is installed now: what the enable flow
   *  asks the person to consent to, and what an update is measured against. */
  grant: Grant
  /** The manifest's `author.name`, when it has one: who the person is trusting. */
  publisher?: string
  /** Set while `state` is `needs-consent`. `grant` is the parked version's own. */
  pending?: { version: string; delta: GrantDelta; stagedAt: string; grant: Grant }
  /** The version `rollback` would return to. */
  rollbackVersion?: string
  /** The last failure, also while an older update is parked. */
  failure?: UpdateFailure
  applied?: { version: string; at: string; silent: boolean }
}

/**
 * What the consent UI (and anything else) calls. Every method resolves to the
 * status of the plugin(s) it touched; failures of the network or of a bad
 * package are RECORDED in the status, not thrown. A call that cannot apply
 * (`recordConsent` for a version that is not parked, `rollback` with nothing
 * to roll back) rejects.
 */
export interface ProviderModUpdateService {
  /** Every installed plugin that carries providers. */
  status(): Promise<ProviderModUpdateStatus[]>
  /** Check now: one plugin, or all of them. */
  checkNow(pluginId?: string): Promise<ProviderModUpdateStatus[]>
  /** The scheduler's tick: check only the plugins last checked more than the interval ago. */
  checkDue(): Promise<ProviderModUpdateStatus[]>
  /** The person agreed to the parked version's grant: activate it. */
  recordConsent(pluginId: string, version: string): Promise<ProviderModUpdateStatus>
  /** The person turned the parked version down: drop it and do not offer it again. */
  decline(pluginId: string, version: string): Promise<ProviderModUpdateStatus>
  /** Go back to the previous version (kept for this). */
  rollback(pluginId: string): Promise<ProviderModUpdateStatus>
  /** The enable flow consented to the grant of the version running now. */
  recordInitialConsent(pluginId: string): Promise<ProviderModUpdateStatus>
  /** A status changed. Returns the unsubscribe. */
  subscribe(listener: () => void): () => void
}

// ── dependencies ──

/** The one method of `ProviderModHost` the service uses. */
export type ProviderModSwapper = {
  isConfigured(): boolean
  swapPlugin(plugin: ActivePlugin): Promise<unknown>
}

export type ProviderModUpdateDeps = {
  ctx: PluginInstallPathContext
  fs: RuntimeFs
  fetchImpl?: typeof fetch
  /** Milliseconds since the epoch. */
  now?: () => number
  /** Where the module version is swapped. Default: the realm's host. */
  host?: ProviderModSwapper
  /** Admission of a staged version before it can be activated: throws to refuse
   *  it. Default: each provider module must be readable. */
  admit?: (plugin: ActivePlugin) => Promise<void>
  /** Called after a baseline was recorded: the host registers the plugin's
   *  providers now that the person approved them. Failures are reported. */
  afterConsent?: () => Promise<void>
  /** The most between checks of one plugin. Default one day. */
  intervalMs?: number
  limits?: HttpsLimits
  report?: (line: string) => void
}

export const DEFAULT_UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000

const EMPTY_STATE: UpdateStateFile = { version: 1, plugins: {} }

function failureText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

class StageFailure extends Error {
  constructor(
    readonly kind: UpdateFailureKind,
    message: string,
    readonly version?: string,
  ) {
    super(message)
  }
}

function failureKindOf(error: unknown): UpdateFailureKind {
  if (error instanceof StageFailure) return error.kind
  if (error instanceof HttpsSourceError) {
    switch (error.code) {
      case 'digest-mismatch':
        return 'integrity'
      case 'bad-archive':
      case 'too-many-files':
      case 'file-too-large':
      case 'no-manifest':
      case 'bad-manifest':
      case 'bad-name':
      case 'bad-version':
        return 'invalid-archive'
      default:
        return 'fetch'
    }
  }
  return 'fetch'
}

type Candidate = {
  files: ExtractedFile[]
  sha256?: string
  origin?: PluginSetupRecord['origin']
}

type InstalledProvider = {
  id: string
  name: string
  catalog: string
  entry: PluginSetupRecord
  plugin: ActivePlugin
  updates?: PluginUpdateSource
}

export function createProviderModUpdateService(deps: ProviderModUpdateDeps): ProviderModUpdateService {
  const { ctx, fs } = deps
  const now = deps.now ?? (() => Date.now())
  const iso = (): string => new Date(now()).toISOString()
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch.bind(globalThis)
  const limits = deps.limits ?? DEFAULT_HTTPS_LIMITS
  const intervalMs = deps.intervalMs ?? DEFAULT_UPDATE_INTERVAL_MS
  const report = deps.report ?? (() => {})
  const listeners = new Set<() => void>()
  let chain: Promise<unknown> = Promise.resolve()

  const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
    const run = chain.then(work)
    chain = run.catch(() => undefined)
    return run
  }
  const changed = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch (error) {
        report(`an update listener failed: ${failureText(error)}`)
      }
    }
  }

  // ── the state file ──

  async function readState(forWrite: boolean): Promise<UpdateStateFile> {
    const path = providerModUpdatesFilePath(ctx)
    let raw: string
    try {
      raw = String(await fs.readFile(path, { encoding: 'utf-8' }))
    } catch (error) {
      if (/ENOENT|not found|no such file/i.test(failureText(error))) return structuredClone(EMPTY_STATE)
      if (forWrite) throw new Error(`provider_mod_updates.json is unreadable (${failureText(error)}); refusing to overwrite it`)
      return structuredClone(EMPTY_STATE)
    }
    try {
      const parsed = JSON.parse(raw) as Partial<UpdateStateFile> | null
      if (parsed && parsed.version === 1 && parsed.plugins && typeof parsed.plugins === 'object') {
        return { version: 1, plugins: parsed.plugins as Record<string, PluginUpdateRecord> }
      }
      throw new Error('not an update state file')
    } catch (error) {
      if (forWrite) throw new Error(`provider_mod_updates.json is malformed (${failureText(error)}); refusing to overwrite it. Fix or delete the file.`)
      return structuredClone(EMPTY_STATE)
    }
  }

  async function writeState(state: UpdateStateFile): Promise<void> {
    await ensureDirRecursive(fs, pluginsRoot(ctx))
    await fs.writeFile(providerModUpdatesFilePath(ctx), `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf-8' })
  }

  // ── what is installed ──

  async function installedProviders(): Promise<InstalledProvider[]> {
    const { registry } = await loadInstalledPlugins(ctx, fs)
    const out: InstalledProvider[] = []
    for (const [id, entries] of Object.entries(registry.plugins).sort(([a], [b]) => a.localeCompare(b))) {
      const entry = entries.find(candidate => candidate.scope === 'user')
      const ref = readStrictPluginRef(id)
      if (!entry || !ref.ok) continue
      try {
        const { plugin } = await assemblePluginAt(entry.installPath, `marketplace:${id}`, true, ref.value.name, fs)
        plugin.installIdentifier = id
        const providers = Object.values(plugin.manifest.providers ?? {})
        if (providers.length === 0) continue
        const updates = providers.find(provider => provider.updates !== undefined)?.updates
        out.push({
          id,
          name: ref.value.name,
          catalog: ref.value.marketplace,
          entry,
          plugin,
          ...(updates ? { updates: { ...updates } } : {}),
        })
      } catch (error) {
        report(`${id}: could not be read: ${failureText(error)}`)
      }
    }
    return out
  }

  async function findInstalled(pluginId: string): Promise<InstalledProvider> {
    const found = (await installedProviders()).find(candidate => candidate.id === pluginId)
    if (!found) throw new Error(`${pluginId} is not an installed provider mod`)
    return found
  }

  function statusOf(installed: InstalledProvider, record: PluginUpdateRecord | undefined): ProviderModUpdateStatus {
    const source = record?.source ?? installed.updates
    const state: ProviderModUpdateStatus['state'] = record?.pending
      ? 'needs-consent'
      : record?.failure
        ? 'failed'
        : source === undefined
          ? 'no-source'
          : record?.lastCheckedAt === undefined
            ? 'unchecked'
            : 'up-to-date'
    return {
      pluginId: installed.id,
      state,
      consented: record?.consent !== undefined,
      grant: grantOf(installed.plugin.manifest.providers ?? {}),
      ...(installed.plugin.manifest.author?.name ? { publisher: installed.plugin.manifest.author.name } : {}),
      ...(source ? { source } : {}),
      ...(installed.entry.version !== undefined ? { activeVersion: installed.entry.version } : {}),
      ...(record?.lastCheckedAt !== undefined ? { lastCheckedAt: record.lastCheckedAt } : {}),
      ...(record?.pending
        ? {
            pending: {
              version: record.pending.version,
              delta: record.pending.delta,
              stagedAt: record.pending.stagedAt,
              grant: record.pending.grant,
            },
          }
        : {}),
      ...(record?.previous ? { rollbackVersion: record.previous.version } : {}),
      ...(record?.failure ? { failure: record.failure } : {}),
      ...(record?.applied ? { applied: record.applied } : {}),
    }
  }

  // ── fetching a candidate ──

  async function fetchFromUrl(url: string, active: string | undefined, record: PluginUpdateRecord): Promise<Candidate | null> {
    assertHttpsUrl(url)
    const first = await downloadHttps(url, fetchImpl, limits.maxArchiveBytes)
    let archive = first
    let archiveUrl = url
    let pinned: string | undefined
    if (/json/i.test(first.contentType) || new URL(url).pathname.toLowerCase().endsWith('.json')) {
      let pointer: { version?: unknown; archive?: unknown; sha256?: unknown }
      try {
        pointer = JSON.parse(new TextDecoder('utf-8').decode(first.bytes)) as typeof pointer
      } catch (error) {
        throw new StageFailure('invalid-archive', `the update pointer at ${url} is not valid JSON: ${failureText(error)}`)
      }
      if (typeof pointer.version !== 'string' || typeof pointer.archive !== 'string') {
        throw new StageFailure('invalid-archive', `the update pointer at ${url} needs a "version" and an "archive"`)
      }
      if (pointer.version === active || pointer.version === record.skippedVersion || pointer.version === record.pending?.version) return null
      archiveUrl = new URL(pointer.archive, first.url).href
      if (typeof pointer.sha256 === 'string') pinned = pointer.sha256.toLowerCase()
      archive = await downloadHttps(archiveUrl, fetchImpl, limits.maxArchiveBytes)
    }
    const sha256 = await sha256Of(archive.bytes)
    if (pinned && pinned !== sha256) {
      throw new HttpsSourceError('digest-mismatch', `the archive's SHA-256 is ${sha256}, not the pinned ${pinned}`)
    }
    if (archive === first && sha256 === record.lastArchiveSha256) return null
    const files = await extractPluginArchive(archive.bytes, limits)
    return { files, sha256, origin: { source: 'https', url: archiveUrl, sha256 } }
  }

  async function fetchFromMarketplace(installed: InstalledProvider, marketplace: string, record: PluginUpdateRecord): Promise<Candidate | null> {
    await fetchCatalog(ctx, fs, marketplace, iso(), fetchImpl)
    const listing = await findCatalogPlugin(ctx, fs, marketplace, installed.name)
    if (!listing) {
      throw new StageFailure('source-missing', `${installed.name} is not listed in marketplace '${marketplace}'`)
    }
    const active = installed.entry.version
    if (listing.version !== undefined && (listing.version === active || listing.version === record.skippedVersion || listing.version === record.pending?.version)) {
      return null
    }
    const { files, sha } = await fetchListingFiles(ctx, fs, marketplace, listing, installed.id, fetchImpl)
    return { files, ...(sha !== undefined ? { sha256: sha } : {}) }
  }

  // ── staging ──

  async function removeDir(path: string): Promise<void> {
    try {
      await fs.rm(path, { recursive: true, force: true })
    } catch (error) {
      report(`could not remove ${path}: ${failureText(error)}`)
    }
  }

  /** Parse and admit the staged directory; throws a `StageFailure`. */
  async function admitStaged(installed: InstalledProvider, installPath: string, version: string): Promise<ActivePlugin> {
    const { plugin, errors } = await assemblePluginAt(installPath, `marketplace:${installed.id}`, true, installed.name, fs)
    plugin.installIdentifier = installed.id
    const providerIssues = errors.filter(isProviderIssue)
    if (providerIssues.length > 0) {
      const lines = providerIssues.flatMap(issue => (issue.type === 'manifest-validation-error' ? issue.validationErrors.filter(line => line.startsWith('providers')) : [describeIssue(issue)]))
      const kind: UpdateFailureKind = lines.some(line => /providerApi/.test(line)) ? 'unsupported-provider-api' : 'invalid-manifest'
      throw new StageFailure(kind, lines.join('; '), version)
    }
    if (errors.some(issue => issue.type === 'manifest-parse-error')) {
      throw new StageFailure('invalid-manifest', errors.map(describeIssue).join('; '), version)
    }
    if (plugin.name !== installed.name) {
      throw new StageFailure('name-mismatch', `the new version is named "${plugin.name}", not "${installed.name}"`, version)
    }
    if (!plugin.providers || plugin.providers.length === 0) {
      const why = errors.length > 0 ? `: ${errors.map(describeIssue).join('; ')}` : ''
      throw new StageFailure('no-providers', `the new version has no provider${why}`, version)
    }
    try {
      await (deps.admit ?? defaultAdmit)(plugin)
    } catch (error) {
      throw new StageFailure('admission', failureText(error), version)
    }
    return plugin
  }

  async function defaultAdmit(plugin: ActivePlugin): Promise<void> {
    for (const provider of plugin.providers ?? []) await fs.readFile(provider.modulePath, { encoding: 'utf-8' })
  }

  // ── activation ──

  async function swapHost(plugin: ActivePlugin): Promise<void> {
    const host: ProviderModSwapper = deps.host ?? getProviderModHost()
    if (host.isConfigured()) await host.swapPlugin(plugin)
  }

  /** Point the registry at `version`'s directory and swap the host; reverts the registry if the swap fails. */
  async function switchTo(
    installed: InstalledProvider,
    target: { version: string; installPath: string; origin?: PluginSetupRecord['origin'] },
    plugin: ActivePlugin,
  ): Promise<void> {
    const before = installed.entry
    const next: PluginSetupRecord = {
      ...before,
      installPath: target.installPath,
      version: target.version,
      lastUpdated: iso(),
      ...(target.origin ? { origin: target.origin } : {}),
    }
    await recordPluginSetup(ctx, fs, installed.id, next)
    try {
      await swapHost(plugin)
    } catch (error) {
      await recordPluginSetup(ctx, fs, installed.id, before)
      throw new StageFailure('activate', `the new version could not be swapped in: ${failureText(error)}`, target.version)
    }
  }

  async function activate(
    installed: InstalledProvider,
    record: PluginUpdateRecord,
    staged: { version: string; installPath: string; grant: Grant; origin?: PluginSetupRecord['origin'] },
    plugin: ActivePlugin,
    silent: boolean,
  ): Promise<void> {
    const oldVersion = installed.entry.version
    const oldPath = installed.entry.installPath
    await switchTo(installed, staged, plugin)
    const stalePrevious = record.previous
    record.previous = {
      version: oldVersion ?? 'unknown',
      installPath: oldPath,
      grant: record.consent?.grant ?? grantOf(installed.plugin.manifest.providers ?? {}),
    }
    record.consent = { version: staged.version, grant: staged.grant, at: iso() }
    record.applied = { version: staged.version, at: iso(), silent }
    delete record.pending
    delete record.failure
    // Only the one rollback target is kept.
    if (stalePrevious && stalePrevious.installPath !== staged.installPath && stalePrevious.installPath !== oldPath) {
      await removeDir(stalePrevious.installPath)
    }
  }

  // ── one plugin's check ──

  async function checkOne(installed: InstalledProvider, state: UpdateStateFile): Promise<void> {
    const record = (state.plugins[installed.id] ??= {})
    const source = installed.updates
    if (source) record.source = source
    else delete record.source
    // A plugin the person has not approved runs nothing and is measured
    // against nothing: no baseline is invented for it. Approval is
    // `recordInitialConsent` (the consent dialog).
    if (!record.consent) return
    record.lastCheckedAt = iso()
    if (!source) return
    const activeVersion = installed.entry.version
    let stagedPath: string | undefined
    try {
      let candidate: Candidate | null
      if (source.url) candidate = await fetchFromUrl(source.url, activeVersion, record)
      else if (source.marketplace) candidate = await fetchFromMarketplace(installed, source.marketplace, record)
      else candidate = null
      if (candidate === null) {
        delete record.failure
        return
      }
      const identity = readArchiveIdentity(candidate.files)
      if (identity.name !== installed.name) {
        throw new StageFailure('name-mismatch', `the new version is named "${identity.name}", not "${installed.name}"`, identity.version)
      }
      if (identity.version === activeVersion || identity.version === record.skippedVersion || identity.version === record.pending?.version) {
        if (candidate.sha256 && source.url) record.lastArchiveSha256 = candidate.sha256
        delete record.failure
        return
      }
      stagedPath = await writeVersionDir(ctx, fs, installed.catalog, installed.name, identity.version, candidate.files)
      const plugin = await admitStaged(installed, stagedPath, identity.version)
      const grant = grantOf(plugin.manifest.providers ?? {})
      const delta = widened(record.consent.grant, grant)
      const staged = {
        version: identity.version,
        installPath: stagedPath,
        grant,
        ...(candidate.origin ? { origin: candidate.origin } : {}),
      }
      if (candidate.sha256 && source.url) record.lastArchiveSha256 = candidate.sha256
      if (delta.widened) {
        // A newer parked version replaces an older parked one.
        if (record.pending && record.pending.installPath !== stagedPath) await removeDir(record.pending.installPath)
        record.pending = {
          version: identity.version,
          installPath: stagedPath,
          grant,
          delta,
          stagedAt: iso(),
          ...(candidate.sha256 ? { sha256: candidate.sha256 } : {}),
          ...(candidate.origin ? { origin: candidate.origin } : {}),
        }
        delete record.failure
        stagedPath = undefined
      } else {
        await activate(installed, record, staged, plugin, true)
        stagedPath = undefined
      }
    } catch (error) {
      const version = error instanceof StageFailure ? error.version : undefined
      record.failure = {
        at: iso(),
        kind: failureKindOf(error),
        reason: failureText(error),
        ...(version !== undefined ? { version } : {}),
      }
      report(`${installed.id}: update failed (${record.failure.kind}): ${record.failure.reason}`)
      if (stagedPath && stagedPath !== record.pending?.installPath) await removeDir(stagedPath)
    }
  }

  async function runChecks(select: (installed: InstalledProvider, record: PluginUpdateRecord | undefined) => boolean): Promise<ProviderModUpdateStatus[]> {
    const state = await readState(true)
    const all = await installedProviders()
    for (const installed of all) {
      if (select(installed, state.plugins[installed.id])) await checkOne(installed, state)
    }
    await writeState(state)
    changed()
    return (await installedProviders()).map(installed => statusOf(installed, state.plugins[installed.id]))
  }

  // ── the service ──

  return {
    status: () =>
      exclusive(async () => {
        const state = await readState(false)
        return (await installedProviders()).map(installed => statusOf(installed, state.plugins[installed.id]))
      }),

    checkNow: pluginId => exclusive(() => runChecks(installed => pluginId === undefined || installed.id === pluginId)),

    checkDue: () =>
      exclusive(() =>
        runChecks((installed, record) => {
          if (!installed.updates) return false
          const last = record?.lastCheckedAt ? Date.parse(record.lastCheckedAt) : Number.NaN
          return Number.isNaN(last) || now() - last >= intervalMs
        }),
      ),

    recordConsent: (pluginId, version) =>
      exclusive(async () => {
        const state = await readState(true)
        const installed = await findInstalled(pluginId)
        const record = (state.plugins[pluginId] ??= {})
        const pending = record.pending
        if (!pending || pending.version !== version) {
          throw new Error(`${pluginId} has no parked update ${version} waiting for consent`)
        }
        try {
          const plugin = await admitStaged(installed, pending.installPath, pending.version)
          await activate(installed, record, pending, plugin, false)
        } catch (error) {
          record.failure = {
            at: iso(),
            kind: failureKindOf(error),
            reason: failureText(error),
            version: pending.version,
          }
          report(`${pluginId}: ${pending.version} could not be activated: ${record.failure.reason}`)
        }
        await writeState(state)
        changed()
        return statusOf(await findInstalled(pluginId), record)
      }),

    decline: (pluginId, version) =>
      exclusive(async () => {
        const state = await readState(true)
        const installed = await findInstalled(pluginId)
        const record = (state.plugins[pluginId] ??= {})
        if (!record.pending || record.pending.version !== version) {
          throw new Error(`${pluginId} has no parked update ${version} to decline`)
        }
        await removeDir(record.pending.installPath)
        record.skippedVersion = version
        delete record.pending
        await writeState(state)
        changed()
        return statusOf(installed, record)
      }),

    rollback: pluginId =>
      exclusive(async () => {
        const state = await readState(true)
        const installed = await findInstalled(pluginId)
        const record = (state.plugins[pluginId] ??= {})
        const previous = record.previous
        if (!previous) throw new Error(`${pluginId} has no previous version to roll back to`)
        const { plugin, errors } = await assemblePluginAt(previous.installPath, `marketplace:${pluginId}`, true, installed.name, fs)
        plugin.installIdentifier = pluginId
        if (errors.some(isProviderIssue) || !plugin.providers?.length) {
          throw new Error(`${pluginId}: the previous version ${previous.version} is no longer usable`)
        }
        const demotedVersion = installed.entry.version
        const demotedPath = installed.entry.installPath
        await switchTo(installed, { version: previous.version, installPath: previous.installPath }, plugin)
        record.consent = { version: previous.version, grant: previous.grant, at: iso() }
        if (demotedVersion) record.skippedVersion = demotedVersion
        record.applied = { version: previous.version, at: iso(), silent: false }
        delete record.previous
        delete record.failure
        // A parked update was measured against the grant of the version just left.
        if (record.pending) {
          record.pending.delta = widened(previous.grant, record.pending.grant)
          if (!record.pending.delta.widened) {
            await removeDir(record.pending.installPath)
            delete record.pending
          }
        }
        await removeDir(demotedPath)
        await writeState(state)
        changed()
        return statusOf(await findInstalled(pluginId), record)
      }),

    recordInitialConsent: async pluginId => {
      const status = await exclusive(async () => {
        const state = await readState(true)
        const installed = await findInstalled(pluginId)
        const record = (state.plugins[pluginId] ??= {})
        record.consent = {
          version: installed.entry.version ?? 'unknown',
          grant: grantOf(installed.plugin.manifest.providers ?? {}),
          at: iso(),
        }
        await writeState(state)
        changed()
        return statusOf(installed, record)
      })
      // Outside the exclusive section: the host's scan may read this service.
      try {
        await deps.afterConsent?.()
      } catch (error) {
        report(`${pluginId}: its providers could not be registered after approval: ${failureText(error)}`)
      }
      return status
    },

    subscribe: listener => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

function isProviderIssue(issue: PluginLoadIssue): boolean {
  if (issue.type === 'manifest-validation-error') return issue.validationErrors.some(line => line.startsWith('providers'))
  return issue.type === 'path-not-found' && issue.component === 'providers'
}

function describeIssue(issue: PluginLoadIssue): string {
  switch (issue.type) {
    case 'manifest-validation-error':
      return issue.validationErrors.join('; ')
    case 'manifest-parse-error':
      return `plugin.json: ${issue.parseError}`
    case 'path-not-found':
      return `${issue.component ?? 'file'} not found: ${issue.path}`
    default:
      return issue.type
  }
}

// ── the schedule ──

export type UpdateScheduleOptions = {
  /** How often to look at what is due. Default one hour; a plugin is checked at most once per `intervalMs`. */
  pollMs?: number
  /** Check at once, then on the poll. Default true. */
  immediate?: boolean
  setIntervalFn?: (callback: () => void, ms: number) => unknown
  clearIntervalFn?: (handle: unknown) => void
  report?: (line: string) => void
}

/** Runs `service.checkDue()` in the background. Returns the stop function. */
export function startProviderModUpdateSchedule(service: ProviderModUpdateService, options: UpdateScheduleOptions = {}): () => void {
  const setTimer = options.setIntervalFn ?? ((callback, ms) => setInterval(callback, ms))
  const clearTimer = options.clearIntervalFn ?? (handle => clearInterval(handle as ReturnType<typeof setInterval>))
  const tick = (): void => {
    service.checkDue().catch(error => options.report?.(`the background update check failed: ${failureText(error)}`))
  }
  if (options.immediate !== false) tick()
  const handle = setTimer(tick, options.pollMs ?? 60 * 60 * 1000)
  return () => clearTimer(handle)
}
