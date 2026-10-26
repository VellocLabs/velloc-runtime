/**
 * Adding a marketplace from a parsed source: it is registered under a name
 * derived from the source, fetched, and filed under the name its
 * marketplace.json declares. Shared by the marketplace command and
 * the `plugins.addMarketplace` handler.
 */
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import { addMarketplace, fetchCatalog, removeMarketplace } from './marketplaces'
import { marketplaceNameProblem, reservedNameSourceProblem } from './marketplaceNaming'
import type { PluginInstallPathContext } from './pluginDirs'
import type { MarketplaceSourceInput } from './marketplaceSource'

export { githubRepoOf, parseMarketplaceSource, type MarketplaceSourceInput } from './marketplaceSource'

/**
 * Placeholder registry key (the repo basename) until the fetched
 * marketplace.json supplies the canonical name. A basename that a reserved
 * name guard would refuse for this source is prefixed with its owner, so the
 * transient key is unique and allowed; the canonical name takes over after
 * the fetch.
 */
export function placeholderMarketplaceName(source: MarketplaceSourceInput): string {
  let owner = ''
  let base: string
  if (source.source === 'github') {
    const slash = source.repo.lastIndexOf('/')
    owner = slash >= 0 ? source.repo.slice(0, slash) : ''
    base = slash >= 0 ? source.repo.slice(slash + 1) : source.repo
  } else {
    const match = source.url.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/)
    owner = match?.[1] ?? ''
    base = match?.[2] ?? 'unknown-marketplace'
  }
  if (owner && reservedNameSourceProblem(base, source) !== null) {
    const prefixed = `${owner}-${base}`
    return marketplaceNameProblem(prefixed) === null ? prefixed : `${owner}-marketplace`
  }
  return base
}

/** Where a failed add stopped: registering, fetching (nothing is left registered), or the final rename. */
export type RegisterMarketplaceOutcome =
  | { ok: true; name: string; pluginCount: number }
  | { ok: false; stage: 'register' | 'fetch' | 'rename'; name: string; error: unknown }

/** Registers `source`, fetches it, and files it under the name its marketplace.json declares. */
export async function registerMarketplaceSource(
  pathCtx: PluginInstallPathContext,
  fs: RuntimeFs,
  source: MarketplaceSourceInput,
  nowIso: string,
  fetchImpl: typeof fetch,
): Promise<RegisterMarketplaceOutcome> {
  const placeholder = placeholderMarketplaceName(source)
  try {
    await addMarketplace(pathCtx, fs, placeholder, source, nowIso)
  } catch (error) {
    return { ok: false, stage: 'register', name: placeholder, error }
  }
  let manifest
  try {
    manifest = (await fetchCatalog(pathCtx, fs, placeholder, nowIso, fetchImpl)).marketplace
  } catch (error) {
    try {
      await removeMarketplace(pathCtx, fs, placeholder, nowIso)
    } catch {
      /* best-effort cleanup */
    }
    return { ok: false, stage: 'fetch', name: placeholder, error }
  }
  if (manifest.name !== placeholder) {
    try {
      await addMarketplace(pathCtx, fs, manifest.name, source, nowIso)
      await removeMarketplace(pathCtx, fs, placeholder, nowIso)
      await fetchCatalog(pathCtx, fs, manifest.name, nowIso, fetchImpl)
    } catch (error) {
      return { ok: false, stage: 'rename', name: manifest.name, error }
    }
  }
  return { ok: true, name: manifest.name, pluginCount: manifest.plugins.length }
}
