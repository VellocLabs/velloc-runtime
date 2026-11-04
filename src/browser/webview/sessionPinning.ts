import {
  buildSessionListView,
  orderSessions,
  type ListableSession,
  type SessionGroup,
  type SessionListView,
} from './sessionListView'
import {
  flattenSessionTree,
  nestSessions,
  partitionArchived,
  type SessionTree,
  type TreeableSession,
} from './sessionTree'

/**
 * Pinned sessions list above unpinned ones. The partition is stable, so each
 * half keeps the caller's order (newest activity first).
 */
export function pinnedFirst<T extends { pinned?: boolean }>(
  sessions: readonly T[],
): T[] {
  const pinned = sessions.filter(session => session.pinned)
  if (pinned.length === 0) return [...sessions]
  return [...pinned, ...sessions.filter(session => !session.pinned)]
}

/**
 * The tree the docked list nests its rows by: the live sessions in the view's
 * order, a child of an archived parent drawn top-level. The archived rows
 * themselves are not in it (the Archived section lists them flat). (F-36)
 */
export function sidebarSessionTree<T extends ListableSession & TreeableSession>(
  sessions: readonly T[],
  view: SessionListView,
): SessionTree<T> {
  const { live, archivedIds } = partitionArchived(sessions)
  return nestSessions(orderSessions(live, view.field, view.direction), archivedIds)
}

/**
 * The docked sidebar's rows in display order: the Pinned section in the view's
 * order, then Recents in the view's grouping and order, each top-level row
 * followed by its children unless its id is in `collapsedParents`. A section
 * listed in `collapsed` contributes no rows (they are not on screen), and an
 * archived session is not among them (the Archived section lists it). (F-17)
 */
export function sidebarRowOrder<
  T extends ListableSession & TreeableSession & { pinned?: boolean },
>(
  sessions: readonly T[],
  view: SessionListView,
  now: number,
  collapsed: { pinned?: boolean; recents?: boolean } = {},
  collapsedParents: ReadonlySet<string> = new Set(),
): T[] {
  const tree = sidebarSessionTree(sessions, view)
  const pinned = collapsed.pinned
    ? []
    : orderSessions(tree.roots.filter(session => session.pinned), view.field, view.direction)
  const recents = collapsed.recents
    ? []
    : buildSessionListView(tree.roots.filter(session => !session.pinned), view, now)
        .flatMap(group => group.sessions)
  return flattenSessionTree([...pinned, ...recents], tree.childrenOf, collapsedParents)
}

/**
 * `buildSessionListView` with the pinned sessions lifted into one leading,
 * header-less group (in the view's order). The unpinned rows keep the view's
 * grouping, and their first group always draws its header, so rows below the
 * pinned block never read as part of it.
 */
export function buildPinnedFirstView<
  T extends ListableSession & { pinned?: boolean },
>(sessions: readonly T[], view: SessionListView, now: number): SessionGroup<T>[] {
  const pinned = sessions.filter(session => session.pinned)
  if (pinned.length === 0) return buildSessionListView(sessions, view, now)
  const rest = buildSessionListView(
    sessions.filter(session => !session.pinned),
    view,
    now,
  )
  const first = rest[0]
  if (first && !first.label && view.groupBy !== 'none') {
    rest[0] = { ...first, label: { kind: 'message', key: 'sidebar.timeToday' } }
  }
  return [
    {
      key: 'pinned',
      sessions: orderSessions(pinned, view.field, view.direction),
    },
    ...rest,
  ]
}
