// @vitest-environment happy-dom
/**
 * The chunk-load failure overlay (`src/browser/boot/chunkLoadFailure.ts`): any chunk that cannot load stops the
 * UI behind one overlay whose only action is Reload; its text follows the connection (offline vs failed).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  CHUNK_FAILURE_OVERLAY_ID,
  installChunkLoadFailureOverlay,
  isChunkLoadError,
} from '../browser/boot/chunkLoadFailure'
import { BOOTSTRAP_MESSAGES } from '../browser/webview/i18n/translate'
import { en } from '../browser/webview/i18n/messages/en'

function setOnline(online: boolean): void {
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => online })
}

function overlay(): HTMLElement | null {
  return document.getElementById(CHUNK_FAILURE_OVERLAY_ID)
}

function preloadError(): void {
  const event = new Event('vite:preloadError', { cancelable: true }) as Event & { payload?: unknown }
  event.payload = new TypeError('Failed to fetch dynamically imported module: /v1/assets/x.js')
  window.dispatchEvent(event)
}

describe('chunk-load failure overlay', () => {
  let stop: (() => void) | null = null
  afterEach(() => {
    stop?.()
    stop = null
    overlay()?.remove()
    vi.restoreAllMocks()
  })

  it('covers the whole UI with a Reload button on a preload failure', () => {
    setOnline(true)
    stop = installChunkLoadFailureOverlay(window)
    expect(overlay()).toBeNull()

    preloadError()
    const el = overlay()!
    expect(el).not.toBeNull()
    expect(el.getAttribute('role')).toBe('alertdialog')
    expect(el.style.position).toBe('fixed')
    expect(el.textContent).toContain(en['chunkLoad.failedTitle'])
    expect(el.querySelector('button')?.textContent).toBe(en['chunkLoad.reload'])
  })

  it('does not auto-reload; the button does', () => {
    setOnline(true)
    const reload = vi.fn()
    const win = Object.assign(Object.create(window), {
      addEventListener: window.addEventListener.bind(window),
      removeEventListener: window.removeEventListener.bind(window),
      navigator: window.navigator,
      document,
      location: { reload },
    })
    stop = installChunkLoadFailureOverlay(win)
    preloadError()
    expect(reload).not.toHaveBeenCalled()
    overlay()!.querySelector('button')!.click()
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('shows one overlay however many chunks fail', () => {
    setOnline(true)
    stop = installChunkLoadFailureOverlay(window)
    preloadError()
    preloadError()
    expect(document.querySelectorAll(`#${CHUNK_FAILURE_OVERLAY_ID}`)).toHaveLength(1)
  })

  it('says offline while offline, and switches when the connection returns', () => {
    setOnline(false)
    stop = installChunkLoadFailureOverlay(window)
    preloadError()
    expect(overlay()!.textContent).toContain(en['chunkLoad.offlineTitle'])

    setOnline(true)
    window.dispatchEvent(new Event('online'))
    expect(overlay()!.textContent).toContain(en['chunkLoad.failedTitle'])
  })

  it('catches an unhandled chunk rejection (dev server), and ignores other rejections', () => {
    setOnline(true)
    stop = installChunkLoadFailureOverlay(window)
    const reject = (reason: unknown) => {
      const event = new Event('unhandledrejection') as Event & { reason?: unknown }
      event.reason = reason
      window.dispatchEvent(event)
    }
    reject(new Error('boom'))
    expect(overlay()).toBeNull()
    reject(new TypeError('Failed to fetch dynamically imported module: /src/x.tsx'))
    expect(overlay()).not.toBeNull()
  })

  it('classifies chunk errors by message', () => {
    expect(isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: x'))).toBe(true)
    expect(isChunkLoadError(new Error('Unable to preload CSS for /assets/a.css'))).toBe(true)
    expect(isChunkLoadError(new Error('x is not a function'))).toBe(false)
    expect(isChunkLoadError(undefined)).toBe(false)
  })

  it('renders with no catalog loaded: every string is a bootstrap message', () => {
    for (const key of [
      'chunkLoad.failedTitle',
      'chunkLoad.failedBody',
      'chunkLoad.offlineTitle',
      'chunkLoad.offlineBody',
      'chunkLoad.reload',
    ] as const) {
      expect(BOOTSTRAP_MESSAGES[key]).toBe(en[key])
    }
  })
})
