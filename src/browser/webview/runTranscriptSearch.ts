import type { BrowserBridgeTransport } from '../bridge/browserBridgeProtocol'
import type { TranscriptSearchMatch } from '../bridge/protocol/search'
import { queryTranscriptSearch } from './nexusBridgeActions'
import { chunkSearchTargets, type SearchTarget } from './searchTargets'
import {
  appendTranscriptSearchChunk,
  beginTranscriptSearch,
  failTranscriptSearch,
  finishTranscriptSearch,
  type TranscriptSearchGroup,
} from './transcriptSearchStore'

/**
 * Runs one search as consecutive, awaited slices of the relevance-ordered targets, pushing each response
 * into the store so rows only get appended. Stops when `isCurrent()` goes false, the match budget is
 * spent, or on the first host error.
 */

/** Total matches a single search will collect (host per-file cap is 10). */
const SEARCH_HIT_CEILING = 500

export type RunTranscriptSearchParams = {
  transport: BrowserBridgeTransport
  targets: readonly SearchTarget[]
  query: string
  regex: boolean
  caseSensitive: boolean
  generation: number
  /** False once a newer search has taken over — stop and discard. */
  isCurrent: () => boolean
  /** Maps a thrown bridge error to translated, user-facing text. */
  describeError: (error: unknown) => string
}

/**
 * Groups one chunk's flat match list by session, preserving the order the
 * host returned them in (which is the order the targets were given in).
 * Sessions with no hits simply produce no group — but they are still
 * counted as scanned, so the progress line stays honest.
 */
export function groupChunkMatches(
  matches: readonly TranscriptSearchMatch[],
  targets: readonly SearchTarget[],
): TranscriptSearchGroup[] {
  const byId = new Map<string, TranscriptSearchGroup>()
  const order: TranscriptSearchGroup[] = []
  for (const match of matches) {
    let group = byId.get(match.sessionId)
    if (!group) {
      const target = targets.find(
        candidate => candidate.sessionId === match.sessionId,
      )
      group = {
        sessionId: match.sessionId,
        title: target?.title ?? match.sessionId,
        templateType: target?.templateType,
        updatedAt: target?.updatedAt ?? 0,
        matches: [],
      }
      byId.set(match.sessionId, group)
      order.push(group)
    }
    group.matches.push(match)
  }
  return order
}

/**
 * Sessions in this slice whose title matches and which produced no body hit of their own (the host never
 * reads titles).
 */
export function titleOnlyGroups(
  targets: readonly SearchTarget[],
  query: string,
  withBodyHits: ReadonlySet<string>,
): TranscriptSearchGroup[] {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return []
  return targets
    .filter(
      target =>
        !withBodyHits.has(target.sessionId) &&
        target.title.toLowerCase().includes(needle),
    )
    .map(target => ({
      sessionId: target.sessionId,
      title: target.title,
      templateType: target.templateType,
      updatedAt: target.updatedAt,
      titleMatch: true,
      matches: [],
    }))
}

export async function runTranscriptSearch(
  params: RunTranscriptSearchParams,
): Promise<void> {
  const {
    transport,
    targets,
    query,
    regex,
    caseSensitive,
    generation,
    isCurrent,
    describeError,
  } = params

  beginTranscriptSearch(generation, targets.length)
  if (targets.length === 0 || query === '') {
    finishTranscriptSearch(generation)
    return
  }

  let remaining = SEARCH_HIT_CEILING
  try {
    const chunks = chunkSearchTargets(targets)
    for (let index = 0; index < chunks.length; index++) {
      const chunk = chunks[index]!
      if (!isCurrent() || remaining <= 0) break
      const response = await queryTranscriptSearch(transport, {
        targets: chunk.map(target => target.path),
        query,
        regex,
        caseSensitive,
        maxResults: remaining,
        generation,
      })
      // Two independent staleness gates: the host echoes our generation
      // and also self-cancels a chunk a newer keystroke overtook.
      if (!isCurrent() || response.generation !== generation) return
      if (response.superseded) {
        // Normally a newer keystroke superseded us and has already reset
        // the store — returning is right. But the host is shared by every
        // panel, so a search in ANOTHER window can cancel this one while
        // we are still the current search here. Settle instead of
        // returning, or this popup spins forever on results that will
        // never arrive.
        finishTranscriptSearch(generation)
        return
      }

      remaining -= response.matches.length
      // Spending the budget only counts as truncation if there was more
      // left to search: a query whose hits land exactly on the cap
      // dropped nothing, and must not tell the user to refine it.
      const moreChunksLeft = index < chunks.length - 1
      const bodyGroups = groupChunkMatches(response.matches, chunk)
      const withBody = new Set(bodyGroups.map(group => group.sessionId))
      appendTranscriptSearchChunk(generation, {
        // Title matches keep this slice's priority order too: they are
        // appended after its content hits, never re-sorted in later.
        groups: [...bodyGroups, ...titleOnlyGroups(chunk, query, withBody)],
        scanned: chunk.length,
        truncated: response.truncated || (remaining <= 0 && moreChunksLeft),
      })
    }
    finishTranscriptSearch(generation)
  } catch (error) {
    if (!isCurrent()) return
    failTranscriptSearch(generation, describeError(error))
  }
}
