/**
 * The phone shell's drawer list (F-24): top-level, unarchived sessions only, pinned first, then the
 * desktop sidebar's default time groups, newest activity first, narrowed by a title filter.
 */
import { describe, expect, it } from 'vitest'

import { buildMobileSessionGroups, namedTitle, type MobileListSession } from '../mobile/mobileSessionGroups'

const DAY = 24 * 60 * 60 * 1000
const NOW = new Date(2026, 10, 16, 12, 0, 0).getTime()
const none = new Set<string>()

function session(sessionId: string, updatedAt: number, extra: Partial<MobileListSession> = {}): MobileListSession {
  return { sessionId, title: sessionId, updatedAt, ...extra }
}

describe('buildMobileSessionGroups', () => {
  it('lists pinned sessions first, then time groups, newest first', () => {
    const groups = buildMobileSessionGroups(
      [
        session('old', NOW - 40 * DAY),
        session('today-early', NOW - 60 * 60 * 1000),
        session('today-late', NOW - 60 * 1000),
        session('pinned-old', NOW - 10 * DAY, { pinned: true }),
      ],
      { query: '', running: none, needsAnswer: none, now: NOW },
    )
    expect(groups[0]).toMatchObject({ key: 'pinned', pinned: true, label: null })
    expect(groups[0].rows.map(r => r.sessionId)).toEqual(['pinned-old'])
    const rest = groups.slice(1).flatMap(g => g.rows.map(r => r.sessionId))
    expect(rest).toEqual(['today-late', 'today-early', 'old'])
    // Today draws no header; an older group does.
    expect(groups[1].label).toBeNull()
    expect(groups[groups.length - 1].label).not.toBeNull()
  })

  it('leaves out archived, sub-agent, side-chat and child sessions', () => {
    const groups = buildMobileSessionGroups(
      [
        session('root', NOW - 1000),
        session('archived', NOW - 2000, { archived: true }),
        session('sub-agent', NOW - 3000, { spawnerSessionId: 'root' }),
        session('side-chat', NOW - 4000, { sideChat: { parentSessionId: 'root' } }),
        session('child', NOW - 5000, { parentSessionId: 'root' }),
      ],
      { query: '', running: none, needsAnswer: none, now: NOW },
    )
    expect(groups.flatMap(g => g.rows.map(r => r.sessionId))).toEqual(['root'])
  })

  it('narrows by a case-insensitive title substring; blank lists everything', () => {
    const all = [
      session('a', NOW - 1000, { title: 'Fix the Login page' }),
      session('b', NOW - 2000, { title: 'Release notes' }),
    ]
    const narrowed = buildMobileSessionGroups(all, { query: '  login ', running: none, needsAnswer: none, now: NOW })
    expect(narrowed.flatMap(g => g.rows.map(r => r.sessionId))).toEqual(['a'])
    const none2 = buildMobileSessionGroups(all, { query: 'zzz', running: none, needsAnswer: none, now: NOW })
    expect(none2).toEqual([])
    const blank = buildMobileSessionGroups(all, { query: '   ', running: none, needsAnswer: none, now: NOW })
    expect(blank.flatMap(g => g.rows.map(r => r.sessionId))).toEqual(['a', 'b'])
  })

  it('lists an unnamed session with a blank title, which the filter does not match', () => {
    const all = [session('a', NOW - 1000, { title: 'New Thread' }), session('b', NOW - 2000, { title: ' Thread notes ' })]
    expect(buildMobileSessionGroups(all, { query: '', running: none, needsAnswer: none, now: NOW })[0].rows.map(r => r.title))
      .toEqual(['', 'Thread notes'])
    const narrowed = buildMobileSessionGroups(all, { query: 'new', running: none, needsAnswer: none, now: NOW })
    expect(narrowed).toEqual([])
    expect(namedTitle(undefined)).toBe('')
  })

  it('marks running and waiting rows, and ages a row by its later draft edit', () => {
    const [group] = buildMobileSessionGroups(
      [session('a', NOW - 5000, { lastComposerEditAt: NOW - 1000 }), session('b', NOW - 9000)],
      { query: '', running: new Set(['a']), needsAnswer: new Set(['b']), now: NOW },
    )
    expect(group.rows).toEqual([
      { sessionId: 'a', title: 'a', activityAt: NOW - 1000, running: true, needsAnswer: false },
      { sessionId: 'b', title: 'b', activityAt: NOW - 9000, running: false, needsAnswer: true },
    ])
  })
})
