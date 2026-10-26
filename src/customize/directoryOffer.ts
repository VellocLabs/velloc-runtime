/**
 * The item the directory page shows (F-35): its page path read as a plugin
 * or a connector, looked up in the public directory listing and matched to
 * what this machine can install — a plugin from a registered marketplace, or
 * a connector as an http MCP server.
 */
import type { NexusMcpServerConfig } from '../settings/settingsTypes'
import type { CatalogListing, PluginOrigin } from '../pluginHost/registryFormats'
import { DIRECTORY_API_ORIGIN } from './directorySite'

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

export type DirectoryItemFailure = 'not_found' | 'lookup_failed' | 'install_failed'

/**
 * Contract: the published state of the item the page shows. `resolving`
 * until the lookup ends; `ready` carries the details and whether it is
 * already here (`alreadyInstalled`, with `installedAs`: the plugin
 * identifier or the MCP server id) or can be installed at all
 * (`installable`); `installing` → `installed` (with `installedAs`) or
 * `failed` after the person presses Add. A page on another item replaces it.
 */
export type DirectoryPageItem = {
  id: number
  kind: DirectoryItemKind
  phase: 'resolving' | 'ready' | 'installing' | 'installed' | 'failed'
  details?: DirectoryItemSummary
  alreadyInstalled?: boolean
  installable?: boolean
  installedAs?: string
  failure?: DirectoryItemFailure
}

/** What Add installs. Kept in the runtime, never published. */
export type DirectoryInstallTarget =
  | { kind: 'plugin'; identifier: string }
  | { kind: 'connector'; id: string; config: NexusMcpServerConfig }

export type DirectoryResolution = {
  details: DirectoryItemSummary
  alreadyInstalled: boolean
  /** When already installed: the plugin identifier or the MCP server id. */
  installedAs?: string
  target: DirectoryInstallTarget | null
}

/** The runtime calls the lookup and the install make. */
export type DirectoryOfferDeps = {
  fetchJson(url: string): Promise<unknown>
  listMarketplaces(): Promise<Array<{ name: string; source: PluginOrigin; isOfficial?: boolean }>>
  listMarketplaceListings(marketplace: string): Promise<Array<CatalogListing & { installed: boolean }>>
  installPlugin(identifier: string): Promise<void>
  listMcpServers(): Promise<Record<string, NexusMcpServerConfig>>
  upsertMcpServer(id: string, config: NexusMcpServerConfig): Promise<void>
}

const DIRECTORY_LIST_PATH = '/api/directory/plugins'

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
  publisher?: { name?: unknown }
  media?: { icons?: Array<{ url?: unknown }> }
  source?: { repository?: { url?: unknown } }
  components?: Array<{ type?: unknown; endpoint?: { type?: unknown; url?: unknown } }>
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

function summarize(record: DirectoryRecord): DirectoryItemSummary {
  const name = str(record.name) ?? str(record.slug) ?? ''
  const summary = str(record.summary)
  const publisher = str(record.publisher?.name)
  const iconUrl = directoryIconUrl(str(record.media?.icons?.[0]?.url))
  return {
    name,
    ...(summary ? { summary } : {}),
    ...(publisher ? { publisher } : {}),
    ...(iconUrl ? { iconUrl } : {}),
  }
}

/** A git URL or GitHub repo reduced to `host/owner/repo`, lowercase. */
export function normalizeRepoUrl(url: string | undefined): string | null {
  if (!url) return null
  const trimmed = url.trim().toLowerCase().replace(/^git@github\.com:/, 'https://github.com/')
  const match = /^(?:https?:\/\/)?([^/]+)\/([^/]+)\/([^/#?]+)/.exec(trimmed)
  if (!match) return null
  return `${match[1]}/${match[2]}/${match[3]!.replace(/\.git$/, '')}`
}

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

/**
 * The marketplace listing that is this directory plugin: same repository,
 * and — when the repository holds several plugins — the same name. Official
 * marketplaces are searched first.
 */
async function findPluginListing(
  record: DirectoryRecord,
  deps: DirectoryOfferDeps,
): Promise<{ identifier: string; installed: boolean } | null> {
  const repo = normalizeRepoUrl(str(record.source?.repository?.url))
  if (!repo) return null
  const names = new Set(
    [str(record.name), str(record.slug)?.split('/').pop()].filter((v): v is string => !!v).map(nameKey),
  )
  const marketplaces = [...(await deps.listMarketplaces())].sort(
    (a, b) => Number(b.isOfficial === true) - Number(a.isOfficial === true),
  )
  for (const marketplace of marketplaces) {
    let listings: Array<CatalogListing & { installed: boolean }>
    try {
      listings = await deps.listMarketplaceListings(marketplace.name)
    } catch {
      continue
    }
    const marketplaceRepo = originRepo(marketplace.source)
    const sameRepo = listings.filter(listing => listingRepo(listing, marketplaceRepo) === repo)
    const match = sameRepo.length === 1 ? sameRepo[0] : sameRepo.find(listing => names.has(nameKey(listing.name)))
    if (match) return { identifier: `${match.name}@${marketplace.name}`, installed: match.installed }
  }
  return null
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
  const details = summarize(record)
  try {
    if (intent.kind === 'connector') return { details, ...(await resolveConnector(record, intent.slug, deps)) }
    const listing = await findPluginListing(record, deps)
    if (!listing) return { details, alreadyInstalled: false, target: null }
    const target: DirectoryInstallTarget = { kind: 'plugin', identifier: listing.identifier }
    return listing.installed
      ? { details, alreadyInstalled: true, installedAs: listing.identifier, target }
      : { details, alreadyInstalled: false, target }
  } catch (error) {
    throw new DirectoryLookupError('lookup_failed', error)
  }
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

/** Installs `target`; resolves to what it is installed as (the plugin identifier or the MCP server id). */
export async function installDirectoryTarget(target: DirectoryInstallTarget, deps: DirectoryOfferDeps): Promise<string> {
  if (target.kind === 'plugin') {
    await deps.installPlugin(target.identifier)
    return target.identifier
  }
  await deps.upsertMcpServer(target.id, target.config)
  return target.id
}
