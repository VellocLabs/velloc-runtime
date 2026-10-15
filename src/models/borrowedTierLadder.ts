/**
 * A tier ladder BORROWED for a provider that declares none (a gateway, a custom
 * endpoint): the first-party table owning the session model's family names the tier
 * target, looked up under the SAME provider and the SAME vendor prefix, never a
 * variant. Security: never another provider or prefix, so the provider's trust
 * standing stays the session's. Nothing found = `undefined` (F-28).
 */
import { familyRowCovers } from '../config/nexusModelConfig/familyRows'
import {
  groupFamilies,
  LATEST,
  parseEntryId,
  resolveEntry,
  versionParser,
} from '../config/nexusModelConfig/modelEntries'
import { resolveModelId } from '../config/nexusModelConfig/modelEntryResolution'
import { deriveCanonicalModelId } from '../config/nexusModelConfig/patterns'
import { providerModelPool } from '../config/nexusModelConfig/providerModelPool'
import type {
  NexusConfiguredModel,
  NexusModelConfig,
  NexusProviderModelConfig,
} from '../config/nexusModelConfig/types'

export type LadderTier = 'fast' | 'balanced' | 'best'

const TIER_FIELD = { fast: 'fastModel', balanced: 'balancedModel', best: 'bestModel' } as const

/** A gateway id's vendor prefix (`anthropic/`), '' for a bare id. */
const prefixOf = (id: string): string => id.slice(0, id.lastIndexOf('/') + 1)

/** What a first-party tier field asks for: a family, and which version of it. */
type TierTarget = {
  /** The bare family key, as the owner's table writes it. */
  family: string
  /** `latest`, or the version label a fixed id names ('' never: a family of
   *  one is its own latest). */
  version: string
  /** The owner's family row, whose range bounds what `latest` may take. */
  row?: NexusConfiguredModel
}

function tierTarget(owner: NexusProviderModelConfig, tier: LadderTier): TierTarget | undefined {
  const field = owner[TIER_FIELD[tier]]
  if (!field) return undefined
  const row = owner.models.find(r => r.family && r.family.toLowerCase() === field.toLowerCase())
  if (row) return { family: row.family!, version: LATEST, row }
  if (field.includes('*')) return undefined // a family key no row declares
  const info = versionParser(owner.providerId)(field)
  return { family: info.family, version: info.versionLabel || LATEST }
}

/** Whether `owner`'s table has a row of `bareFamily` (lower-cased). */
function ownsFamily(owner: NexusProviderModelConfig, bareFamily: string): boolean {
  const parse = versionParser(owner.providerId)
  return owner.models.some(row => {
    if (row.family) return row.family.toLowerCase() === bareFamily
    const id = deriveCanonicalModelId(row.model)
    return !!id && parse(id).family.toLowerCase() === bareFamily
  })
}

/**
 * The model `tier` means for a session on (`providerId`, `sessionModelId`)
 * when the provider declares no ladder of its own, or undefined (see the
 * header). The caller has already ruled out a user pin and the provider's
 * own ladder field.
 */
export function borrowTierModel(
  providerId: string,
  sessionModelId: string,
  tier: LadderTier,
  config: NexusModelConfig,
): string | undefined {
  const pool = providerModelPool(providerId)
  if (pool.length === 0) return undefined
  const parse = versionParser(providerId)

  // 1. The session model's prefix and bare family. An entry id that has not
  //    resolved yet still names its family.
  const concrete = resolveModelId(providerId, sessionModelId)
  const family = parseEntryId(concrete)?.family ?? parse(concrete).family
  const prefix = prefixOf(family)
  const bareFamily = family.slice(prefix.length).toLowerCase()
  if (!bareFamily) return undefined

  for (const owner of config.providers) {
    // 2. A first-party table that speaks for the family and has this tier.
    if (owner.providerId === providerId || !ownsFamily(owner, bareFamily)) continue
    const target = tierTarget(owner, tier)
    if (!target) continue

    // 3 + 4. The target family under the same prefix, among what this
    //        provider can run — within the owner row's version range.
    const wanted = target.family.toLowerCase()
    const siblings = pool.filter(id => {
      if (prefixOf(id) !== prefix) return false
      const info = parse(id)
      if (info.family.slice(prefix.length).toLowerCase() !== wanted) return false
      return !target.row || familyRowCovers(target.row, { ...info, family: target.row.family! })
    })
    if (siblings.length === 0) continue
    const families = groupFamilies(siblings.map(id => ({ id })), parse)
    for (const listed of families.values()) {
      const resolved = resolveEntry({ family: listed.family, version: target.version }, families, parse)
      if (resolved) return resolved.id
    }
  }
  return undefined
}
