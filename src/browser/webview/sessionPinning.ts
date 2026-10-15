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
