// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  GUEST_PALETTE_STORAGE_KEY,
  readGuestPalette,
  writeGuestPalette,
} from '../browser/boot/guestPalette'

import {
  HOST_THEME_APPLIED_ATTR,
  HOST_THEME_ROLE_TOKENS,
  NEXUS_THEME_MESSAGE_TYPE,
  applyHostTheme,
  installHostThemeListener,
  isTrustedHostOrigin,
} from '../browser/boot/hostTheme'

// This vitest realm's `localStorage` is not a working Storage; the palette
// reads it at call time, so a Map-backed stub stands in.
const memoryStorage = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => memoryStorage.get(k) ?? null,
  setItem: (k: string, v: string) => void memoryStorage.set(k, String(v)),
  removeItem: (k: string) => void memoryStorage.delete(k),
  clear: () => memoryStorage.clear(),
})

/**
 * The guest paints Chrome's LIVE colours only through this module: the host
 * posts resolved role colours, and the roles land on the design tokens as
 * inline custom properties on <html>. These pin the contract: the mapping
 * writes the right tokens, hairlines get the outline at reduced alpha,
 * non-colour values are refused, a later payload clears what an earlier one
 * set, and the listener accepts only a well-formed `nexus-theme` message.
 */

const DARK = {
  scheme: 'dark' as const,
  colors: {
    surface: 'rgb(31, 31, 31)',
    toolbar: 'rgb(60, 60, 60)',
    base: 'rgb(60, 60, 60)',
    surfaceRaised: 'rgb(39, 40, 42)',
    textPrimary: 'rgb(227, 227, 227)',
    outline: 'rgb(142, 145, 143)',
    primary: 'rgb(168, 199, 250)',
    onPrimary: 'rgb(6, 46, 111)',
  },
}

describe('applyHostTheme', () => {
  it('maps roles onto their design tokens and stamps the scheme', () => {
    const root = document.createElement('html')
    const n = applyHostTheme(root, DARK)
    expect(root.style.getPropertyValue('--background')).toBe('rgb(31, 31, 31)')
    expect(root.style.getPropertyValue('--toolbar')).toBe('rgb(60, 60, 60)')
    expect(root.style.getPropertyValue('--base')).toBe('rgb(60, 60, 60)')
    expect(root.style.getPropertyValue('--card')).toBe('rgb(39, 40, 42)')
    expect(root.style.getPropertyValue('--popover')).toBe('rgb(39, 40, 42)')
    expect(root.style.getPropertyValue('--foreground')).toBe('rgb(227, 227, 227)')
    expect(root.style.getPropertyValue('--sidebar-foreground')).toBe('rgb(227, 227, 227)')
    expect(root.style.getPropertyValue('--primary')).toBe('rgb(168, 199, 250)')
    expect(root.style.getPropertyValue('--primary-foreground')).toBe('rgb(6, 46, 111)')
    expect(root.getAttribute(HOST_THEME_APPLIED_ATTR)).toBe('dark')
    expect(root.classList.contains('dark'), 'host scheme drives the class').toBe(true)
    const expected = Object.entries(HOST_THEME_ROLE_TOKENS)
      .filter(([role]) => role in DARK.colors)
      .reduce((sum, [, targets]) => sum + targets.length, 0)
    expect(n).toBe(expected)
  })

  it('mixes the outline role into hairline tokens at reduced alpha', () => {
    const root = document.createElement('html')
    applyHostTheme(root, DARK)
    expect(root.style.getPropertyValue('--border')).toBe(
      'color-mix(in srgb, rgb(142, 145, 143) 20%, transparent)',
    )
    expect(root.style.getPropertyValue('--input')).toBe(
      'color-mix(in srgb, rgb(142, 145, 143) 30%, transparent)',
    )
  })

  it('leaves tokens for roles the payload omits untouched (fallback palette)', () => {
    const root = document.createElement('html')
    applyHostTheme(root, DARK)
    expect(root.style.getPropertyValue('--sidebar')).toBe('')
    expect(root.style.getPropertyValue('--muted-foreground')).toBe('')
  })

  it('refuses values that are not browser colour strings', () => {
    const root = document.createElement('html')
    const n = applyHostTheme(root, {
      scheme: 'light',
      colors: {
        surface: 'var(--evil)',
        textPrimary: 'url(javascript:1)',
        primary: 'red; background: url(x)',
        outline: '#abc',
      },
    })
    expect(root.style.getPropertyValue('--background')).toBe('')
    expect(root.style.getPropertyValue('--foreground')).toBe('')
    expect(root.style.getPropertyValue('--primary')).toBe('')
    expect(root.style.getPropertyValue('--border')).toBe('color-mix(in srgb, #abc 20%, transparent)')
    expect(n).toBe(HOST_THEME_ROLE_TOKENS.outline.length)
  })

  it('a later payload clears tokens the earlier one set', () => {
    const root = document.createElement('html')
    applyHostTheme(root, DARK)
    applyHostTheme(root, { scheme: 'light', colors: { surface: 'rgb(255, 255, 255)' } })
    expect(root.style.getPropertyValue('--background')).toBe('rgb(255, 255, 255)')
    expect(root.style.getPropertyValue('--card')).toBe('')
    expect(root.style.getPropertyValue('--primary')).toBe('')
    expect(root.getAttribute(HOST_THEME_APPLIED_ATTR)).toBe('light')
    expect(root.classList.contains('dark'), 'light payload clears the class').toBe(false)
  })

  it('an empty payload removes the applied stamp', () => {
    const root = document.createElement('html')
    applyHostTheme(root, DARK)
    applyHostTheme(root, { scheme: 'light', colors: {} })
    expect(root.getAttribute(HOST_THEME_APPLIED_ATTR)).toBeNull()
  })
})

describe('installHostThemeListener', () => {
  type Listener = (e: MessageEvent) => void
  function fakeWindow() {
    const listeners = new Set<Listener>()
    return {
      addEventListener: (_t: string, l: EventListener) => void listeners.add(l as unknown as Listener),
      removeEventListener: (_t: string, l: EventListener) => void listeners.delete(l as unknown as Listener),
      post(data: unknown, origin = 'chrome://custom.top-chrome') {
        for (const l of listeners) l({ data, origin } as MessageEvent)
      },
      size: () => listeners.size,
    }
  }

  it('applies a well-formed nexus-theme message and ignores everything else', () => {
    const win = fakeWindow()
    const root = document.createElement('html')
    const dispose = installHostThemeListener(win, root, undefined, 'chrome')

    win.post({ type: 'nexus-init', nexus: true })
    win.post({ type: NEXUS_THEME_MESSAGE_TYPE, theme: DARK }) // missing nexus:true
    win.post({ type: NEXUS_THEME_MESSAGE_TYPE, nexus: true, theme: { scheme: 'blue', colors: {} } })
    expect(root.style.getPropertyValue('--background')).toBe('')

    win.post({ type: NEXUS_THEME_MESSAGE_TYPE, nexus: true, theme: DARK })
    expect(root.style.getPropertyValue('--background')).toBe('rgb(31, 31, 31)')

    dispose()
    expect(win.size()).toBe(0)
  })

  it('ignores a well-formed nexus-theme from any origin but the host', () => {
    // A theme is inline CSS on <html>; only the WebUI host may paint it. The
    // message used to be believed from ANY origin.
    const win = fakeWindow()
    const root = document.createElement('html')
    const trace = vi.fn()
    const dispose = installHostThemeListener(win, root, trace, 'chrome')

    win.post({ type: NEXUS_THEME_MESSAGE_TYPE, nexus: true, theme: DARK }, 'https://evil.example')
    win.post({ type: NEXUS_THEME_MESSAGE_TYPE, nexus: true, theme: DARK }, '')
    win.post({ type: NEXUS_THEME_MESSAGE_TYPE, nexus: true, theme: DARK }, 'null')
    expect(root.style.getPropertyValue('--background')).toBe('')
    expect(root.classList.contains('dark')).toBe(false)
    expect(trace).toHaveBeenCalledWith(
      'nexus-theme ignored: untrusted origin',
      { origin: 'https://evil.example' },
    )

    win.post({ type: NEXUS_THEME_MESSAGE_TYPE, nexus: true, theme: DARK }, 'chrome-untrusted://custom.top-chrome')
    expect(root.style.getPropertyValue('--background')).toBe('rgb(31, 31, 31)')
    dispose()
  })
})

describe('isTrustedHostOrigin', () => {
  it('accepts WebUI origins only', () => {
    expect(isTrustedHostOrigin('chrome://custom.top-chrome')).toBe(true)
    expect(isTrustedHostOrigin('chrome-untrusted://custom.top-chrome')).toBe(true)
    expect(isTrustedHostOrigin('https://evil.example')).toBe(false)
    expect(isTrustedHostOrigin('https://app.velloc.app')).toBe(false)
    expect(isTrustedHostOrigin('chrome-extension://abcdef')).toBe(false)
    expect(isTrustedHostOrigin('null')).toBe(false)
    expect(isTrustedHostOrigin('')).toBe(false)
    expect(isTrustedHostOrigin(undefined)).toBe(false)
  })

  it("takes the page's own origin only when the page itself is WebUI", () => {
    // A harness posting to itself from a chrome:// page passes; the same
    // pattern on an http(s) deploy — any page can claim that origin — does not.
    expect(
      isTrustedHostOrigin('chrome://nexus-harness', { origin: 'chrome://nexus-harness', protocol: 'chrome:' }),
    ).toBe(true)
    expect(
      isTrustedHostOrigin('https://app.velloc.app', { origin: 'https://app.velloc.app', protocol: 'https:' }),
    ).toBe(false)
    expect(isTrustedHostOrigin('https://app.velloc.app', undefined)).toBe(false)
  })
})

/**
 * The classic palette is Velloc's own black/white token set: host colours are
 * ignored, the host's scheme still owns the class, and it is the default for a
 * profile that never chose — the regression is Chrome's stock palette painting
 * over the built-in one on a fresh install.
 */
describe('classic guest palette', () => {
  afterEach(() => localStorage.clear())

  it('sets no colour token but still follows the host scheme', () => {
    const root = document.createElement('html')
    root.style.setProperty('--background', 'rgb(1, 2, 3)')
    const n = applyHostTheme(root, DARK, 'classic')
    expect(n).toBe(0)
    expect(root.style.getPropertyValue('--background')).toBe('')
    expect(root.style.getPropertyValue('--primary')).toBe('')
    expect(root.classList.contains('dark')).toBe(true)
    expect(root.getAttribute(HOST_THEME_APPLIED_ATTR)).toBe('dark')
  })

  it('is the default when nothing is stored, and a stored choice survives', () => {
    expect(readGuestPalette()).toBe('classic')
    writeGuestPalette('chrome')
    expect(localStorage.getItem(GUEST_PALETTE_STORAGE_KEY)).toBe('chrome')
    expect(readGuestPalette()).toBe('chrome')
    // Garbage and a throwing storage both fall back to classic.
    localStorage.setItem(GUEST_PALETTE_STORAGE_KEY, 'neon')
    expect(readGuestPalette()).toBe('classic')
    const throwing = { getItem: () => { throw new Error('denied') }, setItem: () => {} }
    expect(readGuestPalette(throwing)).toBe('classic')
  })

  it('switching palette re-applies the last payload live', () => {
    const listeners = new Set<(e: MessageEvent) => void>()
    const win = {
      addEventListener: (_t: string, l: EventListener) => void listeners.add(l as never),
      removeEventListener: (_t: string, l: EventListener) => void listeners.delete(l as never),
    }
    const root = document.createElement('html')
    const dispose = installHostThemeListener(win, root)
    for (const l of listeners) {
      l({
        data: { type: NEXUS_THEME_MESSAGE_TYPE, nexus: true, theme: DARK },
        origin: 'chrome://custom.top-chrome',
      } as MessageEvent)
    }
    expect(root.style.getPropertyValue('--background'), 'default is classic').toBe('')
    expect(root.classList.contains('dark')).toBe(true)

    writeGuestPalette('chrome')
    expect(root.style.getPropertyValue('--background')).toBe('rgb(31, 31, 31)')
    writeGuestPalette('classic')
    expect(root.style.getPropertyValue('--background')).toBe('')

    dispose()
    writeGuestPalette('chrome')
    expect(root.style.getPropertyValue('--background'), 'disposed listener stays put').toBe('')
  })

  it("another window's palette write repaints this one (storage event)", () => {
    // Window B learns of window A's write only through a `storage` event; the
    // in-page listener set never sees it.
    const listeners = new Set<(e: MessageEvent) => void>()
    const win = {
      addEventListener: (_t: string, l: EventListener) => void listeners.add(l as never),
      removeEventListener: (_t: string, l: EventListener) => void listeners.delete(l as never),
    }
    const root = document.createElement('html')
    const dispose = installHostThemeListener(win, root, undefined, 'chrome')
    for (const l of listeners) {
      l({
        data: { type: NEXUS_THEME_MESSAGE_TYPE, nexus: true, theme: DARK },
        origin: 'chrome://custom.top-chrome',
      } as MessageEvent)
    }
    expect(root.style.getPropertyValue('--background')).toBe('rgb(31, 31, 31)')

    // Window A picks Default: storage changes behind this realm's back.
    localStorage.setItem(GUEST_PALETTE_STORAGE_KEY, 'classic')
    window.dispatchEvent(new StorageEvent('storage', { key: GUEST_PALETTE_STORAGE_KEY }))
    expect(root.style.getPropertyValue('--background'), 'classic applied').toBe('')

    dispose()
    localStorage.setItem(GUEST_PALETTE_STORAGE_KEY, 'chrome')
    window.dispatchEvent(new StorageEvent('storage', { key: GUEST_PALETTE_STORAGE_KEY }))
    expect(root.style.getPropertyValue('--background'), 'disposed listener stays put').toBe('')
  })
})
