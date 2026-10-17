import {
  buildSessionListView,
  orderSessions,
  type ListableSession,
  type SessionGroup,
  type SessionListView,
} from './sessionListView'

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
 * The docked sidebar's top-level rows in display order: the Pinned section in
 * the view's order, then Recents in the view's grouping and order. A section
 * listed in `collapsed` contributes no rows (they are not on screen). (F-17)
 */
export function sidebarRowOrder<
  T extends ListableSession & { pinned?: boolean },
>(
  sessions: readonly T[],
  view: SessionListView,
  now: number,
  collapsed: { pinned?: boolean; recents?: boolean } = {},
): T[] {
  const pinned = collapsed.pinned
    ? []
    : orderSessions(sessions.filter(session => session.pinned), view.field, view.direction)
  const recents = collapsed.recents
    ? []
    : buildSessionListView(sessions.filter(session => !session.pinned), view, now)
        .flatMap(group => group.sessions)
  return [...pinned, ...recents]
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
