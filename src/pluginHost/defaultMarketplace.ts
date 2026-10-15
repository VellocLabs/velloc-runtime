// The marketplaces a fresh install registers without being asked.

import type {
  CatalogRecord,
  PluginOrigin,
} from './registryFormats'
import { getMarketplaceContentDir } from './pluginDirs'
import type { PluginInstallPathContext } from './pluginDirs'

export const CURATED_CATALOG_ORIGIN = {
  source: 'github',
  repo: 'anthropics/claude-plugins-official',
} as const satisfies PluginOrigin

/** Key of the curated catalog in known_marketplaces.json. */
export const CURATED_CATALOG_KEY = 'claude-plugins-official'

/** Key of the community catalog in known_marketplaces.json. */
export const COMMUNITY_MARKETPLACE_NAME = 'claude-plugins-community'

const OFFICIAL_MARKETPLACES: ReadonlyArray<{
  name: string
  source: PluginOrigin
  description: string
}> = [
  {
    name: CURATED_CATALOG_KEY,
    source: CURATED_CATALOG_ORIGIN,
    description:
      "Anthropic's curated marketplace — vetted plugins from major vendors and community classics, with pinned SHAs",
  },
  {
    name: COMMUNITY_MARKETPLACE_NAME,
    source: {
      source: 'github',
      repo: 'anthropics/claude-plugins-community',
    },
    description:
      'Anthropic-mirrored community submissions (lower bar than the curated official marketplace)',
  },
] as const

const OFFICIAL_NAME_TO_SOURCE: ReadonlyMap<string, PluginOrigin> = new Map(
  OFFICIAL_MARKETPLACES.map(m => [m.name, m.source] as const),
)

/** Fixed source of a default marketplace; undefined for any other name. */
export function getOfficialMarketplaceSource(
  name: string,
): PluginOrigin | undefined {
  return OFFICIAL_NAME_TO_SOURCE.get(name)
}

export function listOfficialMarketplaces(): ReadonlyArray<{
  name: string
  source: PluginOrigin
  description: string
}> {
  return OFFICIAL_MARKETPLACES
}

/** Registry entries for every default marketplace, stamped with `nowIso`. */
export function buildInitialOfficialEntries(
  ctx: PluginInstallPathContext,
  nowIso: string,
): Record<string, CatalogRecord> {
  const out: Record<string, CatalogRecord> = {}
  for (const m of OFFICIAL_MARKETPLACES) {
    out[m.name] = {
      source: m.source,
      installLocation: getMarketplaceContentDir(ctx, m.name),
      lastUpdated: nowIso,
    }
  }
  return out
}
