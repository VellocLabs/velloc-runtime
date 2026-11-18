// Installing and uninstalling a marketplace plugin: fetch, unpack into the
// version cache, record in installed_plugins.json.

import type { RuntimeFs } from '../utils/fs/runtimeFs'
import { joinPath } from '../memory/memoryPaths'
import type { SettingsPathContext } from '../settings/settingsStore'
import { applyEnabledPluginsPatch } from './enabledPlugins'
import { extractGitHubTarball, extractSubdir, type ExtractedFile } from './extract'
import { fetchSourceTarball } from './fetch'
import {
  DEFAULT_HTTPS_LIMITS,
  HttpsSourceError,
  downloadHttps,
  extractPluginArchive,
  sha256Of,
} from './httpsSource'
import {
  recordPluginSetup,
  getInstalledPlugin,
  dropPluginRecord,
} from './installedRegistry'
import { codeSourceOf } from './codeSource'
import { DIRECTORY_CATALOG_KEY, readDirectoryListing, updateDirectoryPlugins } from './directoryListings'
import {
  ensureMarketplaceRepo,
  findCatalogPlugin,
  fetchCatalog,
  fetchCatalogListing,
  loadKnownMarketplaces,
  parseMarketplaceManifest,
  withMarketplaceContent,
} from './marketplaces'
import { BUILTIN_MARKETPLACE_KEY } from './builtinMarketplace'
import { joinPluginRef, splitPluginRef } from './pluginRef'
import {
  getMarketplaceContentDir,
  getMarketplaceManifestPath,
  getPluginVersionCacheDir,
  type PluginInstallPathContext,
} from './pluginDirs'
import type {
  PluginSetupRecord,
  CatalogListing,
  InstallScope,
  PluginOrigin,
} from './registryFormats'
import { pickCacheVersion } from './cacheVersion'
import { holdProviderPluginForConsent } from './providerPluginConsent'
import { writeExtractedFiles } from './writeExtracted'

export function isoNow(): string {
  return new Date().toISOString()
}

/** Resolves `relative` under `base`; throws if the result leaves `base`. */
export function confineUnder(
  basePath: string,
  subPath: string,
): string {
  const resolvedPath = joinAndNormalize(basePath, subPath)
  const normalizedBase = normalizePath(basePath)
  const sep = normalizedBase.includes('\\') ? '\\' : '/'
  const baseWithSep = normalizedBase.endsWith(sep)
    ? normalizedBase
    : normalizedBase + sep

  if (
    !resolvedPath.startsWith(baseWithSep) &&
    resolvedPath !== normalizedBase
  ) {
    throw new Error(
      `Path traversal detected: "${subPath}" would escape the base directory`,
    )
  }

  return resolvedPath
}

function normalizePath(p: string): string {
  const isWindows = /^[A-Za-z]:[\\/]/.test(p) || p.includes('\\')
  const sep = isWindows ? '\\' : '/'
  const rawParts = p.split(/[\\/]/)
  const out: string[] = []
  for (const part of rawParts) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (out.length === 0 || out[out.length - 1] === '..') {
        out.push('..')
      } else {
        out.pop()
      }
      continue
    }
    out.push(part)
  }
  if (isWindows) {
    const driveMatch = p.match(/^[A-Za-z]:/)
    if (driveMatch) {
      return `${driveMatch[0]}${sep}${out.join(sep)}`
    }
    if (p.startsWith(sep)) {
      return `${sep}${out.join(sep)}`
    }
  } else if (p.startsWith('/')) {
    return `/${out.join('/')}`
  }
  return out.join(sep)
}

function joinAndNormalize(basePath: string, subPath: string): string {
  if (/^[/\\]/.test(subPath) || /^[A-Za-z]:[/\\]/.test(subPath)) {
    return normalizePath(subPath)
  }
  const sep = /^[A-Za-z]:[\\/]/.test(basePath) || basePath.includes('\\') ? '\\' : '/'
  const joined = basePath.endsWith(sep)
    ? `${basePath}${subPath}`
    : `${basePath}${sep}${subPath}`
  return normalizePath(joined)
}

/** The plugin is not in its marketplace's listing. */
export class PluginNotListedError extends Error {
  constructor(readonly pluginName: string, readonly catalogKey: string) {
    super(
      `[installPlugin] '${pluginName}' is not listed in marketplace '${catalogKey}'.`
      + ` Run \`/marketplace update ${catalogKey}\` to refresh the listing, or check the plugin name.`,
    )
    this.name = 'PluginNotListedError'
  }
}

export type InstallPluginOptions = {
  refreshFirst?: boolean
  /**
   * Reads the marketplace's current listing before the lookup: the manifest
   * alone, then the repo when the plugin is kept inside it, with the lookup
   * repeated on the downloaded manifest. A person's install asks for it.
   */
  freshListing?: boolean
  fetchImpl?: typeof fetch
  nowIso?: string
}

export type PluginSetupOutcome = {
  entry: PluginSetupRecord
  identifier: string
  fileCount: number
  /** It declares providers and was turned off until the person consents. */
  heldForConsent: boolean
}

/**
 * Installs one plugin at user scope from its catalog's listing: a
 * marketplace's, or — for `plugin-directory` — the one it was installed
 * from the directory with (never downloaded again).
 */
export async function setupPlugin(
  ctx: PluginInstallPathContext,
  fs: RuntimeFs,
  catalogKey: string,
  pluginName: string,
  options: InstallPluginOptions = {},
): Promise<PluginSetupOutcome> {
  const nowIso = options.nowIso ?? isoNow()
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis)
  const identifier = joinPluginRef(pluginName, catalogKey)

  if (catalogKey === DIRECTORY_CATALOG_KEY) {
    const listing = await readDirectoryListing(ctx, fs, pluginName)
    if (!listing) throw new Error(`[installPlugin] '${identifier}' was not installed from the plugin directory.`)
    const fetched = await fetchListingFiles(ctx, fs, catalogKey, listing, identifier, fetchImpl, nowIso)
    return placePlugin(ctx, fs, catalogKey, pluginName, listing, fetched, { nowIso })
  }

  const looked = await withMarketplaceContent(ctx, catalogKey, async () => {
    const listed = options.freshListing && catalogKey !== BUILTIN_MARKETPLACE_KEY
      ? await lookupInFreshListing(ctx, fs, catalogKey, pluginName, nowIso, fetchImpl)
      : await lookupInCachedListing(ctx, fs, catalogKey, pluginName, nowIso, fetchImpl, options.refreshFirst === true)
    if (!listed) throw new PluginNotListedError(pluginName, catalogKey)
    // Only a plugin kept inside the repo copies from the marketplace's content.
    const copied = listed.source.source === 'local'
      ? await fetchListingFiles(ctx, fs, catalogKey, listed, identifier, fetchImpl, nowIso)
      : null
    return { listed, copied }
  })
  const entry = looked.listed
  const fetched = entry.source.source === 'local'
    ? looked.copied!
    : await fetchListingFiles(ctx, fs, catalogKey, entry, identifier, fetchImpl, nowIso)
  const marketplaceSource = entry.source.source === 'local'
    ? (await loadKnownMarketplaces(ctx, fs, nowIso)).registry[catalogKey]?.source
    : undefined
  return placePlugin(ctx, fs, catalogKey, pluginName, entry, fetched, { nowIso, marketplaceSource })
}

/**
 * Writes fetched plugin files into the version cache and records the install
 * at user scope, with the code source they came from. A plugin that adds
 * model providers is held off until the person consents.
 */
export async function placePlugin(
  ctx: PluginInstallPathContext,
  fs: RuntimeFs,
  catalogKey: string,
  pluginName: string,
  entry: CatalogListing,
  fetched: { files: ExtractedFile[]; sha?: string },
  options: { nowIso: string; marketplaceSource?: PluginOrigin },
): Promise<PluginSetupOutcome> {
  const { nowIso } = options
  const identifier = joinPluginRef(pluginName, catalogKey)
  const { files, sha: fetchedSha } = fetched

  const manifestEntry = files.find(
    f => f.path === '.claude-plugin/plugin.json',
  )
  let manifestVersion: string | undefined
  let manifestParsed: unknown
  if (manifestEntry) {
    try {
      const manifestText = new TextDecoder('utf-8').decode(manifestEntry.content)
      const manifestJson = JSON.parse(manifestText) as { version?: unknown }
      manifestParsed = manifestJson
      if (typeof manifestJson.version === 'string') {
        manifestVersion = manifestJson.version
      }
    } catch (e) {
      throw new Error(
        `[installPlugin] '${identifier}' .claude-plugin/plugin.json failed to parse: ${e instanceof Error ? e.message : String(e)}`,
      )
    }
  }

  let version = pickCacheVersion({
    manifestVersion: manifestVersion || undefined,
    catalogVersion: entry.version,
    commitSha: fetchedSha,
    source: entry.source,
  })
  if (version === 'unknown') {
    version = `tmp-${nowIso.replace(/[^0-9]/g, '').slice(0, 14)}`
  }

  const installPath = getPluginVersionCacheDir(
    ctx, catalogKey, pluginName, version,
  )
  const writeResult = await writeExtractedFiles(fs, installPath, files)
  if (writeResult.firstFailureIndex !== null) {
    const failingPath = files[writeResult.firstFailureIndex]?.path ?? '<unknown>'
    throw new Error(
      `[installPlugin] '${identifier}' wrote ${writeResult.written}/${files.length} files`
      + ` before failing at '${failingPath}' under ${installPath}`,
    )
  }

  const scope: InstallScope = 'user'
  const codeSource = codeSourceOf(entry.source, options.marketplaceSource, fetchedSha)
  const recorded: PluginSetupRecord = {
    scope,
    installPath,
    version,
    installedAt: nowIso,
    ...(fetchedSha ? { gitCommitSha: fetchedSha } : {}),
    ...(codeSource ? { codeSource } : {}),
  }
  await recordPluginSetup(ctx, fs, identifier, recorded)
  // A plugin that adds model providers starts OFF: the person turns it on
  // through the consent dialog.
  const heldForConsent = await holdProviderPluginForConsent(ctx, fs, identifier, manifestParsed)

  return {
    entry: recorded,
    identifier,
    fileCount: writeResult.written,
    heldForConsent,
  }
}

/** The files of a catalog listing's plugin: copied from the cached marketplace
 *  content (a `local` source) or fetched and unpacked. Throws when there are none. */
export async function fetchListingFiles(
  ctx: PluginInstallPathContext,
  fs: RuntimeFs,
  catalogKey: string,
  entry: CatalogListing,
  identifier: string,
  fetchImpl: typeof fetch,
  nowIso: string = isoNow(),
): Promise<{ files: ExtractedFile[]; sha?: string }> {
  let files: ExtractedFile[]
  let fetchedSha: string | undefined
  if (entry.source.source === 'local') {
    const localPath = entry.source.path
    await ensureMarketplaceRepo(ctx, fs, catalogKey, nowIso, fetchImpl)
    files = await readLocalPluginFiles(ctx, fs, catalogKey, localPath)
    if (localPath === '') files = await withoutSiblingPlugins(ctx, fs, catalogKey, files)
    if (files.length === 0) {
      throw new Error(
        `[installPlugin] '${identifier}' local source './${localPath}' is empty or`
        + ` missing from marketplace '${catalogKey}' content`
        + ` — run \`/marketplace update ${catalogKey}\` and retry`,
      )
    }
  } else if (entry.source.source === 'https') {
    // Security: the https source's download rules (https on every hop, size cap),
    // and a listing that pins its archive's digest gets exactly those bytes.
    const fetched = await downloadHttps(entry.source.url, fetchImpl, DEFAULT_HTTPS_LIMITS.maxArchiveBytes)
    if (entry.source.sha256) {
      const digest = await sha256Of(fetched.bytes)
      if (digest !== entry.source.sha256) {
        throw new HttpsSourceError(
          'digest-mismatch',
          `[installPlugin] '${identifier}' archive digest ${digest} is not the listed ${entry.source.sha256}`,
        )
      }
    }
    files = await extractPluginArchive(fetched.bytes)
  } else {
    const fetched = await fetchSourceTarball(entry.source, fetchImpl)
    fetchedSha = fetched.sha
    files = await extractGitHubTarball(fetched.bytes)
    if (entry.source.source === 'git-subdir') {
      const subdir = entry.source.path
      const rerooted = extractSubdir(files, subdir)
      if (rerooted.length === 0) {
        throw new Error(
          `[installPlugin] '${identifier}' subdirectory '${subdir}' not found in`
          + ` ${entry.source.url} (git-subdir source) — check the marketplace entry's path`,
        )
      }
      files = rerooted
    }
    if (files.length === 0) {
      throw new Error(
        `[installPlugin] '${identifier}' fetched OK but extracted 0 files; aborting`,
      )
    }
  }

  return { files, sha: fetchedSha }
}

async function readLocalPluginFiles(
  ctx: PluginInstallPathContext,
  fs: RuntimeFs,
  catalogKey: string,
  localPath: string,
): Promise<ExtractedFile[]> {
  const root = joinPath(
    getMarketplaceContentDir(ctx, catalogKey),
    ...localPath.split('/'),
  )
  const out: ExtractedFile[] = []
  await collectFilesUnder(fs, root, '', out)
  return out
}

/** A repo-root listing's files minus the folders the marketplace lists as other plugins. */
async function withoutSiblingPlugins(
  ctx: PluginInstallPathContext,
  fs: RuntimeFs,
  catalogKey: string,
  files: ExtractedFile[],
): Promise<ExtractedFile[]> {
  const raw = await fs.readFile(getMarketplaceManifestPath(ctx, catalogKey), { encoding: 'utf-8' })
  const siblings = parseMarketplaceManifest(raw, catalogKey).plugins
    .flatMap(p => (p.source.source === 'local' && p.source.path !== '' ? [`${p.source.path}/`] : []))
  return files.filter(file => !siblings.some(prefix => file.path.startsWith(prefix)))
}

async function collectFilesUnder(
  fs: RuntimeFs,
  absDir: string,
  relPrefix: string,
  out: ExtractedFile[],
): Promise<void> {
  let entries
  try {
    entries = await fs.readdir(absDir)
  } catch {
    return
  }
  for (const dirent of entries) {
    const abs = joinPath(absDir, dirent.name)
    const rel = relPrefix ? `${relPrefix}/${dirent.name}` : dirent.name
    if (dirent.isDirectory()) {
      await collectFilesUnder(fs, abs, rel, out)
    } else if (dirent.isFile()) {
      out.push({ path: rel, content: await fs.readFileBytes(abs) })
    }
  }
}

/** The listing read after the repo download, so it and the files come from one commit. */
async function lookupInCachedListing(
  ctx: PluginInstallPathContext,
  fs: RuntimeFs,
  catalogKey: string,
  pluginName: string,
  nowIso: string,
  fetchImpl: typeof fetch,
  refreshFirst: boolean,
): Promise<CatalogListing | null> {
  if (refreshFirst) return refreshAndLookup(ctx, fs, catalogKey, pluginName, nowIso, fetchImpl)
  const downloaded = await ensureMarketplaceRepo(ctx, fs, catalogKey, nowIso, fetchImpl)
  const entry = await findCatalogPlugin(ctx, fs, catalogKey, pluginName)
  if (entry || downloaded) return entry
  return refreshAndLookup(ctx, fs, catalogKey, pluginName, nowIso, fetchImpl)
}

/**
 * The listing as the marketplace publishes it now. A plugin kept inside the
 * repo is looked up again in the manifest of the repo just downloaded.
 */
async function lookupInFreshListing(
  ctx: PluginInstallPathContext,
  fs: RuntimeFs,
  catalogKey: string,
  pluginName: string,
  nowIso: string,
  fetchImpl: typeof fetch,
): Promise<CatalogListing | null> {
  await fetchCatalogListing(ctx, fs, catalogKey, nowIso, fetchImpl)
  const listed = await findCatalogPlugin(ctx, fs, catalogKey, pluginName)
  if (listed?.source.source !== 'local') return listed
  return (await ensureMarketplaceRepo(ctx, fs, catalogKey, nowIso, fetchImpl))
    ? findCatalogPlugin(ctx, fs, catalogKey, pluginName)
    : listed
}

async function refreshAndLookup(
  ctx: PluginInstallPathContext,
  fs: RuntimeFs,
  catalogKey: string,
  pluginName: string,
  nowIso: string,
  fetchImpl: typeof fetch,
): Promise<CatalogListing | null> {
  await fetchCatalog(ctx, fs, catalogKey, nowIso, fetchImpl)
  return findCatalogPlugin(ctx, fs, catalogKey, pluginName)
}

/** `<plugin>@<marketplace>` */
export function buildInstallIdentifier(
  catalogKey: string,
  pluginName: string,
): string {
  return joinPluginRef(pluginName, catalogKey)
}

export type UninstallPluginOptions = {
  clearEnabledOverride?: boolean
}

export type UninstallPluginResult = {
  registryHadEntry: boolean
  formerInstallPath?: string
}

/** Drops the registry record and, unless told not to, the enabled override; files stay on disk. */
export async function teardownPlugin(
  pluginCtx: PluginInstallPathContext,
  settingsCtx: SettingsPathContext,
  fs: RuntimeFs,
  identifier: string,
  options: UninstallPluginOptions = {},
): Promise<UninstallPluginResult> {
  const clearEnabledOverride = options.clearEnabledOverride !== false
  const existing = await getInstalledPlugin(pluginCtx, fs, identifier)
  if (!existing) {
    return { registryHadEntry: false }
  }
  await dropPluginRecord(pluginCtx, fs, identifier)
  const { name, marketplace } = splitPluginRef(identifier)
  if (marketplace === DIRECTORY_CATALOG_KEY) {
    await updateDirectoryPlugins(pluginCtx, fs, plugins => {
      delete plugins[name]
    })
  }
  if (clearEnabledOverride) {
    await applyEnabledPluginsPatch(settingsCtx, fs, { [identifier]: null })
  }
  return {
    registryHadEntry: true,
    formerInstallPath: existing.installPath,
  }
}
