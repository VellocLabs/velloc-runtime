/**
 * Memory age helpers: how old a saved memory is, the short age phrase the
 * recall header uses, and the caveat a stale memory carries for the model.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  describeSavedAge,
  staleMemoryCaveat,
  staleMemoryReminder,
  wholeDaysSince,
} from '../memory/memoryStaleness'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 5, 15, 12, 0, 0)

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})
afterEach(() => {
  vi.useRealTimers()
})

describe('whole days since a memory was saved', () => {
  it('is 0 for a memory saved just now', () => {
    expect(wholeDaysSince(NOW)).toBe(0)
    expect(wholeDaysSince(NOW - 1)).toBe(0)
    expect(wholeDaysSince(NOW - DAY + 1)).toBe(0)
  })

  it('counts completed 24-hour periods, rounding down', () => {
    expect(wholeDaysSince(NOW - DAY)).toBe(1)
    expect(wholeDaysSince(NOW - 5 * DAY)).toBe(5)
    expect(wholeDaysSince(NOW - 5.9 * DAY)).toBe(5)
    expect(wholeDaysSince(NOW - 400 * DAY)).toBe(400)
  })

  it('treats a save time in the future (clock skew) as today', () => {
    expect(wholeDaysSince(NOW + 1)).toBe(0)
    expect(wholeDaysSince(NOW + 10 * DAY)).toBe(0)
  })
})

describe('age phrase', () => {
  it('says today, yesterday, or N days ago', () => {
    expect(describeSavedAge(NOW)).toBe('today')
    expect(describeSavedAge(NOW + 3 * DAY)).toBe('today')
    expect(describeSavedAge(NOW - DAY)).toBe('yesterday')
    expect(describeSavedAge(NOW - 1.5 * DAY)).toBe('yesterday')
    expect(describeSavedAge(NOW - 2 * DAY)).toBe('2 days ago')
    expect(describeSavedAge(NOW - 47 * DAY)).toBe('47 days ago')
  })
})

describe('stale-memory caveat', () => {
  it('is empty for a memory saved today or yesterday', () => {
    expect(staleMemoryCaveat(NOW)).toBe('')
    expect(staleMemoryCaveat(NOW - DAY)).toBe('')
    expect(staleMemoryCaveat(NOW - 2 * DAY + 1)).toBe('')
    expect(staleMemoryCaveat(NOW + 9 * DAY)).toBe('')
  })

  it('from two days on, names the age and asks for a check against the code', () => {
    for (const days of [2, 10, 365]) {
      const text = staleMemoryCaveat(NOW - days * DAY)
      expect(text).toContain(`${days} days`)
      expect(text).toMatch(/code/i)
      expect(text).toMatch(/file:line/)
      expect(text).toMatch(/verif|check/i)
      expect(text).not.toContain('\n')
      expect(text).toBe(text.trim())
    }
  })

  it('is plain text, with no reminder tags of its own', () => {
    expect(staleMemoryCaveat(NOW - 3 * DAY)).not.toContain('<system-reminder>')
  })
})

describe('stale-memory reminder', () => {
  it('is empty for fresh memories', () => {
    expect(staleMemoryReminder(NOW)).toBe('')
    expect(staleMemoryReminder(NOW - DAY)).toBe('')
  })

  it('wraps the caveat in a system-reminder and ends with a newline', () => {
    const at = NOW - 3 * DAY
    expect(staleMemoryReminder(at)).toBe(
      `<system-reminder>${staleMemoryCaveat(at)}</system-reminder>\n`,
    )
  })
})
