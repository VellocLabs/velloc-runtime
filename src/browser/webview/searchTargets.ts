import {
  getConversationTranscriptPath,
  getNexusWorkspaceDirForType,
  projectHomeFor,
} from '../../utils/conversationStoragePaths'
import { sessionActivityTime } from './sessionTimeBucket'

/**
 * Turns the sidebar's cached session list into the ordered list of transcript files the host searches:
 * the session on screen first, then the rest newest activity first. The order is a contract: the host
 * preserves it, the caps cut its tail, and the popup renders in it.
 */

/** The subset of a sidebar session row this module needs. */
export type SearchTargetSession = {
  sessionId: string
  title: string
  updatedAt: number
  lastComposerEditAt?: number
  projectRoot?: string
  templateType?: string
}

export type SearchTarget = {
  sessionId: string
  title: string
  /** Session kind (agent / chat / code), for the row's type icon. */
  templateType?: string
  /** Activity time (max of updatedAt / lastComposerEditAt), for display. */
  updatedAt: number
  /** Absolute path of the session's transcript.jsonl. */
  path: string
}

// Mirrors the worker's DEFAULT_TEMPLATE_TYPE — an unbound session stores
// under the shared workspace for its type.
const DEFAULT_TEMPLATE_TYPE = 'agent'

/**
 * The transcript path for one session — the same formula the storage
 * coordinator uses when it WRITES the file, so the two cannot drift:
 * a bound session lives under its project root, an unbound one under the
 * per-type shared workspace.
 */
export function transcriptPathForSession(
  homeDir: string,
  session: SearchTargetSession,
): string {
  const projectRoot =
    session.projectRoot ??
    getNexusWorkspaceDirForType(
      homeDir,
      session.templateType ?? DEFAULT_TEMPLATE_TYPE,
    )
  return getConversationTranscriptPath(
    projectHomeFor(homeDir, projectRoot),
    session.sessionId,
  )
}

export function orderSearchTargets(params: {
  sessions: readonly SearchTargetSession[]
  activeSessionId: string | null | undefined
  homeDir: string
}): SearchTarget[] {
  const { sessions, activeSessionId, homeDir } = params
  const rest = sessions.filter(
    session => session.sessionId !== activeSessionId,
  )
  // The list arrives sorted, but sort defensively — this ordering is the
  // whole contract and a caller passing an unsorted array must not
  // silently produce a scrambled search.
  rest.sort(
    (a, b) =>
      sessionActivityTime(b.updatedAt, b.lastComposerEditAt) -
      sessionActivityTime(a.updatedAt, a.lastComposerEditAt),
  )
  const active = activeSessionId
    ? sessions.find(session => session.sessionId === activeSessionId)
    : undefined
  const ordered = active ? [active, ...rest] : rest

  const seen = new Set<string>()
  const targets: SearchTarget[] = []
  for (const session of ordered) {
    if (seen.has(session.sessionId)) continue
    seen.add(session.sessionId)
    targets.push({
      sessionId: session.sessionId,
      title: session.title,
      templateType: session.templateType,
      updatedAt: sessionActivityTime(
        session.updatedAt,
        session.lastComposerEditAt,
      ),
      path: transcriptPathForSession(homeDir, session),
    })
  }
  return targets
}

/**
 * Slice sizes for the streaming search, in order; the last value repeats. The first slice is the active
 * session alone; the plateau bounds each host round trip the popup waits on.
 */
export const SEARCH_CHUNK_SIZES = [1, 3, 6, 12] as const

/** Splits `targets` into the ramped slices above, order preserved. */
export function chunkSearchTargets<T>(targets: readonly T[]): T[][] {
  const chunks: T[][] = []
  let index = 0
  let step = 0
  while (index < targets.length) {
    const size =
      SEARCH_CHUNK_SIZES[Math.min(step, SEARCH_CHUNK_SIZES.length - 1)]
    chunks.push(targets.slice(index, index + size) as T[])
    index += size
    step += 1
  }
  return chunks
}
