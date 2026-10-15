/**
 * Turn `fs.readdirTree` rows of `<projectsRoot>/<projectDir>/<sessionId>/{meta.json,
 * transcript.jsonl, …}` into the sidebar's session index. Pure: no fs, no bridge.
 */
import type { BridgeFsTreeEntry } from '../bridge/protocol/fs'

const TRANSCRIPT_FILE_NAME = 'transcript.jsonl'
const META_FILE_NAME = 'meta.json'
const LEGACY_META_SIDECAR_FILE_NAME = 'meta.jsonl'

export type SessionTreeRow = {
  /** Immediate child dir name under the projects root, NOT a full path. */
  projectDirName: string
  sessionId: string
  /** Byte size of `transcript.jsonl`; null when it has none. */
  transcriptSize: number | null
  /** Byte size of `meta.json`; null when the session has none (yet). */
  metaSize: number | null
  /** Byte size of the retired `meta.jsonl` sidecar; null when absent. Only a
   *  session without `meta.json` cares — it is that session's migration seed. */
  legacyMetaSize: number | null
}

/**
 * A scan's rows plus whether the host CUT the listing short (`fs.readdirTree`
 * has an entry cap). A truncated scan is still worth listing, but it is NOT a
 * complete picture of the profile — the one-time meta migration must not
 * record itself as done off it, or every session past the cap vanishes for
 * good. A bare `SessionTreeRow[]` is accepted wherever this is and reads as
 * complete.
 */
export type SessionTreeScanResult = {
  rows: SessionTreeRow[]
  truncated: boolean
}

/**
 * Rows of a depth-3 scan, root-relative and '/'-separated (wire contract). Only 3-segment file rows
 * count; a session needs a `meta.json` or a `transcript.jsonl` (a lone `meta.jsonl` is not one).
 */
export function parseSessionTree(
  entries: readonly BridgeFsTreeEntry[],
): SessionTreeRow[] {
  // keyed `projectDirName\0sessionId` so a session id appearing under two
  // project dirs stays two rows — resolving that duplicate needs both.
  const rows = new Map<string, SessionTreeRow>()

  for (const entry of entries) {
    if (entry.isDirectory) continue
    const segments = entry.path.split('/')
    if (segments.length !== 3) continue

    const [projectDirName, sessionId, fileName] = segments as [
      string,
      string,
      string,
    ]
    if (
      fileName !== TRANSCRIPT_FILE_NAME &&
      fileName !== META_FILE_NAME &&
      fileName !== LEGACY_META_SIDECAR_FILE_NAME
    ) {
      continue
    }
    if (!projectDirName || !sessionId) continue

    const key = `${projectDirName}\0${sessionId}`
    let row = rows.get(key)
    if (!row) {
      row = {
        projectDirName,
        sessionId,
        transcriptSize: null,
        metaSize: null,
        legacyMetaSize: null,
      }
      rows.set(key, row)
    }
    if (fileName === TRANSCRIPT_FILE_NAME) {
      row.transcriptSize = entry.size
    } else if (fileName === META_FILE_NAME) {
      row.metaSize = entry.size
    } else {
      row.legacyMetaSize = entry.size
    }
  }

  return [...rows.values()].filter(
    row =>
      (row.metaSize !== null && row.metaSize > 0) ||
      (row.transcriptSize !== null && row.transcriptSize > 0),
  )
}

/** One `fs.readdirTree` call: rows root-relative and '/'-separated, plus
 *  whether the host cut the listing at its entry cap. Throws on failure. */
export type ReaddirTreeFn = (
  path: string,
  maxDepth: number,
) => Promise<{ entries: readonly BridgeFsTreeEntry[]; truncated: boolean }>

/**
 * The session index, COMPLETE even when one depth-3 `readdirTree` hits the host's row cap: falls
 * back to per-project, then per-session scans. `truncated` only when a finest-level listing was cut.
 */
export async function scanSessionTreeComplete(
  root: string,
  readdirTree: ReaddirTreeFn,
  joinPath: (base: string, child: string) => string,
): Promise<SessionTreeScanResult> {
  const whole = await readdirTree(root, 3)
  if (!whole.truncated) {
    return { rows: parseSessionTree(whole.entries), truncated: false }
  }

  const entries: BridgeFsTreeEntry[] = []
  const reroot = (prefix: string, rows: readonly BridgeFsTreeEntry[]) => {
    for (const row of rows) {
      entries.push({ ...row, path: `${prefix}/${row.path}` })
    }
  }
  const projects = await readdirTree(root, 1)
  let truncated = projects.truncated
  for (const project of projects.entries) {
    if (!project.isDirectory) continue
    const projectPath = joinPath(root, project.path)
    const subtree = await readdirTree(projectPath, 2)
    if (!subtree.truncated) {
      reroot(project.path, subtree.entries)
      continue
    }
    const sessions = await readdirTree(projectPath, 1)
    if (sessions.truncated) truncated = true
    for (const session of sessions.entries) {
      if (!session.isDirectory) continue
      const files = await readdirTree(joinPath(projectPath, session.path), 1)
      if (files.truncated) truncated = true
      reroot(`${project.path}/${session.path}`, files.entries)
    }
  }
  return { rows: parseSessionTree(entries), truncated }
}
