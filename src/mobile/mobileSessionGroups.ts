/**
 * The phone shell's session list (F-24): the same order and groups as the desktop sidebar's
 * default view, built from the same pure helpers. Only top-level, unarchived sessions are listed;
 * a title filter narrows them.
 */
import { DEFAULT_SESSION_LIST_VIEW, orderSessions, type SessionGroupLabel } from '../browser/webview/sessionListView'
import { buildPinnedFirstView } from '../browser/webview/sessionPinning'
import { sessionActivityTime } from '../browser/webview/sessionTimeBucket'
import { nestSessions, partitionArchived } from '../browser/webview/sessionTree'
import type { SessionLineageKind } from '../sessions/sessionLineage'

/** The title a session carries until it is named; the phone shows it as untitled. */
const UNNAMED_SESSION_TITLE = 'New Thread'

/** `title`, or blank for an unnamed session, so callers show their own untitled label. */
export function namedTitle(title: string | undefined): string {
  const trimmed = (title ?? '').trim()
  return trimmed === UNNAMED_SESSION_TITLE ? '' : trimmed
}

/** The session fields the list reads. */
export type MobileListSession = {
  sessionId: string
  title: string
  updatedAt: number
  createdAt?: number
  lastComposerEditAt?: number
  pinned?: boolean
  archived?: boolean
  spawnerSessionId?: string
  sideChat?: unknown
  parentSessionId?: string
  lineageKind?: SessionLineageKind
  detached?: boolean
}

export type MobileSessionRow = {
  sessionId: string
  title: string
  /** Last activity: the later of the last transcript change and the last draft edit. */
  activityAt: number
  running: boolean
  needsAnswer: boolean
}

export type MobileSessionGroup = {
  key: string
  /** `null`: no header (the pinned group has its own; "Today" draws none). */
  label: SessionGroupLabel | null
  pinned: boolean
  rows: MobileSessionRow[]
}

export type MobileListOptions = {
  /** Case-insensitive substring of the title; blank lists everything. */
  query: string
  running: ReadonlySet<string>
  needsAnswer: ReadonlySet<string>
  now: number
}

type Listed = MobileListSession & { running: boolean; needsAnswer: boolean }

function toRow(s: Listed): MobileSessionRow {
  return {
    sessionId: s.sessionId,
    title: namedTitle(s.title),
    activityAt: sessionActivityTime(s.updatedAt, s.lastComposerEditAt),
    running: s.running,
    needsAnswer: s.needsAnswer,
  }
}

/** Pinned sessions first, then the default time groups. Empty groups are left out. */
export function buildMobileSessionGroups(
  sessions: readonly MobileListSession[],
  options: MobileListOptions,
): MobileSessionGroup[] {
  const listed: Listed[] = sessions
    .filter(s => !s.spawnerSessionId && !s.sideChat)
    .map(s => ({
      ...s,
      running: options.running.has(s.sessionId),
      needsAnswer: options.needsAnswer.has(s.sessionId),
    }))
  const ordered = orderSessions(listed, DEFAULT_SESSION_LIST_VIEW.field, DEFAULT_SESSION_LIST_VIEW.direction)
  const { live, archivedIds } = partitionArchived(ordered)
  const query = options.query.trim().toLocaleLowerCase()
  const roots = nestSessions(live, archivedIds).roots.filter(
    s => query === '' || namedTitle(s.title).toLocaleLowerCase().includes(query),
  )
  return buildPinnedFirstView(roots, DEFAULT_SESSION_LIST_VIEW, options.now).map(g => ({
    key: g.key,
    label: g.label ?? null,
    pinned: g.key === 'pinned',
    rows: g.sessions.map(toRow),
  }))
}
