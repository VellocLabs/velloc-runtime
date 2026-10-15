import { describe, expect, it } from 'vitest'
import {
  sessionActivityTime,
  sessionTimeBucket,
} from '../browser/webview/sessionTimeBucket'
import { dialogueDigest, sanitizeTitle } from '../sessions/sessionTitles'
import type { Message } from '../runtime/RuntimeTypes'

// Recents-list relative-time grouping (Part 1) + the conversation-text input
// to AI session naming (Part 2). Both are pure + boundary-prone.

describe('sessionTimeBucket', () => {
  // Fixed "now": 2026-06-04 14:00 local (month is 0-indexed → 5 = June).
  const now = new Date(2026, 5, 4, 14, 0, 0).getTime()
  const at = (y: number, m: number, d: number, h = 12) =>
    new Date(y, m, d, h).getTime()

  it('buckets same-day timestamps as Today', () => {
    expect(sessionTimeBucket(at(2026, 5, 4, 1), now)).toBe('sidebar.timeToday')
    expect(sessionTimeBucket(now, now)).toBe('sidebar.timeToday')
  })

  it('buckets the prior calendar day as Yesterday', () => {
    expect(sessionTimeBucket(at(2026, 5, 3), now)).toBe('sidebar.timeYesterday')
  })

  it('buckets by CALENDAR date, not elapsed time (a late-night session past midnight is Yesterday)', () => {
    // Now is 01:00; a session last active at 23:00 *yesterday* is only ~2h ago,
    // but on yesterday's calendar date → "Yesterday", never "Today".
    const at1am = new Date(2026, 5, 4, 1, 0, 0).getTime()
    expect(
      sessionTimeBucket(new Date(2026, 5, 3, 23, 0, 0).getTime(), at1am),
    ).toBe('sidebar.timeYesterday')
    // …while a session at 00:30 today (30 min ago) is "Today".
    expect(
      sessionTimeBucket(new Date(2026, 5, 4, 0, 30, 0).getTime(), at1am),
    ).toBe('sidebar.timeToday')
  })

  it('buckets 2–7 days back as Previous 7 days', () => {
    expect(sessionTimeBucket(at(2026, 5, 2), now)).toBe('sidebar.timePrevious7Days')
    expect(sessionTimeBucket(at(2026, 4, 29), now)).toBe('sidebar.timePrevious7Days')
  })

  it('buckets ~8–30 days back as Previous 30 days', () => {
    expect(sessionTimeBucket(at(2026, 4, 20), now)).toBe('sidebar.timePrevious30Days')
  })

  it('buckets older than 30 days as Older', () => {
    expect(sessionTimeBucket(at(2026, 3, 1), now)).toBe('sidebar.timeOlder')
  })

  it('is monotonic across the day boundaries (newest-first ordering)', () => {
    const order = [
      sessionTimeBucket(at(2026, 5, 4), now),
      sessionTimeBucket(at(2026, 5, 3), now),
      sessionTimeBucket(at(2026, 5, 1), now),
      sessionTimeBucket(at(2026, 4, 15), now),
      sessionTimeBucket(at(2026, 0, 1), now),
    ]
    expect(order).toEqual([
      'sidebar.timeToday',
      'sidebar.timeYesterday',
      'sidebar.timePrevious7Days',
      'sidebar.timePrevious30Days',
      'sidebar.timeOlder',
    ])
  })
})

describe('sessionActivityTime (sort key === bucket key)', () => {
  const now = new Date(2026, 5, 4, 14, 0, 0).getTime()
  const D = 86_400_000
  const H = 3_600_000

  it('returns the newer of updatedAt and lastComposerEditAt', () => {
    expect(sessionActivityTime(100, 200)).toBe(200)
    expect(sessionActivityTime(500, 200)).toBe(500)
    expect(sessionActivityTime(100)).toBe(100) // no draft
    expect(sessionActivityTime(100, 0)).toBe(100)
  })

  it('buckets a draft-floated old session by its draft (separators stay monotonic)', () => {
    // Old transcript (5 days ago) but a fresh unsent draft (1h ago) floats the
    // row to the top. Bucketing by the activity time (what the row sorts by)
    // keeps it in "Today", consistent with its position…
    const updatedAt = now - 5 * D
    const draftAt = now - 1 * H
    expect(
      sessionTimeBucket(sessionActivityTime(updatedAt, draftAt), now),
    ).toBe('sidebar.timeToday')
    // …whereas bucketing by `updatedAt` alone wrongly said "Previous 7 days",
    // producing the out-of-order separator bug this guards against.
    expect(sessionTimeBucket(updatedAt, now)).toBe('sidebar.timePrevious7Days')
  })
})

describe('dialogueDigest (AI naming input)', () => {
  const userMsg = (text: string) =>
    ({ type: 'user', message: { content: [{ type: 'text', text }] } }) as Message
  const asstMsg = (text: string) =>
    ({
      type: 'assistant',
      message: { content: [{ type: 'text', text }] },
    }) as Message

  it('includes visible user + assistant text', () => {
    const out = dialogueDigest([
      userMsg('fix the login bug'),
      asstMsg('sure, here is the fix'),
    ])
    expect(out).toContain('fix the login bug')
    expect(out).toContain('sure, here is the fix')
  })

  it('skips post-compact (isMeta) and tool-result messages', () => {
    const meta = {
      type: 'user',
      isMeta: true,
      message: { content: [{ type: 'text', text: 'COMPACT_SUMMARY' }] },
    } as Message
    const toolRes = {
      type: 'user',
      toolUseResult: {},
      message: { content: [{ type: 'text', text: 'TOOL_OUTPUT' }] },
    } as Message
    const out = dialogueDigest([meta, toolRes, userMsg('real prompt')])
    expect(out).toContain('real prompt')
    expect(out).not.toContain('COMPACT_SUMMARY')
    expect(out).not.toContain('TOOL_OUTPUT')
  })

  it('returns empty string when there is no visible conversation', () => {
    expect(dialogueDigest([])).toBe('')
  })
})

describe('sanitizeTitle (AI naming output — human-readable, not a slug)', () => {
  it('keeps natural casing and spaces', () => {
    expect(sanitizeTitle('Fix login redirect bug')).toBe('Fix login redirect bug')
  })

  it('strips wrapping quotes and backticks', () => {
    expect(sanitizeTitle('"Add OAuth support"')).toBe('Add OAuth support')
    expect(sanitizeTitle('`Debug failing tests`')).toBe('Debug failing tests')
  })

  it('collapses whitespace and drops trailing sentence punctuation', () => {
    expect(sanitizeTitle('Refactor   the API client.')).toBe('Refactor the API client')
  })

  it('uses only the first line of the reply', () => {
    expect(sanitizeTitle('Plan the trip\nHere is why...')).toBe('Plan the trip')
  })

  it('caps the length', () => {
    expect((sanitizeTitle('word '.repeat(40)) ?? '').length).toBeLessThanOrEqual(60)
  })

  it('returns null for blank input', () => {
    expect(sanitizeTitle('   ')).toBeNull()
  })
})
