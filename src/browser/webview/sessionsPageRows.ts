import { folderName } from './childSessionStatus'
import { sessionDisplayTitle, type SessionListItem } from './SessionRows'
import type { TranslateFn } from './i18n'
import { sessionActivityTime } from './sessionTimeBucket'

/** Which list the Sessions page shows. (F-17) */
export type SessionsPageTab = 'active' | 'archived'

/** One row of the Sessions page, ready to draw. */
export type SessionsPageRow = {
  session: SessionListItem
  title: string
  /** The project folder's name; absent for a session with no project. */
  project?: string
  /** Activity time the row is ordered and aged by. */
  activityAt: number
}

/**
 * The Sessions page's rows: every listed session of `tab`, flat (children are
 * not nested), newest activity first, kept to those whose title or project
 * name contains `query` (case-insensitive, trimmed; empty matches all).
 */
export function sessionsPageRows(
  sessions: readonly SessionListItem[],
  tab: SessionsPageTab,
  query: string,
  t: TranslateFn,
): SessionsPageRow[] {
  const needle = query.trim().toLocaleLowerCase()
  const rows: SessionsPageRow[] = []
  for (const session of sessions) {
    if (!!session.archived !== (tab === 'archived')) continue
    const title = sessionDisplayTitle(session, t)
    const project = folderName(session.projectRoot)
    if (
      needle &&
      !title.toLocaleLowerCase().includes(needle) &&
      !(project ?? '').toLocaleLowerCase().includes(needle)
    ) {
      continue
    }
    rows.push({
      session,
      title,
      project,
      activityAt: sessionActivityTime(session.updatedAt, session.lastComposerEditAt),
    })
  }
  return rows.sort((a, b) => b.activityAt - a.activityAt)
}
