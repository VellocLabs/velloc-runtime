// Catalog lookup: the `NexusConfiguredModel` entry for a (provider, model)
// pair. One matcher for every per-model flag read at query time
// (`supportsStrictTools`, `promptProfile`, …) so a new flag never grows a
// parallel pattern-matching routine.

import { NEXUS_MODEL_CONFIG } from '../nexusModelConfig'
import {
  familyRowCovers,
  listedFigures,
  resolveFamilyRow,
  type ListedModelFigures,
} from './familyRows'
import { withCatalogFigures } from './catalogFigures'
import { deriveCanonicalModelId } from './patterns'
import type { ModelVersionInfo } from './providers/shared/modelVersions'
import { versionParser } from './modelEntries'
import { resolveModelId } from './modelEntryResolution'
import type { NexusConfiguredModel, NexusModelConfig, NexusModelPattern } from './types'

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '')
}

export function patternMatches(pattern: NexusModelPattern, modelId: string): boolean {
  if (pattern instanceof RegExp) {
    pattern.lastIndex = 0
    return pattern.test(modelId)
  }
  const normalized = normalize(pattern)
  if (!normalized) return false
  return normalize(modelId).includes(normalized)
}

const excluded = (row: NexusConfiguredModel, modelId: string): boolean =>
  !!row.exclude?.some(pattern => patternMatches(pattern, modelId))

/**
 * Contract: THE lookup for every per-model figure and flag. Per provider: the first
 * FIXED row whose pattern matches (minus `exclude`) wins; else a FAMILY row covering
 * the model's family and version (`resolveFamilyRow`, a fresh object). Beneath
 * either, `withCatalogFigures`. A family row is never matched by its pattern.
 * Without a `providerId` every provider is searched in catalog order.
 */
export function findConfiguredModelIn(
  config: NexusModelConfig,
  providerId: string | undefined,
  rawModelId: string,
): NexusConfiguredModel | undefined {
  // A model entry (`claude-opus-*@latest`) reads the model it resolves to.
  const modelId = resolveModelId(providerId, rawModelId)
  for (const provider of config.providers) {
    if (providerId && provider.providerId !== providerId) continue
    const fixed = provider.models.find(
      row => !row.family && patternMatches(row.model, modelId) && !excluded(row, modelId),
    )
    if (fixed) return withCatalogFigures(provider.providerId, fixed, modelId)
    if (!provider.models.some(row => row.family)) continue
    const parse = versionParser(provider.providerId)
    const info = parse(modelId)
    const familyRow = provider.models.find(row => familyRowCovers(row, info) && !excluded(row, modelId))
    if (familyRow) {
      return withCatalogFigures(
        provider.providerId,
        resolvedFamilyRow(familyRow, modelId, info, parse, listedFigures(provider.providerId, modelId)),
        modelId,
        verifiedIdOf(familyRow),
      )
    }
  }
  return undefined
}

/** A family row's verified version id, derived once per row. */
const verifiedIds = new WeakMap<NexusConfiguredModel, string | undefined>()
function verifiedIdOf(row: NexusConfiguredModel): string | undefined {
  if (!verifiedIds.has(row)) verifiedIds.set(row, deriveCanonicalModelId(row.model))
  return verifiedIds.get(row)
}

/**
 * `resolveFamilyRow` remembered per (family row, model id) while the listing's
 * figures object is the same, so consumers memoising on the row see a stable value.
 */
const familyRowCache = new WeakMap<
  NexusConfiguredModel,
  Map<string, { listed: ListedModelFigures | undefined; row: NexusConfiguredModel }>
>()

function resolvedFamilyRow(
  familyRow: NexusConfiguredModel,
  modelId: string,
  info: ModelVersionInfo,
  parse: (id: string) => ModelVersionInfo,
  listed: ListedModelFigures | undefined,
): NexusConfiguredModel {
  let byId = familyRowCache.get(familyRow)
  if (!byId) {
    byId = new Map()
    familyRowCache.set(familyRow, byId)
  }
  const hit = byId.get(modelId)
  if (hit && hit.listed === listed) return hit.row
  const row = resolveFamilyRow(familyRow, info, parse, listed)
  byId.set(modelId, { listed, row })
  return row
}

/**
 * The catalog entry for `modelId` under `providerId`, or undefined when
 * either is absent, the provider is not in the catalog, or no row speaks for
 * the model. Both arguments are required: a model id is only meaningful per
 * provider (an OpenAI-compat shim may host a `claude-*` alias whose flags
 * must not leak from the Anthropic table).
 */
export function findConfiguredModel(
  providerId: string | undefined,
  rawModelId: string | undefined,
): NexusConfiguredModel | undefined {
  if (!rawModelId || !providerId) return undefined
  return findConfiguredModelIn(NEXUS_MODEL_CONFIG, providerId, rawModelId)
}
