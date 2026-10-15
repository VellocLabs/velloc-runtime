/**
 * The `~/.velloc/plugins/known_marketplaces.json` registry (load / save / add /
 * remove / update) and marketplace catalog refresh and lookup.
 * `loadKnownMarketplaces` never throws; mutation paths throw on a
 * malformed-but-present file so it is never overwritten with defaults.
 */

import type { RuntimeFs } from '../utils/fs/runtimeFs'
import { extractGitHubTarball } from './extract'
import { fetchSourceTarball } from './fetch'
import { buildInitialOfficialEntries } from './defaultMarketplace'
import {
  buildInitialBuiltinEntries,
  builtinNameSourceProblem,
  isBuiltinMarketplace,
} from './builtinMarketplace'
import type { UpdateChannel } from '../branding/updateChannels'
import { isCuratedCatalog } from './pluginRef'
import { marketplaceNameProblem, reservedNameSourceProblem } from './marketplaceNaming'
import {
  getKnownMarketplacesFilePath,
  getMarketplaceContentDir,
  getMarketplaceManifestPath,
  pluginsRoot,
  type PluginInstallPathContext,
} from './pluginDirs'
import type {
  CatalogRecord,
  KnownMarketplacesRegistry,
  MarketplaceCatalog,
  CatalogListing,
  PluginOrigin,
  RegistryReadResult,
} from './registryFormats'
import { writeExtractedFiles } from './writeExtracted'

// ---------------------------------------------------------------------------
// `memoize` from lodash on `getMarketplace` and exposes
// `forgetCatalogs`. nexus uses a direct module-level cache
// because we don't pull lodash into the bundle.)
// ---------------------------------------------------------------------------

/**
 * process, nexus by context for test isolation).
 */
const knownMarketplacesCache = new Map<string, KnownMarketplacesRegistry>()

/**
 *  Pass `homeDir` to clear a single context; omit to clear all. */
export function forgetCatalogs(homeDir?: string): void {
  if (homeDir === undefined) {
    knownMarketplacesCache.clear()
  } else {
    knownMarketplacesCache.delete(homeDir)
  }
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

function defaultRegistry(
  ctx: PluginInstallPathContext,
  nowIso: string,
): KnownMarketplacesRegistry {
  // Officials are pre-seeded so a fresh install can immediately browse plugins.
  return { ...buildInitialOfficialEntries(ctx, nowIso), ...buildInitialBuiltinEntries(ctx, nowIso) }
}

function isMissingFileError(e: unknown): boolean {
  if (!e) return false
  const message = e instanceof Error ? e.message : String(e)
  return /ENOENT|not found|no such file/i.test(message)
}

function normalizeRegistry(
  raw: unknown,
  ctx: PluginInstallPathContext,
  nowIso: string,
): KnownMarketplacesRegistry {
  const out: KnownMarketplacesRegistry = {}
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
      const entry = normalizeEntry(value, ctx, name)
      if (entry && typeof name === 'string' && name.length > 0) {
        out[name] = entry
      }
    }
  }
  // Self-heal: if any official or the built-in is missing, re-seed it. An
  // entry that is present keeps its own source.
  const officials = { ...buildInitialOfficialEntries(ctx, nowIso), ...buildInitialBuiltinEntries(ctx, nowIso) }
  for (const [name, entry] of Object.entries(officials)) {
    if (!(name in out)) {
      out[name] = entry
    }
  }
  return out
}

function normalizeEntry(
  raw: unknown,
  ctx: PluginInstallPathContext,
  name: string,
): CatalogRecord | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Partial<CatalogRecord> & {
    // Tolerate the legacy nexus shape (`installedAt: number`, no `installLocation`)
    // on read so an existing file doesn't silently reset every marketplace
    installedAt?: unknown
    lastFetchedAt?: unknown
    lastFetchedSha?: unknown
  }
  if (!r.source || typeof r.source !== 'object') return null
  let lastUpdated: string | undefined
  if (typeof r.lastUpdated === 'string' && r.lastUpdated.length > 0) {
    lastUpdated = r.lastUpdated
  } else if (typeof r.lastFetchedAt === 'number') {
    lastUpdated = new Date(r.lastFetchedAt).toISOString()
  } else if (typeof r.installedAt === 'number') {
    lastUpdated = new Date(r.installedAt).toISOString()
  } else {
    // Stamp with epoch-zero so the field is present + parseable; UI shows
    // "never" semantics by checking the year.
    lastUpdated = new Date(0).toISOString()
  }
  const entry: CatalogRecord = {
    source: r.source as PluginOrigin,
    installLocation:
      typeof r.installLocation === 'string' && r.installLocation.length > 0
        ? r.installLocation
        : getMarketplaceContentDir(ctx, name),
    lastUpdated,
  }
  if (typeof r.autoUpdate === 'boolean') entry.autoUpdate = r.autoUpdate
  return entry
}

/**
 * Read `known_marketplaces.json` (officials self-healed). `throwOnCorrupt` makes
 * an unreadable file throw instead of returning defaults; a missing file still
 * returns defaults. Only parsed registries are cached.
 */
async function readKnownMarketplaces(
  ctx: PluginInstallPathContext,
  fs: RuntimeFs,
  nowIso: string,
  throwOnCorrupt: boolean,
): Promise<RegistryReadResult<KnownMarketplacesRegistry>> {
  // single session. Invalidated on every mutator via `saveKnownMarketplaces`.
  const cached = knownMarketplacesCache.get(ctx.homeDir)
  if (cached !== undefined) {
    return { registry: cached, source: 'file' }
  }
  const path = getKnownMarketplacesFilePath(ctx)
  let raw: string
  try {
    raw = await fs.readFile(path, { encoding: 'utf-8' })
  } catch (e) {
    if (isMissingFileError(e)) {
      // No file yet — defaulting is safe (the next save is a first write).
      return { registry: defaultRegistry(ctx, nowIso), source: 'default' }
    }
    // A real read error (permission / IO): the file may exist with user
    // entries we just can't see. Defaulting + saving would erase them.
    const message = e instanceof Error ? e.message : String(e)
    if (throwOnCorrupt) {
      throw new Error(
        `known_marketplaces.json is unreadable (${message}); refusing to overwrite it. Fix or delete the file manually.`,
      )
    }
    // eslint-disable-next-line no-console
    console.warn(
      `[marketplaceManager] failed to read ${path}: ${message}; using defaults`,
    )
    return { registry: defaultRegistry(ctx, nowIso), source: 'default' }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    if (throwOnCorrupt) {
      throw new Error(
        `known_marketplaces.json contains malformed JSON (${message}); refusing to overwrite it. Fix or delete the file manually.`,
      )
    }
    // eslint-disable-next-line no-console
    console.warn(
      `[marketplaceManager] malformed JSON in ${path}: ${message}; using defaults (file NOT overwritten — fix or delete manually)`,
    )
    return { registry: defaultRegistry(ctx, nowIso), source: 'default' }
  }

  // nexus file with `{version: 1, marketplaces: {...}}` lands here — read it
  // by unwrapping the inner map and re-normalizing).
  let mapForNormalize: unknown = parsed
  if (
    parsed
    && typeof parsed === 'object'
    && !Array.isArray(parsed)
    && 'marketplaces' in (parsed as Record<string, unknown>)
    && (parsed as Record<string, unknown>).marketplaces
    && typeof (parsed as Record<string, unknown>).marketplaces === 'object'
  ) {
    // Legacy nexus wrapper shape — migrate on read.
    mapForNormalize = (parsed as Record<string, unknown>).marketplaces
  }

  const normalized = normalizeRegistry(mapForNormalize, ctx, nowIso)
  knownMarketplacesCache.set(ctx.homeDir, normalized)
  return { registry: normalized, source: 'file' }
}

/**
 * Read `known_marketplaces.json` for a READ-ONLY caller. Returns defaults on
 * missing / malformed / unreadable; never throws. Mutators must use
 * `loadKnownMarketplacesForMutation` instead so a corrupt file isn't clobbered.
 */
export async function loadKnownMarketplaces(
  ctx: PluginInstallPathContext,
  fs: RuntimeFs,
  nowIso: string,
): Promise<RegistryReadResult<KnownMarketplacesRegistry>> {
  return readKnownMarketplaces(ctx, fs, nowIso, false)
}

/**
 * Read `known_marketplaces.json` for a path that is about to SAVE. Defaults
 * only for a genuinely-missing file; THROWS on an unreadable / malformed file
 * so the caller aborts instead of overwriting the user's registry with
 * officials-only defaults.
 */
async function loadKnownMarketplacesForMutation(
  ctx: PluginInstallPathContext,
  fs: RuntimeFs,
  nowIso: string,
): Promise<RegistryReadResult<KnownMarketplacesRegistry>> {
  return readKnownMarketplaces(ctx, fs, nowIso, true)
}

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

/**
 * Write `known_marketplaces.json`. Ensures `~/.velloc/plugins/` exists (lazy
 * mkdir). No atomic-rename — the `RuntimeFs` facade doesn't expose
 * `rename`; the file is small (~1 KB per marketplace), and the load path is
 * robust to torn writes.
 *
 */
export async function saveKnownMarketplaces(
  ctx: PluginInstallPathContext,
  fs: RuntimeFs,
  registry: KnownMarketplacesRegistry,
): Promise<void> {
  const dirPath = pluginsRoot(ctx)
  try {
    await fs.mkdir(dirPath)
  } catch {
    /* dir exists or mkdir is no-op for existing dirs */
  }
  const path = getKnownMarketplacesFilePath(ctx)
  const body = `${JSON.stringify(registry, null, 2)}\n`
  await fs.writeFile(path, body, { encoding: 'utf-8' })
  // `fetchCatalog` invalidates `getMarketplace.cache` on every write.
  knownMarketplacesCache.set(ctx.homeDir, registry)
}

// ---------------------------------------------------------------------------
// CRUD helpers
// ---------------------------------------------------------------------------

/**
 * Register a new marketplace. Returns the updated registry. Throws on empty
 * name OR reserved-name impersonation. Re-adding an existing name is allowed
 */
export async function addMarketplace(
  ctx: PluginInstallPathContext,
  fs: RuntimeFs,
  name: string,
  source: PluginOrigin,
  nowIso: string,
): Promise<KnownMarketplacesRegistry> {
  if (!name || typeof name !== 'string') {
    throw new Error('addMarketplace: name is required')
  }
  const trimmed = name.trim()
  if (!trimmed) {
    throw new Error('addMarketplace: name is empty after trim')
  }
  // the reserved `inline`/`builtin`, and (critically) names that impersonate an
  // official Anthropic marketplace via the homograph / pattern guard
  // (`looksLikeReservedName`). Without this a third-party marketplace.json could
  // claim e.g. `claude-plugins-pro` or a Cyrillic homograph and render
  // Anthropic-branded. `reservedNameSourceProblem` below only guards the EXACT
  // reserved names, so this check is what covers the broader impersonation set.
  const nameError = marketplaceNameProblem(trimmed)
  if (nameError) {
    throw new Error(`addMarketplace: ${nameError}`)
  }
  const guardMessage = reservedNameSourceProblem(trimmed, source) ?? builtinNameSourceProblem(trimmed, source)
  if (guardMessage) {
    throw new Error(`addMarketplace: ${guardMessage}`)
  }

  const { registry } = await loadKnownMarketplacesForMutation(ctx, fs, nowIso)
  const next: KnownMarketplacesRegistry = {
    ...registry,
    [trimmed]: {
      source,
      installLocation: getMarketplaceContentDir(ctx, trimmed),
      lastUpdated: nowIso,
    },
  }
  await saveKnownMarketplaces(ctx, fs, next)
  return next
}

/**
 * Remove a marketplace from the registry. Officials cannot be removed —
 * the self-healing load path would re-seed them anyway. Removing a
 */
export async function removeMarketplace(
  ctx: PluginInstallPathContext,
  fs: RuntimeFs,
  name: string,
  nowIso: string,
): Promise<KnownMarketplacesRegistry> {
  const trimmed = name?.trim() ?? ''
  if (!trimmed) {
    throw new Error('removeMarketplace: name is empty')
  }
  if (isCuratedCatalog(trimmed)) {
    throw new Error(
      `removeMarketplace: '${trimmed}' is an official Anthropic marketplace and cannot be removed`,
    )
  }
  if (isBuiltinMarketplace(trimmed)) {
    throw new Error(
      `removeMarketplace: '${trimmed}' is the built-in marketplace and cannot be removed`,
    )
  }
  const { registry } = await loadKnownMarketplacesForMutation(ctx, fs, nowIso)
  if (!(trimmed in registry)) {
    return registry
  }
  const next: KnownMarketplacesRegistry = { ...registry }
  delete next[trimmed]
  await saveKnownMarketplaces(ctx, fs, next)
  return next
}

/**
 * Bookkeeping: update `lastUpdated` for a marketplace after a successful
 * fetch. Called from `fetchCatalog`. Safe to call even if the
 * marketplace isn't in the registry (no-ops).
 *
 * timestamp-bump shape.
 */
export async function updateMarketplaceLastUpdated(
  ctx: PluginInstallPathContext,
  fs: RuntimeFs,
  name: string,
  nowIso: string,
): Promise<KnownMarketplacesRegistry> {
  const { registry } = await loadKnownMarketplacesForMutation(ctx, fs, nowIso)
  const current = registry[name]
  if (!current) return registry
  const next: KnownMarketplacesRegistry = {
    ...registry,
    [name]: { ...current, lastUpdated: nowIso },
  }
  await saveKnownMarketplaces(ctx, fs, next)
  return next
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

export type CatalogSnapshot = {
  /** The parsed `marketplace.json` after the fetch. */
  marketplace: MarketplaceCatalog
  cachePath: string
  /** SHA the fetch came from, when known. */
  sha?: string
}

/**
 * Fetch a known marketplace's repo as a tarball + write the extracted
 * contents to `~/.velloc/plugins/marketplaces/<name>/`. Updates
 * `fetchCatalog`.
 *
 * `fetchImpl` defaults to `globalThis.fetch`; production paths inject the
 * CSP-bypass `bridgeBackedFetch` from the adapter.
 */
export async function fetchCatalog(
  ctx: PluginInstallPathContext,
  fs: RuntimeFs,
  catalogKey: string,
  nowIso: string,
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
  options: { /** Lower-case hex digest the tarball bytes must have; nothing is written on a mismatch. */ sha256?: string } = {},
): Promise<CatalogSnapshot> {
  const { registry } = await loadKnownMarketplaces(ctx, fs, nowIso)
  const entry = registry[catalogKey]
  if (!entry) {
    throw new Error(
      `[marketplaceManager] marketplace '${catalogKey}' is not registered; add it first via addMarketplace()`,
    )
  }

  const fetched = await fetchSourceTarball(entry.source, fetchImpl)
  if (options.sha256) {
    const digest = await sha256Hex(fetched.bytes)
    if (digest !== options.sha256.toLowerCase()) {
      throw new Error(
        `[marketplaceManager] '${catalogKey}' tarball digest ${digest} is not the published ${options.sha256}`,
      )
    }
  }
  const files = await extractGitHubTarball(fetched.bytes)
  if (files.length === 0) {
    throw new Error(
      `[marketplaceManager] '${catalogKey}' fetched OK but extracted 0 files`,
    )
  }

  const cachePath = getMarketplaceContentDir(ctx, catalogKey)
  const writeResult = await writeExtractedFiles(fs, cachePath, files)
  if (writeResult.firstFailureIndex !== null) {
    const failingPath = files[writeResult.firstFailureIndex]?.path ?? '<unknown>'
    throw new Error(
      `[marketplaceManager] wrote ${writeResult.written}/${files.length} files`
      + ` for '${catalogKey}' before failing at '${failingPath}'`,
    )
  }

  const manifestPath = getMarketplaceManifestPath(ctx, catalogKey)
  let manifestRaw: string
  try {
    manifestRaw = await fs.readFile(manifestPath, { encoding: 'utf-8' })
  } catch (e) {
    throw new Error(
      `[marketplaceManager] '${catalogKey}' fetched + extracted but`
      + ` ${manifestPath} is unreadable: ${e instanceof Error ? e.message : String(e)}`,
    )
  }
  const marketplace = parseMarketplaceManifest(manifestRaw, catalogKey)

  await updateMarketplaceLastUpdated(ctx, fs, catalogKey, nowIso)

  return { marketplace, cachePath, sha: fetched.sha }
}

/** Lower-case hex SHA-256 of `bytes`. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
}

/**
 * `findCatalogPlugin` (on the manager class) — same lookup, same return shape.
 *
 * Reads the manifest from disk every call. v1 doesn't cache — files are
 * small + the data is OS-cached. If hot, add a per-(ctx, marketplace) memo
 * with explicit invalidation on refresh.
 */
export async function findCatalogPlugin(
  ctx: PluginInstallPathContext,
  fs: RuntimeFs,
  catalogKey: string,
  pluginName: string,
): Promise<CatalogListing | null> {
  const manifestPath = getMarketplaceManifestPath(ctx, catalogKey)
  let raw: string
  try {
    raw = await fs.readFile(manifestPath, { encoding: 'utf-8' })
  } catch {
    return null
  }
  const manifest = parseMarketplaceManifest(raw, catalogKey)
  return manifest.plugins.find(p => p.name === pluginName) ?? null
}

/** Backwards-compat alias — old call sites used `resolvePluginInMarketplace`.
 *  @deprecated Use `findCatalogPlugin`. */
export const resolvePluginInMarketplace = findCatalogPlugin

// ---------------------------------------------------------------------------
// Manifest parser
// ---------------------------------------------------------------------------

/**
 * Parse + validate a `marketplace.json` string. Drops malformed plugin
 * entries with a console warn instead of failing the whole parse — a single
 * bad entry shouldn't blind us to the other 221 valid ones.
 *
 * Throws on the top-level shape being wrong.
 */
export function parseMarketplaceManifest(
  raw: string,
  contextNameForErrors: string,
): MarketplaceCatalog {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    throw new Error(
      `[parseMarketplaceManifest] '${contextNameForErrors}' marketplace.json is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
    )
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(
      `[parseMarketplaceManifest] '${contextNameForErrors}' marketplace.json top-level must be an object`,
    )
  }
  const r = parsed as Partial<MarketplaceCatalog>
  if (typeof r.name !== 'string' || r.name.length === 0) {
    throw new Error(
      `[parseMarketplaceManifest] '${contextNameForErrors}' marketplace.json missing string 'name'`,
    )
  }
  if (!Array.isArray(r.plugins)) {
    throw new Error(
      `[parseMarketplaceManifest] '${contextNameForErrors}' marketplace.json 'plugins' must be an array`,
    )
  }
  const plugins: CatalogListing[] = []
  for (const rawEntry of r.plugins) {
    const entry = normalizePluginEntry(rawEntry)
    if (entry) {
      plugins.push(entry)
    } else {
      // eslint-disable-next-line no-console
      console.warn(
        `[parseMarketplaceManifest] '${contextNameForErrors}' dropping malformed plugin entry: ${JSON.stringify(rawEntry).slice(0, 200)}`,
      )
    }
  }
  return {
    name: r.name,
    description: typeof r.description === 'string' ? r.description : undefined,
    owner: r.owner && typeof r.owner === 'object' ? r.owner : undefined,
    plugins,
  }
}

function normalizePluginEntry(raw: unknown): CatalogListing | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Partial<CatalogListing>
  if (typeof r.name !== 'string' || r.name.length === 0) return null
  // read it untyped and let coercePluginOrigin validate. (Previously a string
  // source was rejected here, dropping every local-source plugin entry.)
  const rawSource: unknown = (raw as Record<string, unknown>).source
  if (rawSource === undefined || rawSource === null) return null
  const source = coercePluginOrigin(rawSource)
  if (!source) return null
  const out: CatalogListing = { name: r.name, source }
  if (typeof r.description === 'string') out.description = r.description
  if (typeof r.version === 'string') out.version = r.version
  if (typeof r.category === 'string') out.category = r.category
  if (typeof r.homepage === 'string') out.homepage = r.homepage
  if (r.author && typeof r.author === 'object') out.author = r.author
  if (typeof r.onByDefault === 'boolean') out.onByDefault = r.onByDefault
  if (typeof r.betaOnly === 'boolean') out.betaOnly = r.betaOnly
  return out
}

/** The listings a channel shows: `betaOnly` ones only on `beta`. */
export function listingsVisibleOn<T extends Pick<CatalogListing, 'betaOnly'>>(
  plugins: readonly T[],
  channel: UpdateChannel,
): T[] {
  return channel === 'beta' ? [...plugins] : plugins.filter(p => p.betaOnly !== true)
}

function coercePluginOrigin(raw: unknown): PluginOrigin | null {
  // a path relative to the marketplace repo root, must start with `./`. nexus
  // stores it as `{ source:'local', path }` (discriminated-union representation;
  // marketplace repo at <path>; the install op copies it from the cached
  // marketplace content dir rather than fetching.
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (!trimmed.startsWith('./')) return null
    const segs = trimmed
      .slice(2)
      .split('/')
      .filter(s => s.length > 0 && s !== '.')
    if (segs.length === 0 || segs.some(s => s === '..')) return null
    return { source: 'local', path: segs.join('/') }
  }
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const kind = r.source
  if (kind === 'local') {
    // Object round-trip form of the above (e.g. a re-normalized entry).
    if (typeof r.path !== 'string' || r.path.length === 0) return null
    return { source: 'local', path: r.path }
  }
  if (kind === 'github') {
    if (typeof r.repo !== 'string' || !r.repo.includes('/')) return null
    const out: PluginOrigin = { source: 'github', repo: r.repo }
    if (typeof r.sha === 'string' && r.sha.length > 0) out.sha = r.sha
    if (typeof r.ref === 'string' && r.ref.length > 0) out.ref = r.ref
    return out
  }
  if (kind === 'url') {
    if (typeof r.url !== 'string') return null
    // Remote plugin sources must be https. Plain http is allowed ONLY for
    // loopback (a local/self-hosted or e2e fake-marketplace server) — matches
    // the http+https the fetch layer (`resolveSourceFetchUrl`) accepts.
    const isHttps = r.url.startsWith('https://')
    const isLoopbackHttp = /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\//.test(
      r.url,
    )
    if (!isHttps && !isLoopbackHttp) return null
    const out: PluginOrigin = { source: 'url', url: r.url }
    if (typeof r.sha === 'string' && r.sha.length > 0) out.sha = r.sha
    if (typeof r.ref === 'string' && r.ref.length > 0) out.ref = r.ref
    return out
  }
  if (kind === 'https') {
    if (typeof r.url !== 'string' || !r.url.startsWith('https://')) return null
    const out: PluginOrigin = { source: 'https', url: r.url }
    if (typeof r.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(r.sha256)) out.sha256 = r.sha256.toLowerCase()
    return out
  }
  if (kind === 'git-subdir') {
    // be `owner/repo` shorthand, an https github.com URL, or a git@ SSH URL —
    // `resolveSourceFetchUrl` narrows to the GitHub-fetchable forms. `path` is
    // the subdirectory the plugin actually lives in (re-rooted at install).
    // Without this branch the entry was dropped as malformed, so every
    // git-subdir plugin (the bulk of monorepo community submissions) was
    // silently unlistable + uninstallable.
    if (typeof r.url !== 'string' || r.url.length === 0) return null
    if (typeof r.path !== 'string' || r.path.length === 0) return null
    const out: PluginOrigin = { source: 'git-subdir', url: r.url, path: r.path }
    if (typeof r.sha === 'string' && r.sha.length > 0) out.sha = r.sha
    if (typeof r.ref === 'string' && r.ref.length > 0) out.ref = r.ref
    return out
  }
  if (kind === 'directory') {
    if (typeof r.path !== 'string' || r.path.length === 0) return null
    return { source: 'directory', path: r.path }
  }
  if (kind === 'inline') {
    if (!Array.isArray(r.plugins)) return null
    return { source: 'inline', plugins: r.plugins as CatalogListing[] }
  }
  return null
}
