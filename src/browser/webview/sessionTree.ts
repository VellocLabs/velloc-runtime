/**
 * How the sidebar nests child session rows under their parent: one pure
 * function from a listed, ordered set of rows to the top-level rows, each
 * parent's children and each row's depth, plus the rows that fell back to the
 * top level. (F-36)
 */
import type { SessionLineageKind } from '../../sessions/sessionLineage'

/** The row fields the tree reads. */
export type TreeableSession = {
  sessionId: string
  parentSessionId?: string
  lineageKind?: SessionLineageKind
  detached?: boolean
  running?: boolean
  needsAnswer?: boolean
  /** Out of the active list: listed apart, never nested. */
  archived?: boolean
}

/** A chain longer than this is drawn flat from where it exceeds the cap. */
export const SESSION_TREE_MAX_DEPTH = 32

export type SessionTree<T> = {
  /** Rows drawn at the top level, in the input order. */
  roots: T[]
  /** Each parent's children, in the input order; parents with none are absent. */
  childrenOf: ReadonlyMap<string, T[]>
  /** `0` for a top-level row. */
  depthOf: ReadonlyMap<string, number>
  /** Every listed row, by id. */
  byId: ReadonlyMap<string, T>
  /**
   * Rows that name a parent yet are drawn top-level: the parent is not listed,
   * the chain is cyclic, or it is deeper than the cap. Never hidden.
   */
  fallbackIds: readonly string[]
}

/**
 * The parent a row is drawn under, if any: a listed session named by
 * `parentSessionId`, for a row that is neither detached nor a team member
 * (teammates live on the topbar tab strip, not in the list).
 */
function listedParentOf<T extends TreeableSession>(
  row: T,
  byId: ReadonlyMap<string, T>,
): string | undefined {
  if (!row.parentSessionId || row.detached || row.lineageKind === 'team') {
    return undefined
  }
  if (row.parentSessionId === row.sessionId) return undefined
  return byId.has(row.parentSessionId) ? row.parentSessionId : undefined
}

/**
 * Contract: nests `sessions`; a row goes under its listed parent, one level
 * per link, and keeps its place among its siblings. A row whose parent is not
 * listed, whose chain loops back on itself, or which sits deeper than
 * {@link SESSION_TREE_MAX_DEPTH} is a top-level row instead (and is reported in
 * `fallbackIds`); its own children still nest under it. A row whose parent is
 * in `archivedParents` is top-level too, and not reported: its parent is
 * listed apart. Both the roots and each children list keep the input order,
 * so ordering is the caller's.
 */
export function nestSessions<T extends TreeableSession>(
  sessions: readonly T[],
  archivedParents: ReadonlySet<string> = new Set(),
): SessionTree<T> {
  const byId = new Map<string, T>()
  for (const session of sessions) byId.set(session.sessionId, session)

  const FALLBACK = -1
  const depthMemo = new Map<string, number>()
  const fallbackIds: string[] = []
  const visiting = new Set<string>()

  const resolve = (row: T): number => {
    const known = depthMemo.get(row.sessionId)
    if (known !== undefined) return known
    const parentId = listedParentOf(row, byId)
    let depth: number
    if (parentId === undefined) {
      depth =
        row.parentSessionId &&
        !row.detached &&
        row.lineageKind !== 'team' &&
        !archivedParents.has(row.parentSessionId)
          ? FALLBACK
          : 0
    } else if (visiting.has(parentId)) {
      depth = FALLBACK
    } else {
      visiting.add(row.sessionId)
      const parentDepth = resolve(byId.get(parentId)!)
      visiting.delete(row.sessionId)
      const next = (parentDepth === FALLBACK ? 0 : parentDepth) + 1
      depth = next > SESSION_TREE_MAX_DEPTH ? FALLBACK : next
    }
    depthMemo.set(row.sessionId, depth)
    if (depth === FALLBACK) fallbackIds.push(row.sessionId)
    return depth
  }

  const roots: T[] = []
  const childrenOf = new Map<string, T[]>()
  const depthOf = new Map<string, number>()
  for (const session of sessions) {
    const depth = resolve(session)
    if (depth <= 0) {
      depthOf.set(session.sessionId, 0)
      roots.push(session)
      continue
    }
    depthOf.set(session.sessionId, depth)
    const parentId = listedParentOf(session, byId)!
    const siblings = childrenOf.get(parentId)
    if (siblings) siblings.push(session)
    else childrenOf.set(parentId, [session])
  }
  return { roots, childrenOf, depthOf, byId, fallbackIds }
}

/**
 * `sessions` split into the rows the list nests and the archived rows it lists
 * apart, each in the input order, plus the archived ids for
 * {@link nestSessions}. (F-36)
 */
export function partitionArchived<T extends TreeableSession>(
  sessions: readonly T[],
): { live: T[]; archived: T[]; archivedIds: ReadonlySet<string> } {
  const live: T[] = []
  const archived: T[] = []
  for (const session of sessions) (session.archived ? archived : live).push(session)
  return { live, archived, archivedIds: new Set(archived.map(s => s.sessionId)) }
}

/**
 * `roots` with each row followed by its descendants, depth-first, skipping the
 * children of a parent listed in `collapsed`: the rows as the list draws them.
 */
export function flattenSessionTree<T extends TreeableSession>(
  roots: readonly T[],
  childrenOf: ReadonlyMap<string, T[]>,
  collapsed: ReadonlySet<string> = new Set(),
): T[] {
  const out: T[] = []
  const visit = (row: T) => {
    out.push(row)
    if (collapsed.has(row.sessionId)) return
    for (const child of childrenOf.get(row.sessionId) ?? []) visit(child)
  }
  for (const root of roots) visit(root)
  return out
}

/** How many rows sit under `sessionId`, at every depth. */
export function countDescendants<T extends TreeableSession>(
  sessionId: string,
  childrenOf: ReadonlyMap<string, T[]>,
): number {
  let count = 0
  for (const child of childrenOf.get(sessionId) ?? []) {
    count += 1 + countDescendants(child.sessionId, childrenOf)
  }
  return count
}

/**
 * Every row drawn under `sessionId` in a tree's `childrenOf`, at every depth,
 * nearest level first: the rows {@link countDescendants} counts. Empty for a
 * row with no children in that tree.
 */
export function descendantSessionIds<T extends TreeableSession>(
  sessionId: string,
  childrenOf: ReadonlyMap<string, T[]>,
): string[] {
  const found: string[] = []
  const seen = new Set<string>([sessionId])
  const queue = [sessionId]
  while (queue.length > 0) {
    const current = queue.shift()!
    for (const child of childrenOf.get(current) ?? []) {
      if (seen.has(child.sessionId)) continue
      seen.add(child.sessionId)
      found.push(child.sessionId)
      queue.push(child.sessionId)
    }
  }
  return found
}

/**
 * The state a collapsed parent row shows for its subtree: running if any
 * descendant runs, needing an answer if any descendant does.
 */
export function aggregateDescendantState<T extends TreeableSession>(
  sessionId: string,
  childrenOf: ReadonlyMap<string, T[]>,
): { running: boolean; needsAnswer: boolean } {
  let running = false
  let needsAnswer = false
  for (const child of childrenOf.get(sessionId) ?? []) {
    running ||= !!child.running
    needsAnswer ||= !!child.needsAnswer
    if (running && needsAnswer) break
    const below = aggregateDescendantState(child.sessionId, childrenOf)
    running ||= below.running
    needsAnswer ||= below.needsAnswer
    if (running && needsAnswer) break
  }
  return { running, needsAnswer }
}

/** The top-level row `sessionId` sits under (itself when top-level); `undefined` when not listed. */
export function rootOf<T extends TreeableSession>(
  sessionId: string,
  tree: Pick<SessionTree<T>, 'byId' | 'depthOf'>,
): string | undefined {
  const start = tree.byId.get(sessionId)
  if (!start) return undefined
  let current: T = start
  let guard = SESSION_TREE_MAX_DEPTH + 1
  while ((tree.depthOf.get(current.sessionId) ?? 0) > 0 && guard-- > 0) {
    const parent: T | undefined = current.parentSessionId
      ? tree.byId.get(current.parentSessionId)
      : undefined
    if (!parent) break
    current = parent
  }
  return current.sessionId
}

const reportedFallbacks = new Set<string>()

/**
 * Log each row that fell back to the top level, once per session id for the
 * life of the page, so a missing or looping parent is visible in the console
 * and never silently flattened.
 */
export function reportSessionTreeFallbacks<T extends TreeableSession>(
  fallbackIds: readonly string[],
  byId: ReadonlyMap<string, T>,
): void {
  for (const sessionId of fallbackIds) {
    if (reportedFallbacks.has(sessionId)) continue
    reportedFallbacks.add(sessionId)
    const row = byId.get(sessionId)
    console.warn(
      `[sidebar] session ${sessionId} names parent ${row?.parentSessionId ?? '?'}` +
        ' that is not listed, loops, or sits too deep; drawn top-level',
    )
  }
}

/** Test seam: forget which fallbacks were logged. */
export function resetSessionTreeFallbackReports(): void {
  reportedFallbacks.clear()
}
