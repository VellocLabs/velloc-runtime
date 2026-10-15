// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

import { I18nProvider } from '../browser/webview/i18n'
import {
  INSTALL_TIP_STORAGE_KEY,
  enableAppInstall,
  getInstallState,
  installRoute,
  isRunningAsApp,
  linkWebAppManifest,
  manifestHref,
  resetInstallStateForTests,
} from '../browser/webview/remote/appInstall'
import { RemoteInstallTip } from '../browser/webview/remote/RemoteInstallTip'

/**
 * F-24: the remote page offers to become an app: the manifest is linked once under vite's base; the tip names a
 * route per browser (none for iOS, Android, Firefox); it hides when installed, dismissed or not enabled, and shows
 * on one page load per device.
 */

// This vitest realm's `localStorage` is not a working Storage; appInstall.ts
// reads it at call time, so a Map-backed stub stands in (as in the other
// render tests).
const memoryStorage = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => memoryStorage.get(k) ?? null,
  setItem: (k: string, v: string) => void memoryStorage.set(k, String(v)),
  removeItem: (k: string) => void memoryStorage.delete(k),
  clear: () => memoryStorage.clear(),
})

const CHROME_WIN =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36'
const EDGE_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36 Edg/149.0.0.0'
const CHROME_ANDROID =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Mobile Safari/537.36'
const SAFARI_IPAD =
  'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
const FIREFOX_WIN =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0'

function setUserAgent(ua: string) {
  Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => ua })
}

function setDisplayModes(matching: string[]) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({
      matches: matching.some((mode) => query === `(display-mode: ${mode})`),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  })
}

/** happy-dom's page is visible; a test that needs a page nobody can see (a
 *  background tab, an occluded window) redefines it. */
function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  })
}

function renderTip() {
  return render(
    createElement(I18nProvider, { locale: 'en' as const }, createElement(RemoteInstallTip)),
  )
}

/** A stand-in for Chromium's BeforeInstallPromptEvent. */
function fireInstallPrompt(outcome: 'accepted' | 'dismissed' = 'accepted') {
  const event = new Event('beforeinstallprompt', { cancelable: true }) as Event & {
    prompt: ReturnType<typeof vi.fn>
    userChoice: Promise<{ outcome: string }>
  }
  event.prompt = vi.fn(() => Promise.resolve())
  event.userChoice = Promise.resolve({ outcome })
  act(() => {
    window.dispatchEvent(event)
  })
  return event
}

beforeEach(() => {
  resetInstallStateForTests()
  localStorage.clear()
  document.head.querySelectorAll('link[rel="manifest"]').forEach((l) => l.remove())
  setUserAgent(CHROME_WIN)
  setDisplayModes([])
  setVisibility('visible')
})

afterEach(() => {
  cleanup()
})

describe('the manifest link', () => {
  it('sits under vite base, beside the favicon', () => {
    expect(manifestHref('/v7/')).toBe('/v7/manifest.webmanifest')
    expect(manifestHref('/')).toBe('/manifest.webmanifest')
    expect(manifestHref('/v7')).toBe('/v7/manifest.webmanifest')
  })

  it('is added once, however often the boot asks', () => {
    linkWebAppManifest(document, '/v7/manifest.webmanifest')
    linkWebAppManifest(document, '/v7/manifest.webmanifest')
    const links = document.head.querySelectorAll('link[rel="manifest"]')
    expect(links).toHaveLength(1)
    expect(links[0]!.getAttribute('href')).toBe('/v7/manifest.webmanifest')
  })

  it('is linked by enableAppInstall, and not before it', () => {
    expect(document.head.querySelector('link[rel="manifest"]')).toBeNull()
    enableAppInstall(window, document)
    expect(document.head.querySelector('link[rel="manifest"]')).not.toBeNull()
    expect(getInstallState().enabled).toBe(true)
  })
})

describe('installRoute', () => {
  it('prefers the browser prompt wherever it fired', () => {
    expect(installRoute(SAFARI_IPAD, true)).toBe('prompt')
    expect(installRoute(CHROME_WIN, true)).toBe('prompt')
  })

  it('names the menu in desktop Chrome and Edge', () => {
    expect(installRoute(CHROME_WIN, false)).toBe('chrome-menu')
    expect(installRoute(EDGE_MAC, false)).toBe('edge-menu')
  })

  it('names nothing where the installed app would not work', () => {
    // Android: an insecure page becomes a shortcut that opens a normal tab.
    expect(installRoute(CHROME_ANDROID, false)).toBeNull()
    // iOS: a Home Screen app has its own storage — no remembered pairing.
    expect(installRoute(SAFARI_IPAD, false)).toBeNull()
    // Firefox desktop has no install.
    expect(installRoute(FIREFOX_WIN, false)).toBeNull()
    expect(installRoute(undefined, false)).toBeNull()
  })
})

describe('isRunningAsApp', () => {
  it('is true in an app window, false in a tab', () => {
    expect(isRunningAsApp(window)).toBe(false)
    setDisplayModes(['standalone'])
    expect(isRunningAsApp(window)).toBe(true)
    setDisplayModes(['window-controls-overlay'])
    expect(isRunningAsApp(window)).toBe(true)
  })

  it('does not take element fullscreen for an app', () => {
    setDisplayModes(['fullscreen'])
    expect(isRunningAsApp(window)).toBe(false)
  })
})

describe('RemoteInstallTip', () => {
  it('shows nothing until the boot enables install', () => {
    renderTip()
    expect(screen.queryByTestId('remote-install-tip')).toBeNull()
  })

  it('names the Chrome menu path in desktop Chrome', () => {
    enableAppInstall(window, document)
    renderTip()
    const tip = screen.getByTestId('remote-install-tip')
    expect(tip.getAttribute('data-route')).toBe('chrome-menu')
    expect(tip.textContent).toContain('Install page as app')
    // No one-click button without the browser's prompt.
    expect(screen.queryByTestId('remote-install-tip-install')).toBeNull()
  })

  it('offers the one-click install when the browser fires its prompt', async () => {
    enableAppInstall(window, document)
    renderTip()
    const event = fireInstallPrompt()
    expect(event.defaultPrevented).toBe(true)
    expect(screen.getByTestId('remote-install-tip').getAttribute('data-route')).toBe('prompt')

    await act(async () => {
      fireEvent.click(screen.getByTestId('remote-install-tip-install'))
    })
    expect(event.prompt).toHaveBeenCalledTimes(1)

    // Installed: the tip goes, and this browser is not asked again.
    act(() => {
      window.dispatchEvent(new Event('appinstalled'))
    })
    expect(screen.queryByTestId('remote-install-tip')).toBeNull()
    expect(localStorage.getItem(INSTALL_TIP_STORAGE_KEY)).toBe('installed')
  })

  it('shows on the first page load only, on this device', () => {
    enableAppInstall(window, document)
    renderTip()
    expect(screen.getByTestId('remote-install-tip')).toBeTruthy()
    expect(localStorage.getItem(INSTALL_TIP_STORAGE_KEY)).toBe('seen')

    // The same page remounting the shell keeps it until dismissed.
    cleanup()
    renderTip()
    expect(screen.getByTestId('remote-install-tip')).toBeTruthy()

    // A new page load (module state fresh, storage kept) does not show it.
    cleanup()
    resetInstallStateForTests()
    enableAppInstall(window, document)
    renderTip()
    expect(screen.queryByTestId('remote-install-tip')).toBeNull()
  })

  it('counts only a page a person can look at', () => {
    setVisibility('hidden')
    enableAppInstall(window, document)
    renderTip()
    // The tip IS on screen — it stays until "Not now" — but a page nobody can
    // see is no sighting: the mark waits for the page to come forward.
    expect(screen.getByTestId('remote-install-tip')).toBeTruthy()
    expect(localStorage.getItem(INSTALL_TIP_STORAGE_KEY)).toBeNull()

    setVisibility('visible')
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(localStorage.getItem(INSTALL_TIP_STORAGE_KEY)).toBe('seen')
  })

  it('offers again to a device the rule before this one marked', () => {
    // `shown` was written the moment the tip rendered, which a page nobody was
    // looking at does too — not evidence of a sighting.
    localStorage.setItem(INSTALL_TIP_STORAGE_KEY, 'shown')
    enableAppInstall(window, document)
    renderTip()
    expect(screen.getByTestId('remote-install-tip')).toBeTruthy()
    expect(localStorage.getItem(INSTALL_TIP_STORAGE_KEY)).toBe('seen')
  })

  it('does not mark itself shown where it did not render', () => {
    enableAppInstall(window, document)
    setUserAgent(FIREFOX_WIN)
    renderTip()
    expect(screen.queryByTestId('remote-install-tip')).toBeNull()
    expect(localStorage.getItem(INSTALL_TIP_STORAGE_KEY)).toBeNull()
  })

  it('stays away after Not now, on this device', () => {
    enableAppInstall(window, document)
    renderTip()
    fireEvent.click(screen.getByTestId('remote-install-tip-dismiss'))
    expect(screen.queryByTestId('remote-install-tip')).toBeNull()
    expect(localStorage.getItem(INSTALL_TIP_STORAGE_KEY)).toBe('dismissed')

    cleanup()
    renderTip()
    expect(screen.queryByTestId('remote-install-tip')).toBeNull()
  })

  it('is absent inside the installed app', () => {
    enableAppInstall(window, document)
    setDisplayModes(['standalone'])
    renderTip()
    expect(screen.queryByTestId('remote-install-tip')).toBeNull()
  })

  it('is absent where no route would give a working app', () => {
    enableAppInstall(window, document)
    setUserAgent(SAFARI_IPAD)
    renderTip()
    expect(screen.queryByTestId('remote-install-tip')).toBeNull()
  })
})

describe('public/manifest.webmanifest', () => {
  // Read from disk: vite serves public/ verbatim, and the C++ router proxies
  // exactly these three names under /v<N>/ (kFixedVersionedFiles).
  const publicDir = join(__dirname, '..', '..', 'public')
  const manifest = JSON.parse(readFileSync(join(publicDir, 'manifest.webmanifest'), 'utf8'))

  it('reopens at the listener root, in its own window', () => {
    // `/` redirects to the current entry, which finds the remembered pairing;
    // a pinned /v<N>/b/<key>/ would outlive its build.
    expect(manifest.start_url).toBe('/')
    expect(manifest.scope).toBe('/')
    expect(manifest.display).toBe('standalone')
    expect(typeof manifest.name).toBe('string')
  })

  it('names icons that exist, at the sizes it claims, relative to itself', () => {
    const sizes = manifest.icons.map((icon: { sizes: string }) => icon.sizes)
    expect(sizes).toEqual(expect.arrayContaining(['192x192', '512x512']))
    for (const icon of manifest.icons as Array<{ src: string; sizes: string }>) {
      // Relative, so it resolves under /v<N>/ next to the manifest.
      expect(icon.src.startsWith('/')).toBe(false)
      const png = readFileSync(join(publicDir, icon.src))
      // PNG IHDR: width and height, big-endian, at bytes 16 and 20.
      const [w, h] = icon.sizes.split('x').map(Number)
      expect(png.readUInt32BE(16)).toBe(w)
      expect(png.readUInt32BE(20)).toBe(h)
    }
  })
})
