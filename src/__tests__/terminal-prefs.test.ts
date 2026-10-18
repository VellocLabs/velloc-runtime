// @vitest-environment happy-dom
/** The viewer's terminal preferences (F-31): sanitized reads, coalesced writes, listeners. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_TERMINAL_PREFS,
  TERMINAL_PREFS_STORAGE_KEY,
  loadTerminalPrefs,
  resetTerminalPrefsForTests,
  sanitizeTerminalPrefs,
  subscribeTerminalPrefs,
  updateTerminalPrefs,
} from '@/browser/webview/terminal/terminalPrefs'

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
  resetTerminalPrefsForTests()
})
afterEach(() => {
  vi.unstubAllGlobals()
  resetTerminalPrefsForTests()
})

describe('sanitizeTerminalPrefs', () => {
  it('keeps readable fields and defaults the rest', () => {
    expect(sanitizeTerminalPrefs(null)).toEqual(DEFAULT_TERMINAL_PREFS)
    expect(sanitizeTerminalPrefs({ cursorStyle: 'block', cursorBlink: false, copyOnSelect: true, scrollbackLines: 5000 })).toEqual({
      cursorStyle: 'block',
      cursorBlink: false,
      copyOnSelect: true,
      scrollbackLines: 5000,
    })
    expect(sanitizeTerminalPrefs({ cursorStyle: 'wave', cursorBlink: 'yes', scrollbackLines: -3 })).toEqual(
      DEFAULT_TERMINAL_PREFS,
    )
    expect(sanitizeTerminalPrefs({ scrollbackLines: 1.5 }).scrollbackLines).toBe(DEFAULT_TERMINAL_PREFS.scrollbackLines)
  })
})

describe('terminal prefs store', () => {
  it('reads the stored blob, ignoring garbage', () => {
    localStorage.setItem(TERMINAL_PREFS_STORAGE_KEY, '{not json')
    expect(loadTerminalPrefs()).toEqual(DEFAULT_TERMINAL_PREFS)
    resetTerminalPrefsForTests()
    localStorage.setItem(TERMINAL_PREFS_STORAGE_KEY, JSON.stringify({ cursorStyle: 'underline' }))
    expect(loadTerminalPrefs().cursorStyle).toBe('underline')
  })

  it('writes an update, tells the listeners, and returns the same object for a no-op', () => {
    const listener = vi.fn()
    const release = subscribeTerminalPrefs(listener)
    const before = loadTerminalPrefs()
    expect(updateTerminalPrefs({ cursorBlink: true })).toBe(before)
    expect(listener).not.toHaveBeenCalled()
    const after = updateTerminalPrefs({ copyOnSelect: true, scrollbackLines: 50_000 })
    expect(after).toEqual({ ...before, copyOnSelect: true, scrollbackLines: 50_000 })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(JSON.parse(localStorage.getItem(TERMINAL_PREFS_STORAGE_KEY) ?? '{}')).toEqual(after)
    release()
    updateTerminalPrefs({ cursorStyle: 'block' })
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
