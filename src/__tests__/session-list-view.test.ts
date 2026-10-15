import { describe, expect, it } from 'vitest'
import {
  buildSessionListView,
  formatGroupDay,
  orderSessions,
  SESSION_GROUP_BYS,
  SESSION_SORT_DIRECTIONS,
  SESSION_SORT_FIELDS,
  type ListableSession,
  type SessionGroup,
  type SessionListView,
} from '../browser/webview/sessionListView'

// The session list's one view function: every group-by × sort field × direction
// combination over one fixture, as an exact shape, plus the invariants every
// combination must keep. (F-17)

/** Local wall-clock time `daysAgo` days before the fixed "now", at `hour`:00. */
function at(daysAgo: number, hour: number): number {
  return new Date(2026, 9, 15 - daysAgo, hour, 0, 0, 0).getTime()
}

const NOW = at(0, 12)

type Row = ListableSession & { sessionId: string }

// Activity: a (today 10:00) > f (today 08:00, a draft) > b > c > d > e.
// Creation: f (today) > b (yesterday) > c (3 d) > a (20 d) > d (40 d) > e (unknown).
// Status: b and d need input (d is also running — needs input wins), a runs,
// c / e / f are idle.
const SESSIONS: Row[] = [
  { sessionId: 'a', updatedAt: at(0, 10), createdAt: at(20, 9), running: true },
  { sessionId: 'b', updatedAt: at(1, 15), createdAt: at(1, 9), needsAnswer: true },
  { sessionId: 'c', updatedAt: at(3, 9), createdAt: at(3, 8) },
  { sessionId: 'd', updatedAt: at(10, 9), createdAt: at(40, 9), running: true, needsAnswer: true },
  { sessionId: 'e', updatedAt: at(50, 9) },
  { sessionId: 'f', updatedAt: at(0, 7), lastComposerEditAt: at(0, 8), createdAt: at(0, 7) },
]

/**
 * A group as `key=ids`; a group without a header is wrapped in parentheses.
 * Day keys read as `day-N` (N days before now), so the table is timezone-free.
 */
function shape(groups: SessionGroup<Row>[]): string[] {
  return groups.map(group => {
    let key = group.key
    const day = /^day:(\d+)$/.exec(key)
    if (day) {
      const daysAgo = Math.round((at(0, 0) - Number(day[1])) / 86_400_000)
      key = `day-${daysAgo}`
    }
    const body = `${key}=${group.sessions.map(s => s.sessionId).join(',')}`
    return group.label ? body : `(${body})`
  })
}

const T = 'sidebar.time'
const EXPECTED: Record<string, string[]> = {
  'none|updated|desc': ['(all=a,f,b,c,d,e)'],
  'none|updated|asc': ['(all=e,d,c,b,f,a)'],
  'none|created|desc': ['(all=f,b,c,a,d,e)'],
  'none|created|asc': ['(all=e,d,a,c,b,f)'],

  'status|updated|desc': ['sidebar.needsAnswer=b,d', 'sidebar.groupRunning=a', 'sidebar.groupIdle=f,c,e'],
  'status|updated|asc': ['sidebar.needsAnswer=d,b', 'sidebar.groupRunning=a', 'sidebar.groupIdle=e,c,f'],
  'status|created|desc': ['sidebar.needsAnswer=b,d', 'sidebar.groupRunning=a', 'sidebar.groupIdle=f,c,e'],
  'status|created|asc': ['sidebar.needsAnswer=d,b', 'sidebar.groupRunning=a', 'sidebar.groupIdle=e,c,f'],

  'date|updated|desc': ['(day-0=a,f)', 'day-1=b', 'day-3=c', 'day-10=d', 'day-50=e'],
  'date|updated|asc': ['day-50=e', 'day-10=d', 'day-3=c', 'day-1=b', 'day-0=f,a'],
  'date|created|desc': ['(day-0=f)', 'day-1=b', 'day-3=c', 'day-20=a', 'day-40=d', 'day:unknown=e'],
  'date|created|asc': ['day:unknown=e', 'day-40=d', 'day-20=a', 'day-3=c', 'day-1=b', 'day-0=f'],

  'week|updated|desc': [`(${T}Today=a,f)`, `${T}Yesterday=b`, `${T}Previous7Days=c`, `${T}Previous30Days=d`, `${T}Older=e`],
  'week|updated|asc': [`${T}Older=e`, `${T}Previous30Days=d`, `${T}Previous7Days=c`, `${T}Yesterday=b`, `${T}Today=f,a`],
  'week|created|desc': [`(${T}Today=f)`, `${T}Yesterday=b`, `${T}Previous7Days=c`, `${T}Previous30Days=a`, `${T}Older=d,e`],
  'week|created|asc': [`${T}Older=e,d`, `${T}Previous30Days=a`, `${T}Previous7Days=c`, `${T}Yesterday=b`, `${T}Today=f`],
}

const ALL_VIEWS: SessionListView[] = SESSION_GROUP_BYS.flatMap(groupBy =>
  SESSION_SORT_FIELDS.flatMap(field =>
    SESSION_SORT_DIRECTIONS.map(direction => ({ groupBy, field, direction })),
  ),
)

const label = (view: SessionListView) => `${view.groupBy}|${view.field}|${view.direction}`

describe('buildSessionListView — every combination', () => {
  it('the table covers every combination', () => {
    expect(ALL_VIEWS.map(label).sort()).toEqual(Object.keys(EXPECTED).sort())
  })

  for (const view of ALL_VIEWS) {
    describe(label(view), () => {
      const groups = buildSessionListView(SESSIONS, view, NOW)

      it('has the expected groups, headers and rows', () => {
        expect(shape(groups)).toEqual(EXPECTED[label(view)])
      })

      it('lists every session exactly once', () => {
        const ids = groups.flatMap(g => g.sessions.map(s => s.sessionId))
        expect([...ids].sort()).toEqual(SESSIONS.map(s => s.sessionId).sort())
      })

      it('keeps the sort inside every group', () => {
        const order = orderSessions(SESSIONS, view.field, view.direction).map(s => s.sessionId)
        for (const group of groups) {
          const ids = group.sessions.map(s => s.sessionId)
          expect(ids).toEqual(order.filter(id => ids.includes(id)))
        }
      })

      it('gives each group a unique key and no empty group', () => {
        expect(new Set(groups.map(g => g.key)).size).toBe(groups.length)
        expect(groups.every(g => g.sessions.length > 0)).toBe(true)
      })

      if (view.groupBy !== 'status') {
        it('reads, flattened, exactly as the plain sort', () => {
          expect(groups.flatMap(g => g.sessions.map(s => s.sessionId))).toEqual(
            orderSessions(SESSIONS, view.field, view.direction).map(s => s.sessionId),
          )
        })
      }
    })
  }
})

describe('buildSessionListView — edges', () => {
  it('an empty list has no groups under any view', () => {
    for (const view of ALL_VIEWS) expect(buildSessionListView([], view, NOW)).toEqual([])
  })

  it('a header-less "Today" happens only when it is the first group', () => {
    const groups = buildSessionListView(
      SESSIONS,
      { groupBy: 'week', field: 'updated', direction: 'asc' },
      NOW,
    )
    expect(groups.at(-1)?.label).toEqual({ kind: 'message', key: 'sidebar.timeToday' })
  })

  it('a list that starts before today labels its first group', () => {
    const old = SESSIONS.filter(s => s.sessionId === 'c' || s.sessionId === 'e')
    const groups = buildSessionListView(
      old,
      { groupBy: 'week', field: 'updated', direction: 'desc' },
      NOW,
    )
    expect(shape(groups)).toEqual([`${T}Previous7Days=c`, `${T}Older=e`])
  })

  it('day groups older than yesterday carry their day for the renderer to format', () => {
    const groups = buildSessionListView(
      SESSIONS,
      { groupBy: 'date', field: 'updated', direction: 'desc' },
      NOW,
    )
    expect(groups[1]?.label).toEqual({ kind: 'message', key: 'sidebar.timeYesterday' })
    expect(groups[2]?.label).toEqual({ kind: 'day', dayStart: at(3, 0) })
  })

  it('a composer edit is activity: a drafted old session joins today', () => {
    const drafted = [{ sessionId: 'old', updatedAt: at(9, 9), lastComposerEditAt: at(0, 11) }]
    const groups = buildSessionListView(
      drafted,
      { groupBy: 'week', field: 'updated', direction: 'desc' },
      NOW,
    )
    expect(shape(groups)).toEqual([`(${T}Today=old)`])
  })

  it('equal times break ties by id in both directions', () => {
    const tied = [
      { sessionId: 'y', updatedAt: at(2, 9) },
      { sessionId: 'x', updatedAt: at(2, 9) },
    ]
    for (const direction of SESSION_SORT_DIRECTIONS) {
      expect(orderSessions(tied, 'updated', direction).map(s => s.sessionId)).toEqual(['x', 'y'])
    }
  })

  it('does not mutate its input', () => {
    const input = [...SESSIONS]
    buildSessionListView(input, { groupBy: 'status', field: 'created', direction: 'asc' }, NOW)
    expect(input).toEqual(SESSIONS)
  })
})

describe('formatGroupDay', () => {
  it('names the weekday and date in the given locale', () => {
    const text = formatGroupDay(at(3, 0), 'en', NOW)
    expect(text).toContain('Oct')
    expect(text).toContain('12')
    expect(text).not.toContain('2026')
  })

  it('adds the year for a day in another year', () => {
    expect(formatGroupDay(new Date(2025, 11, 30).getTime(), 'en', NOW)).toContain('2025')
  })
})
