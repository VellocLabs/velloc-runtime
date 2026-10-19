/**
 * Fuzzy ranking of file paths for `fsx.findFiles` (F-9). Pure. A match in the file name ranks above
 * one spread over the folders: an exact name (with or without its extension) first, then a name that
 * starts with the query, then a name that contains it, then a fuzzy match inside the name, then the
 * rest; uFuzzy's own order breaks ties inside each band.
 */
import uFuzzy from '@leeoniya/ufuzzy'

/** Matches ranked in detail; past this a cheap pre-order (name band, then path length) picks them. */
const RANK_DETAIL_MAX = 2000

// `intraIns: Infinity`: the letters of a word may be spread out ("fbrw" finds FilesBrowse).
const fuzzy = new uFuzzy({ intraIns: Infinity })

/** `index` into the ranked list; `ranges` flat `[start, end)` pairs into that path. */
export type RankedFile = { index: number; ranges: number[] }
export type RankedFiles = { files: RankedFile[]; matched: number }

type NameBand = { band: number; ranges?: number[] }

function nameStart(path: string): number {
  return path.lastIndexOf('/') + 1
}

/** How the file name alone relates to the lower-cased `needle`; bands 0..2 carry the name's range. */
function nameBand(path: string, needle: string): NameBand {
  const start = nameStart(path)
  const name = path.slice(start).toLowerCase()
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  if (name === needle || stem === needle) return { band: 0, ranges: [start, start + needle.length] }
  if (name.startsWith(needle)) return { band: 1, ranges: [start, start + needle.length] }
  const at = name.indexOf(needle)
  if (at >= 0) return { band: 2, ranges: [start + at, start + at + needle.length] }
  return { band: 3 }
}

/** Indices of `paths` holding `needle` (lower-cased) anywhere: the matcher for a query with no letters or digits. */
function substringMatches(paths: readonly string[], needle: string): number[] {
  const found: number[] = []
  paths.forEach((path, index) => {
    if (path.toLowerCase().includes(needle)) found.push(index)
  })
  return found
}

function substringRanges(path: string, needle: string): number[] {
  const at = path.toLowerCase().indexOf(needle)
  return at >= 0 ? [at, at + needle.length] : []
}

/**
 * The best `limit` of `paths` for `query`, best first, with `matched` = how many matched at all.
 * An empty query matches nothing.
 */
export function rankFilePaths(paths: readonly string[], query: string, limit: number): RankedFiles {
  const needle = query.trim()
  if (needle === '' || limit <= 0 || paths.length === 0) return { files: [], matched: 0 }
  const lower = needle.toLowerCase()
  const haystack = paths as string[]

  const usesFuzzy = fuzzy.split(needle).length > 0
  const candidates = usesFuzzy ? (fuzzy.filter(haystack, needle) ?? []) : substringMatches(paths, lower)
  const matched = candidates.length
  if (matched === 0) return { files: [], matched: 0 }

  let pool = candidates
  if (pool.length > RANK_DETAIL_MAX) {
    const band = new Map(pool.map(index => [index, nameBand(paths[index]!, lower).band]))
    pool = [...pool]
      .sort((a, b) => band.get(a)! - band.get(b)! || paths[a]!.length - paths[b]!.length)
      .slice(0, RANK_DETAIL_MAX)
  }

  let ordered: Array<{ index: number; ranges: number[] }>
  if (usesFuzzy) {
    const info = fuzzy.info(pool, haystack, needle)
    ordered = fuzzy.sort(info, haystack, needle).map(at => ({ index: info.idx[at]!, ranges: info.ranges[at] ?? [] }))
  } else {
    ordered = pool.map(index => ({ index, ranges: substringRanges(paths[index]!, lower) }))
  }

  const scored = ordered.map((entry, rank) => {
    const path = paths[entry.index]!
    const named = nameBand(path, lower)
    let band = named.band
    if (band === 3) {
      const start = nameStart(path)
      const inName = entry.ranges.length > 0 && entry.ranges.every((offset, i) => i % 2 === 1 || offset >= start)
      band = inName ? 3 : 4
    }
    return { index: entry.index, ranges: named.ranges ?? entry.ranges, band, rank }
  })
  scored.sort((a, b) => a.band - b.band || a.rank - b.rank)
  return {
    files: scored.slice(0, limit).map(({ index, ranges }) => ({ index, ranges })),
    matched,
  }
}
