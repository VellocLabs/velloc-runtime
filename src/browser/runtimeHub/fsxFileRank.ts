/**
 * Ranking of file paths for `fsx.findFiles` (F-9). Pure. A query is matched against the whole
 * '/'-separated path; its space-separated words must all match, in any order. Each word falls in a
 * band, best first: the file name equals it (with or without the extension), starts with it, contains
 * it; a folder of the path contains it; it matches fuzzily inside the name; it matches fuzzily across
 * the path. A path ranks by its worst word's band, then shorter paths first.
 */
import uFuzzy from '@leeoniya/ufuzzy'

/** Fuzzy-only matches ranked in detail; past this the shortest paths are the ones kept. */
const FUZZY_DETAIL_MAX = 2000
// Sort-key packing: a path length is counted up to KEY_LENGTH_SPAN - 1; `paths` holds fewer than KEY_INDEX_SPAN.
const KEY_LENGTH_SPAN = 2 ** 16
const KEY_INDEX_SPAN = 2 ** 21

// `intraIns: Infinity`: the letters of a word may be spread out ("fbrw" finds FilesBrowse).
const fuzzy = new uFuzzy({ intraIns: Infinity })

/** `index` into the ranked list; `ranges` flat, ordered `[start, end)` pairs into that path. */
export type RankedFile = { index: number; ranges: number[] }
export type RankedFiles = { files: RankedFile[]; matched: number }

const BAND_NAME_EXACT = 0
const BAND_NAME_PREFIX = 1
const BAND_NAME_CONTAINS = 2
const BAND_FOLDER_CONTAINS = 3
const BAND_FUZZY_NAME = 4
const BAND_FUZZY_PATH = 5

type WordHit = { band: number; ranges: number[] }

function nameStart(path: string): number {
  return path.lastIndexOf('/') + 1
}

/** The band and range of plain word `needle` (lower-cased) in `path`, or null when it is not a substring. */
function substringHit(path: string, lower: string, needle: string): WordHit | null {
  const start = nameStart(path)
  const name = lower.slice(start)
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const at = (offset: number) => [start + offset, start + offset + needle.length]
  if (name === needle || stem === needle) return { band: BAND_NAME_EXACT, ranges: at(0) }
  if (name.startsWith(needle)) return { band: BAND_NAME_PREFIX, ranges: at(0) }
  const inName = name.indexOf(needle)
  if (inName >= 0) return { band: BAND_NAME_CONTAINS, ranges: at(inName) }
  // Not in the name, so any occurrence lies in (or reaches into) the folders; the last is nearest the name.
  const inPath = lower.lastIndexOf(needle)
  return inPath >= 0 ? { band: BAND_FOLDER_CONTAINS, ranges: [inPath, inPath + needle.length] } : null
}

function hasWordChars(word: string): boolean {
  return fuzzy.split(word).length > 0
}

function mergeRanges(ranges: number[]): number[] {
  const pairs: Array<[number, number]> = []
  for (let i = 0; i + 1 < ranges.length; i += 2) pairs.push([ranges[i]!, ranges[i + 1]!])
  pairs.sort((a, b) => a[0] - b[0])
  const out: number[] = []
  for (const [start, end] of pairs) {
    if (out.length > 0 && start <= out[out.length - 1]!) out[out.length - 1] = Math.max(out[out.length - 1]!, end)
    else out.push(start, end)
  }
  return out
}

type Candidate = { index: number; band: number; ranges: number[]; fuzzyWords: string[] }

/**
 * The best `limit` of `paths` (fewer than 2^21) for `query`, best first, with `matched` = how many
 * matched at all. An empty query matches nothing.
 */
export function rankFilePaths(paths: readonly string[], query: string, limit: number): RankedFiles {
  const words = [...new Set(query.trim().toLowerCase().split(/\s+/).filter(word => word !== ''))]
  if (words.length === 0 || limit <= 0 || paths.length === 0) return { files: [], matched: 0 }
  const haystack = paths as string[]

  // Every word narrows the pool: a substring anywhere, or (for a word with letters or digits) a fuzzy match.
  const lowered: Array<string | undefined> = []
  const lowerOf = (index: number): string => (lowered[index] ??= paths[index]!.toLowerCase())
  let pool: number[] | null = null
  for (const word of words) {
    const subset: number[] = pool ?? paths.map((_, index) => index)
    const fuzzyHits: Set<number> | null = hasWordChars(word)
      ? new Set(fuzzy.filter(haystack, word, pool ?? undefined) ?? [])
      : null
    pool = subset.filter((index: number): boolean => fuzzyHits?.has(index) === true || lowerOf(index).includes(word))
    if (pool.length === 0) return { files: [], matched: 0 }
  }
  const matched = pool!.length

  // One sortable number per match: band (fuzzy ones parked at BAND_FUZZY_NAME), then length, then index.
  const keys = new Float64Array(matched)
  pool!.forEach((index, at) => {
    let band = BAND_NAME_EXACT
    for (const word of words) {
      const hit = substringHit(paths[index]!, lowerOf(index), word)
      band = Math.max(band, hit ? hit.band : BAND_FUZZY_NAME)
      if (!hit) break
    }
    keys[at] = (band * KEY_LENGTH_SPAN + Math.min(paths[index]!.length, KEY_LENGTH_SPAN - 1)) * KEY_INDEX_SPAN + index
  })
  keys.sort()
  const bandOf = (key: number) => Math.floor(key / (KEY_LENGTH_SPAN * KEY_INDEX_SPAN))
  const candidateAt = (key: number): Candidate => {
    const index = key % KEY_INDEX_SPAN
    const candidate: Candidate = { index, band: BAND_NAME_EXACT, ranges: [], fuzzyWords: [] }
    for (const word of words) {
      const hit = substringHit(paths[index]!, lowerOf(index), word)
      if (hit) {
        candidate.band = Math.max(candidate.band, hit.band)
        candidate.ranges.push(...hit.ranges)
      } else {
        candidate.fuzzyWords.push(word)
      }
    }
    return candidate
  }

  const ordered: Candidate[] = []
  let at = 0
  for (; at < keys.length && ordered.length < limit && bandOf(keys[at]!) < BAND_FUZZY_NAME; at += 1) {
    ordered.push(candidateAt(keys[at]!))
  }
  if (ordered.length < limit && at < keys.length) {
    const fuzzyOnes = Array.from(keys.subarray(at, at + FUZZY_DETAIL_MAX), candidateAt)
    resolveFuzzy(fuzzyOnes, haystack)
    fuzzyOnes.sort((a, b) => a.band - b.band || paths[a.index]!.length - paths[b.index]!.length || a.index - b.index)
    ordered.push(...fuzzyOnes.slice(0, limit - ordered.length))
  }
  return { files: ordered.map(({ index, ranges }) => ({ index, ranges: mergeRanges(ranges) })), matched }
}

/** Places each fuzzy word of `candidates` inside the name (band 4) or across the path (band 5), with its ranges. */
function resolveFuzzy(candidates: Candidate[], haystack: string[]): void {
  const byWord = new Map<string, Candidate[]>()
  for (const candidate of candidates) {
    for (const word of candidate.fuzzyWords) byWord.set(word, [...(byWord.get(word) ?? []), candidate])
  }
  for (const [word, group] of byWord) {
    const info = fuzzy.info(group.map(candidate => candidate.index), haystack, word)
    const rangesOf = new Map<number, number[]>()
    info.idx.forEach((index, at) => rangesOf.set(index, info.ranges[at] ?? []))
    for (const candidate of group) {
      const ranges = rangesOf.get(candidate.index) ?? []
      const start = nameStart(haystack[candidate.index]!)
      const inName = ranges.length > 0 && ranges.every((offset, i) => i % 2 === 1 || offset >= start)
      candidate.band = Math.max(candidate.band, inName ? BAND_FUZZY_NAME : BAND_FUZZY_PATH)
      candidate.ranges.push(...ranges)
    }
  }
}
