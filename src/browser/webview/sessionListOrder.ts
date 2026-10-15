/**
 * The sidebar session list's sort order: which time it orders by and in which
 * direction, plus this window's remembered choice. (F-17)
 */
import { sessionActivityTime } from './sessionTimeBucket'

export type SessionSortField = 'updated' | 'created'
export type SessionSortDirection = 'desc' | 'asc'

export type SessionListOrder = {
  field: SessionSortField
  direction: SessionSortDirection
}

export const DEFAULT_SESSION_LIST_ORDER: SessionListOrder = {
  field: 'updated',
  direction: 'desc',
}

type OrderableSession = {
  sessionId: string
  updatedAt: number
  lastComposerEditAt?: number
  createdAt?: number
}

/** The time a row is ordered and day-grouped by; `undefined` = creation unknown. */
export function sessionOrderTime(
  session: OrderableSession,
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
 * `sessions` in `order`, as a new array. An unknown creation time counts as
 * older than every known one (such sessions predate the field); among
 * themselves they order by activity. Ties break by id, so the order is stable.
 */
export function orderSessions<T extends OrderableSession>(
  sessions: readonly T[],
  order: SessionListOrder,
): T[] {
  const sign = order.direction === 'asc' ? 1 : -1
  const activity = (session: T) =>
    sessionActivityTime(session.updatedAt, session.lastComposerEditAt)
  return [...sessions].sort((left, right) => {
    if (order.field === 'created') {
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

const STORAGE_KEY = 'nexus:sidebar:sessionOrder'

/** This window's remembered order; the default when none is stored or it is malformed. */
export function readSessionListOrder(): SessionListOrder {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_SESSION_LIST_ORDER
    const parsed = JSON.parse(raw) as Partial<SessionListOrder> | null
    const field =
      parsed?.field === 'created' || parsed?.field === 'updated'
        ? parsed.field
        : DEFAULT_SESSION_LIST_ORDER.field
    const direction =
      parsed?.direction === 'asc' || parsed?.direction === 'desc'
        ? parsed.direction
        : DEFAULT_SESSION_LIST_ORDER.direction
    return { field, direction }
  } catch {
    return DEFAULT_SESSION_LIST_ORDER
  }
}

/** Remember `order` for this window. A view preference, so per-origin page storage. */
export function writeSessionListOrder(order: SessionListOrder): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(order))
  } catch {
    // Storage unavailable: the choice lasts for this page only.
  }
}
