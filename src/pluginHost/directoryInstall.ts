/**
 * Installs a plugin-directory record's reviewed commit of its repository
 * folder; updates read the record again (F-35).
 *
 * Security: only GitHub repositories, folders without dot segments, hex
 * commits and an https listing origin (http only on loopback) are accepted.
 */
import { DIRECTORY_LIST_PATH } from '../customize/directorySite'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import { codeSourceOf, normalizeCodePath, sameCode } from './codeSource'
import {
  DIRECTORY_CATALOG_KEY,
  loadDirectoryPlugins,
  updateDirectoryPlugins,
  type DirectoryPluginEntry,
} from './directoryListings'
import { getInstalledPlugin } from './installedRegistry'
import { fetchListingFiles, placePlugin, type PluginSetupOutcome } from './installSteps'
import { PLUGIN_MANIFEST_DIR_NAME, type PluginInstallPathContext } from './pluginDirs'
import { joinPluginRef } from './pluginRef'
import type { CatalogListing, PluginOrigin } from './registryFormats'

/** What a directory record says about where a plugin's code is. */
export type DirectoryPluginSpec = {
  /** The record's `manifest_name`. */
  manifestName: string
  /** The origin of the listing API the record came from. */
  apiOrigin: string
  repositoryUrl: string
  /** The folder in the repository; absent or empty for its root. */
  path?: string
  /** The record's reviewed commit. */
  commit: string
  /** The name to install under when the plugin's manifest names none. */
  fallbackName: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const COMMIT = /^[0-9a-f]{7,40}$/i
const PLUGIN_NAME = /^[a-z0-9][a-z0-9._-]{0,99}$/i
const GITHUB_REPO = /^https:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i
const IDS_PER_QUERY = 20

/** The listing source a record installs from; null when it cannot be installed here. */
export function directoryListingSource(spec: Pick<DirectoryPluginSpec, 'repositoryUrl' | 'path' | 'commit'>): PluginOrigin | null {
  const repo = GITHUB_REPO.exec(spec.repositoryUrl.trim())
  const path = normalizeCodePath(spec.path)
  if (!repo || path === null || !COMMIT.test(spec.commit)) return null
  const sha = spec.commit.toLowerCase()
  return path
    ? { source: 'git-subdir', url: `https://github.com/${repo[1]}/${repo[2]}`, path, sha }
    : { source: 'github', repo: `${repo[1]}/${repo[2]}`, sha }
}

/** An https origin, or http on loopback; null otherwise. */
export function listingApiOrigin(origin: string): string | null {
  try {
    const url = new URL(origin)
    const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost'
    return url.protocol === 'https:' || (url.protocol === 'http:' && loopback) ? url.origin : null
  } catch {
    return null
  }
}

/** The name a record installs under when its plugin's manifest names none: `fallbackName` as a folder-safe slug. */
export function directoryFallbackName(fallbackName: string): string {
  const slug = fallbackName.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+/, '')
  return slug || 'plugin'
}

function manifestNameOf(files: ReadonlyArray<{ path: string; content: Uint8Array }>): string | undefined {
  const manifest = files.find(file => file.path === `${PLUGIN_MANIFEST_DIR_NAME}/plugin.json`)
  if (!manifest) return undefined
  try {
    const name = (JSON.parse(new TextDecoder('utf-8').decode(manifest.content)) as { name?: unknown }).name
    return typeof name === 'string' && PLUGIN_NAME.test(name) ? name : undefined
  } catch {
    return undefined
  }
}

/**
 * Installs the record's reviewed commit as `<name>@plugin-directory`, `name`
 * from the plugin's manifest. Refused when another plugin's code already
 * holds that name here.
 * Security: `options.refuse` is asked for that identifier once the manifest
 * is read and before anything is written; a non-null answer is thrown.
 */
export async function installFromDirectory(
  ctx: PluginInstallPathContext,
  fs: RuntimeFs,
  spec: DirectoryPluginSpec,
  options: { fetchImpl: typeof fetch; nowIso: string; refuse?: (identifier: string) => string | null },
): Promise<PluginSetupOutcome> {
  const source = directoryListingSource(spec)
  const apiOrigin = listingApiOrigin(spec.apiOrigin)
  if (!source) throw new Error('[installFromDirectory] the record names no GitHub repository, folder and reviewed commit')
  if (!apiOrigin || !UUID.test(spec.manifestName)) throw new Error('[installFromDirectory] the record cannot be found again')
  const provisional: CatalogListing = { name: directoryFallbackName(spec.fallbackName), source }
  const fetched = await fetchListingFiles(
    ctx, fs, DIRECTORY_CATALOG_KEY, provisional, joinPluginRef(provisional.name, DIRECTORY_CATALOG_KEY), options.fetchImpl,
  )
  const name = manifestNameOf(fetched.files) ?? provisional.name
  const refusal = options.refuse?.(joinPluginRef(name, DIRECTORY_CATALOG_KEY)) ?? null
  if (refusal !== null) throw new Error(refusal)
  const listing: CatalogListing = { name, source }
  const code = codeSourceOf(source)!
  const held = await getInstalledPlugin(ctx, fs, joinPluginRef(name, DIRECTORY_CATALOG_KEY))
  const heldCode = held?.codeSource
  if (heldCode && !sameCode(heldCode, code)) {
    throw new Error(`[installFromDirectory] another plugin from the directory is already installed as '${name}'`)
  }
  const outcome = await placePlugin(ctx, fs, DIRECTORY_CATALOG_KEY, name, listing, fetched, { nowIso: options.nowIso })
  await updateDirectoryPlugins(ctx, fs, plugins => {
    plugins[name] = { listing, manifestName: spec.manifestName.toLowerCase(), apiOrigin }
  })
  return outcome
}

type ListedRecord = {
  manifest_name?: unknown
  source?: { repository?: { url?: unknown; path?: unknown; reviewed_commit?: unknown } }
}

const quote = (value: string) => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`

/**
 * Reads the records of the directory installs `names` again and moves each
 * listing to its record's reviewed commit; returns those listings. Throws
 * when a listing API cannot be read (nothing is changed then).
 */
export async function refreshDirectoryListings(
  ctx: PluginInstallPathContext,
  fs: RuntimeFs,
  names: readonly string[],
  fetchImpl: typeof fetch,
): Promise<CatalogListing[]> {
  const stored = await loadDirectoryPlugins(ctx, fs)
  const wanted = names.filter(name => name in stored)
  const byOrigin = new Map<string, string[]>()
  for (const name of wanted) {
    const origin = stored[name]!.apiOrigin
    byOrigin.set(origin, [...(byOrigin.get(origin) ?? []), stored[name]!.manifestName])
  }
  const records = new Map<string, ListedRecord>()
  for (const [origin, ids] of byOrigin) {
    for (let at = 0; at < ids.length; at += IDS_PER_QUERY) {
      const chunk = ids.slice(at, at + IDS_PER_QUERY)
      const params = new URLSearchParams({
        q: '',
        limit: '100',
        filter: `manifest_name in [${chunk.map(quote).join(', ')}]`,
      })
      const response = await fetchImpl(`${origin}${DIRECTORY_LIST_PATH}?${params.toString()}`, {
        headers: { accept: 'application/json' },
      })
      if (!response.ok) throw new Error(`the plugin directory answered HTTP ${response.status}`)
      const body = (await response.json()) as { data?: unknown }
      for (const record of Array.isArray(body?.data) ? (body.data as ListedRecord[]) : []) {
        if (typeof record?.manifest_name === 'string') records.set(`${origin} ${record.manifest_name.toLowerCase()}`, record)
      }
    }
  }
  const moved: Record<string, DirectoryPluginEntry> = {}
  for (const name of wanted) {
    const entry = stored[name]!
    const repository = records.get(`${entry.apiOrigin} ${entry.manifestName}`)?.source?.repository
    if (typeof repository?.url !== 'string' || typeof repository.reviewed_commit !== 'string') continue
    const source = directoryListingSource({
      repositoryUrl: repository.url,
      ...(typeof repository.path === 'string' ? { path: repository.path } : {}),
      commit: repository.reviewed_commit,
    })
    const was = codeSourceOf(entry.listing.source)
    const now = source ? codeSourceOf(source) : null
    // A record that moved to other code is not followed: that is another plugin.
    if (!source || !was || !now || !sameCode(was, now)) continue
    moved[name] = { ...entry, listing: { ...entry.listing, source } }
  }
  if (Object.keys(moved).length > 0) await updateDirectoryPlugins(ctx, fs, plugins => Object.assign(plugins, moved))
  return wanted.map(name => (moved[name] ?? stored[name]!).listing)
}
