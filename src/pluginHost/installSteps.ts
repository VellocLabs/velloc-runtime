// Installing and uninstalling a marketplace plugin: fetch, unpack into the
// version cache, record in installed_plugins.json.

import type { RuntimeFs } from '../utils/fs/runtimeFs'
import { joinPath } from '../memory/memoryPaths'
import type { SettingsPathContext } from '../settings/settingsStore'
import { applyEnabledPluginsPatch } from './enabledPlugins'
import { extractGitHubTarball, extractSubdir, type ExtractedFile } from './extract'
import { fetchSourceTarball } from './fetch'
import { extractPluginArchive } from './httpsSource'
import {
  recordPluginSetup,
  getInstalledPlugin,
  dropPluginRecord,
} from './installedRegistry'
import {
  findCatalogPlugin,
  fetchCatalog,
} from './marketplaces'
import { joinPluginRef } from './pluginRef'
import {
  getMarketplaceContentDir,
  getPluginVersionCacheDir,
  type PluginInstallPathContext,
} from './pluginDirs'
import type {
  PluginSetupRecord,
  CatalogListing,
  InstallScope,
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

export type InstallPluginOptions = {
  refreshFirst?: boolean
  fetchImpl?: typeof fetch
  nowIso?: string
}

export type PluginSetupOutcome = {
  entry: PluginSetupRecord
  identifier: string
  fileCount: number
}

/** Installs one plugin from a marketplace entry at user scope. */
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

  let entry: CatalogListing | null = options.refreshFirst
    ? await refreshAndLookup(ctx, fs, catalogKey, pluginName, nowIso, fetchImpl)
    : await findCatalogPlugin(ctx, fs, catalogKey, pluginName)
  if (!entry) {
    entry = await refreshAndLookup(
      ctx, fs, catalogKey, pluginName, nowIso, fetchImpl,
    )
  }
  if (!entry) {
    throw new Error(
      `[installPlugin] '${pluginName}' is not listed in marketplace '${catalogKey}'.`
      + ` Run \`/marketplace update ${catalogKey}\` to refresh the listing, or check the plugin name.`,
    )
  }

  const { files, sha: fetchedSha } = await fetchListingFiles(
    ctx, fs, catalogKey, entry, identifier, fetchImpl,
  )

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
  const recorded: PluginSetupRecord = {
    scope,
    installPath,
    version,
    installedAt: nowIso,
    ...(fetchedSha ? { gitCommitSha: fetchedSha } : {}),
  }
  await recordPluginSetup(ctx, fs, identifier, recorded)
  // A plugin that adds model providers starts OFF: the person turns it on
  // through the consent dialog.
  await holdProviderPluginForConsent(ctx, fs, identifier, manifestParsed)

  return {
    entry: recorded,
    identifier,
    fileCount: writeResult.written,
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
): Promise<{ files: ExtractedFile[]; sha?: string }> {
  let files: ExtractedFile[]
  let fetchedSha: string | undefined
  if (entry.source.source === 'local') {
    const localPath = entry.source.path
    files = await readLocalPluginFiles(ctx, fs, catalogKey, localPath)
    if (files.length === 0) {
      throw new Error(
        `[installPlugin] '${identifier}' local source './${localPath}' is empty or`
        + ` missing from marketplace '${catalogKey}' content`
        + ` — run \`/marketplace update ${catalogKey}\` and retry`,
      )
    }
  } else {
    const fetched = await fetchSourceTarball(entry.source, fetchImpl)
    fetchedSha = fetched.sha
    files = entry.source.source === 'https'
      ? await extractPluginArchive(fetched.bytes)
      : await extractGitHubTarball(fetched.bytes)
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
  if (clearEnabledOverride) {
    await applyEnabledPluginsPatch(settingsCtx, fs, { [identifier]: null })
  }
  return {
    registryHadEntry: true,
    formerInstallPath: existing.installPath,
  }
}
