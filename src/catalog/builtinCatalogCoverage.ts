/**
 * The bundle snapshot must cover every built-in row that leaves its context
 * window or output cap to the catalog (F-28). `catalogCoverageProblems` lists
 * uncovered rows; the snapshot generator fails the publish on any.
 */
import { NEXUS_MODEL_CONFIG } from '../config/nexusModelConfig'
import {
  findCatalogFigures,
  figureLayerOf,
  type CatalogFigureLayer,
  type CatalogModelFigures,
} from '../config/nexusModelConfig/catalogFigures'
import { knownModelRows } from '../config/nexusModelConfig/familyRows'
import { versionParser } from '../config/nexusModelConfig/modelEntries'
import { deriveCanonicalModelId } from '../config/nexusModelConfig/patterns'
import type { NexusConfiguredModel, NexusModelConfig } from '../config/nexusModelConfig/types'
import { providerRelPath } from './catalogReader'
import type { CatalogProviderRecords } from './types'

/** The figures a row may leave to the catalog and the guarantee covers. */
export const GUARANTEED_FIELDS = ['contextWindow', 'maxOutputTokens'] as const

export type CatalogUnit = {
  providerId: string
  keys: string[]
  /** The row as the unit reads it from config alone (no catalog). */
  row: NexusConfiguredModel
  /** Its concrete id, absent for a regex-only row. */
  modelId?: string
  /** For a version a family row names: the family's verified version id. */
  verifiedId?: string
}

/** Every unit of every provider whose config names catalog keys. */
export function catalogUnits(config: NexusModelConfig = NEXUS_MODEL_CONFIG): CatalogUnit[] {
  const units: CatalogUnit[] = []
  for (const provider of config.providers) {
    const keys = provider.catalog?.keys ?? []
    if (keys.length === 0) continue
    // A named version's id -> its family's verified version id.
    const verifiedOf = new Map<string, string>()
    for (const row of provider.models) {
      if (!row.family) continue
      const verifiedId = deriveCanonicalModelId(row.model)
      if (!verifiedId) continue
      for (const version of Object.values(row.versions ?? {})) {
        if (version.id && version.id !== verifiedId) verifiedOf.set(version.id, verifiedId)
      }
    }
    for (const row of knownModelRows(provider.models, versionParser(provider.providerId))) {
      const modelId = deriveCanonicalModelId(row.model)
      const verifiedId = modelId ? verifiedOf.get(modelId) : undefined
      units.push({
        providerId: provider.providerId,
        keys: [...keys],
        row,
        ...(modelId ? { modelId } : {}),
        ...(verifiedId ? { verifiedId } : {}),
      })
    }
  }
  return units
}

/** Reads one provider key's records (undefined when the source lacks it). */
export type RecordsOf = (key: string) => CatalogProviderRecords | undefined

/**
 * What the catalog states for a unit: by id, or for a regex-only row every
 * record of its keys the pattern matches (first key holding an id wins).
 */
export function unitFigures(unit: CatalogUnit, recordsOf: RecordsOf): Map<string, CatalogModelFigures> {
  const layers: CatalogFigureLayer[] = unit.keys.map(key => figureLayerOf(recordsOf(key)))
  const out = new Map<string, CatalogModelFigures>()
  if (unit.modelId) {
    const hit = findCatalogFigures(layers, unit.modelId)
    if (hit) {
      out.set(unit.modelId, hit)
    } else if (unit.verifiedId) {
      const verified = findCatalogFigures(layers, unit.verifiedId)
      if (verified) out.set(unit.verifiedId, verified)
    }
    return out
  }
  const pattern = unit.row.model
  for (const layer of layers) {
    for (const [id, figures] of layer) {
      if (out.has(id)) continue
      if (pattern instanceof RegExp) {
        pattern.lastIndex = 0
        if (!pattern.test(id)) continue
      } else if (id !== pattern) continue
      out.set(id, figures)
    }
  }
  return out
}

/** Built-in rows that leave a guaranteed figure to the catalog and find none in `recordsOf`. */
export function catalogCoverageProblems(
  recordsOf: RecordsOf,
  config: NexusModelConfig = NEXUS_MODEL_CONFIG,
): string[] {
  const problems: string[] = []
  for (const unit of catalogUnits(config)) {
    const missing = GUARANTEED_FIELDS.filter(field => unit.row[field] === undefined)
    if (missing.length === 0) continue
    const found = [...unitFigures(unit, recordsOf).values()]
    const name = unit.modelId ?? String(unit.row.model)
    for (const field of missing) {
      if (!found.some(figures => figures[field] !== undefined)) {
        problems.push(
          `${unit.providerId} / ${name}: the row leaves ${field} to the catalog, but no record under ${unit.keys.join(', ')} states it`,
        )
      }
    }
  }
  return problems
}

/** The same check over generated snapshot files (`buildSnapshotFiles`). */
export function snapshotCoverageProblems(
  files: Record<string, string>,
  config: NexusModelConfig = NEXUS_MODEL_CONFIG,
): string[] {
  const cache = new Map<string, CatalogProviderRecords | undefined>()
  return catalogCoverageProblems(key => {
    if (!cache.has(key)) {
      const text = files[providerRelPath(key)]
      cache.set(key, text ? (JSON.parse(text) as CatalogProviderRecords) : undefined)
    }
    return cache.get(key)
  }, config)
}
