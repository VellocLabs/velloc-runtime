// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  DARK_CLASS,
  DARK_SCHEME_QUERY,
  GUEST_COLOR_SCHEME_STORAGE_KEY,
  applyGuestColorScheme,
  installGuestColorScheme,
  parseGuestColorScheme,
  readGuestColorScheme,
  resolveGuestColorSchemeDark,
  subscribeGuestColorScheme,
  writeGuestColorScheme,
} from '../browser/boot/guestColorScheme'

// This vitest realm's localStorage is not a working Storage; the module reads
// it at call time, so a Map-backed stub stands in.
const memoryStorage = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => memoryStorage.get(k) ?? null,
  setItem: (k: string, v: string) => void memoryStorage.set(k, String(v)),
  removeItem: (k: string) => void memoryStorage.delete(k),
  clear: () => memoryStorage.clear(),
})

type Listener = () => void

function fakeMatchMedia(initialDark: boolean) {
  const listeners = new Set<Listener>()
  const queries: string[] = []
  const mql = {
    matches: initialDark,
    addEventListener(_type: 'change', l: Listener) {
      listeners.add(l)
    },
    removeEventListener(_type: 'change', l: Listener) {
      listeners.delete(l)
    },
  }
  const win = {
    matchMedia(query: string) {
      queries.push(query)
      return mql
    },
  }
  const flip = (dark: boolean): void => {
    mql.matches = dark
    for (const l of listeners) l()
  }
  return { win, queries, flip, listeners }
}

afterEach(() => {
  memoryStorage.clear()
})

describe('parseGuestColorScheme / readGuestColorScheme', () => {
  it('parses the three valid values and rejects everything else', () => {
    expect(parseGuestColorScheme('light')).toBe('light')
    expect(parseGuestColorScheme('dark')).toBe('dark')
    expect(parseGuestColorScheme('system')).toBe('system')
    expect(parseGuestColorScheme('auto')).toBeNull()
    expect(parseGuestColorScheme('')).toBeNull()
    expect(parseGuestColorScheme(undefined)).toBeNull()
    expect(parseGuestColorScheme(null)).toBeNull()
  })

  it('reads the stored scheme, defaulting to system', () => {
    expect(readGuestColorScheme()).toBe('system')
    writeGuestColorScheme('dark')
    expect(readGuestColorScheme()).toBe('dark')
    expect(localStorage.getItem(GUEST_COLOR_SCHEME_STORAGE_KEY)).toBe('dark')
    // Garbage in storage reads as the default.
    localStorage.setItem(GUEST_COLOR_SCHEME_STORAGE_KEY, 'purple')
    expect(readGuestColorScheme()).toBe('system')
  })

  it('a throwing storage reads as system and never throws', () => {
    const throwing = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {},
    }
    expect(readGuestColorScheme(throwing)).toBe('system')
  })
})

describe('resolveGuestColorSchemeDark', () => {
  it('light and dark are literal; system reads the media query', () => {
    const { win } = fakeMatchMedia(true)
    expect(resolveGuestColorSchemeDark('light', win)).toBe(false)
    expect(resolveGuestColorSchemeDark('dark', win)).toBe(true)
    expect(resolveGuestColorSchemeDark('system', win)).toBe(true)
  })

  it('system follows a light OS', () => {
    const { win } = fakeMatchMedia(false)
    expect(resolveGuestColorSchemeDark('system', win)).toBe(false)
  })

  it('a window without matchMedia resolves system as light', () => {
    expect(resolveGuestColorSchemeDark('system', {})).toBe(false)
  })
})

describe('applyGuestColorScheme', () => {
  it('toggles the dark class on the root', () => {
    const root = document.createElement('html')
    applyGuestColorScheme(root, true)
    expect(root.classList.contains(DARK_CLASS)).toBe(true)
    applyGuestColorScheme(root, false)
    expect(root.classList.contains(DARK_CLASS)).toBe(false)
  })

  it('stands down once the host theme receiver has stamped the root', () => {
    const root = document.createElement('html')
    root.classList.add(DARK_CLASS)
    root.setAttribute('data-host-theme', 'dark')
    applyGuestColorScheme(root, false)
    expect(root.classList.contains(DARK_CLASS)).toBe(true)
  })
})

describe('installGuestColorScheme', () => {
  it('stamps the root with the stored scheme at install', () => {
    writeGuestColorScheme('dark')
    const root = document.createElement('html')
    const { win } = fakeMatchMedia(false)
    installGuestColorScheme(win, root)
    expect(root.classList.contains(DARK_CLASS)).toBe(true)
  })

  it('light clears the class', () => {
    writeGuestColorScheme('light')
    const root = document.createElement('html')
    root.classList.add(DARK_CLASS)
    const { win } = fakeMatchMedia(true)
    installGuestColorScheme(win, root)
    expect(root.classList.contains(DARK_CLASS)).toBe(false)
  })

  it('system mirrors the media query at install', () => {
    writeGuestColorScheme('system')
    const root = document.createElement('html')
    const { win, queries } = fakeMatchMedia(true)
    installGuestColorScheme(win, root)
    expect(queries.length).toBeGreaterThan(0)
    expect(queries[0]).toBe(DARK_SCHEME_QUERY)
    expect(root.classList.contains(DARK_CLASS)).toBe(true)
  })

  it('system follows OS flips until disposed', () => {
    writeGuestColorScheme('system')
    const root = document.createElement('html')
    const { win, flip } = fakeMatchMedia(false)
    const dispose = installGuestColorScheme(win, root)
    expect(root.classList.contains(DARK_CLASS)).toBe(false)
    flip(true)
    expect(root.classList.contains(DARK_CLASS)).toBe(true)
    flip(false)
    expect(root.classList.contains(DARK_CLASS)).toBe(false)
    dispose()
    flip(true)
    expect(root.classList.contains(DARK_CLASS)).toBe(false)
  })

  it('explicit light/dark does NOT subscribe to the OS query', () => {
    writeGuestColorScheme('dark')
    const root = document.createElement('html')
    const { win, flip } = fakeMatchMedia(false)
    installGuestColorScheme(win, root)
    expect(root.classList.contains(DARK_CLASS)).toBe(true)
    // An OS flip does NOT repaint an explicit choice.
    flip(true)
    flip(false)
    expect(root.classList.contains(DARK_CLASS)).toBe(true)
  })

  it('switching between system and explicit re-subscribes correctly', () => {
    writeGuestColorScheme('system')
    const root = document.createElement('html')
    const { win, flip, listeners } = fakeMatchMedia(false)
    const dispose = installGuestColorScheme(win, root)
    expect(listeners.size).toBe(1)

    // To explicit dark: the OS listener detaches; an OS flip is ignored.
    writeGuestColorScheme('dark')
    expect(root.classList.contains(DARK_CLASS)).toBe(true)
    expect(listeners.size).toBe(0)
    flip(true)
    flip(false)
    expect(root.classList.contains(DARK_CLASS)).toBe(true)

    // Back to system: re-attach, follow again.
    writeGuestColorScheme('system')
    expect(listeners.size).toBe(1)
    flip(true)
    expect(root.classList.contains(DARK_CLASS)).toBe(true)

    dispose()
  })

  it('is inert when the window has no matchMedia', () => {
    writeGuestColorScheme('system')
    const root = document.createElement('html')
    const dispose = installGuestColorScheme({}, root)
    expect(root.classList.contains(DARK_CLASS)).toBe(false)
    expect(() => dispose()).not.toThrow()
  })

  it('a write from outside notifies subscribers and re-stamps', () => {
    writeGuestColorScheme('light')
    const root = document.createElement('html')
    const { win } = fakeMatchMedia(false)
    installGuestColorScheme(win, root)
    expect(root.classList.contains(DARK_CLASS)).toBe(false)
    writeGuestColorScheme('dark')
    expect(root.classList.contains(DARK_CLASS)).toBe(true)
  })
})

describe('subscribeGuestColorScheme', () => {
  it('notifies on write and stops after unsubscribe', () => {
    const seen: string[] = []
    const unsub = subscribeGuestColorScheme((s) => seen.push(s))
    writeGuestColorScheme('dark')
    writeGuestColorScheme('light')
    unsub()
    writeGuestColorScheme('system')
    expect(seen).toEqual(['dark', 'light'])
  })
})
