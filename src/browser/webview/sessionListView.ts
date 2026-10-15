/**
 * The sidebar session list's view: how rows are grouped, which time they are
 * ordered by and in which direction — one pure function from (sessions, view,
 * now) to the ordered groups the list renders — plus this window's remembered
 * choice. (F-17)
 */
import type { MessageKey } from './i18n/messages/en'
import { sessionActivityTime, sessionTimeBucket } from './sessionTimeBucket'

export type SessionGroupBy = 'none' | 'status' | 'date' | 'week'
export type SessionSortField = 'updated' | 'created'
export type SessionSortDirection = 'desc' | 'asc'

export type SessionListView = {
  groupBy: SessionGroupBy
  field: SessionSortField
  direction: SessionSortDirection
}

export const DEFAULT_SESSION_LIST_VIEW: SessionListView = {
  groupBy: 'week',
  field: 'updated',
  direction: 'desc',
}

export const SESSION_GROUP_BYS: readonly SessionGroupBy[] = ['none', 'status', 'date', 'week']
export const SESSION_SORT_FIELDS: readonly SessionSortField[] = ['updated', 'created']
export const SESSION_SORT_DIRECTIONS: readonly SessionSortDirection[] = ['desc', 'asc']

/** The row fields the view reads. */
export type ListableSession = {
  sessionId: string
  updatedAt: number
  lastComposerEditAt?: number
  createdAt?: number
  running?: boolean
  needsAnswer?: boolean
}

/** A group header: a catalog entry, or a calendar day (local midnight) the renderer formats. */
export type SessionGroupLabel =
  | { kind: 'message'; key: MessageKey }
  | { kind: 'day'; dayStart: number }

export type SessionGroup<T> = {
  /** Stable and locale-independent; unique within one view. */
  key: string
  /** Absent: the group draws no header. */
  label?: SessionGroupLabel
  sessions: T[]
}

/** The time a row is ordered and grouped by; `undefined` = creation unknown. */
export function sessionOrderTime(
  session: ListableSession,
  field: SessionSortField,
): number | undefined {
  return field === 'created'
    ? session.createdAt
    : sessionActivityTime(session.updatedAt, session.lastComposerEditAt)
}

function compareNumbers(left: number, right: number): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * `sessions` sorted by `field` in `direction`, as a new array. An unknown
 * creation time counts as older than every known one (such sessions predate
 * the field); among themselves they order by activity. Ties break by id.
 */
export function orderSessions<T extends ListableSession>(
  sessions: readonly T[],
  field: SessionSortField,
  direction: SessionSortDirection,
): T[] {
  const sign = direction === 'asc' ? 1 : -1
  const activity = (session: T) =>
    sessionActivityTime(session.updatedAt, session.lastComposerEditAt)
  return [...sessions].sort((left, right) => {
    if (field === 'created') {
      const byCreated = compareNumbers(
        left.createdAt ?? Number.NEGATIVE_INFINITY,
        right.createdAt ?? Number.NEGATIVE_INFINITY,
      )
      if (byCreated !== 0) return sign * byCreated
    }
    const byActivity = compareNumbers(activity(left), activity(right))
    if (byActivity !== 0) return sign * byActivity
    return left.sessionId.localeCompare(right.sessionId)
  })
}

const STATUS_GROUPS = [
  'sidebar.needsAnswer',
  'sidebar.groupRunning',
  'sidebar.groupIdle',
] as const satisfies readonly MessageKey[]

/** A halted session waiting on the user outranks one that is merely running. */
function statusOf(session: ListableSession): (typeof STATUS_GROUPS)[number] {
  if (session.needsAnswer) return 'sidebar.needsAnswer'
  if (session.running) return 'sidebar.groupRunning'
  return 'sidebar.groupIdle'
}

function localDayStart(time: number): number {
  const day = new Date(time)
  day.setHours(0, 0, 0, 0)
  return day.getTime()
}

/** Today and yesterday read as words; earlier days as their date. */
function dayLabel(dayStart: number, now: number): SessionGroupLabel {
  const today = localDayStart(now)
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  if (dayStart === today) return { kind: 'message', key: 'sidebar.timeToday' }
  if (dayStart === yesterday.getTime()) {
    return { kind: 'message', key: 'sidebar.timeYesterday' }
  }
  return { kind: 'day', dayStart }
}

/** Group key + label of a row under a time grouping; unknown creation gets its own group. */
function timeGroupOf(
  session: ListableSession,
  view: SessionListView,
  now: number,
): { key: string; label: SessionGroupLabel } {
  const time = sessionOrderTime(session, view.field)
  if (view.groupBy === 'week') {
    const bucket =
      time === undefined ? 'sidebar.timeOlder' : sessionTimeBucket(time, now)
    return { key: bucket, label: { kind: 'message', key: bucket } }
  }
  if (time === undefined) {
    return {
      key: 'day:unknown',
      label: { kind: 'message', key: 'sidebar.groupDateUnknown' },
    }
  }
  const dayStart = localDayStart(time)
  return { key: `day:${dayStart}`, label: dayLabel(dayStart, now) }
}

/**
 * The list as it renders under `view`: groups in display order, each holding
 * its rows in display order. Status groups keep a fixed order (needs input,
 * running, idle); time groups follow the sort. Empty groups are left out.
 * A time grouping's first group draws no header when it is "Today" — the
 * list's own heading already says so. `now` is passed in so every row is
 * grouped against the same day boundary.
 */
export function buildSessionListView<T extends ListableSession>(
  sessions: readonly T[],
  view: SessionListView,
  now: number,
): SessionGroup<T>[] {
  const ordered = orderSessions(sessions, view.field, view.direction)
  if (ordered.length === 0) return []
  if (view.groupBy === 'none') return [{ key: 'all', sessions: ordered }]

  if (view.groupBy === 'status') {
    const byStatus = new Map<string, T[]>()
    for (const session of ordered) {
      const key = statusOf(session)
      const rows = byStatus.get(key)
      if (rows) rows.push(session)
      else byStatus.set(key, [session])
    }
    return STATUS_GROUPS.filter(key => byStatus.has(key)).map(key => ({
      key,
      label: { kind: 'message', key },
      sessions: byStatus.get(key)!,
    }))
  }

  const groups = new Map<string, SessionGroup<T>>()
  for (const session of ordered) {
    const { key, label } = timeGroupOf(session, view, now)
    const group = groups.get(key)
    if (group) group.sessions.push(session)
    else groups.set(key, { key, label, sessions: [session] })
  }
  const result = [...groups.values()]
  const first = result[0]
  if (
    first?.label?.kind === 'message' &&
    first.label.key === 'sidebar.timeToday'
  ) {
    result[0] = { key: first.key, sessions: first.sessions }
  }
  return result
}

/** A day group's header in `locale`, e.g. "Mon, Oct 13"; the year only when it is not this year's. */
export function formatGroupDay(dayStart: number, locale: string, now = Date.now()): string {
  const sameYear = new Date(dayStart).getFullYear() === new Date(now).getFullYear()
  return new Intl.DateTimeFormat(locale, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  }).format(dayStart)
}

/** One unlabeled group: a list that is already grouped by something else. */
export function ungroupedView<T>(sessions: T[]): SessionGroup<T>[] {
  return sessions.length > 0 ? [{ key: 'all', sessions }] : []
}

const STORAGE_KEY = 'nexus:sidebar:sessionListView'

function oneOf<V extends string>(value: unknown, allowed: readonly V[], fallback: V): V {
  return allowed.includes(value as V) ? (value as V) : fallback
}

/** This window's remembered view; each malformed or missing part falls back to its default. */
export function readSessionListView(): SessionListView {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_SESSION_LIST_VIEW
    const parsed = JSON.parse(raw) as Partial<Record<keyof SessionListView, unknown>> | null
    return {
      groupBy: oneOf(parsed?.groupBy, SESSION_GROUP_BYS, DEFAULT_SESSION_LIST_VIEW.groupBy),
      field: oneOf(parsed?.field, SESSION_SORT_FIELDS, DEFAULT_SESSION_LIST_VIEW.field),
      direction: oneOf(
        parsed?.direction,
        SESSION_SORT_DIRECTIONS,
        DEFAULT_SESSION_LIST_VIEW.direction,
      ),
    }
  } catch {
    return DEFAULT_SESSION_LIST_VIEW
  }
}

/** Remember `view` for this window. A view preference, so per-origin page storage. */
export function writeSessionListView(view: SessionListView): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(view))
  } catch {
    // Storage unavailable: the choice lasts for this page only.
  }
}
