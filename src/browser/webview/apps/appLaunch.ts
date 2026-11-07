/**
 * Opening an app from its topbar icon (F-40): today's session of the app, or a
 * new one, shown with its A2UI pane covering the chat. An app session the
 * person never wrote in is left out of the session list unless it is on
 * screen. Page-side; the runtime seeds the folder when the session starts.
 */

import { openPane, setMaximized, type PaneWeightByKind, type SessionPaneRecord } from '../layout/paneLayout'
import { sessionActivityTime } from '../sessionTimeBucket'

/** The fields the rules read; a `LocalSessionEntry` satisfies it. */
export type AppSessionEntry = {
  sessionId: string
  templateType?: string
  updatedAt: number
  lastComposerEditAt?: number
  messageCount?: number
  archived?: boolean
  spawnerSessionId?: string
}

const sameLocalDay = (a: number, b: number): boolean => {
  const x = new Date(a)
  const y = new Date(b)
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate()
}

/** The newest session of app `type` used on `now`'s local day; undefined when there is none. */
export function pickAppSession<T extends AppSessionEntry>(entries: readonly T[], type: string, now: number): T | undefined {
  let best: T | undefined
  let bestAt = -Infinity
  for (const entry of entries) {
    if (entry.templateType !== type || entry.archived || entry.spawnerSessionId) continue
    const at = sessionActivityTime(entry.updatedAt, entry.lastComposerEditAt)
    if (at > 0 && sameLocalDay(at, now) && at > bestAt) {
      best = entry
      bestAt = at
    }
  }
  return best
}

/** App sessions the person never wrote in, except the one on screen. */
export function unlistedAppSessionIds(
  entries: readonly AppSessionEntry[],
  appTypes: ReadonlySet<string>,
  activeSessionId: string | undefined,
): ReadonlySet<string> {
  const out = new Set<string>()
  if (appTypes.size === 0) return out
  for (const entry of entries) {
    if (entry.sessionId === activeSessionId) continue
    if (entry.templateType !== undefined && appTypes.has(entry.templateType) && entry.messageCount === 0) out.add(entry.sessionId)
  }
  return out
}

/** The pane record an app opens with: the A2UI pane open and covering the chat. */
export function appPaneRecord(record: SessionPaneRecord, weights: PaneWeightByKind): SessionPaneRecord {
  return setMaximized(openPane(record, 'a2ui', weights), 'a2ui')
}

/**
 * The topbar's app press: focus or open the app's session, then show its pane.
 * Plain-name inputs, so the shell's memo holds no render scope.
 */
export function createOpenApp<T extends AppSessionEntry>(
  sessions: { readonly current: readonly T[] },
  focusSession: (sessionId: string) => void,
  /** Opens a session of `type` (an empty one of that type may be reused); its id. */
  openNewSession: (type: string) => string,
  updatePaneRecord: (fn: (prev: SessionPaneRecord) => SessionPaneRecord, sessionId?: string) => void,
  layouts: { getSnapshot(): { weights: PaneWeightByKind } },
  now: () => number = Date.now,
): (type: string) => string {
  return type => {
    const today = pickAppSession(sessions.current, type, now())
    let sessionId: string
    if (today) {
      sessionId = today.sessionId
      focusSession(sessionId)
    } else {
      sessionId = openNewSession(type)
    }
    updatePaneRecord(record => appPaneRecord(record, layouts.getSnapshot().weights), sessionId)
    return sessionId
  }
}
