/**
 * The product's own marketplace (F-14): registered on every profile beside
 * the official catalogs, served from its own origin as a plain tarball, and
 * never removable. Its listings may carry `onByDefault` and `betaOnly`,
 * which only the built-in seeder (`builtinMarketplaceSeed.ts`) and the
 * channel filter act on.
 */

import type { CatalogRecord, PluginOrigin } from './registryFormats'
import { getMarketplaceContentDir, type PluginInstallPathContext } from './pluginDirs'

/** Key of the built-in marketplace in known_marketplaces.json. */
export const BUILTIN_MARKETPLACE_KEY = 'velloc'

/**
 * Where the built-in marketplace is published (the marketplace repository's
 * deploy). While it serves nothing, a fetch fails and is retried
 * at the next boot.
 */
export const BUILTIN_MARKETPLACE_ORIGIN_URL = 'https://plugins.velloc.app'

/** File names the origin serves at its root. */
export const BUILTIN_MARKETPLACE_TARBALL_FILE = 'marketplace.tar.gz'
export const BUILTIN_MARKETPLACE_INDEX_FILE = 'index.json'

export const BUILTIN_MARKETPLACE_SOURCE = {
  source: 'url',
  url: `${BUILTIN_MARKETPLACE_ORIGIN_URL}/${BUILTIN_MARKETPLACE_TARBALL_FILE}`,
} as const satisfies PluginOrigin

/**
 * settings.json `features` key: `false` switches the whole built-in job off
 * (first-launch install, boot reconcile and the daily check). Absent = on.
 */
export const BUILTIN_MARKETPLACE_AUTO_INSTALL_FLAG = 'builtinMarketplace.autoInstall'

export function isBuiltinMarketplace(name?: string): boolean {
  return typeof name === 'string' && name.toLowerCase() === BUILTIN_MARKETPLACE_KEY
}

/**
 * The `index.json` URL that goes with a tarball URL: the same directory. The
 * registry entry's tarball URL is authoritative, so a repointed entry (a test
 * server, a mirror) moves both files together.
 */
export function builtinMarketplaceIndexUrl(source: PluginOrigin): string | null {
  if (source.source !== 'url') return null
  const slash = source.url.lastIndexOf('/')
  if (slash < 0) return null
  return `${source.url.slice(0, slash + 1)}${BUILTIN_MARKETPLACE_INDEX_FILE}`
}

/**
 * Security: null when `name` may be registered from `source`; otherwise why
 * not. The built-in name is bound to the product's origin — a marketplace.json
 * from elsewhere cannot claim it and be shown as built in.
 */
export function builtinNameSourceProblem(name: string, source: PluginOrigin): string | null {
  if (!isBuiltinMarketplace(name)) return null
  if (source.source === 'url' && source.url === BUILTIN_MARKETPLACE_SOURCE.url) return null
  return `'${BUILTIN_MARKETPLACE_KEY}' is the built-in marketplace; it cannot be added from another source.`
}

/** Registry entry for the built-in marketplace, stamped with `nowIso`. */
export function buildInitialBuiltinEntries(
  ctx: PluginInstallPathContext,
  nowIso: string,
): Record<string, CatalogRecord> {
  return {
    [BUILTIN_MARKETPLACE_KEY]: {
      source: BUILTIN_MARKETPLACE_SOURCE,
      installLocation: getMarketplaceContentDir(ctx, BUILTIN_MARKETPLACE_KEY),
      lastUpdated: nowIso,
    },
  }
}
