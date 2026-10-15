import { joinRuntimePath } from './runtimePaths'

/**
 * Path helpers for sub-agent transcripts, under the parent session's dir:
 *   {basePath}/{sessionId}/subagents/agent-{agentId}.jsonl  (sync fork files)
 *   {basePath}/{sessionId}/subagents/{subagentSessionId}/   (background sessions)
 * Deleting the session dir removes every sub-agent; the `agent-` prefix and the
 * `isFile()` guard keep the two kinds apart.
 */

/** The per-session subdirectory holding sub-agent transcripts. Exported as the
 *  ONE source of truth: `SharedWorkerSessionManager` reuses it to nest
 *  background sub-agent SESSIONS under the same dir as the sync-fork files. */
export const SUBAGENTS_DIR_NAME = 'subagents'
/** The per-session subdirectory holding TEAMMATE (child) session directories.
 *  The same nesting trick as `SUBAGENTS_DIR_NAME` — deleting a lead's session
 *  dir sweeps its children's files — but a teammate is a real, openable
 *  session: it is hidden from the sidebar by its `spawnerSessionId`, not by
 *  living here. Sync-fork transcript FILES never land in this dir. */
export const TEAMMATES_DIR_NAME = 'teammates'

/**
 * Session-id mint prefixes for the two nested kinds, and their predicates. Kept
 * beside the directory names (the id and the directory are one fact); imports
 * only `runtimePaths`, so storage modules may depend on it.
 */
export const SUBAGENT_SESSION_ID_PREFIX = 'subagent-'
export const TEAMMATE_SESSION_ID_PREFIX = 'teammate-'

/** True for a BACKGROUND sub-agent session id. */
export function isSubAgentSessionId(sessionId: string): boolean {
  return sessionId.startsWith(SUBAGENT_SESSION_ID_PREFIX)
}

/** True for a TEAMMATE (child) session id, minted by `TeamCoordinator.spawn`. */
export function isTeammateSessionId(sessionId: string): boolean {
  return sessionId.startsWith(TEAMMATE_SESSION_ID_PREFIX)
}

/**
 * The spawn time a teammate session id carries, in epoch ms: the only creation
 * time a teammate has. Parses the trailing `-<digits>` the mint appends; must
 * stay in step with it. Null when not a teammate id or no timestamp.
 */
export function teammateSpawnTimeFromId(sessionId: string): number | null {
  if (!isTeammateSessionId(sessionId)) return null
  const match = /-(\d+)$/.exec(sessionId)
  if (!match) return null
  const spawnedAt = Number(match[1])
  return Number.isFinite(spawnedAt) ? spawnedAt : null
}

const SIDECHAIN_FILE_SUFFIX = '.jsonl'
/** Filename prefix for sync-fork transcript files. Distinguishes them
 *  from the background sub-agent `subagent-…/` session dirs that share the
 *  `subagents/` directory. */
const SIDECHAIN_FILE_PREFIX = 'agent-'

export function getSubagentsDirectoryPath(
  basePath: string,
  sessionId: string,
): string {
  return joinRuntimePath(basePath, sessionId, SUBAGENTS_DIR_NAME)
}

export function getSubagentTranscriptPath(
  basePath: string,
  sessionId: string,
  agentId: string,
): string {
  return joinRuntimePath(
    getSubagentsDirectoryPath(basePath, sessionId),
    `${SIDECHAIN_FILE_PREFIX}${encodeURIComponent(agentId)}${SIDECHAIN_FILE_SUFFIX}`,
  )
}

/**
 * Extract an agentId from a sync-fork transcript filename. Returns undefined
 * when the filename doesn't match the expected `agent-{encodedAgentId}.jsonl`
 * shape — so a stray non-`agent-` `.jsonl` (or a `subagent-…/` directory name)
 * is never mis-parsed as a sync fork. Used by `list(sessionId)` implementations
 * to round-trip filenames back to logical IDs.
 */
export function parseAgentIdFromFilename(
  filename: string,
): string | undefined {
  if (!filename.endsWith(SIDECHAIN_FILE_SUFFIX)) return undefined
  const stem = filename.slice(0, -SIDECHAIN_FILE_SUFFIX.length)
  if (!stem.startsWith(SIDECHAIN_FILE_PREFIX)) return undefined
  const encoded = stem.slice(SIDECHAIN_FILE_PREFIX.length)
  try {
    return decodeURIComponent(encoded)
  } catch {
    return undefined
  }
}
