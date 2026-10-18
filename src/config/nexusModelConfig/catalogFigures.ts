/**
 * Catalog figures, the lowest layer a model row reads (F-28): a row's unset
 * `contextWindow`, `maxOutputTokens` and `supportsImageInput` come from the model
 * catalog's record (or, for an unlisted family version, the verified version's),
 * else each consumer's default. A provider that opts in (`catalog.thinkingTiers`)
 * also takes a row's unset `availableThinkingTiers` and their default. Never a
 * name. Filled per realm; lookups are synchronous and merged rows are remembered.
 */
import { normalizeModelId, preferSibling } from '../../catalog/catalogMatch'
import type { CatalogModel, CatalogProviderRecords } from '../../catalog/types'
import { fallbackTier, orderedTiers } from './providers/shared/listing'
import type { NexusConfiguredModel, NexusModelConfig, NexusProviderModelConfig } from './types'

/** What the catalog states about one model, in row terms. */
export type CatalogModelFigures = Pick<
  NexusConfiguredModel,
  'contextWindow' | 'maxOutputTokens' | 'supportsImageInput' | 'availableThinkingTiers' | 'defaultThinkingTier'
>

/** Whether, and with which default, a provider takes the record's effort list. */
export type CatalogTierRule = { defaultThinkingTier?: string }

/** One catalog provider key's figures: model id -> figures. */
export type CatalogFigureLayer = ReadonlyMap<string, CatalogModelFigures>

const FIELDS = [
  'contextWindow',
  'maxOutputTokens',
  'supportsImageInput',
  'availableThinkingTiers',
  'defaultThinkingTier',
] as const

/** The figures filled one by one; the tier pair is filled as one. */
const SIZE_FIELDS = ['contextWindow', 'maxOutputTokens', 'supportsImageInput'] as const

/** The tier rule a provider config opts into, or undefined. */
export function catalogTierRuleOf(provider: NexusProviderModelConfig | undefined): CatalogTierRule | undefined {
  const catalog = provider?.catalog
  if (!catalog?.thinkingTiers) return undefined
  return catalog.defaultThinkingTier ? { defaultThinkingTier: catalog.defaultThinkingTier } : {}
}

function defaultTierOf(tiers: readonly string[], rule: CatalogTierRule): string | undefined {
  if (rule.defaultThinkingTier && tiers.includes(rule.defaultThinkingTier)) return rule.defaultThinkingTier
  return fallbackTier(tiers)
}

/** A catalog record's figures (empty when it states none). Effort tiers only under `tierRule`. */
export function catalogFiguresOfRecord(model: CatalogModel, tierRule?: CatalogTierRule): CatalogModelFigures {
  const figures: CatalogModelFigures = {}
  if (typeof model.contextWindow === 'number' && model.contextWindow > 0) {
    figures.contextWindow = model.contextWindow
  }
  if (typeof model.maxOutput === 'number' && model.maxOutput > 0) {
    figures.maxOutputTokens = model.maxOutput
  }
  if (Array.isArray(model.inputModalities) && model.inputModalities.length > 0) {
    figures.supportsImageInput = model.inputModalities.includes('image')
  }
  if (tierRule && model.reasoningEfforts) {
    const tiers = orderedTiers(model.reasoningEfforts)
    if (tiers.length > 0) {
      figures.availableThinkingTiers = tiers
      const tier = defaultTierOf(tiers, tierRule)
      if (tier) figures.defaultThinkingTier = tier
    }
  }
  return figures
}

/** One provider key's records as a figure layer (records stating nothing are left out). */
export function figureLayerOf(
  records: CatalogProviderRecords | undefined,
  tierRule?: CatalogTierRule,
): Map<string, CatalogModelFigures> {
  const layer = new Map<string, CatalogModelFigures>()
  if (!records) return layer
  for (const [id, model] of Object.entries(records)) {
    const figures = catalogFiguresOfRecord(model, tierRule)
    if (Object.keys(figures).length > 0) layer.set(id, figures)
  }
  return layer
}

/** The catalog keys a provider's config names, empty when it takes nothing. */
export function catalogKeysOf(config: NexusModelConfig, providerId: string): string[] {
  return [...(config.providers.find(p => p.providerId === providerId)?.catalog?.keys ?? [])]
}

/**
 * Compare-forms of a model id, most specific first: the catalog's own
 * normalization, and the same without a trailing `-YYYY-MM-DD` snapshot date
 * (the catalog strips only the `-YYYYMMDD` form).
 */
function compareForms(modelId: string): string[] {
  const forms = [normalizeModelId(modelId)]
  const undated = modelId.trim().replace(/-\d{4}-\d{2}-\d{2}$/, '')
  if (undated !== modelId.trim()) forms.push(normalizeModelId(undated))
  return forms.filter(form => form.length > 0)
}

type IndexedLayer = {
  exact: CatalogFigureLayer
  normalized: Map<string, CatalogModelFigures>
}

function indexLayer(layer: CatalogFigureLayer): IndexedLayer {
  // Same-normalized siblings resolve by the catalog's own pick (F-28), so the
  // answer does not depend on the order of the document's records.
  const best = new Map<string, string>()
  for (const id of layer.keys()) {
    const form = normalizeModelId(id)
    if (form.length === 0) continue
    const held = best.get(form)
    if (held === undefined || preferSibling(id, held) < 0) best.set(form, id)
  }
  const normalized = new Map<string, CatalogModelFigures>()
  for (const [form, id] of best) normalized.set(form, layer.get(id)!)
  return { exact: layer, normalized }
}

function findIn(layers: readonly IndexedLayer[], modelId: string): CatalogModelFigures | undefined {
  // Key order first: a key that holds the model answers for it, by exact id
  // and then by normalized id, before the next key is looked at.
  for (const layer of layers) {
    const exact = layer.exact.get(modelId)
    if (exact) return exact
    for (const form of compareForms(modelId)) {
      const hit = layer.normalized.get(form)
      if (hit) return hit
    }
  }
  return undefined
}

/**
 * What `layers` (one per catalog key, in key order) state for `modelId`, by
 * the same rule the registry reads with. Pure: the snapshot coverage check
 * and the fixture generator use it on a snapshot's records.
 */
export function findCatalogFigures(
  layers: readonly CatalogFigureLayer[],
  modelId: string,
): CatalogModelFigures | undefined {
  return findIn(layers.map(indexLayer), modelId)
}

// ── Registry ───────────────────────────────────────────────────────────────

const fromCatalog = new Map<string, IndexedLayer[]>()
const published = new Map<string, IndexedLayer[]>()
/** Providers whose catalog figures were read at least once (even if empty). */
const catalogRead = new Set<string>()

/**
 * Replace what the catalog states for `providerId`: one layer per catalog
 * key, in the provider's key order. `undefined` clears it.
 */
export function setCatalogFigures(providerId: string, layers: readonly CatalogFigureLayer[] | undefined): void {
  catalogRead.add(providerId)
  const kept = (layers ?? []).filter(layer => layer.size > 0)
  if (kept.length > 0) fromCatalog.set(providerId, kept.map(indexLayer))
  else fromCatalog.delete(providerId)
}

/** Whether the catalog has been read for `providerId` in this realm. */
export function catalogFiguresRead(providerId: string): boolean {
  return catalogRead.has(providerId)
}

/**
 * A page realm's copy: the figures of the rows the runtime published for
 * `providerId` (concrete model id -> figures). Consulted after the catalog's
 * own figures, so it only answers where this realm never read the catalog.
 * A figure object equal to the one already held is kept, so a republish that
 * changes nothing keeps every merged row's identity.
 */
export function recordPublishedFigures(providerId: string, figures: ReadonlyMap<string, CatalogModelFigures>): void {
  const previous = published.get(providerId)?.[0]?.exact
  const next = new Map<string, CatalogModelFigures>()
  for (const [id, value] of figures) {
    const before = previous?.get(id)
    next.set(id, before && sameFigures(before, value) ? before : value)
  }
  if (next.size > 0) published.set(providerId, [indexLayer(next)])
  else published.delete(providerId)
}

/** What the catalog (else the published rows) states for one model. */
export function catalogFiguresFor(providerId: string, modelId: string): CatalogModelFigures | undefined {
  const catalogLayers = fromCatalog.get(providerId)
  const fromCat = catalogLayers ? findIn(catalogLayers, modelId) : undefined
  const publishedLayers = published.get(providerId)
  const fromPub = publishedLayers ? findIn(publishedLayers, modelId) : undefined
  if (!fromCat) return fromPub
  if (!fromPub) return fromCat
  // Both: the catalog's field first, the published one for what it lacks.
  if (FIELDS.every(field => fromCat[field] !== undefined || fromPub[field] === undefined)) return fromCat
  return combined(fromCat, fromPub)
}

const combinedCache = new WeakMap<CatalogModelFigures, WeakMap<CatalogModelFigures, CatalogModelFigures>>()
function combined(first: CatalogModelFigures, second: CatalogModelFigures): CatalogModelFigures {
  let inner = combinedCache.get(first)
  if (!inner) combinedCache.set(first, (inner = new WeakMap()))
  const hit = inner.get(second)
  if (hit) return hit
  const out: CatalogModelFigures = { ...first }
  for (const field of SIZE_FIELDS) {
    if (out[field] === undefined && second[field] !== undefined) {
      ;(out as Record<string, unknown>)[field] = second[field]
    }
  }
  if (out.availableThinkingTiers === undefined && second.availableThinkingTiers !== undefined) {
    out.availableThinkingTiers = second.availableThinkingTiers
    if (second.defaultThinkingTier !== undefined) out.defaultThinkingTier = second.defaultThinkingTier
    else delete out.defaultThinkingTier
  }
  inner.set(second, out)
  return out
}

/** Field-by-field equality; the tier list compares by its entries. */
export function sameFigures(a: CatalogModelFigures, b: CatalogModelFigures): boolean {
  return FIELDS.every(field => {
    const x = a[field]
    const y = b[field]
    if (Array.isArray(x) && Array.isArray(y)) return x.length === y.length && x.every((v, i) => v === y[i])
    return x === y
  })
}

/** Test hook. */
export function resetCatalogFigures(): void {
  fromCatalog.clear()
  published.clear()
  catalogRead.clear()
}

// ── The lowest layer ───────────────────────────────────────────────────────

const mergedCache = new WeakMap<
  NexusConfiguredModel,
  Map<string, { figures: CatalogModelFigures; row: NexusConfiguredModel }>
>()

/**
 * `row` with the catalog's figures beneath its three unset fields; `row` itself when
 * nothing is filled. `verifiedModelId` answers for a family version the catalog does
 * not list. A filled output cap also lowers a higher `defaultMaxOutputTokens`.
 */
export function withCatalogFigures(
  providerId: string,
  row: NexusConfiguredModel,
  modelId: string,
  verifiedModelId?: string,
): NexusConfiguredModel {
  const figures =
    catalogFiguresFor(providerId, modelId) ??
    (verifiedModelId && verifiedModelId !== modelId ? catalogFiguresFor(providerId, verifiedModelId) : undefined)
  if (!figures) return row
  const fillsTiers = row.availableThinkingTiers === undefined && figures.availableThinkingTiers !== undefined
  if (!fillsTiers && !SIZE_FIELDS.some(field => row[field] === undefined && figures[field] !== undefined)) return row
  let byId = mergedCache.get(row)
  if (!byId) mergedCache.set(row, (byId = new Map()))
  const hit = byId.get(modelId)
  if (hit && hit.figures === figures) return hit.row
  const out: NexusConfiguredModel = { ...row }
  if (out.contextWindow === undefined && figures.contextWindow !== undefined) {
    out.contextWindow = figures.contextWindow
  }
  if (out.maxOutputTokens === undefined && figures.maxOutputTokens !== undefined) {
    out.maxOutputTokens = figures.maxOutputTokens
    if (out.defaultMaxOutputTokens !== undefined && out.defaultMaxOutputTokens > figures.maxOutputTokens) {
      out.defaultMaxOutputTokens = figures.maxOutputTokens
    }
  }
  if (out.supportsImageInput === undefined && figures.supportsImageInput !== undefined) {
    out.supportsImageInput = figures.supportsImageInput
  }
  // The tiers and their default travel together: a row that states its own
  // tiers keeps its own default too.
  if (fillsTiers) {
    out.availableThinkingTiers = [...figures.availableThinkingTiers!]
    if (figures.defaultThinkingTier !== undefined) out.defaultThinkingTier = figures.defaultThinkingTier
    else delete out.defaultThinkingTier
  }
  byId.set(modelId, { figures, row: out })
  return out
}
