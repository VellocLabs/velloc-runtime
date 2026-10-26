/**
 * The item the directory page shows (F-35): its page path read as a plugin
 * or a connector, looked up in the public directory listing and matched to
 * what this machine can install — a plugin from a registered marketplace, or
 * a connector as an http MCP server.
 */
import type { NexusMcpServerConfig } from '../settings/settingsTypes'
import type { CatalogListing, PluginOrigin } from '../pluginHost/registryFormats'
import {
  codeSourceOf,
  normalizeCodePath,
  normalizeRepoUrl,
  sameCode,
  sameCommit,
  type PluginCodeSource,
} from '../pluginHost/codeSource'
import { directoryListingSource, type DirectoryPluginSpec } from '../pluginHost/directoryInstall'
import { DIRECTORY_API_ORIGIN, DIRECTORY_LIST_PATH } from './directorySite'

/** What a directory page path names. */
export type DirectoryIntent =
  | { kind: 'plugin'; manifestName: string }
  | { kind: 'connector'; slug: string }

export type DirectoryItemKind = DirectoryIntent['kind']

/** What the person is shown about the item. */
export type DirectoryItemSummary = {
  name: string
  summary?: string
  publisher?: string
  iconUrl?: string
}

/** The kinds of part a directory item lists; anything else reads as `other`. */
export type DirectoryComponentType = 'skill' | 'command' | 'agent' | 'hook' | 'mcp_server' | 'other'

/** One part an item brings: a skill, a command, an agent, a hook or an MCP server. */
export type DirectoryComponent = {
  type: DirectoryComponentType
  name: string
  description?: string
  /** An MCP server's tool count. */
  toolCount?: number
}

/**
 * Contract: everything a detail page shows about a directory record. Every
 * URL is `https`; lists are capped.
 */
export type DirectoryItemDetails = DirectoryItemSummary & {
  description?: string
  publisherUrl?: string
  /** The directory reviewed it (its record carries a verified tier). */
  verified?: boolean
  screenshots?: string[]
  components?: DirectoryComponent[]
  links?: { documentation?: string; support?: string; privacy?: string; repository?: string }
  categories?: string[]
  /** ISO 8601. */
  addedTime?: string
  updatedTime?: string
  /** The record's own page on the directory site, as a path. */
  pagePath?: string
}

export type DirectoryItemFailure = 'not_found' | 'lookup_failed' | 'install_failed' | 'remove_failed'

/**
 * Contract: the published state of the item the page shows. `resolving`
 * until the lookup ends; `ready` carries the details and whether it is
 * already here (`alreadyInstalled`, with `installedAs`: the plugin
 * identifier or the MCP server id) or can be installed at all
 * (`installable`); `installing` → `installed` (with `installedAs`) or
 * `failed` after the person presses Add. An installed item goes `removing`
 * on Uninstall, then is looked up again; a removal that fails keeps it
 * installed with `failure: 'remove_failed'`. A page on another item
 * replaces it.
 */
export type DirectoryPageItem = {
  id: number
  kind: DirectoryItemKind
  phase: 'resolving' | 'ready' | 'installing' | 'installed' | 'removing' | 'failed'
  details?: DirectoryItemDetails
  alreadyInstalled?: boolean
  installable?: boolean
  installedAs?: string
  /** Installed, and the directory has reviewed a newer commit of it. */
  updateAvailable?: boolean
  failure?: DirectoryItemFailure
  /** A connector this runtime cannot connect: it signs in only with a client
   *  registered in advance with its provider (F-10). Not installable. */
  unsupported?: 'needs_registered_client'
}

/** What Add installs. Kept in the runtime, never published. */
export type DirectoryInstallTarget =
  | { kind: 'plugin'; spec: DirectoryPluginSpec }
  | { kind: 'connector'; id: string; config: NexusMcpServerConfig }

export type DirectoryResolution = {
  details: DirectoryItemDetails
  alreadyInstalled: boolean
  /** When already installed: the plugin identifier or the MCP server id. */
  installedAs?: string
  updateAvailable?: boolean
  target: DirectoryInstallTarget | null
}

/** The runtime calls the lookup and the install make. */
export type DirectoryOfferDeps = {
  fetchJson(url: string): Promise<unknown>
  listMarketplaces(): Promise<Array<{ name: string; source: PluginOrigin; isOfficial?: boolean }>>
  listMarketplaceListings(marketplace: string): Promise<Array<CatalogListing & { installed: boolean }>>
  /** Every installed plugin, with the code it came from when its record says. */
  listInstalledPlugins(): Promise<Array<{ identifier: string; codeSource?: PluginCodeSource; gitCommitSha?: string }>>
  /** Installs a record's reviewed commit; answers the identifier it is installed as. */
  installFromDirectory(spec: DirectoryPluginSpec): Promise<string>
  listMcpServers(): Promise<Record<string, NexusMcpServerConfig>>
  upsertMcpServer(id: string, config: NexusMcpServerConfig): Promise<void>
  /** Starts the sign-in of an installed http server that asks for one (F-10). */
  startSignIn?(url: string): void
  /** Whether a connector's server can be connected from here (F-10). */
  checkConnector?(url: string): Promise<'supported' | 'needs_registered_client' | 'unknown'>
  /** Uninstalls the plugin `identifier` (`name@marketplace`). */
  uninstallPlugin(identifier: string): Promise<void>
  removeMcpServer(id: string): Promise<void>
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SLUG = /^[a-z0-9][a-z0-9-]{0,99}$/
/** Directory paths that list items rather than name one. */
const LIST_PAGES = new Set(['all', 'all-plugins', 'trending', 'new', 'manage', 'plugins', 'connectors'])
const LIST_PREFIXES = ['topic-', 'industry-', 'category-', 'department-']

/**
 * Security: the page controls its path, so only two exact shapes become an
 * intent — `/directory/<slug>` and `/customize/plugins/id/<uuid>@<marketplace>`;
 * anything else (a list page, another path, a full URL) is null.
 */
export function parseDirectoryIntent(pagePath: string): DirectoryIntent | null {
  if (!pagePath.startsWith('/') || pagePath.startsWith('//')) return null
  const path = pagePath.split(/[?#]/)[0]!
  const segments = path.split('/').slice(1).map(segment => {
    try {
      return decodeURIComponent(segment)
    } catch {
      return ''
    }
  })
  if (segments.length === 2 && segments[0] === 'directory') {
    const slug = segments[1]!.toLowerCase()
    if (!SLUG.test(slug) || LIST_PAGES.has(slug) || LIST_PREFIXES.some(p => slug.startsWith(p))) return null
    return { kind: 'connector', slug }
  }
  if (segments.length === 4 && segments[0] === 'customize' && segments[1] === 'plugins' && segments[2] === 'id') {
    const manifestName = segments[3]!.split('@')[0]!
    return UUID.test(manifestName) ? { kind: 'plugin', manifestName: manifestName.toLowerCase() } : null
  }
  return null
}

/** The listing query that finds the one record an intent names. */
export function directoryLookupUrl(intent: DirectoryIntent, origin: string = DIRECTORY_API_ORIGIN): string {
  const filter = intent.kind === 'plugin' ? `manifest_name == '${intent.manifestName}'` : `slug == '${intent.slug}'`
  const params = new URLSearchParams({ q: '', limit: '5', filter })
  return `${origin}${DIRECTORY_LIST_PATH}?${params.toString()}`
}

type DirectoryRecord = {
  name?: unknown
  slug?: unknown
  summary?: unknown
  description?: unknown
  manifest_name?: unknown
  verified_tier?: unknown
  added_time?: unknown
  updated_time?: unknown
  publisher?: { name?: unknown; url?: unknown }
  media?: { icons?: Array<{ url?: unknown }>; screenshots?: Array<{ url?: unknown } | string> }
  links?: { documentation?: unknown; support?: unknown; privacy_policy?: unknown }
  taxonomy?: Record<string, unknown>
  source?: { marketplace_slug?: unknown; repository?: { url?: unknown; path?: unknown; reviewed_commit?: unknown } }
  components?: Array<{
    type?: unknown
    name?: unknown
    description?: unknown
    slash_command?: unknown
    tools?: unknown
    endpoint?: { type?: unknown; url?: unknown }
  }>
}

const str = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined)

/** A directory icon entry is an image or only a site address; the site's favicon stands in for the latter. */
export function directoryIconUrl(url: string | undefined): string | undefined {
  if (!url) return undefined
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'https:') return undefined
  if (/\.(svg|png|jpe?g|gif|ico|webp)$/i.test(parsed.pathname)) return url
  if (parsed.hostname === 't0.gstatic.com' || parsed.hostname === 'www.google.com') return url
  return `https://www.google.com/s2/favicons?sz=64&domain=${encodeURIComponent(parsed.hostname)}`
}

/** Security: only an absolute `https` URL is shown or linked; anything else is dropped. */
function httpsUrl(value: unknown): string | undefined {
  const url = str(value)
  if (!url) return undefined
  try {
    return new URL(url).protocol === 'https:' ? url : undefined
  } catch {
    return undefined
  }
}

const COMPONENT_TYPES = new Set<string>(['skill', 'command', 'agent', 'hook', 'mcp_server'])
const MAX_COMPONENTS = 60
const MAX_SCREENSHOTS = 8
const MAX_CATEGORIES = 8

function componentsOf(record: DirectoryRecord): DirectoryComponent[] {
  const out: DirectoryComponent[] = []
  for (const part of Array.isArray(record.components) ? record.components : []) {
    if (out.length >= MAX_COMPONENTS) break
    const name = str(part?.slash_command) ?? str(part?.name)
    if (!name) continue
    const type = COMPONENT_TYPES.has(part.type as string) ? (part.type as DirectoryComponentType) : 'other'
    const description = str(part.description)
    out.push({
      type,
      name,
      ...(description ? { description } : {}),
      ...(Array.isArray(part.tools) ? { toolCount: part.tools.length } : {}),
    })
  }
  return out
}

function categoriesOf(record: DirectoryRecord): string[] {
  const values = Object.values(record.taxonomy ?? {}).flatMap(v => (Array.isArray(v) ? v : [v]))
  const tags = values.filter((v): v is string => typeof v === 'string' && /^[a-z0-9-]{1,40}$/.test(v))
  return [...new Set(tags)].slice(0, MAX_CATEGORIES)
}

function recordPagePath(record: DirectoryRecord): string | undefined {
  const manifest = str(record.manifest_name)
  const marketplace = str(record.source?.marketplace_slug)
  if (manifest) {
    return UUID.test(manifest) && marketplace && SLUG.test(marketplace)
      ? `/customize/plugins/id/${manifest.toLowerCase()}@${marketplace}`
      : undefined
  }
  // A connector is a record with no repository of its own.
  const slug = str(record.slug)
  return slug && SLUG.test(slug) && !record.source?.repository ? `/directory/${slug}` : undefined
}

/** A directory record as a detail page shows it. */
export function describeDirectoryRecord(record: DirectoryRecord): DirectoryItemDetails {
  const details: DirectoryItemDetails = { name: str(record.name) ?? str(record.slug) ?? '' }
  const optional: Partial<Record<keyof DirectoryItemDetails, string | undefined>> = {
    summary: str(record.summary),
    description: str(record.description),
    publisher: str(record.publisher?.name),
    publisherUrl: httpsUrl(record.publisher?.url),
    iconUrl: directoryIconUrl(str(record.media?.icons?.[0]?.url)),
    addedTime: str(record.added_time),
    updatedTime: str(record.updated_time),
    pagePath: recordPagePath(record),
  }
  for (const [key, value] of Object.entries(optional)) {
    if (value) (details as Record<string, unknown>)[key] = value
  }
  if (str(record.verified_tier)) details.verified = true
  const screenshots = (Array.isArray(record.media?.screenshots) ? record.media.screenshots : [])
    .map(shot => httpsUrl(typeof shot === 'string' ? shot : shot?.url))
    .filter((url): url is string => !!url)
    .slice(0, MAX_SCREENSHOTS)
  if (screenshots.length) details.screenshots = screenshots
  const parts = componentsOf(record)
  if (parts.length) details.components = parts
  const links = Object.entries({
    documentation: httpsUrl(record.links?.documentation),
    support: httpsUrl(record.links?.support),
    privacy: httpsUrl(record.links?.privacy_policy),
    repository: httpsUrl(record.source?.repository?.url),
  }).filter(([, url]) => url)
  if (links.length) details.links = Object.fromEntries(links)
  const tags = categoriesOf(record)
  if (tags.length) details.categories = tags
  return details
}

export { normalizeRepoUrl }

function originRepo(source: PluginOrigin): string | null {
  if (source.source === 'github') return normalizeRepoUrl(`https://github.com/${source.repo}`)
  if (source.source === 'url' || source.source === 'git-subdir') return normalizeRepoUrl(source.url)
  return null
}

/** A listing's repository; a path inside the marketplace means the marketplace's own. */
function listingRepo(listing: CatalogListing, marketplaceRepo: string | null): string | null {
  const source = listing.source
  if (source.source === 'local' || source.source === 'directory') return marketplaceRepo
  return originRepo(source)
}

const nameKey = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

/** What Add installs a plugin record with; null when its code cannot be installed here. */
export function directoryPluginSpec(record: DirectoryRecord, apiOrigin: string): DirectoryPluginSpec | null {
  const repository = record.source?.repository
  const spec: DirectoryPluginSpec = {
    manifestName: str(record.manifest_name) ?? '',
    apiOrigin,
    repositoryUrl: str(repository?.url) ?? '',
    ...(str(repository?.path) ? { path: str(repository?.path) } : {}),
    commit: str(repository?.reviewed_commit) ?? '',
    fallbackName: str(record.slug)?.split('/').pop() ?? str(record.name) ?? '',
  }
  return UUID.test(spec.manifestName) && directoryListingSource(spec) ? spec : null
}

/** The repository and folder a record names. */
function recordCode(record: DirectoryRecord): PluginCodeSource | null {
  const repo = normalizeRepoUrl(str(record.source?.repository?.url))
  const path = normalizeCodePath(str(record.source?.repository?.path))
  return repo && path !== null ? { repo, path } : null
}

/**
 * A plugin record here: installed when an installed plugin's code is the
 * record's repository and folder (an install whose record names no code is
 * matched through the marketplace listing it came from), with an update when
 * the directory reviewed another commit. Add installs the reviewed commit.
 */
async function resolvePlugin(
  record: DirectoryRecord,
  deps: DirectoryOfferDeps,
  apiOrigin: string,
): Promise<Omit<DirectoryResolution, 'details'>> {
  const spec = directoryPluginSpec(record, apiOrigin)
  const target: DirectoryInstallTarget | null = spec ? { kind: 'plugin', spec } : null
  const code = recordCode(record)
  if (!code) return { alreadyInstalled: false, target }
  const commit = str(record.source?.repository?.reviewed_commit)
  for (const plugin of await deps.listInstalledPlugins()) {
    if (!plugin.codeSource || !sameCode(plugin.codeSource, code)) continue
    const have = plugin.codeSource.sha ?? plugin.gitCommitSha
    return {
      alreadyInstalled: true,
      installedAs: plugin.identifier,
      updateAvailable: !!commit && !!have && !sameCommit(have, commit),
      target,
    }
  }
  for (const marketplace of await deps.listMarketplaces()) {
    let listings: Array<CatalogListing & { installed: boolean }>
    try {
      listings = await deps.listMarketplaceListings(marketplace.name)
    } catch {
      continue
    }
    const match = listings.find(listing => {
      const listed = listing.installed ? codeSourceOf(listing.source, marketplace.source) : null
      return !!listed && sameCode(listed, code)
    })
    if (match) return { alreadyInstalled: true, installedAs: `${match.name}@${marketplace.name}`, target }
  }
  return { alreadyInstalled: false, target }
}

const sameUrl = (a: string | undefined, b: string) => !!a && a.replace(/\/+$/, '') === b.replace(/\/+$/, '')

async function resolveConnector(
  record: DirectoryRecord,
  slug: string,
  deps: DirectoryOfferDeps,
): Promise<Omit<DirectoryResolution, 'details'>> {
  const server = record.components?.find(component => component.type === 'mcp_server')
  const url = server?.endpoint?.type === 'fixed' ? str(server.endpoint.url) : undefined
  const servers = await deps.listMcpServers()
  const installedAs = slug in servers
    ? slug
    : url ? Object.entries(servers).find(([, config]) => sameUrl(config.url, url))?.[0] : undefined
  const installed = installedAs !== undefined ? { alreadyInstalled: true, installedAs } : { alreadyInstalled: false }
  if (!url || !/^https:\/\//i.test(url)) return { ...installed, target: null }
  return { ...installed, target: { kind: 'connector', id: slug, config: { transport: 'http', url } } }
}

/**
 * Looks the intent up and matches it here. Throws `DirectoryLookupError`:
 * `not_found` when the directory has no such item, `lookup_failed` when the
 * directory or a local list could not be read.
 */
export async function resolveDirectoryIntent(
  intent: DirectoryIntent,
  deps: DirectoryOfferDeps,
  origin: string = DIRECTORY_API_ORIGIN,
): Promise<DirectoryResolution> {
  let record: DirectoryRecord | undefined
  try {
    const body = (await deps.fetchJson(directoryLookupUrl(intent, origin))) as { data?: unknown }
    record = Array.isArray(body?.data) ? (body.data[0] as DirectoryRecord | undefined) : undefined
  } catch (error) {
    throw new DirectoryLookupError('lookup_failed', error)
  }
  if (!record || typeof record !== 'object') throw new DirectoryLookupError('not_found')
  const details = describeDirectoryRecord(record)
  try {
    if (intent.kind === 'connector') return { details, ...(await resolveConnector(record, intent.slug, deps)) }
    return { details, ...(await resolvePlugin(record, deps, origin)) }
  } catch (error) {
    throw new DirectoryLookupError('lookup_failed', error)
  }
}

const LISTING_PAGE_SIZE = 100
const LISTING_PAGE_LIMIT = 3
const REPOS_PER_QUERY = 20

/** A repository as the directory records it, `https://<host>/<owner>/<repo>`, as written and lowercased. */
function repositoryUrls(source: PluginOrigin): string[] {
  const raw = source.source === 'github'
    ? `https://github.com/${source.repo}`
    : source.source === 'url' || source.source === 'git-subdir' ? source.url : ''
  const match = /^(?:https?:\/\/)?([^/]+)\/([^/]+)\/([^/#?]+)/i.exec(raw.trim().replace(/^git@github\.com:/i, 'https://github.com/'))
  if (!match) return []
  const url = `https://${match[1]}/${match[2]}/${match[3]!.replace(/\.git$/i, '')}`
  return [...new Set([url, url.toLowerCase()])]
}

/** Security: a listing-filter string literal; a quote or backslash in a URL cannot end it. */
const filterString = (value: string) => `'${value.replace(/[\\']/g, ch => `\\${ch}`)}'`

async function listingRecords(urls: string[], deps: DirectoryOfferDeps, origin: string): Promise<DirectoryRecord[]> {
  const records: DirectoryRecord[] = []
  for (let i = 0; i < urls.length; i += REPOS_PER_QUERY) {
    const filter = `source.repository.url in [${urls.slice(i, i + REPOS_PER_QUERY).map(filterString).join(', ')}]`
    let page: string | undefined
    for (let n = 0; n < LISTING_PAGE_LIMIT; n++) {
      const params = new URLSearchParams({ q: '', limit: String(LISTING_PAGE_SIZE), filter, ...(page ? { page } : {}) })
      const body = (await deps.fetchJson(`${origin}${DIRECTORY_LIST_PATH}?${params.toString()}`)) as {
        data?: unknown
        next_page?: unknown
      }
      if (Array.isArray(body?.data)) {
        records.push(...(body.data.filter(r => r && typeof r === 'object') as DirectoryRecord[]))
      }
      page = str(body?.next_page)
      if (!page) break
    }
  }
  return records
}

/**
 * The directory's details for each plugin `marketplace` lists, keyed by
 * plugin name: the records of the listings' repositories, matched by name
 * (or, for a repository with one listing and one record, that record).
 * Plugins the directory does not carry are absent. Throws when a list cannot
 * be read.
 */
export async function describeMarketplacePlugins(
  marketplace: string,
  deps: DirectoryOfferDeps,
  origin: string = DIRECTORY_API_ORIGIN,
): Promise<Record<string, DirectoryItemDetails>> {
  const entry = (await deps.listMarketplaces()).find(m => m.name === marketplace)
  if (!entry) return {}
  const listings = await deps.listMarketplaceListings(marketplace)
  const marketplaceRepo = originRepo(entry.source)
  const byRepo = new Map<string, CatalogListing[]>()
  const urls = new Set<string>()
  for (const listing of listings) {
    const repo = listingRepo(listing, marketplaceRepo)
    if (!repo) continue
    byRepo.set(repo, [...(byRepo.get(repo) ?? []), listing])
    const local = listing.source.source === 'local' || listing.source.source === 'directory'
    for (const url of repositoryUrls(local ? entry.source : listing.source)) urls.add(url)
  }
  if (urls.size === 0) return {}
  const records = await listingRecords([...urls], deps, origin)
  const out: Record<string, DirectoryItemDetails> = {}
  for (const [repo, sameRepo] of byRepo) {
    const candidates = records.filter(r => normalizeRepoUrl(str(r.source?.repository?.url)) === repo)
    for (const listing of sameRepo) {
      const key = nameKey(listing.name)
      const named = candidates.find(r =>
        [str(r.name), str(r.slug)?.split('/').pop(), str(r.source?.repository?.path)?.split('/').pop()]
          .some(name => !!name && nameKey(name) === key),
      )
      const record = named ?? (sameRepo.length === 1 && candidates.length === 1 ? candidates[0] : undefined)
      if (record) out[listing.name] = describeDirectoryRecord(record)
    }
  }
  return out
}

export class DirectoryLookupError extends Error {
  constructor(
    readonly code: 'not_found' | 'lookup_failed',
    cause?: unknown,
  ) {
    super(code, cause === undefined ? undefined : { cause })
    this.name = 'DirectoryLookupError'
  }
}

/** Removes what `installedAs` names: a plugin identifier, or a connector's MCP server id. */
export async function removeDirectoryItem(
  kind: DirectoryItemKind,
  installedAs: string,
  deps: DirectoryOfferDeps,
): Promise<void> {
  if (kind === 'plugin') await deps.uninstallPlugin(installedAs)
  else await deps.removeMcpServer(installedAs)
}

/** Installs `target`; resolves to what it is installed as (the plugin identifier or the MCP server id). */
export async function installDirectoryTarget(target: DirectoryInstallTarget, deps: DirectoryOfferDeps): Promise<string> {
  if (target.kind === 'plugin') return deps.installFromDirectory(target.spec)
  await deps.upsertMcpServer(target.id, target.config)
  if (target.config.transport === 'http' && target.config.url) deps.startSignIn?.(target.config.url)
  return target.id
}
