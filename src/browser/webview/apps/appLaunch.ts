/**
 * Opening an app from its topbar icon (F-40): today's session of the app, or a
 * new one, shown with its A2UI pane covering the chat. An app session the
 * person never wrote in is left out of the session list unless it is on
 * screen. Page-side; the runtime seeds the folder when the session starts.
 */

import { openPane, setMaximized, type PaneWeightByKind, type SessionPaneRecord, type SidePaneKind } from '../layout/paneLayout'
import type { RightPanelPresenceEvent } from '../layout/rightPanelPresence'
import { sessionActivityTime, sessionTimeBucket } from '../sessionTimeBucket'
import { isSideChatUnderParent } from '../sideChat'

/** The fields the rules read; a `LocalSessionEntry` satisfies it. */
export type AppSessionEntry = {
  sessionId: string
  templateType?: string
  updatedAt: number
  lastComposerEditAt?: number
  messageCount?: number
  archived?: boolean
  spawnerSessionId?: string
  sideChat?: boolean
  detached?: boolean
  parentSessionId?: string
}

const NONE: ReadonlySet<string> = new Set()

/** The newest session of app `type` used on `now`'s local day; undefined when there is none. */
export function pickAppSession<T extends AppSessionEntry>(entries: readonly T[], type: string, now: number): T | undefined {
  let best: T | undefined
  let bestAt = -Infinity
  for (const entry of entries) {
    if (entry.templateType !== type || entry.archived || entry.spawnerSessionId || isSideChatUnderParent(entry)) continue
    const at = sessionActivityTime(entry.updatedAt, entry.lastComposerEditAt)
    if (at > 0 && sessionTimeBucket(at, now) === 'sidebar.timeToday' && at > bestAt) {
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
  if (appTypes.size === 0) return NONE
  const out = new Set<string>()
  for (const entry of entries) {
    if (entry.sessionId === activeSessionId) continue
    if (entry.templateType !== undefined && appTypes.has(entry.templateType) && entry.messageCount === 0) out.add(entry.sessionId)
  }
  return out.size === 0 ? NONE : out
}

/** The same ids as one string, so a memo keyed on it changes only when the ids do. */
export function unlistedAppSessionKey(ids: ReadonlySet<string>): string {
  return [...ids].sort().join('\n')
}

/** The ids back from `unlistedAppSessionKey`. */
export function unlistedAppSessionSet(key: string): ReadonlySet<string> {
  return key === '' ? NONE : new Set(key.split('\n'))
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
  /** The pane each session's pane shortcuts act on. */
  focusedPane: { readonly current: Map<string, SidePaneKind> },
  presentRightPanel: (event: RightPanelPresenceEvent) => void,
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
    focusedPane.current.set(sessionId, 'a2ui')
    presentRightPanel({ type: 'personOpen', view: 'a2ui' })
    return sessionId
  }
}
