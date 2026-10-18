/**
 * Model listings fetched by the runtime (cached in memory and on disk), and the
 * runtime-only providers built on them (F-28). Reconciliation only ever runs on a
 * listing that was fetched, parsed and non-empty; a failed or empty fetch never
 * touches the user's models. Settings writes go through `RuntimeProvidersHost`.
 */
import {
  createBridgeRoute,
  type BrowserBridgeTransport,
  type BrowserLlmCatalog,
  type BrowserLlmModel,
  type BrowserLlmProvider,
} from '../../browser/bridge/browserBridgeProtocol'
import { GENERIC_PROVIDER_ICON_SVG } from '../../config/customProviderRegistry'
import {
  NEXUS_MODEL_CONFIG,
  type NexusConfiguredModel,
  type NexusProviderModelConfig,
} from '../../config/nexusModelConfig'
import type {
  ProviderModelInfo,
  ProviderVerifyResult,
} from '../../config/nexusModelConfig/providerDefinition'
import {
  getProviderDefinition,
  isDisabledModProviderId,
  isModProviderScanComplete,
} from '../../config/nexusModelConfig/providers'
import {
  listedFiguresOf,
  listedModelRow,
  recordListedFigures,
  resetListedFigures,
} from '../../config/nexusModelConfig/familyRows'
import { publishListedModelPool, resetProviderModelPool } from '../../config/nexusModelConfig/providerModelPool'
import type { NexusProviderConfig } from '../../settings/settingsTypes'
import { holdsModSignIn } from '../../settings/providerSignIn'
import { traceLine } from '../../utils/debugLog'
import {
  entryForModelId,
  entryId,
  familyLabel,
  groupFamilies,
  LATEST,
  parseEntryId,
  resolveEntry,
  type ModelEntry,
  type ModelFamily,
  versionParser,
} from '../../config/nexusModelConfig/modelEntries'
import { sanitizeUserModels, withUserModels } from '../../config/nexusModelConfig/userModels'
import { buildEntryRows, effectiveEntries } from './modelEntryCatalog'
import { listProviderModels, verifyProvider } from './providerDocuments'
import { confineModelWire, parseModelWire } from './modelWire'
import {
  isRuntimeOnlyProvider,
  listsModelsInRuntime,
  providerWireBaseUrl,
  runtimeOnlyProviderIds,
  verifiesInRuntime,
} from './driverRegistry'

/** A listing is re-fetched after this long; a failed refresh keeps the last. */
export const MODEL_LISTING_TTL_MS = 60 * 60 * 1000
/** How long a catalog fetch waits for the listings before answering. */
export const LISTING_WAIT_MS = 5_000
/** After a failed listing fetch, how long an unforced refresh answers with
 *  that failure instead of asking again: the TTL counts successes only, so
 *  without this every catalog read re-fetches a listing that keeps failing. */
export const LISTING_RETRY_MS = 5 * 60 * 1000

/** What the runtime hub lends this module: settings writes and the cache. */
export type RuntimeProvidersHost = {
  /** Replace one provider's settings.json config through the `providers`
   *  write path. `apiKey` absent = keep the stored key. */
  writeProviderConfig(providerId: string, config: NexusProviderConfig): Promise<void>
  readCache(providerId: string): Promise<string | undefined>
  writeCache(providerId: string, text: string): Promise<void>
  /** Publish the current `NEXUS_MODEL_CONFIG` to the host (`model.publishCatalog`)
   *  — a provider mod was added or removed. Absent = no host. */
  republishCatalog?(): Promise<void>
  /** Broadcast `providers.changed` to every open surface. Absent = no hub. */
  broadcastProvidersChanged?(extra?: ProvidersChangedListing): Promise<void>
}

/** Rides on `providers.changed` when a listing's rows were replaced. */
export type ProvidersChangedListing = {
  reason: 'listing'
  /** The providers whose listing was replaced. */
  listedProviderIds: string[]
}

type Listing = {
  models: ProviderModelInfo[]
  fetchedAt: number
  /** What the last reconciliation removed: `ids` are display names for the
   *  settings notice, `entryIds` the entries themselves — the page and
   *  `setModelEntries` never write one of those back (a stale page copy). */
  removed?: { ids: string[]; entryIds?: string[]; at: number }
}

const listings = new Map<string, Listing>()
const inFlight = new Map<string, Promise<RefreshOutcome>>()
/** The last failed listing fetch per provider, cleared by a success. */
const failures = new Map<string, { at: number; error: string }>()
const cacheLoaded = new Set<string>()
let configs: Record<string, NexusProviderConfig> = {}
/** settings.json's provider configs have been read (`setRuntimeProviderConfigs`
 *  ran): only then can an entry be written without clobbering a stored one. */
let configsLoaded = false
let host: RuntimeProvidersHost | undefined

export function configureRuntimeProviders(next: RuntimeProvidersHost | undefined): void {
  host = next
}

function catalogEntry(providerId: string): NexusProviderModelConfig | undefined {
  return NEXUS_MODEL_CONFIG.providers.find(p => p.providerId === providerId)
}

/** The ids picked for a first connection: a built-in gateway's catalog list,
 *  or a provider mod's `modelsUi.starterModels`. */
function starterModelIds(providerId: string): readonly string[] {
  return catalogEntry(providerId)?.starterModels
    ?? getProviderDefinition(providerId)?.catalogMod?.modelsUi?.starterModels
    ?? []
}

/**
 * The provider configs as settings.json holds them. Called where the
 * custom-provider records are (worker boot, every `providers.*` write).
 */
export function setRuntimeProviderConfigs(next: Record<string, NexusProviderConfig> | undefined): void {
  const before = configs
  configs = next ?? {}
  // A change to the hand-added models changes what the listing reads as.
  for (const id of listings.keys()) {
    if (JSON.stringify(before[id]?.userModels) !== JSON.stringify(configs[id]?.userModels)) reapplyListing(id)
  }
  if (next !== undefined) {
    const first = !configsLoaded
    configsLoaded = true
    void flushModAdoptions()
    if (first) for (const listener of [...configsLoadedListeners]) listener()
    for (const listener of [...configsChangedListeners]) listener()
  }
}

const configsLoadedListeners = new Set<() => void>()
const configsChangedListeners = new Set<() => void>()

/** Whether settings.json's provider configs have been read. */
export function runtimeProviderConfigsLoaded(): boolean {
  return configsLoaded
}

/** `listener` runs after every read or write of settings.json's provider configs. */
export function onRuntimeProviderConfigsChanged(listener: () => void): () => void {
  configsChangedListeners.add(listener)
  return () => configsChangedListeners.delete(listener)
}

/** `listener` runs once settings.json's provider configs are first read. */
export function onRuntimeProviderConfigsLoaded(listener: () => void): () => void {
  configsLoadedListeners.add(listener)
  return () => configsLoadedListeners.delete(listener)
}

/** Security: the install identifier that owns a provider mod's stored entry.
 *  Undefined: no owner recorded, or settings.json not read yet. */
export function modProviderOwner(providerId: string): string | undefined {
  return configs[providerId]?.modOwner
}

/** Every provider's config as settings.json holds it (the model entries of
 *  built-in providers read it too — modelEntryCatalog.ts). */
export function runtimeProviderConfigs(): Record<string, NexusProviderConfig> {
  return configs
}

function hasApiKey(providerId: string): boolean {
  const config = configs[providerId]
  return !!(config?.apiKey && config.apiKey.length > 0) || config?.hasApiKey === true
}

/**
 * The provider can be used now: a key is stored, or a provider mod has a signed-in
 * account, or a mod offering `anonymous` was CHOSEN keyless
 * (`credentialMode: 'anonymous'`). Offering the mode is not choosing it.
 */
export function isProviderSetUp(providerId: string): boolean {
  if (hasApiKey(providerId)) return true
  const mod = getProviderDefinition(providerId)?.catalogMod
  if (!mod) return false
  const config = configs[providerId]
  if (holdsModSignIn(config)) return true
  return mod.credentialMethods?.includes('anonymous') === true && config?.credentialMode === 'anonymous'
}

/**
 * A provider mod's cached listing was made under another version of its
 * plugin than the one registered now (the stored `modVersion` is the version
 * of the listing last fetched): it is stale whatever its age. Staleness only
 * lifts the TTL — it never starts a worker by itself; the listing is fetched
 * the next time something may call the module (a refresh while it is loaded,
 * Refresh, the first connection).
 */
function listingIsStale(providerId: string): boolean {
  const definition = getProviderDefinition(providerId)
  if (!definition?.codeListing || !definition.catalogMod) return false
  return configs[providerId]?.modVersion !== definition.catalogMod.version
}

/** A listing that comes from a mod's code is refreshed in the background only
 *  while that module is already loaded: reading the catalog never starts a
 *  worker. */
function mayRefreshInBackground(providerId: string): boolean {
  const code = getProviderDefinition(providerId)?.codeListing
  return !code || code.isLoaded()
}

/** What the cached listing states about one model — a provider mod reads the
 *  family and version of an id from it instead of from a rule of its own. */
export function listedModelInfo(providerId: string, modelId: string): ProviderModelInfo | undefined {
  return mergedModels(providerId).find(model => model.id === modelId)
}

/** The cached listing plus the models the person added by hand (a provider
 *  mod's `userModels`; a listed id wins). Every reader of the listing reads
 *  this, so a hand-added model is a listed model from there on. */
function mergedModels(providerId: string): ProviderModelInfo[] {
  return withHandAdded(providerId, listings.get(providerId)?.models ?? [])
}

/** A fresh listing with the hand-added models appended, for reconciling. */
function withHandAdded(providerId: string, models: ProviderModelInfo[]): ProviderModelInfo[] {
  const config = configs[providerId]
  if (config?.source !== 'mod' || !config.userModels) return models
  const definition = getProviderDefinition(providerId)
  const merged = withUserModels(models, sanitizeUserModels(config.userModels), {
    wires: definition?.catalogMod?.modelsUi?.customModels?.wires,
    defaultFormat: definition?.config.wire?.format,
  })
  // The listed rows were parsed on arrival; the hand-added ones are parsed here.
  return withParsedWires(providerId, merged)
}

/** Re-derive what the listing feeds (figures, model pool, catalog rows) after
 *  the hand-added models changed. */
function reapplyListing(providerId: string): void {
  const listing = listings.get(providerId)
  if (listing) applyListing(providerId, listing)
}

/** The provider's model entries (stored, else migrated from a pre-entry
 *  `enabledModels`); a gateway has no default entries until its first
 *  connection picks them. */
export function providerEntries(providerId: string): ModelEntry[] {
  return effectiveEntries(providerId, configs[providerId], [])
}

/** The provider's usable listing grouped into families. */
function listedFamilies(providerId: string): Map<string, ModelFamily> {
  return groupFamilies(
    usableModels(providerId).map(m => ({ id: m.id, ...(m.name ? { label: m.name } : {}) })),
    versionParser(providerId),
  )
}

/** A listed model as a catalog row: an exact-id pattern plus what it states. */
function toConfiguredModel(info: ProviderModelInfo): NexusConfiguredModel {
  return listedModelRow(info.id, listedFiguresOf(info))
}

/** The listed rows the agent can use: function calling is required. */
function usableModels(providerId: string): ProviderModelInfo[] {
  return mergedModels(providerId).filter(model => model.supportsTools)
}

/**
 * A listing's rows with each `wire` reduced to its well-formed part (a row
 * with nothing usable left loses the key, and stays). Whatever arrives —
 * a provider mod's rows, a cache file on disk — passes here first.
 */
function withParsedWires(providerId: string, models: ProviderModelInfo[]): ProviderModelInfo[] {
  return models.map(model => {
    if (model.wire === undefined) return model
    const { wire: raw, ...row } = model
    const wire = parseModelWire(providerId, raw)
    return wire ? { ...row, wire } : row
  })
}

/** The rows as the routing reads them: each `wire.baseUrl` held to the
 *  provider's origin (the host's domain lock is anchored to it). */
function withConfinedWires(providerId: string, models: ProviderModelInfo[]): ProviderModelInfo[] {
  const baseUrl = providerWireBaseUrl(providerId)
  return models.map(model => {
    if (!model.wire) return model
    const { wire: parsed, ...row } = model
    const wire = confineModelWire(providerId, parsed, baseUrl)
    return wire ? { ...row, wire } : row
  })
}

function applyListing(providerId: string, incoming: Listing): void {
  // The listing is kept (and cached) as parsed; the origin is checked where
  // it is read, against the base URL in force then.
  const listing: Listing = { ...incoming, models: withParsedWires(providerId, incoming.models) }
  listings.set(providerId, listing)
  // What the listing states is the middle layer of a family row's figures.
  recordListedFigures(providerId, withConfinedWires(providerId, mergedModels(providerId)))
  // …and its tool-capable models are everything the provider can run, which
  // the tier ladder searches (config/nexusModelConfig/providerModelPool.ts).
  publishListedModelPool(providerId, usableModels(providerId))
  // A runtime-only provider's rows ARE its listing. In place, like the
  // custom-provider overlay: NEXUS_MODEL_CONFIG is read by reference
  // everywhere. A built-in keeps its curated rows: a listed version of one
  // of its families reads that family's row (familyRows.ts), nothing is added.
  const entry = catalogEntry(providerId)
  if (entry && isRuntimeOnlyProvider(providerId)) {
    entry.models = usableModels(providerId).map(toConfiguredModel)
  }
}

async function loadCachedListing(providerId: string): Promise<void> {
  if (cacheLoaded.has(providerId) || !host) return
  cacheLoaded.add(providerId)
  try {
    const text = await host.readCache(providerId)
    if (!text || listings.has(providerId)) return
    const parsed = JSON.parse(text) as Partial<Listing>
    if (!Array.isArray(parsed.models) || typeof parsed.fetchedAt !== 'number') return
    applyListing(providerId, {
      models: parsed.models.filter(
        (m): m is ProviderModelInfo => !!m && typeof m.id === 'string' && typeof m.supportsTools === 'boolean',
      ),
      fetchedAt: parsed.fetchedAt,
      ...(parsed.removed ? { removed: parsed.removed } : {}),
    })
  } catch {
    // No cache yet, or an unreadable one: the next fetch writes a fresh one.
  }
}

function saveCache(providerId: string): void {
  const listing = listings.get(providerId)
  if (!host || !listing) return
  host.writeCache(providerId, `${JSON.stringify(listing)}\n`).catch(error => {
    traceLine(
      `[providers] listing cache write failed provider=${providerId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { level: 'warn' },
    )
  })
}

/**
 * Reconcile the user's entries with an AUTHORITATIVE listing: drop pinned versions
 * no longer listed (or not calling tools), and a `latest` only when its whole family
 * is gone; `pickDefaults` seeds a first connection. Undefined = nothing to change.
 */
export function reconcileEntries(
  providerId: string,
  config: NexusProviderConfig,
  listed: readonly ProviderModelInfo[],
  options: { pickDefaults?: boolean } = {},
): { next: NexusProviderConfig; removed: string[]; removedIds: string[] } | undefined {
  const parse = versionParser(providerId)
  const families = groupFamilies(
    listed.filter(m => m.supportsTools).map(m => ({ id: m.id, ...(m.name ? { label: m.name } : {}) })),
    parse,
  )
  // A listing with no tool-capable model says nothing about the entries
  // (a changed listing shape, not a provider that delisted everything):
  // never reconcile against it (the caller refuses it too).
  if (families.size === 0) return undefined
  const entries = effectiveEntries(providerId, config, [])
  let kept: ModelEntry[] = []
  const removed: string[] = []
  const removedIds: string[] = []
  for (const entry of entries) {
    if (resolveEntry(entry, families, parse)) kept.push(entry)
    else {
      removedIds.push(entryId(entry))
      // A family the listing still has reads by its name; one it dropped
      // entirely, by the id the entry was added with.
      const family = families.get(entry.family)
      const label = family?.label ?? entry.id ?? familyLabel(entry.family, undefined, '')
      removed.push(entry.version === LATEST || (!family && entry.id) ? label : `${label} ${entry.version}`)
    }
  }
  if (entries.length === 0) {
    // Only a FIRST connection — no list stored yet; an emptied one is the
    // user's choice.
    const stored = Array.isArray(config.modelEntries) || Array.isArray(config.enabledModels)
    if (!options.pickDefaults || stored) return undefined
    const seen = new Set<string>()
    kept = []
    for (const id of starterModelIds(providerId)) {
      const family = parse(id).family
      if (seen.has(family)) continue
      seen.add(family)
      const entry: ModelEntry = { family, version: LATEST }
      const resolved = resolveEntry(entry, families, parse)
      if (resolved) kept.push({ ...entry, id: resolved.id })
    }
    if (kept.length === 0) return undefined
  } else if (removed.length === 0) {
    return undefined
  }
  const next: NexusProviderConfig = { ...config, modelEntries: kept }
  delete next.enabledModels
  const ids = kept.map(entryId)
  for (const key of ['defaultModel', 'model'] as const) {
    const current = config[key]
    if (!current) {
      if (key === 'defaultModel' && ids[0] && entries.length === 0) {
        next.defaultModel = ids[0]
        next.model = ids[0]
      }
      continue
    }
    const asEntry = parseEntryId(current) ?? entryForModelId(current, kept, parse)
    const id = asEntry && ids.includes(entryId(asEntry)) ? entryId(asEntry) : ids[0]
    if (id) next[key] = id
    else delete next[key]
  }
  return { next, removed, removedIds }
}

/**
 * Entry ids the last reconciliation removed that the current listing still
 * cannot resolve: a write naming one comes from a page copy older than the
 * removal, and must not bring it back (`providers.setModelEntries`).
 */
export function staleEntryIds(providerId: string): string[] {
  const removed = listings.get(providerId)?.removed?.entryIds ?? []
  if (removed.length === 0) return []
  const families = listedFamilies(providerId)
  const parse = versionParser(providerId)
  return removed.filter(id => {
    const entry = parseEntryId(id)
    return !entry || !resolveEntry(entry, families, parse)
  })
}

/**
 * The config to write after a successful listing: the reconciled one (if
 * any) carrying the plugin version the listing was made under. Undefined =
 * nothing to write. The version is recorded only into an entry that exists
 * (settings.json was read and holds the mod's entry).
 */
function stampListingVersion(
  providerId: string,
  reconciled: NexusProviderConfig | undefined,
): NexusProviderConfig | undefined {
  if (!listingIsStale(providerId) || !configsLoaded || configs[providerId]?.source !== 'mod') return reconciled
  const version = getProviderDefinition(providerId)?.catalogMod?.version
  const next: NexusProviderConfig = { ...(reconciled ?? configs[providerId]) }
  if (version !== undefined) next.modVersion = version
  else delete next.modVersion
  return next
}

export type RefreshOutcome =
  | { ok: true; models: ProviderModelInfo[]; removed: string[] }
  | { ok: false; error: string }

/**
 * Fetch one provider's listing unless a fresh one is cached (or `force`),
 * then reconcile the picks. Never rejects: a failure keeps the previous
 * listing — and the user's models — and is reported in the outcome.
 */
export async function refreshRuntimeProviderModels(
  transport: BrowserBridgeTransport,
  providerId: string,
  options: { force?: boolean; now?: number; pickDefaults?: boolean } = {},
): Promise<RefreshOutcome> {
  await loadCachedListing(providerId)
  const cached = listings.get(providerId)
  const now = options.now ?? Date.now()
  if (!options.force && cached && now - cached.fetchedAt < MODEL_LISTING_TTL_MS && !listingIsStale(providerId)) {
    return { ok: true, models: cached.models, removed: [] }
  }
  const failed = failures.get(providerId)
  if (!options.force && failed && now - failed.at < LISTING_RETRY_MS) {
    return { ok: false, error: failed.error }
  }
  const running = inFlight.get(providerId)
  if (running) {
    // A forced caller (verify, with `pickDefaults`) must not take an earlier
    // caller's outcome: that task reconciled without its options, and left a
    // listing fresh enough that nothing would reconcile again for an hour.
    if (!options.force) return running
    await running
    return refreshRuntimeProviderModels(transport, providerId, options)
  }
  const fail = (error: string): RefreshOutcome => {
    failures.set(providerId, { at: now, error })
    return { ok: false, error }
  }
  const task = (async (): Promise<RefreshOutcome> => {
    try {
      const models = await listProviderModels(transport, providerId, { now })
      // An empty listing says nothing about the user's models: keep them.
      if (models.length === 0) return fail('the provider listed no models')
      // Nor does one with no tool-capable model: that is a listing whose shape
      // changed (a dropped `supported_parameters`), not a provider that delisted
      // everything — reconciling against it would remove every pick.
      if (!models.some(m => m.supportsTools)) {
        return fail('the provider listed no tool-capable models')
      }
      failures.delete(providerId)
      // Picks are a runtime-only provider's: a built-in's entries resolve
      // against its curated rows, which no listing can remove.
      const reconciled = isProviderSetUp(providerId) && isRuntimeOnlyProvider(providerId)
        ? reconcileEntries(providerId, configs[providerId] ?? {}, withHandAdded(providerId, models), {
            pickDefaults: options.pickDefaults,
          })
        : undefined
      const removed = reconciled?.removed ?? []
      applyListing(providerId, {
        models,
        fetchedAt: now,
        ...(removed.length > 0
          ? { removed: { ids: removed, entryIds: reconciled!.removedIds, at: now } }
          : cached?.removed ? { removed: cached.removed } : {}),
      })
      saveCache(providerId)
      // A listing that landed under the registered plugin version records it.
      const stamped = stampListingVersion(providerId, reconciled?.next)
      if (stamped && host) {
        const { apiKey: _stored, hasApiKey: _flag, ...rest } = stamped
        configs = { ...configs, [providerId]: stamped }
        await host.writeProviderConfig(providerId, rest)
      }
      return { ok: true, models, removed }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      traceLine(`[providers] model listing failed provider=${providerId}: ${message}`, {
        level: 'warn',
      })
      return fail(message)
    }
  })()
  // Registered first, cleared when it settles: clearing inside the task could
  // run before the set (a throw ahead of the first await) and pin a finished
  // task as "running" forever.
  inFlight.set(providerId, task)
  const clear = () => {
    if (inFlight.get(providerId) === task) inFlight.delete(providerId)
  }
  task.then(clear, clear)
  return task
}

/**
 * Refresh the listing of every runtime-only provider that holds a key AND has
 * models picked — a provider nobody uses is not polled; its listing is
 * fetched when the settings page asks. Resolves after the listings or after
 * `LISTING_WAIT_MS`, whichever is first — never rejects. Only a provider with
 * NO listing yet is waited for: a stale cached one already serves the
 * catalog, and is refreshed in the background for the next read.
 */
export async function refreshConfiguredRuntimeProviderModels(
  transport: BrowserBridgeTransport,
  options: { waitMs?: number } = {},
): Promise<void> {
  const ids = runtimeOnlyProviderIds()
  await Promise.all(ids.map(loadCachedListing))
  const due = ids.filter(id => isProviderSetUp(id) && providerEntries(id).length > 0 && mayRefreshInBackground(id))
  if (due.length === 0) return
  const unlisted = new Set(due.filter(id => !listings.has(id)))
  const awaited: Promise<RefreshOutcome>[] = []
  for (const id of due) {
    const done = refreshRuntimeProviderModels(transport, id)
    if (unlisted.has(id)) awaited.push(done)
  }
  if (awaited.length === 0) return
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    Promise.all(awaited),
    new Promise<void>(resolve => {
      timer = setTimeout(resolve, options.waitMs ?? LISTING_WAIT_MS)
    }),
  ])
  clearTimeout(timer)
}

/** Display names — brand names, the same in every language. */
const PROVIDER_LABELS: Record<string, string> = {
  openrouter: 'OpenRouter',
  'vercel-ai-gateway': 'Vercel AI Gateway',
}

export function runtimeProviderLabel(providerId: string): string {
  return getProviderDefinition(providerId)?.label ?? PROVIDER_LABELS[providerId] ?? providerId
}

function toCatalogModel(info: ProviderModelInfo): BrowserLlmModel {
  const row = toConfiguredModel(info)
  const model: BrowserLlmModel = {
    id: info.id,
    label: info.name ?? info.id,
    enabled: true,
    supportsStreaming: true,
    supportsTools: true,
  }
  if (row.contextWindow) model.contextWindow = row.contextWindow
  if (row.maxOutputTokens) model.maxOutputTokens = row.maxOutputTokens
  if (row.availableThinkingTiers) model.availableThinkingTiers = [...row.availableThinkingTiers]
  if (row.defaultThinkingTier) model.defaultThinkingTier = row.defaultThinkingTier
  if (row.supportsImageInput === false) model.supportsImageInput = false
  if (info.price) model.price = { ...info.price }
  if (info.free) model.free = true
  return model
}

/**
 * One catalog row per runtime-only provider, listed (so Settings can offer
 * it) whether or not it is set up. Its models are the user's ENTRIES,
 * resolved against the listing — an entry the listing cannot resolve yet (no
 * cache, no fetch) falls back to the id it was added with. `enabled` = a key
 * and at least one row.
 */
export function runtimeProviderCatalogRows(): BrowserLlmProvider[] {
  const rows = runtimeOnlyProviderIds().map(id => {
    const listed = new Map(usableModels(id).map(info => [info.id, info]))
    const definition = getProviderDefinition(id)
    const base: BrowserLlmProvider = {
      id,
      label: runtimeProviderLabel(id),
      iconSvg: definition?.iconSvg ?? GENERIC_PROVIDER_ICON_SVG,
      enabled: isProviderSetUp(id),
      models: [],
      ...(configs[id]?.defaultModel ? { defaultModelId: configs[id]!.defaultModel } : {}),
      // A provider mod's row carries what the page draws it from.
      ...(definition?.catalogMod ? { mod: definition.catalogMod } : {}),
    }
    return buildEntryRows(base, providerEntries(id), listedFamilies(id), modelId => {
      const { id: _id, enabled: _enabled, ...meta } = toCatalogModel(
        listed.get(modelId) ?? { id: modelId, supportsTools: true },
      )
      return meta
    })
  })
  return [...rows, ...pluginMissingRows()]
}

/**
 * A provider mod whose plugin was UNINSTALLED keeps its settings.json entry
 * (credentials, picks); its row reads "plugin missing" and offers no models.
 * A DISABLED plugin's provider shows nothing at all, and nothing is said
 * before the first plugin scan has finished — the registry is still empty
 * then, and every mod provider would read as missing.
 */
function pluginMissingRows(): BrowserLlmProvider[] {
  if (!isModProviderScanComplete()) return []
  const rows: BrowserLlmProvider[] = []
  for (const [id, config] of Object.entries(configs)) {
    if (config.source !== 'mod' || getProviderDefinition(id) || isDisabledModProviderId(id)) continue
    rows.push({
      id,
      label: config.displayName?.trim() || id,
      iconSvg: GENERIC_PROVIDER_ICON_SVG,
      enabled: false,
      models: [],
      mod: { state: 'plugin-missing', ...(config.modVersion ? { version: config.modVersion } : {}) },
    })
  }
  return rows
}

/** Built-ins whose listing the runtime fetches (they keep a host class). */
function builtInListingIds(): string[] {
  return NEXUS_MODEL_CONFIG.providers
    .map(p => p.providerId)
    .filter(id => listsModelsInRuntime(id) && !isRuntimeOnlyProvider(id))
}

/**
 * Adds to each built-in's host row the listed models it lacks; curated rows stay.
 * Never waits for the network (cached listing; stale ones refresh in the
 * background) and never rejects.
 */
export async function overlayBuiltInListings(
  transport: BrowserBridgeTransport,
  catalog: BrowserLlmCatalog | null | undefined,
): Promise<BrowserLlmCatalog | null | undefined> {
  if (!catalog) return catalog
  const ids = new Set(builtInListingIds())
  if (ids.size === 0) return catalog
  await Promise.all([...ids].map(loadCachedListing))
  const providers = catalog.providers.map(provider => {
    if (!ids.has(provider.id)) return provider
    const setUp = provider.models.some(model => model.enabled)
    if (setUp) void refreshRuntimeProviderModels(transport, provider.id)
    const known = new Set(provider.models.map(model => model.id))
    const added = usableModels(provider.id)
      .filter(info => !known.has(info.id))
      .map((info): BrowserLlmModel => ({
        id: info.id,
        label: info.name ?? info.id,
        enabled: setUp,
        supportsStreaming: true,
        supportsTools: true,
      }))
    return added.length > 0 ? { ...provider, models: [...provider.models, ...added] } : provider
  })
  return { ...catalog, providers }
}

/** Splice the runtime-only providers into a host catalog (replacing a row a
 *  newer host might ship under the same id). */
export function appendRuntimeProvidersToCatalog(
  catalog: BrowserLlmCatalog | null | undefined,
): BrowserLlmCatalog | null | undefined {
  if (!catalog) return catalog
  const rows = runtimeProviderCatalogRows()
  if (rows.length === 0) return catalog
  const replaced = new Set(rows.map(row => row.id))
  return {
    ...catalog,
    providers: [...catalog.providers.filter(p => !replaced.has(p.id)), ...rows],
  }
}

/** What the settings page's model picker shows (`providers.listModels`). */
export type RuntimeProviderListing =
  | {
      ok: true
      /** Every model the agent can use (function calling), listing order. */
      models: ProviderModelInfo[]
      fetchedAt: number
      /** Picked ids the last reconciliation removed. */
      removed?: { ids: string[]; entryIds?: string[]; at: number }
    }
  | { ok: false; error: string; models: ProviderModelInfo[] }

/**
 * The listing for the settings page, refreshed first (forced when asked).
 * On a failed fetch the last listing comes back with the error, so the
 * page can still show what it knew.
 */
export async function listRuntimeProviderModels(
  transport: BrowserBridgeTransport,
  providerId: string,
  options: { force?: boolean } = {},
): Promise<RuntimeProviderListing> {
  if (!listsModelsInRuntime(providerId)) {
    return { ok: false, error: `${providerId} is not a runtime provider`, models: [] }
  }
  const outcome = await refreshRuntimeProviderModels(transport, providerId, options)
  const listing = listings.get(providerId)
  const models = usableModels(providerId)
  if (!outcome.ok) return { ok: false, error: outcome.error, models }
  return {
    ok: true,
    models,
    fetchedAt: listing?.fetchedAt ?? Date.now(),
    ...(listing?.removed ? { removed: listing.removed } : {}),
  }
}

/**
 * The provider's model ids as it lists them RIGHT NOW — for the settings
 * home page's availability count. A provider listed in the runtime re-fetches
 * its listing (which also reconciles a runtime-only provider's picks); any
 * other provider asks the host to re-run its discovery
 * (`providerAuth.refresh`). Never rejects.
 */
export async function fetchFreshModelIds(
  transport: BrowserBridgeTransport,
  providerId: string,
): Promise<{ ok: true; ids: string[] } | { ok: false; error: string }> {
  if (listsModelsInRuntime(providerId)) {
    const listing = await listRuntimeProviderModels(transport, providerId, { force: true })
    return listing.ok
      ? { ok: true, ids: listing.models.map(model => model.id) }
      : { ok: false, error: listing.error }
  }
  try {
    const response = (await transport.request({
      id: `fresh-models-${providerId}-${crypto.randomUUID()}`,
      route: createBridgeRoute('providerAuth', 'refresh'),
      payload: { providerId },
    })) as
      | { ok: true; result: { success: boolean; models?: Array<{ id: string }>; error?: string } }
      | { ok: false; error: { code: string; message: string } }
    if (!response.ok) return { ok: false, error: `${response.error.code}: ${response.error.message}` }
    if (!response.result.success) return { ok: false, error: response.result.error ?? 'refresh failed' }
    return { ok: true, ids: (response.result.models ?? []).map(model => model.id).filter(Boolean) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** The settings page dismissed the removal notice. */
export function dismissRemovedNotice(providerId: string): void {
  const listing = listings.get(providerId)
  if (!listing?.removed) return
  const { removed: _gone, ...rest } = listing
  listings.set(providerId, rest)
  saveCache(providerId)
}

/**
 * Probe the stored key of a provider verified in the runtime (a runtime-only
 * provider, or a built-in on its ModelProvider). When it works: stamp the
 * verification into the provider's config, then refresh the listing (which,
 * for a runtime-only provider, picks the tier models on a first connection)
 * — both written here, one after the other, so neither can overwrite the
 * other with a stale copy.
 */
export async function verifyRuntimeProvider(
  transport: BrowserBridgeTransport,
  providerId: string,
  options: { now?: number } = {},
): Promise<ProviderVerifyResult & { verifiedAtMs?: number }> {
  if (!verifiesInRuntime(providerId)) {
    return { ok: false, code: 'system_unexpected', message: `${providerId} is not a runtime provider` }
  }
  const result = await verifyProvider(transport, providerId)
  if (!result.ok) return result
  const verifiedAtMs = options.now ?? Date.now()
  if (host) {
    const { apiKey: _stored, hasApiKey: _flag, ...rest } = configs[providerId] ?? {}
    const stamped = { ...rest, lastVerification: { providerId, verifiedAtMs } }
    configs = { ...configs, [providerId]: { ...configs[providerId], ...stamped } }
    await host.writeProviderConfig(providerId, stamped)
  }
  await refreshRuntimeProviderModels(transport, providerId, { force: true, pickDefaults: true })
  return { ok: true, verifiedAtMs }
}

/**
 * The configs the host pref needs for a runtime-only provider to be
 * reachable over `model.rawStream*`: the host anchors its domain rule on the
 * stored `base_url`, and a runtime-only provider has no native default to
 * fall back on. The catalog default is injected when the user set none —
 * into the PUBLISHED copy only; settings.json keeps "no override".
 */
export function withRuntimeProviderBaseUrls(
  input: Record<string, NexusProviderConfig>,
): Record<string, NexusProviderConfig> {
  const out: Record<string, NexusProviderConfig> = { ...input }
  for (const id of runtimeOnlyProviderIds()) {
    const defaultBaseUrl = catalogEntry(id)?.defaultBaseUrl
    if (!defaultBaseUrl) continue
    const config = out[id] ?? {}
    if (!config.baseUrl?.trim()) out[id] = { ...config, baseUrl: defaultBaseUrl }
  }
  return out
}

/**
 * A runtime-only provider's catalog default base URL, for the Settings field's
 * placeholder: the host registry (`providerAuth.list`) has no row for these, so
 * the page cannot learn it there. `undefined` for any other provider.
 */
export function runtimeProviderDefaultBaseUrl(providerId: string): string | undefined {
  if (!runtimeOnlyProviderIds().includes(providerId)) return undefined
  return catalogEntry(providerId)?.defaultBaseUrl
}

// ── provider mods: the settings.json entry, and telling everyone ──

/** Some stored config belongs to a provider mod (its plugin may be gone). */
export function hasStoredModProviderConfigs(): boolean {
  return Object.values(configs).some(config => config.source === 'mod')
}

/** Provider mods waiting to have their entry written: id → plugin version and owner. */
const pendingAdoptions = new Map<string, { version: string | undefined; owner: string | undefined }>()
let adopting: Promise<void> = Promise.resolve()

/**
 * Enabling a provider mod sets only `source: 'mod'` and the plugin version on its
 * `providers.configs.<id>` entry (no base URL), when they differ, so a re-enable
 * never costs the key, picks or sign-in. Waits for settings.json to be read.
 */
export function adoptModProvider(providerId: string, modVersion: string | undefined, owner?: string): Promise<void> {
  pendingAdoptions.set(providerId, { version: modVersion, owner })
  return flushModAdoptions()
}

function flushModAdoptions(): Promise<void> {
  adopting = adopting.then(async () => {
    if (!host || !configsLoaded) return
    for (const [id, { version, owner }] of [...pendingAdoptions]) {
      pendingAdoptions.delete(id)
      const stored = configs[id]
      // Security: another plugin's entry is never stamped as this one's (the
      // host refuses to register it once the configs are read).
      if (owner !== undefined && stored?.modOwner !== undefined && stored.modOwner !== owner) continue
      // An entry already a mod's is left whole: a plugin version that moved is
      // seen as a stale listing (`listingIsStale`), and recorded once the
      // listing is fetched under the new version. One with no owner recorded
      // is its first registrant's.
      if (stored?.source === 'mod' && (owner === undefined || stored.modOwner !== undefined)) continue
      const { apiKey: _stored, hasApiKey: _flag, ...rest } = stored ?? {}
      const next: NexusProviderConfig = { ...rest, source: 'mod', ...(owner !== undefined ? { modOwner: owner } : {}) }
      // A new entry has no listing to be stale: it starts at this version. An
      // old entry that was not a mod's before is not stamped (its listing, if
      // any, is not known to be of this version).
      if (stored === undefined && version !== undefined) next.modVersion = version
      configs = { ...configs, [id]: { ...stored, ...next } }
      try {
        await host.writeProviderConfig(id, next)
      } catch (error) {
        traceLine(
          `[providers] could not write the provider-mod entry provider=${id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { level: 'warn' },
        )
      }
    }
  })
  return adopting
}

/**
 * A provider mod was added or removed: the host gets the catalog again and
 * every open surface hears `providers.changed`, in that order — a surface
 * refreshes the catalog the moment it hears. Never rejects.
 */
export async function publishModProvidersChanged(): Promise<void> {
  for (const step of [() => host?.republishCatalog?.(), () => host?.broadcastProvidersChanged?.()]) {
    try {
      await step()
    } catch (error) {
      traceLine(`[providers] provider-mod publish failed: ${error instanceof Error ? error.message : String(error)}`, {
        level: 'warn',
      })
    }
  }
}

/**
 * Listings were replaced without a settings write (the model catalog
 * changed): the host gets the catalog again and every open surface hears
 * `providers.changed` with `reason: 'listing'` and the provider ids, so a
 * page showing one of them reads its rows again. Never rejects.
 */
export async function publishListingsChanged(providerIds: string[]): Promise<void> {
  const extra: ProvidersChangedListing = { reason: 'listing', listedProviderIds: [...providerIds] }
  for (const step of [() => host?.republishCatalog?.(), () => host?.broadcastProvidersChanged?.(extra)]) {
    try {
      await step()
    } catch (error) {
      traceLine(`[providers] listing publish failed: ${error instanceof Error ? error.message : String(error)}`, {
        level: 'warn',
      })
    }
  }
}

/** Test hook. */
export function resetRuntimeProviders(): void {
  configsLoaded = false
  pendingAdoptions.clear()
  adopting = Promise.resolve()
  listings.clear()
  failures.clear()
  resetListedFigures()
  resetProviderModelPool()
  inFlight.clear()
  cacheLoaded.clear()
  configs = {}
  host = undefined
  for (const id of runtimeOnlyProviderIds()) {
    const entry = catalogEntry(id)
    if (entry) entry.models = []
  }
}
