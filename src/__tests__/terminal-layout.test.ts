// @vitest-environment happy-dom
/**
 * The remembered terminal layout and the page's slots (F-31): sanitizing,
 * the per-session memory with its eviction, blank tabs that turn into
 * terminals in place, the tab order, and distinct tab labels.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  TERMINAL_LAYOUT_MAX_SESSIONS,
  TERMINAL_LAYOUT_MAX_SLOTS,
  TERMINAL_LAYOUT_STORAGE_KEY,
  distinctTabLabels,
  forgetSessionTerminals,
  loadTerminalLayout,
  markPlaceholderStarting,
  orderedKeys,
  placeholderStarted,
  rememberSessionTerminals,
  removePlaceholder,
  resetTerminalSlotsForTests,
  restorePlaceholders,
  sanitizeTerminalLayout,
  sessionSlots,
  subscribeTerminalSlots,
} from '@/browser/webview/terminal/terminalLayout'

/** A Storage stand-in: the environment's localStorage lacks the methods the store calls. */
function fakeStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: key => map.get(key) ?? null,
    key: index => Array.from(map.keys())[index] ?? null,
    removeItem: key => {
      map.delete(key)
    },
    setItem: (key, value) => {
      map.set(key, String(value))
    },
  }
}

beforeEach(() => {
  vi.stubGlobal('localStorage', fakeStorage())
})
afterEach(() => {
  vi.unstubAllGlobals()
  resetTerminalSlotsForTests()
})

describe('sanitizeTerminalLayout', () => {
  it('keeps well-formed sessions and drops the rest', () => {
    const out = sanitizeTerminalLayout({
      sessions: {
        a: { slots: [{ shell: 'pwsh' }, { shell: null }, { shell: 'Bad Shell!' }, 'junk'], active: 1, at: 5 },
        b: { slots: 'nope' },
        c: { slots: [{ shell: 'cmd' }], active: 9 },
      },
    })
    expect(out.sessions.a).toEqual({ slots: [{ shell: 'pwsh' }, { shell: null }, { shell: null }], active: 1, at: 5 })
    expect(out.sessions.b).toBeUndefined()
    // An active index out of range falls back to the last slot.
    expect(out.sessions.c).toEqual({ slots: [{ shell: 'cmd' }], active: 0, at: 0 })
  })

  it('anything that is not a layout is empty', () => {
    expect(sanitizeTerminalLayout(null)).toEqual({ sessions: {} })
    expect(sanitizeTerminalLayout('x')).toEqual({ sessions: {} })
    expect(sanitizeTerminalLayout({ sessions: [] })).toEqual({ sessions: {} })
  })

  it('caps the slots per session', () => {
    const slots = Array.from({ length: TERMINAL_LAYOUT_MAX_SLOTS + 4 }, () => ({ shell: 'pwsh' }))
    expect(sanitizeTerminalLayout({ sessions: { a: { slots } } }).sessions.a?.slots).toHaveLength(TERMINAL_LAYOUT_MAX_SLOTS)
  })
})

describe('the per-session memory', () => {
  it('remembers, reads back, and forgets', () => {
    rememberSessionTerminals('s1', [{ shell: 'pwsh' }, { shell: 'cmd' }], 1, 10)
    expect(loadTerminalLayout().sessions.s1).toEqual({ slots: [{ shell: 'pwsh' }, { shell: 'cmd' }], active: 1, at: 10 })
    expect(JSON.parse(localStorage.getItem(TERMINAL_LAYOUT_STORAGE_KEY) ?? '{}').sessions.s1.slots).toHaveLength(2)
    forgetSessionTerminals('s1')
    expect(loadTerminalLayout().sessions.s1).toBeUndefined()
  })

  it('an unchanged write leaves the stored entry alone', () => {
    rememberSessionTerminals('s1', [{ shell: 'pwsh' }], 0, 10)
    rememberSessionTerminals('s1', [{ shell: 'pwsh' }], 0, 20)
    expect(loadTerminalLayout().sessions.s1?.at).toBe(10)
    rememberSessionTerminals('s1', [{ shell: 'pwsh' }], 0, 30)
  })

  it('evicts the least recently touched sessions past the cap', () => {
    for (let i = 0; i < TERMINAL_LAYOUT_MAX_SESSIONS + 3; i++) {
      rememberSessionTerminals(`s${i}`, [{ shell: 'pwsh' }], 0, i)
    }
    const ids = Object.keys(loadTerminalLayout().sessions)
    expect(ids).toHaveLength(TERMINAL_LAYOUT_MAX_SESSIONS)
    expect(ids).not.toContain('s0')
    expect(ids).not.toContain('s2')
    expect(ids).toContain(`s${TERMINAL_LAYOUT_MAX_SESSIONS + 2}`)
  })

  it('a corrupt store reads as empty and is replaced on the next write', () => {
    localStorage.setItem(TERMINAL_LAYOUT_STORAGE_KEY, '{not json')
    expect(loadTerminalLayout()).toEqual({ sessions: {} })
    rememberSessionTerminals('s1', [{ shell: null }], 0, 1)
    expect(loadTerminalLayout().sessions.s1?.slots).toEqual([{ shell: null }])
  })
})

describe('the page slots', () => {
  it('restores blank tabs, starts one in place, removes another, and tells its subscribers', () => {
    let notified = 0
    const release = subscribeTerminalSlots(() => notified++)
    const ids = restorePlaceholders('s1', ['pwsh', null, 'cmd'])
    expect(ids).toHaveLength(3)
    const first = sessionSlots('s1')
    expect(first.order).toEqual(ids)
    expect(first.placeholders.map(placeholder => placeholder.shell)).toEqual(['pwsh', null, 'cmd'])
    expect(notified).toBe(1)
    // The same object until something changes.
    expect(sessionSlots('s1')).toBe(first)

    markPlaceholderStarting('s1', ids[1]!, true)
    expect(sessionSlots('s1').placeholders[1]?.starting).toBe(true)
    markPlaceholderStarting('s1', ids[1]!, true)
    expect(notified).toBe(2)

    placeholderStarted('s1', ids[1]!, 'term_x')
    expect(sessionSlots('s1').order).toEqual([ids[0], 'term_x', ids[2]])
    expect(sessionSlots('s1').placeholders.map(placeholder => placeholder.id)).toEqual([ids[0], ids[2]])

    removePlaceholder('s1', ids[0]!)
    expect(sessionSlots('s1').order).toEqual(['term_x', ids[2]])
    // Another session is untouched.
    expect(sessionSlots('s2').placeholders).toHaveLength(0)
    release()
  })

  it('orderedKeys keeps known keys in order and appends new live ids', () => {
    expect(orderedKeys(['p1', 'term_a', 'p2', 'gone'], ['term_a', 'term_b'], ['p1', 'p2'])).toEqual([
      'p1',
      'term_a',
      'p2',
      'term_b',
    ])
    expect(orderedKeys([], ['term_a'], [])).toEqual(['term_a'])
  })
})

describe('distinctTabLabels', () => {
  it('numbers only the labels that repeat', () => {
    expect(distinctTabLabels(['pwsh', 'vim', 'pwsh', 'cmd'])).toEqual(['pwsh 1', 'vim', 'pwsh 2', 'cmd'])
    expect(distinctTabLabels(['pwsh'])).toEqual(['pwsh'])
    expect(distinctTabLabels([])).toEqual([])
  })
})
