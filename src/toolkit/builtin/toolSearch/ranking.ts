/**
 * Pure helpers for the deferred-tool loader: splitting tool names into
 * searchable words, scoring keyword queries, and parsing `select:` lists.
 */

/** A candidate the ranker can score: its name and optional hint text. */
export type RankCandidate = { name: string; discoveryHint?: string }

const MCP_PREFIX = 'mcp__'

/** Break a tool name into lowercase words. `mcp__server__do_thing` style
 *  names lose the prefix and split on `__` then `_`; other names split on
 *  camel-case humps and underscores. */
export function nameWords(name: string): string[] {
  if (name.startsWith(MCP_PREFIX)) {
    const rest = name.slice(MCP_PREFIX.length).toLowerCase()
    return rest
      .split('__')
      .flatMap(part => part.split('_'))
      .filter(Boolean)
  }
  return name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map(w => w.toLowerCase())
}

/** Parse a `select:` query into its trimmed, non-empty names, or `null`
 *  when the query is not in select form. */
export function parseSelectList(query: string): string[] | null {
  const m = /^select:(.+)$/is.exec(query)
  if (!m) return null
  return m[1]!
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0)
}

type ParsedTerms = { required: string[]; optional: string[] }

function splitTerms(query: string): ParsedTerms {
  const required: string[] = []
  const optional: string[] = []
  for (const term of query.split(/\s+/).filter(Boolean)) {
    if (term.startsWith('+') && term.length > 1) required.push(term.slice(1))
    else optional.push(term)
  }
  return { required, optional }
}

function termHits(term: string, words: string[], hint: string): boolean {
  return words.some(w => w.includes(term)) || hint.includes(term)
}

function termScore(term: string, words: string[]): number {
  let score = 0
  if (words.includes(term)) score += 10
  else if (words.some(w => w.includes(term))) score += 5
  return score
}

/** Rank candidates for a keyword query. Returns matched names, best first
 *  (ties keep input order), at most `limit` of them. */
export function rankByKeywords(
  query: string,
  candidates: readonly RankCandidate[],
  limit: number,
): string[] {
  const q = query.toLowerCase().trim()
  const exact = candidates.find(c => c.name.toLowerCase() === q)
  if (exact) return [exact.name]
  if (limit <= 0) return []

  const { required, optional } = splitTerms(q)
  const scoringTerms = required.length > 0 ? [...required, ...optional] : optional

  const scored: { name: string; score: number }[] = []
  for (const c of candidates) {
    const words = nameWords(c.name)
    const hint = (c.discoveryHint ?? '').toLowerCase()
    if (required.length > 0 && !required.every(t => termHits(t, words, hint))) {
      continue
    }
    let score = 0
    for (const t of scoringTerms) {
      score += termScore(t, words)
      if (hint && hint.includes(t)) score += 4
    }
    if (score > 0) scored.push({ name: c.name, score })
  }
  // Array.prototype.sort is stable, so equal scores keep candidate order.
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit).map(s => s.name)
}
