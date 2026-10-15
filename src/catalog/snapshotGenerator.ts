/**
 * Bundle snapshot generator (pure): the live source document into
 * `catalog/snapshot/` files, with the same adapter and validation as a runtime
 * refresh, keeping only `keep` providers. Throws on any unusable document.
 */
import { adaptDocument } from './modelsDevAdapter'
import { buildIdIndex } from './catalogMatch'
import { countModels, hashText } from './catalogFetcher'
import { isSafeProviderKey, providerRelPath } from './catalogReader'
import { createSnapshotReader, SNAPSHOT_ASSET_ROOT } from './catalogSnapshot'
import { SNAPSHOT_PROVIDER_KEYS } from './snapshotProviders'
import type { CatalogIndex, CatalogProviderRecords } from './types'

/** Published path (relative to the snapshot root) -> file text. */
export type SnapshotFiles = Record<string, string>

export function buildSnapshotFiles(
  documentText: string,
  now: number,
  keep: readonly string[] = SNAPSHOT_PROVIDER_KEYS,
): SnapshotFiles {
  let doc: unknown
  try {
    doc = JSON.parse(documentText)
  } catch {
    throw new Error('catalog document is not valid JSON')
  }
  const adapted = adaptDocument(doc)
  if (!adapted) throw new Error('catalog document has an unexpected shape')
  const wanted = new Set(keep)
  const all = Object.keys(adapted).filter(isSafeProviderKey)
  if (all.length < 1) throw new Error('catalog document has no providers')
  const providers = Object.fromEntries(
    all.filter(key => wanted.has(key)).map(key => [key, adapted[key]]),
  )
  const keys = Object.keys(providers)
  // The source renamed or dropped most of the kept providers: the list needs
  // updating before a publish ships a snapshot that answers almost nothing.
  if (keys.length * 2 < wanted.size) {
    throw new Error(
      `catalog document has only ${keys.length} of the ${wanted.size} snapshot providers`,
    )
  }

  const files: SnapshotFiles = {}
  const hashes: Record<string, string> = {}
  for (const key of keys) {
    const text = JSON.stringify(providers[key])
    hashes[key] = hashText(text)
    files[providerRelPath(key)] = text
  }
  const index: CatalogIndex = {
    version: 1,
    generatedAt: now,
    contentHash: hashText(
      keys.sort().map(k => `${k}:${hashes[k]}`).join('|'),
    ),
    providers: hashes,
    modelCount: countModels(providers),
    ...(keys.length < all.length ? { partial: true as const } : {}),
  }
  files['ids.json'] = JSON.stringify(buildIdIndex(providers))
  files['index.json'] = JSON.stringify(index)
  return files
}

const SERVED_READ_CONCURRENCY = 8

/** A snapshot an earlier publish serves, checked and ready to write again. */
export type ServedSnapshot = { files: SnapshotFiles; index: CatalogIndex }

/**
 * Read a deployed bundle's snapshot and check its files belong together
 * (hashes and counts match the index); throws with a short reason otherwise.
 * `fetchText` takes a snapshot-relative path and resolves undefined when absent.
 */
export async function readServedSnapshot(
  fetchText: (rel: string) => Promise<string | undefined>,
): Promise<ServedSnapshot> {
  const texts = new Map<string, string>()
  const prefix = `${SNAPSHOT_ASSET_ROOT}/`
  const reader = createSnapshotReader({
    fetchAsset: async assetPath => {
      const rel = assetPath.startsWith(prefix) ? assetPath.slice(prefix.length) : assetPath
      const text = await fetchText(rel)
      if (text !== undefined) texts.set(rel, text)
      return text
    },
  })
  try {
    const index = await reader.readIndex()
    if (!index) throw new Error('served snapshot has no readable index.json')
    const keys = Object.keys(index.providers)
    if (keys.length < 1) throw new Error('served snapshot names no providers')
    for (const key of keys) {
      if (!isSafeProviderKey(key)) throw new Error(`served snapshot names an unsafe provider key`)
    }
    if (!(await reader.readIdIndex())) throw new Error('served snapshot has no readable ids.json')
    const providers: Record<string, CatalogProviderRecords> = {}
    // A few reads at a time: hundreds of parallel requests to one origin
    // get refused, and a refused read would count as a missing file.
    let next = 0
    const worker = async (): Promise<void> => {
      while (next < keys.length) {
        const key = keys[next++]
        const records = await reader.readProvider(key)
        const text = texts.get(providerRelPath(key))
        if (!records || text === undefined) {
          throw new Error(`served snapshot provider ${key} is missing or unreadable`)
        }
        if (hashText(text) !== index.providers[key]) {
          throw new Error(`served snapshot provider ${key} does not match its index hash`)
        }
        providers[key] = records
      }
    }
    await Promise.all(Array.from({ length: Math.min(SERVED_READ_CONCURRENCY, keys.length) }, worker))
    const contentHash = hashText(
      [...keys].sort().map(k => `${k}:${index.providers[k]}`).join('|'),
    )
    if (contentHash !== index.contentHash) {
      throw new Error('served snapshot index content hash does not match its providers')
    }
    if (countModels(providers) !== index.modelCount) {
      throw new Error('served snapshot model count does not match its providers')
    }
    const files: SnapshotFiles = {}
    for (const rel of ['index.json', 'ids.json', ...keys.map(providerRelPath)]) {
      files[rel] = texts.get(rel)!
    }
    return { files, index }
  } finally {
    reader.release()
  }
}

/** "3 days", "5 hours", "under an hour" — the age of a reused snapshot. */
export function describeSnapshotAge(generatedAt: number, now: number): string {
  const hours = Math.floor(Math.max(0, now - generatedAt) / 3_600_000)
  if (hours < 1) return 'under an hour'
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}`
  return `${Math.floor(hours / 24)} days`
}

/** Kept providers the document did not have (for the publish log). */
export function missingSnapshotProviders(
  files: SnapshotFiles,
  keep: readonly string[] = SNAPSHOT_PROVIDER_KEYS,
): string[] {
  const index = JSON.parse(files['index.json']) as CatalogIndex
  return keep.filter(key => !(key in index.providers))
}
