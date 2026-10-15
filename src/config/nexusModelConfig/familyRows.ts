/**
 * FAMILY rows (F-28): one row for every version of a model family. A version reads,
 * first that states it: the row's `versions[<v>]`, the provider's listing, the row.
 * A matching FIXED row answers first. The opt-in flags (`promptProfile`,
 * `todoTools`, `supportsStrictTools`) are never read from a listing.
 */
import type { ModelWire, ProviderModelInfo } from './providerDefinition'
import { deriveCanonicalModelId, escapeRegExp } from './patterns'
import { compareVersionsDesc, type ModelVersionInfo } from './providers/shared/modelVersions'
import { fallbackTier } from './providers/shared/listing'
import { withCatalogFigures } from './catalogFigures'
import type { NexusConfiguredModel, NexusModelConfig } from './types'

/** What a listing states about one model, in catalog-row terms. */
export type ListedModelFigures = Pick<
  NexusConfiguredModel,
  | 'name'
  | 'contextWindow'
  | 'maxOutputTokens'
  | 'availableThinkingTiers'
  | 'defaultThinkingTier'
  | 'supportsImageInput'
> & {
  /** The listing's per-model wire (`ProviderModelInfo.wire`): not a catalog
   *  row field — `resolveProviderSpec` reads it to route the model. */
  wire?: ModelWire
}

const versionOf = (label: string): number[] => label.split('.').map(Number)

/** Whether `row` is a family row that speaks for the model `info` reads as. */
export function familyRowCovers(row: NexusConfiguredModel, info: ModelVersionInfo): boolean {
  if (!row.family || row.family.toLowerCase() !== info.family.toLowerCase()) return false
  if (row.minVersion && compareVersionsDesc(versionOf(row.minVersion), info.version) < 0) return false
  if (row.maxVersion && compareVersionsDesc(versionOf(row.maxVersion), info.version) > 0) return false
  return true
}

/**
 * The first request reserves at most this many output tokens (or the model's
 * cap when lower): a gateway row's cap is often its whole window, and
 * reserving that would leave nothing for the prompt. Truncation recovery
 * escalates to `maxOutputTokens`.
 */
export const FIRST_REQUEST_OUTPUT_RESERVATION = 32_768


/**
 * The row a version of `row`'s family reads (the three layers above). `info`
 * is the model's id as the provider's reader (`parse`) gives it; `listed`
 * what the provider's listing states about that id, once it has been fetched.
 */
export function resolveFamilyRow(
  row: NexusConfiguredModel,
  info: ModelVersionInfo,
  parse: (id: string) => ModelVersionInfo,
  listed?: ListedModelFigures,
): NexusConfiguredModel {
  const { versions, name, ...base } = row
  const override = versions?.[info.versionLabel]
  const out: NexusConfiguredModel = { ...base }

  // The row's `name` is its verified version's ("Fable 5.1"), not the family's.
  const verifiedId = deriveCanonicalModelId(row.model)
  if (name && verifiedId && parse(verifiedId).versionLabel === info.versionLabel) out.name = name

  if (listed) {
    if (listed.name) out.name = listed.name
    if (listed.contextWindow) out.contextWindow = listed.contextWindow
    if (listed.maxOutputTokens) {
      out.maxOutputTokens = listed.maxOutputTokens
      // The first-request reservation never exceeds the listed cap.
      if (out.defaultMaxOutputTokens && out.defaultMaxOutputTokens > listed.maxOutputTokens) {
        out.defaultMaxOutputTokens = listed.maxOutputTokens
      }
    }
    if (listed.availableThinkingTiers) {
      const tiers = [...listed.availableThinkingTiers]
      out.availableThinkingTiers = tiers
      // The default follows the listing's, else stays the row's while the
      // listed tiers still hold it, else the tiers' own fallback.
      const stated = listed.defaultThinkingTier
      const tier = stated && tiers.includes(stated)
        ? stated
        : out.defaultThinkingTier && tiers.includes(out.defaultThinkingTier)
          ? out.defaultThinkingTier
          : fallbackTier(tiers)
      if (tier) out.defaultThinkingTier = tier
      else delete out.defaultThinkingTier
    }
    if (listed.supportsImageInput !== undefined) out.supportsImageInput = listed.supportsImageInput
  }

  if (!override) return out
  // An override that states `undefined` takes the field away: the version
  // does not have what the row has (a tier list, an opt-out). Its `id` is
  // the version's identity, not a figure.
  const { id: _id, ...fields } = override
  const merged: Record<string, unknown> = { ...out, ...fields }
  for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key]
  return merged as NexusConfiguredModel
}

/**
 * A provider's rows as ONE ROW PER KNOWN MODEL (fixed rows as they are; a family
 * row as its verified version then its known versions, newest first), for the
 * consumers that enumerate models. The lookup never uses this.
 */
export function knownModelRows(
  rows: readonly NexusConfiguredModel[],
  parse: (id: string) => ModelVersionInfo,
  /** Given, each row also reads the model catalog's figures for its id
   *  under this provider (./catalogFigures.ts) — what the host is sent. */
  catalogProviderId?: string,
): NexusConfiguredModel[] {
  const out: NexusConfiguredModel[] = []
  const push = (row: NexusConfiguredModel, verifiedId?: string): void => {
    const id = catalogProviderId ? deriveCanonicalModelId(row.model) : undefined
    out.push(id && catalogProviderId ? withCatalogFigures(catalogProviderId, row, id, verifiedId) : row)
  }
  for (const row of rows) {
    if (!row.family) {
      push(row)
      continue
    }
    const verifiedId = deriveCanonicalModelId(row.model)
    const { family: _family, minVersion: _min, maxVersion: _max, versions, ...verified } = row
    push(verified)
    if (!verifiedId) continue
    const known = Object.values(versions ?? {})
      .map(override => override.id)
      .filter((id): id is string => !!id)
      .map(id => ({ id, info: parse(id) }))
      .sort((a, b) => compareVersionsDesc(a.info.version, b.info.version))
    for (const { id, info } of known) {
      const { family: _f, minVersion: _lo, maxVersion: _hi, ...resolved } = resolveFamilyRow(row, info, parse)
      push({
        ...resolved,
        model: typeof row.model === 'string'
          ? id
          : new RegExp(row.model.source.replace(escapeRegExp(verifiedId), escapeRegExp(id)), row.model.flags),
      }, verifiedId)
    }
  }
  return out
}

/**
 * What is wrong with the catalog's family rows, as sentences (empty = nothing),
 * checked by a unit test over the shipped catalog: `model` flattens to one id of the
 * row's family, versions lie in range, one row per family version, tier family keys
 * name a family row.
 */
export function familyRowProblems(
  config: NexusModelConfig,
  parserFor: (providerId: string) => (id: string) => ModelVersionInfo,
): string[] {
  const problems: string[] = []
  for (const provider of config.providers) {
    const parse = parserFor(provider.providerId)
    const seen: NexusConfiguredModel[] = []
    for (const row of provider.models) {
      if (!row.family) continue
      const at = `${provider.providerId} / ${row.family}`
      const verifiedId = deriveCanonicalModelId(row.model)
      if (!verifiedId) {
        problems.push(`${at}: \`model\` does not flatten to one concrete id`)
        continue
      }
      const info = parse(verifiedId)
      if (info.family.toLowerCase() !== row.family.toLowerCase()) {
        problems.push(`${at}: \`model\` ${verifiedId} reads as family ${info.family}`)
        continue
      }
      if (!familyRowCovers(row, info)) {
        problems.push(`${at}: verified version ${info.versionLabel} is outside minVersion..maxVersion`)
      }
      for (const label of Object.keys(row.versions ?? {})) {
        const version = versionOf(label.replace(/-.*$/, ''))
        if (version.some(Number.isNaN) || !familyRowCovers(row, { ...info, version })) {
          problems.push(`${at}: versions['${label}'] is outside minVersion..maxVersion`)
        }
        const id = row.versions![label]!.id
        if (id) {
          const known = parse(id)
          if (known.family.toLowerCase() !== row.family.toLowerCase() || known.versionLabel !== label) {
            problems.push(`${at}: versions['${label}'].id ${id} reads as ${known.family} ${known.versionLabel}`)
          }
        }
      }
      if (seen.some(other => familyRowCovers(other, info))) {
        problems.push(`${at}: an earlier row of the same family already covers ${info.versionLabel}`)
      }
      seen.push(row)
    }
    for (const field of ['fastModel', 'balancedModel', 'bestModel'] as const) {
      const value = provider[field]
      if (!value || !value.includes('*')) continue
      if (!provider.models.some(row => row.family?.toLowerCase() === value.toLowerCase())) {
        problems.push(`${provider.providerId} / ${field}: no family row is ${value}`)
      }
    }
  }
  return problems
}

// ── Listed figures ─────────────────────────────────────────────────────────

const listed = new Map<string, Map<string, ListedModelFigures>>()

/** Replace what `providerId`'s listing states (its whole listing at once). */
export function recordListedFigures(providerId: string, models: readonly ProviderModelInfo[]): void {
  const byId = new Map<string, ListedModelFigures>()
  for (const model of models) {
    const figures = listedFiguresOf(model)
    if (Object.keys(figures).length > 0) byId.set(model.id, figures)
  }
  if (byId.size > 0) listed.set(providerId, byId)
  else listed.delete(providerId)
}

/** What one listed model states, in catalog-row terms. */
export function listedFiguresOf(model: ProviderModelInfo): ListedModelFigures {
  const figures: ListedModelFigures = {}
  if (model.name) figures.name = model.name
  if (model.contextWindow) figures.contextWindow = model.contextWindow
  if (model.maxOutputTokens) figures.maxOutputTokens = model.maxOutputTokens
  if (model.thinkingTiers && model.thinkingTiers.length > 0) {
    figures.availableThinkingTiers = [...model.thinkingTiers]
    if (model.defaultThinkingTier) figures.defaultThinkingTier = model.defaultThinkingTier
  }
  if (model.supportsImageInput !== undefined) figures.supportsImageInput = model.supportsImageInput
  if (model.wire) figures.wire = model.wire
  return figures
}

/**
 * A model no row speaks for, as the FIXED row its listing makes: an exact-id pattern
 * plus what the listing states. The first request reserves at most
 * `FIRST_REQUEST_OUTPUT_RESERVATION`; image input is written only when it is "no".
 */
export function listedModelRow(modelId: string, figures: ListedModelFigures | undefined): NexusConfiguredModel {
  const row: NexusConfiguredModel = { model: new RegExp(`^${escapeRegExp(modelId)}$`) }
  if (!figures) return row
  if (figures.name) row.name = figures.name
  if (figures.contextWindow) row.contextWindow = figures.contextWindow
  if (figures.maxOutputTokens) {
    row.maxOutputTokens = figures.maxOutputTokens
    row.defaultMaxOutputTokens = Math.min(figures.maxOutputTokens, FIRST_REQUEST_OUTPUT_RESERVATION)
  }
  const tiers = figures.availableThinkingTiers
  if (tiers) {
    row.availableThinkingTiers = [...tiers]
    const stated = figures.defaultThinkingTier
    const tier = stated && tiers.includes(stated) ? stated : fallbackTier(tiers)
    if (tier) row.defaultThinkingTier = tier
  }
  if (figures.supportsImageInput === false) row.supportsImageInput = false
  return row
}

export function listedFigures(providerId: string, modelId: string): ListedModelFigures | undefined {
  return listed.get(providerId)?.get(modelId)
}

/** Test hook. */
export function resetListedFigures(): void {
  listed.clear()
}
