// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { BrowserBridgeTransport } from '../browser/bridge/browserBridgeProtocol'
import { writeGuestColorScheme } from '../browser/boot/guestColorScheme'
import { writeGuestPalette } from '../browser/boot/guestPalette'
import { HOST_THEME_APPLIED_ATTR, HOST_THEME_ROLE_TOKENS } from '../browser/boot/hostTheme'
import { installPerClientTheme } from '../browser/boot/perClientTheme'

// This vitest realm's `localStorage` is not a working Storage; the choice is
// read at call time, so a Map-backed stub stands in (host-theme.test.ts).
const memoryStorage = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => memoryStorage.get(k) ?? null,
  setItem: (k: string, v: string) => void memoryStorage.set(k, String(v)),
  removeItem: (k: string) => void memoryStorage.delete(k),
  clear: () => memoryStorage.clear(),
})

/**
 * The per-client theme driver. Colours come from the host (`resolveTheme`),
 * but the light/dark bit is THIS client's own choice — and it has to land
 * under the Default (classic) palette too, where there is nothing to resolve.
 * That half had no test, and the e2e suite found it broken: the classic
 * branch only un-stamped the root, handing the class back to the boot-time
 * media-query sync, so Dark + the Default swatch repainted the client light.
 */

function mediaStub(initialDark: boolean) {
  let dark = initialDark
  const listeners = new Set<() => void>()
  const mql = {
    get matches() {
      return dark
    },
    addEventListener: (_t: 'change', l: () => void) => void listeners.add(l),
    removeEventListener: (_t: 'change', l: () => void) => void listeners.delete(l),
  }
  return {
    win: { matchMedia: () => mql },
    flip(next: boolean) {
      dark = next
      for (const l of listeners) l()
    },
  }
}

function transportResolving(colors: Record<string, string> | 'fail') {
  // One envelope argument — `{ id, route, payload }` (requestHostBridge).
  const request = vi.fn(async (envelope: { payload: { scheme: 'light' | 'dark' } }) =>
    colors === 'fail'
      ? { ok: false, error: { code: 'unknown_route', message: 'no such route' } }
      : { ok: true, result: { scheme: envelope.payload.scheme, colors } },
  )
  return {
    transport: { request, subscribeEvents: () => () => {} } as unknown as BrowserBridgeTransport,
    request,
  }
}

const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0))

/** Inline design tokens currently set on the root (happy-dom's `style.length`
 *  does not count custom properties, so ask for each known token). */
const inlineTokens = (root: HTMLElement): string[] =>
  Object.values(HOST_THEME_ROLE_TOKENS)
    .flat()
    .map(t => t.token)
    .filter(token => root.style.getPropertyValue(token) !== '')

const roots: HTMLElement[] = []
function freshRoot(): HTMLElement {
  const root = document.createElement('html')
  roots.push(root)
  return root
}

afterEach(() => {
  memoryStorage.clear()
  roots.length = 0
})

describe('installPerClientTheme', () => {
  it('Default palette: an explicit Dark choice lands on the class with NO host call and no inline colour', async () => {
    writeGuestColorScheme('dark')
    const { transport, request } = transportResolving({ surface: '#101010' })
    const root = freshRoot()
    const dispose = installPerClientTheme(transport, mediaStub(false).win, root)
    await flush()
    expect(root.classList.contains('dark')).toBe(true)
    expect(root.getAttribute(HOST_THEME_APPLIED_ATTR)).toBe('dark')
    expect(root.style.getPropertyValue('--background')).toBe('')
    expect(request).not.toHaveBeenCalled()
    dispose()
  })

  it('Chrome → Default keeps the chosen scheme and drops EVERY inline token', async () => {
    writeGuestColorScheme('dark')
    writeGuestPalette('chrome')
    const colors = Object.fromEntries(Object.keys(HOST_THEME_ROLE_TOKENS).map(role => [role, '#101010']))
    const { transport } = transportResolving(colors)
    const root = freshRoot()
    // The OS says light: only the client's own choice can keep this dark.
    const dispose = installPerClientTheme(transport, mediaStub(false).win, root)
    await flush()
    expect(inlineTokens(root).length).toBeGreaterThan(1)
    expect(root.classList.contains('dark')).toBe(true)

    writeGuestPalette('classic')
    await flush()
    expect(inlineTokens(root)).toEqual([])
    expect(root.classList.contains('dark')).toBe(true)
    expect(root.getAttribute(HOST_THEME_APPLIED_ATTR)).toBe('dark')
    dispose()
  })

  it("'system' follows THIS client's media query, both ways; an explicit choice ignores it", async () => {
    const media = mediaStub(false)
    const { transport } = transportResolving({})
    const root = freshRoot()
    const dispose = installPerClientTheme(transport, media.win, root)
    await flush()
    expect(root.classList.contains('dark')).toBe(false)

    media.flip(true)
    await flush()
    expect(root.classList.contains('dark')).toBe(true)
    expect(root.getAttribute(HOST_THEME_APPLIED_ATTR)).toBe('dark')

    writeGuestColorScheme('light')
    await flush()
    expect(root.classList.contains('dark')).toBe(false)
    media.flip(false)
    media.flip(true)
    await flush()
    expect(root.classList.contains('dark')).toBe(false)
    dispose()
  })

  it('a host without resolveTheme still gets the chosen scheme — it degrades to the Default look', async () => {
    writeGuestColorScheme('dark')
    writeGuestPalette('chrome')
    const { transport, request } = transportResolving('fail')
    const root = freshRoot()
    const dispose = installPerClientTheme(transport, mediaStub(false).win, root)
    await flush()
    expect(request).toHaveBeenCalled()
    expect(root.classList.contains('dark')).toBe(true)
    expect(inlineTokens(root)).toEqual([])
    dispose()
  })

  it('a slow resolveTheme reply does not paint over a newer choice (Chrome swatch, then Default)', async () => {
    writeGuestColorScheme('dark')
    writeGuestPalette('chrome')
    const colors = Object.fromEntries(Object.keys(HOST_THEME_ROLE_TOKENS).map(role => [role, '#101010']))
    // The reply is held until the test releases it — one relay round trip.
    let release: () => void = () => {}
    const request = vi.fn((envelope: { payload: { scheme: 'light' | 'dark' } }) =>
      new Promise(resolve => {
        release = () => resolve({ ok: true, result: { scheme: envelope.payload.scheme, colors } })
      }),
    )
    const transport = { request, subscribeEvents: () => () => {} } as unknown as BrowserBridgeTransport
    const root = freshRoot()
    const dispose = installPerClientTheme(transport, mediaStub(false).win, root)
    await flush()
    expect(request).toHaveBeenCalledTimes(1)

    // Default is picked while the Chrome resolve is still in flight.
    writeGuestPalette('classic')
    await flush()
    expect(inlineTokens(root)).toEqual([])

    release()
    await flush()
    expect(inlineTokens(root)).toEqual([])
    expect(root.classList.contains('dark')).toBe(true)
    dispose()
  })
})
