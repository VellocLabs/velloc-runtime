/** Model id normalization and the normalized-id index (pure). */
import type { CatalogIdIndex, CatalogProviderRecords } from './types'

/**
 * Compare-form of a model id: lower-case, without a leading `vendor/`,
 * without a trailing `-YYYYMMDD` date, with `-`, `.` and `_` removed.
 */
export function normalizeModelId(id: string): string {
  let s = id.trim().toLowerCase()
  const slash = s.lastIndexOf('/')
  if (slash >= 0) s = s.slice(slash + 1)
  s = s.replace(/-\d{8}$/, '')
  return s.replace(/[-._]/g, '')
}

/** Built at refresh (and by the snapshot generator) from the slimmed records. */
export function buildIdIndex(
  providers: Record<string, CatalogProviderRecords>,
): CatalogIdIndex {
  const ids: Record<string, string[]> = {}
  for (const [key, records] of Object.entries(providers)) {
    for (const modelId of Object.keys(records)) {
      const n = normalizeModelId(modelId)
      if (n.length === 0) continue
      const list = (ids[n] ??= [])
      if (!list.includes(key)) list.push(key)
    }
  }
  return { version: 1, ids }
}

/**
 * The model id in `records` whose normalized form is `normalized`, picked
 * independently of key order: unprefixed before prefixed, undated before
 * dated, newest date, then lowest id.
 */
export function findNormalized(
  records: CatalogProviderRecords,
  normalized: string,
): string | undefined {
  let best: string | undefined
  for (const id of Object.keys(records)) {
    if (normalizeModelId(id) !== normalized) continue
    if (best === undefined || preferSibling(id, best) < 0) best = id
  }
  return best
}

const DATE_SUFFIX = /-(\d{8})$/

/** Negative when `a` is the better pick of two same-normalized ids. */
function preferSibling(a: string, b: string): number {
  const routedA = a.includes('/') ? 1 : 0
  const routedB = b.includes('/') ? 1 : 0
  if (routedA !== routedB) return routedA - routedB
  const dateA = DATE_SUFFIX.exec(a.trim())?.[1]
  const dateB = DATE_SUFFIX.exec(b.trim())?.[1]
  if ((dateA === undefined) !== (dateB === undefined)) return dateA === undefined ? -1 : 1
  if (dateA !== undefined && dateB !== undefined && dateA !== dateB) return dateA > dateB ? -1 : 1
  return a < b ? -1 : a > b ? 1 : 0
}
