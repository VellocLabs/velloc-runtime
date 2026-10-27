/**
 * Adding a marketplace from a parsed source: it is registered under a
 * staging key, fetched, and filed under the name its marketplace.json
 * declares. Shared by the marketplace command and
 * the `plugins.addMarketplace` handler.
 */
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import { builtinNameSourceProblem } from './builtinMarketplace'
import { addMarketplace, fetchCatalog, loadKnownMarketplaces, removeMarketplace } from './marketplaces'
import { marketplaceNameProblem, reservedNameSourceProblem } from './marketplaceNaming'
import { getMarketplaceContentDir, type PluginInstallPathContext } from './pluginDirs'
import { githubRepoOf, type MarketplaceSourceInput } from './marketplaceSource'
import type { PluginOrigin } from './registryFormats'

export { githubRepoOf, parseMarketplaceSource, type MarketplaceSourceInput } from './marketplaceSource'

/** The repository's basename: the name an add that fails before its marketplace.json is read is reported under. */
export function placeholderMarketplaceName(source: MarketplaceSourceInput): string {
  if (source.source === 'github') return source.repo.slice(source.repo.lastIndexOf('/') + 1)
  return source.url.match(/github\.com\/[^/]+\/([^/]+?)(?:\.git)?\/?$/)?.[1] ?? 'unknown-marketplace'
}

/**
 * Where a failed add stopped. `register` / `rename`: a registry write failed;
 * `fetch`: the source could not be read as a marketplace; `nameTaken`: the
 * declared name is already registered from another source; `nameRefused`: the
 * declared name may not be registered from this source. A failed add leaves
 * no registration it created and never changes one another source holds.
 */
export type RegisterMarketplaceOutcome =
  | { ok: true; name: string; pluginCount: number }
  | {
    ok: false
    stage: 'register' | 'fetch' | 'rename' | 'nameTaken' | 'nameRefused'
    name: string
    error: unknown
  }

/** True when `known` and `source` name the same repository. */
function sameMarketplaceSource(known: PluginOrigin, source: MarketplaceSourceInput): boolean {
  if (known.source !== 'github' && known.source !== 'url') return false
  const knownRepo = githubRepoOf(known)
  if (knownRepo !== null) return knownRepo === githubRepoOf(source)
  return known.source === 'url' && source.source === 'url' && known.url === source.url
}

/**
 * A registry key no registration holds, used while the source is fetched
 * for the first time.
 *
 * Security: staging under a fresh key keeps the first fetch from overwriting
 * another marketplace's registration or downloaded content.
 */
async function freshStagingKey(pathCtx: PluginInstallPathContext, fs: RuntimeFs, nowIso: string): Promise<string> {
  const { registry } = await loadKnownMarketplaces(pathCtx, fs, nowIso)
  for (;;) {
    const key = `adding-marketplace-${Math.random().toString(36).slice(2, 10)}`
    if (!(key in registry)) return key
  }
}

/** Unregisters the staging key and deletes its downloaded content; best-effort. */
async function dropStaging(pathCtx: PluginInstallPathContext, fs: RuntimeFs, key: string, nowIso: string): Promise<void> {
  try {
    await removeMarketplace(pathCtx, fs, key, nowIso)
  } catch {
    /* best-effort cleanup */
  }
  try {
    await fs.rm(getMarketplaceContentDir(pathCtx, key), { recursive: true, force: true })
  } catch {
    /* best-effort cleanup */
  }
}

/**
 * Registers `source`, fetches it, and files it under the name its
 * marketplace.json declares; re-adding a repository refreshes it.
 * Security: a declared name registered from another repository is refused,
 * so a marketplace.json cannot take over another marketplace's name, its
 * plugins' updates or its downloaded content.
 */
export async function registerMarketplaceSource(
  pathCtx: PluginInstallPathContext,
  fs: RuntimeFs,
  source: MarketplaceSourceInput,
  nowIso: string,
  fetchImpl: typeof fetch,
): Promise<RegisterMarketplaceOutcome> {
  const placeholder = placeholderMarketplaceName(source)
  let staging: string
  try {
    staging = await freshStagingKey(pathCtx, fs, nowIso)
    await addMarketplace(pathCtx, fs, staging, source, nowIso)
  } catch (error) {
    return { ok: false, stage: 'register', name: placeholder, error }
  }
  let manifest
  try {
    manifest = (await fetchCatalog(pathCtx, fs, staging, nowIso, fetchImpl)).marketplace
  } catch (error) {
    await dropStaging(pathCtx, fs, staging, nowIso)
    return { ok: false, stage: 'fetch', name: placeholder, error }
  }
  const name = manifest.name.trim()
  const refusal = marketplaceNameProblem(name)
    ?? reservedNameSourceProblem(name, source)
    ?? builtinNameSourceProblem(name, source)
  if (refusal !== null) {
    await dropStaging(pathCtx, fs, staging, nowIso)
    return { ok: false, stage: 'nameRefused', name, error: new Error(refusal) }
  }
  let created: boolean
  try {
    const { registry } = await loadKnownMarketplaces(pathCtx, fs, nowIso)
    const held = registry[name]
    if (held && !sameMarketplaceSource(held.source, source)) {
      await dropStaging(pathCtx, fs, staging, nowIso)
      return {
        ok: false,
        stage: 'nameTaken',
        name,
        error: new Error(`'${name}' is already registered from another source`),
      }
    }
    created = !held
  } catch (error) {
    await dropStaging(pathCtx, fs, staging, nowIso)
    return { ok: false, stage: 'rename', name, error }
  }
  try {
    await addMarketplace(pathCtx, fs, name, source, nowIso)
    await fetchCatalog(pathCtx, fs, name, nowIso, fetchImpl)
  } catch (error) {
    if (created) {
      try {
        await removeMarketplace(pathCtx, fs, name, nowIso)
      } catch {
        /* best-effort cleanup */
      }
    }
    await dropStaging(pathCtx, fs, staging, nowIso)
    return { ok: false, stage: 'rename', name, error }
  }
  await dropStaging(pathCtx, fs, staging, nowIso)
  return { ok: true, name, pluginCount: manifest.plugins.length }
}
