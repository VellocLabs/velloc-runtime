/**
 * Runtime registry for USER-CREATED custom providers, which live only in
 * settings.json. Turns them into model metadata spliced into `NEXUS_MODEL_CONFIG`,
 * host catalog rows, and request routing: each rides its OWN id on a runtime
 * ModelProvider with its dialect's `wire`.
 */

import { NEXUS_MODEL_CONFIG } from './nexusModelConfig'
import { modProviderDefinitions } from './nexusModelConfig/providers'
import { findConfiguredModelIn } from './nexusModelConfig/findConfiguredModel'
import type {
  NexusConfiguredModel,
  NexusProviderModelConfig,
} from './nexusModelConfig/types'
import type {
  BrowserLlmCatalog,
  BrowserLlmModel,
  BrowserLlmProvider,
} from '../browser/bridge/protocol/nexus_llm'
import type {
  CustomModelDef,
  NexusProviderConfig,
} from '../settings/settingsTypes'

// ── Wire dialects / backend slots ───────────────────────────────────────────

export type CustomApiCompatibility = 'openai' | 'anthropic'

/**
 * The two ids the C++ factory CAN build for a user-supplied endpoint. Every
 * custom provider executes through the one matching its `apiCompatibility`.
 * They are also legacy provider ids in their own right (the pre-feature
 * "Custom endpoint" row), which is why a record may legitimately carry one of
 * them as its OWN id — the re-point is then a no-op.
 */
export const CUSTOM_BACKEND_IDS: Record<CustomApiCompatibility, string> = {
  openai: 'custom-openai',
  anthropic: 'custom-anthropic',
}

/** Ids reserved by the backend slots — a generated id must never collide. */
export const RESERVED_CUSTOM_PROVIDER_IDS: readonly string[] = [
  CUSTOM_BACKEND_IDS.openai,
  CUSTOM_BACKEND_IDS.anthropic,
]

export function isCustomBackendId(id: string | undefined): boolean {
  return !!id && RESERVED_CUSTOM_PROVIDER_IDS.includes(id)
}

/** Every user-created provider id starts with this prefix (see
 *  `generateCustomProviderId`), which also makes the two backend slots match. */
export const CUSTOM_PROVIDER_ID_PREFIX = 'custom-'

// ── Records ─────────────────────────────────────────────────────────────────

/**
 * The normalised view of one custom provider. Derived from the persisted
 * `NexusProviderConfig`; never stored in this shape.
 */
export type CustomProviderRecord = {
  id: string
  displayName: string
  providerIcon: string
  apiCompatibility: CustomApiCompatibility
  baseUrl: string
  /** The stored key where the record was built from the worker's own
   *  (unredacted) configs; `''` on the WebUI side, which only ever sees
   *  `hasApiKey`. */
  apiKey: string
  /** True when a key is stored for this provider, whichever side built
   *  the record. */
  hasApiKey?: boolean
  defaultModel: string
  models: CustomModelDef[]
  /** Declared trust, when the user has set one. Absent ⇒ the derived
   *  default (`resolveProviderTrust`: custom ⇒ untrusted). */
  trust?: 'trusted' | 'untrusted'
}

/**
 * Read one config entry as a custom-provider record, or `undefined` when the
 * entry belongs to a built-in provider. The `isCustomProvider` marker is the
 * only qualifier — it is written by the settings page on every save.
 */
export function readCustomProviderRecord(
  id: string,
  config: NexusProviderConfig | undefined,
): CustomProviderRecord | undefined {
  if (!config?.isCustomProvider) return undefined
  return {
    id,
    displayName: (config.displayName ?? '').trim() || id,
    providerIcon: config.providerIcon ?? 'generic',
    apiCompatibility:
      config.apiCompatibility === 'anthropic' ? 'anthropic' : 'openai',
    baseUrl: config.baseUrl ?? '',
    apiKey: config.apiKey ?? '',
    hasApiKey: !!config.apiKey || !!config.hasApiKey,
    defaultModel: config.defaultModel ?? config.model ?? '',
    ...(config.trust ? { trust: config.trust } : {}),
    models: Array.isArray(config.customModels)
      ? config.customModels.filter(
          m => !!m && typeof m.modelId === 'string' && !!m.modelId,
        )
      : [],
  }
}

/** All custom providers in a config map, sorted by display name. */
export function listCustomProviderRecords(
  configs: Record<string, NexusProviderConfig>,
): CustomProviderRecord[] {
  const out: CustomProviderRecord[] = []
  for (const [id, config] of Object.entries(configs ?? {})) {
    const record = readCustomProviderRecord(id, config)
    if (record) out.push(record)
  }
  return out.sort((a, b) =>
    a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' }),
  )
}

/**
 * Generate a URL-safe, collision-free provider id from the display name.
 * `"ABC Provider"` → `"custom-abc-provider"`. Suffixes `-2`, `-3`, … when the
 * slug is already taken (including by the two reserved backend slots, so a
 * provider literally named "OpenAI" can never hijack the OpenAI dialect slot).
 */
export function generateCustomProviderId(
  displayName: string,
  takenIds: Iterable<string> = [],
): string {
  const slug = displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  const base = `${CUSTOM_PROVIDER_ID_PREFIX}${slug || 'provider'}`
  const taken = new Set<string>([...RESERVED_CUSTOM_PROVIDER_IDS, ...takenIds])
  if (!taken.has(base)) return base
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`
    if (!taken.has(candidate)) return candidate
  }
}

// ── Model completeness ──────────────────────────────────────────────────────

/**
 * A model is usable when it carries both numeric limits and the output cap
 * fits inside the window. "Discover models" produces INCOMPLETE rows (id
 * only) — they persist, but can't be the default model and are not offered
 * in the picker.
 */
export function isCustomModelComplete(m: CustomModelDef | undefined): boolean {
  return (
    !!m
    && !!m.modelId
    && typeof m.contextWindow === 'number'
    && m.contextWindow > 0
    && typeof m.maxOutputTokens === 'number'
    && m.maxOutputTokens > 0
    && m.maxOutputTokens <= m.contextWindow
  )
}

/** Display label for a model row — display name when set, else the id. */
export function customModelLabel(m: CustomModelDef): string {
  return m.displayName?.trim() || m.modelId
}

// ── `NEXUS_MODEL_CONFIG` overlay ────────────────────────────────────────────

/**
 * The catalog as shipped, captured once at module load. Every apply rebuilds
 * `NEXUS_MODEL_CONFIG.providers` from this baseline so a removed/renamed
 * custom provider leaves nothing behind, and a legacy `custom-openai` record
 * cleanly REPLACES the shipped passthrough entry for that id.
 */
const BASELINE_PROVIDERS: NexusProviderModelConfig[] = [
  ...NEXUS_MODEL_CONFIG.providers,
]

/**
 * Reasoning tiers offered for a custom model that declares the `reasoning`
 * capability. Deliberately WITHOUT a `defaultThinkingTier`: an arbitrary
 * gateway may reject `reasoning_effort` outright, so nothing is sent unless
 * the user explicitly picks a tier.
 */
const CUSTOM_THINKING_TIERS = ['low', 'medium', 'high']

/** The first-party provider whose catalog speaks for a dialect's model ids. */
export const CUSTOM_DIALECT_VENDOR: Record<CustomApiCompatibility, string> = {
  openai: 'openai',
  anthropic: 'anthropic',
}

/** What the vendor's shipped catalog states about a model a custom provider serves. */
export type VendorModelFigures = {
  vendorId: string
  name?: string
  contextWindow?: number
  /** The vendor's first-request output reservation (not its hard cap). */
  defaultMaxOutputTokens?: number
  availableThinkingTiers?: string[]
  supportsImageInput?: boolean
}

/**
 * The figures the dialect's vendor catalog states for `modelId`, when one of
 * its rows covers that id — a relay serving `claude-opus-5-5` over the
 * Anthropic wire is serving Anthropic's model. Figures only: the opt-in flags
 * (prompt profile, todo tools, strict tools) are claims about the vendor's
 * own endpoint, and never cross to a relay. Read from the shipped catalog
 * (`BASELINE_PROVIDERS`), so a custom record can never feed itself.
 */
export function vendorFiguresForCustomModel(
  apiCompatibility: CustomApiCompatibility,
  modelId: string,
): VendorModelFigures | undefined {
  const id = modelId.trim()
  if (!id) return undefined
  const vendorId = CUSTOM_DIALECT_VENDOR[apiCompatibility]
  const row = findConfiguredModelIn({ providers: BASELINE_PROVIDERS }, vendorId, id)
  if (!row) return undefined
  return {
    vendorId,
    ...(row.name ? { name: row.name } : {}),
    ...(row.contextWindow ? { contextWindow: row.contextWindow } : {}),
    ...(row.defaultMaxOutputTokens ? { defaultMaxOutputTokens: row.defaultMaxOutputTokens } : {}),
    ...(row.availableThinkingTiers?.length ? { availableThinkingTiers: [...row.availableThinkingTiers] } : {}),
    ...(row.supportsImageInput !== undefined ? { supportsImageInput: row.supportsImageInput } : {}),
  }
}

/**
 * The effort levels a custom model offers: none unless the user ticked
 * `reasoning`; then the vendor's own levels when its catalog covers the id,
 * the generic three otherwise. Still no default — nothing is sent until the
 * user picks one. The tier is mapped by the dialect vendor's own reasoning
 * mapper (`resolveCustomProviderRequest.thinkingProviderId`), which knows
 * every one of its tiers.
 */
function customThinkingTiers(
  m: CustomModelDef,
  apiCompatibility: CustomApiCompatibility,
): string[] | undefined {
  if (!m.capabilities?.reasoning) return undefined
  return vendorFiguresForCustomModel(apiCompatibility, m.modelId)?.availableThinkingTiers
    ?? [...CUSTOM_THINKING_TIERS]
}

function toConfiguredModel(m: CustomModelDef, apiCompatibility: CustomApiCompatibility): NexusConfiguredModel {
  const entry: NexusConfiguredModel = { model: m.modelId }
  const name = m.displayName?.trim()
  if (name) entry.name = name
  if (typeof m.contextWindow === 'number' && m.contextWindow > 0) {
    entry.contextWindow = m.contextWindow
  }
  if (typeof m.maxOutputTokens === 'number' && m.maxOutputTokens > 0) {
    entry.maxOutputTokens = m.maxOutputTokens
    entry.defaultMaxOutputTokens = m.maxOutputTokens
  }
  const tiers = customThinkingTiers(m, apiCompatibility)
  if (tiers) entry.availableThinkingTiers = tiers
  if (m.capabilities?.structuredOutput) {
    entry.supportsStrictTools = true
  }
  return entry
}

/**
 * The runtime wire a custom provider speaks: the codec of the host class its
 * dialect builds (`LlmProviderFactory::CreateCustomProvider` —
 * `OpenAiProvider` on chat/completions or `AnthropicProvider`, both with
 * `requires_api_key=false`, so the key is optional).
 */
export const CUSTOM_PROVIDER_WIRES: Record<CustomApiCompatibility, NonNullable<NexusProviderModelConfig['wire']>> = {
  openai: { format: 'openai-chat', apiKeyOptional: true },
  anthropic: { format: 'anthropic-messages', apiKeyOptional: true },
}

/** The curated `NEXUS_MODEL_CONFIG` entry for one custom provider. */
export function toProviderModelConfig(
  record: CustomProviderRecord,
): NexusProviderModelConfig {
  const complete = record.models.filter(isCustomModelComplete)
  return {
    providerId: record.id,
    // Runs on a runtime ModelProvider, under its OWN id: the host transport
    // takes the base URL and the key from this provider's config.
    wire: CUSTOM_PROVIDER_WIRES[record.apiCompatibility],
    // Curated: only the models the user actually configured are offered, even
    // when the endpoint's /v1/models returns a hundred more.
    filterMode: 'curated',
    models: complete.map(m => toConfiguredModel(m, record.apiCompatibility)),
  }
}

// Module state — the last records published by the settings layer.
let currentRecords: CustomProviderRecord[] = []
let currentConfigs: Record<string, NexusProviderConfig> = {}

// Entries a realm without the mod registry (the webview) made to hold a mod
// provider's catalog figures; kept across rebuilds while nothing else has the id.
const realmMirrorEntries = new WeakSet<NexusProviderModelConfig>()

/** Mark `entry` as a mirror entry, so `setCustomProviderRecords` keeps it in `NEXUS_MODEL_CONFIG`. */
export function markRealmMirrorEntry(entry: NexusProviderModelConfig): void {
  realmMirrorEntries.add(entry)
}

/**
 * Replace the known custom providers and re-apply the `NEXUS_MODEL_CONFIG`
 * overlay. Called by the worker at boot and after every `providers.*` write,
 * and by the shell when it observes `providers.changed`, so BOTH realms
 * resolve custom model metadata identically.
 */
export function setCustomProviderRecords(
  configs: Record<string, NexusProviderConfig> | undefined,
): CustomProviderRecord[] {
  currentConfigs = configs ?? {}
  currentRecords = listCustomProviderRecords(configs ?? {})
  const overlay = currentRecords
    .filter(record => record.models.some(isCustomModelComplete))
    .map(toProviderModelConfig)
  const overridden = new Set(overlay.map(entry => entry.providerId))
  // The enabled provider mods' entries sit between the shipped catalog and
  // the user's custom providers; they are the registry's definitions' own
  // objects (the listing writes its rows into them in place).
  const baseline = BASELINE_PROVIDERS.filter(entry => !overridden.has(entry.providerId))
  const mods = modProviderDefinitions()
    .map(definition => definition.config)
    .filter(entry => !overridden.has(entry.providerId))
  const defined = new Set([...baseline, ...mods, ...overlay].map(entry => entry.providerId))
  const mirrored = NEXUS_MODEL_CONFIG.providers
    .filter(entry => realmMirrorEntries.has(entry) && !defined.has(entry.providerId))
  const next = [...baseline, ...mods, ...mirrored, ...overlay]
  // Mutate in place: `NEXUS_MODEL_CONFIG` is imported by value all over the
  // codebase (including as a default parameter), so replacing the array
  // object would leave stale references behind.
  NEXUS_MODEL_CONFIG.providers.splice(0, NEXUS_MODEL_CONFIG.providers.length, ...next)
  return currentRecords
}

/**
 * Re-apply the overlay with the configs last given: a provider mod was added
 * or removed, so its `NEXUS_MODEL_CONFIG` entry must appear or go.
 */
export function reapplyProviderCatalog(): void {
  setCustomProviderRecords(currentConfigs)
}

/** Test hook: drop every custom provider and restore the shipped catalog. */
export function resetCustomProviderRecords(): void {
  setCustomProviderRecords({})
}

export function listRegisteredCustomProviders(): CustomProviderRecord[] {
  return currentRecords
}

export function getCustomProviderRecord(
  providerId: string | undefined,
): CustomProviderRecord | undefined {
  if (!providerId) return undefined
  return currentRecords.find(record => record.id === providerId)
}

// ── Catalog synthesis ───────────────────────────────────────────────────────

/**
 * Icon-key → built-in provider id whose brand SVG the host catalog already
 * ships. Keys absent here fall back to `GENERIC_PROVIDER_ICON_SVG`.
 */
const ICON_KEY_TO_CATALOG_PROVIDER: Record<string, string> = {
  openai: 'openai',
  anthropic: 'anthropic',
  google: 'google',
  deepseek: 'deepseek',
  qwen: 'qwen',
  ollama: 'ollama',
}

/** Neutral mark for icon keys the host ships no brand art for. */
export const GENERIC_PROVIDER_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" '
  + 'stroke="currentColor" stroke-width="1.75" stroke-linecap="round" '
  + 'stroke-linejoin="round"><path d="M12 2.5 20.5 7v10L12 21.5 3.5 17V7z"/>'
  + '<path d="M3.5 7 12 11.5 20.5 7"/><path d="M12 11.5v10"/></svg>'

export function resolveCustomProviderIconSvg(
  iconKey: string | undefined,
  catalog: BrowserLlmCatalog | null | undefined,
): string {
  const catalogId = ICON_KEY_TO_CATALOG_PROVIDER[iconKey ?? '']
  if (catalogId) {
    const svg = catalog?.providers.find(p => p.id === catalogId)?.iconSvg
    if (svg) return svg
  }
  return GENERIC_PROVIDER_ICON_SVG
}

function toCatalogModel(m: CustomModelDef, apiCompatibility: CustomApiCompatibility): BrowserLlmModel {
  const model: BrowserLlmModel = {
    id: m.modelId,
    label: customModelLabel(m),
    enabled: true,
    supportsStreaming: true,
    supportsTools: m.capabilities?.toolCalling !== false,
  }
  if (typeof m.contextWindow === 'number') model.contextWindow = m.contextWindow
  if (typeof m.maxOutputTokens === 'number') {
    model.maxOutputTokens = m.maxOutputTokens
  }
  const tiers = customThinkingTiers(m, apiCompatibility)
  if (tiers) model.availableThinkingTiers = tiers
  return model
}

/**
 * `BrowserLlmProvider` rows for the configured custom providers. A provider
 * is `enabled` once it has a base URL and at least one complete model — the
 * same bar `canSubmitCustomProvider` enforces in the settings form, so a
 * half-built provider never reaches the quick picker.
 */
export function synthesizeCustomProviderCatalogEntries(
  records: CustomProviderRecord[],
  hostCatalog: BrowserLlmCatalog | null | undefined,
): BrowserLlmProvider[] {
  const out: BrowserLlmProvider[] = []
  for (const record of records) {
    const models = record.models.filter(isCustomModelComplete).map(m => toCatalogModel(m, record.apiCompatibility))
    const provider: BrowserLlmProvider = {
      id: record.id,
      label: record.displayName,
      iconSvg: resolveCustomProviderIconSvg(record.providerIcon, hostCatalog),
      enabled: models.length > 0 && record.baseUrl.trim().length > 0,
      models,
    }
    const defaultModelId = models.some(m => m.id === record.defaultModel)
      ? record.defaultModel
      : models[0]?.id
    if (defaultModelId) provider.defaultModelId = defaultModelId
    out.push(provider)
  }
  return out
}

/**
 * Splice the custom providers into a host catalog. An id that already exists
 * host-side is REPLACED rather than duplicated — a host that lists a
 * `custom-*` provider must not produce two rows for one provider.
 */
export function appendCustomProvidersToCatalog(
  catalog: BrowserLlmCatalog | null | undefined,
  records: CustomProviderRecord[] = currentRecords,
): BrowserLlmCatalog | null | undefined {
  if (!catalog) return catalog
  if (records.length === 0) return catalog
  const synthesized = synthesizeCustomProviderCatalogEntries(records, catalog)
  if (synthesized.length === 0) return catalog
  const replaced = new Set(synthesized.map(p => p.id))
  return {
    ...catalog,
    providers: [
      ...catalog.providers.filter(p => !replaced.has(p.id)),
      ...synthesized,
    ],
  }
}

// ── Request routing ─────────────────────────────────────────────────────────


export type CustomProviderRouting = {
  /** The id to put on the wire: the provider's own. */
  providerId: string
  /**
   * The id `buildThinkingBodyExtension` must key off to emit the right body
   * shape: the dialect's canonical vendor id — `openai` or `anthropic` —
   * since a custom id has no mapping of its own.
   */
  thinkingProviderId: string
}

/**
 * Resolve how an outbound request for `providerId` must be addressed.
 * `undefined` ⇒ not a custom provider; the caller sends the id unchanged.
 */
export function resolveCustomProviderRequest(
  providerId: string | undefined,
): CustomProviderRouting | undefined {
  const record = getCustomProviderRecord(providerId)
  if (!record) return undefined
  return {
    providerId: record.id,
    thinkingProviderId: record.apiCompatibility,
  }
}
