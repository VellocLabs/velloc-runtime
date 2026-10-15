/**
 * Build the sidebar's Project tree from session summaries (`projectRoot`) plus added project paths: pure,
 * with no fs, bridge or storage reads. Per-type sandbox roots are not projects (`isSandboxProjectRoot`).
 */
import { NEXUS_WORKSPACE_DIR_NAME } from '../../utils/conversationStoragePaths'
import { RUNTIME_DIR_NAME } from '../../branding/runtimeDir'
import { normalizeProjectPath } from '../../utils/workspaceState'

/**
 * The only fields this module reads off a session. Structural on purpose: importing `SessionListItem`
 * from `Sidebar.tsx` would close an import cycle.
 */
export type ProjectTreeSession = {
  projectRoot?: string
  updatedAt: number
  lastComposerEditAt?: number
}

export type ProjectNode<T extends ProjectTreeSession> = {
  /** Absolute folder path, trailing separators trimmed. The node's identity. */
  path: string
  /** Display label — the last path segment. */
  name: string
  /** This project's sessions, newest-first (the caller's incoming order). */
  sessions: T[]
  /**
   * True when the project has no sessions yet — it exists only because the user
   * added it. Drives the "no sessions yet" empty row rather than a bare node.
   */
  isEmpty: boolean
}

/**
 * Normalise a project path as a grouping key: trailing separators removed. Case is preserved (the on-disk
 * dir name is case-sensitive).
 */
export { normalizeProjectPath }

/**
 * True when `projectRoot` is the shared sandbox (`<RUNTIME_DIR_NAME>/shared-workspace` or a per-type
 * subdir), matched by path segment since the page has no home dir; both separators accepted.
 */
export function isSandboxProjectRoot(projectRoot: string): boolean {
  const normalized = normalizeProjectPath(projectRoot).replace(/\\/g, '/')
  const marker = `/${RUNTIME_DIR_NAME}/${NEXUS_WORKSPACE_DIR_NAME}`
  return normalized.endsWith(marker) || normalized.includes(`${marker}/`)
}

/** Display name for a project path — its last path segment. */
function displayName(path: string): string {
  const segments = path.replace(/\\/g, '/').split('/').filter(Boolean)
  return segments[segments.length - 1] ?? path
}

/**
 * Group newest-first `sessions` into project nodes, each keeping that order; projects ordered by newest
 * session, then session-less ones newest addition first. `addedProjectPaths` are deduped against the
 * session-derived paths.
 */
export function buildProjectTree<T extends ProjectTreeSession>(
  sessions: readonly T[],
  addedProjectPaths: readonly string[],
  addedOrder: ReadonlyMap<string, number> = new Map(),
): ProjectNode<T>[] {
  const byPath = new Map<string, ProjectNode<T>>()

  const ensureNode = (path: string): ProjectNode<T> => {
    let node = byPath.get(path)
    if (!node) {
      node = { path, name: displayName(path), sessions: [], isEmpty: true }
      byPath.set(path, node)
    }
    return node
  }

  for (const rawPath of addedProjectPaths) {
    const path = normalizeProjectPath(rawPath)
    if (path.length === 0 || isSandboxProjectRoot(path)) continue
    ensureNode(path)
  }

  for (const session of sessions) {
    if (!session.projectRoot) continue
    const path = normalizeProjectPath(session.projectRoot)
    if (path.length === 0 || isSandboxProjectRoot(path)) continue
    const node = ensureNode(path)
    node.sessions.push(session)
    node.isEmpty = false
  }

  // Newest activity per project — `sessions` arrives newest-first, so the head
  // of each bucket is that project's most recent session.
  const activityOf = (node: ProjectNode<T>): number => {
    const newest = node.sessions[0]
    if (!newest) return -1
    return Math.max(newest.updatedAt, newest.lastComposerEditAt ?? 0)
  }

  return [...byPath.values()].sort((left, right) => {
    const leftActivity = activityOf(left)
    const rightActivity = activityOf(right)
    if (leftActivity !== rightActivity) return rightActivity - leftActivity
    // Both empty: most-recently-added first.
    const leftAdded = addedOrder.get(left.path) ?? 0
    const rightAdded = addedOrder.get(right.path) ?? 0
    if (leftAdded !== rightAdded) return rightAdded - leftAdded
    return left.name.localeCompare(right.name)
  })
}
