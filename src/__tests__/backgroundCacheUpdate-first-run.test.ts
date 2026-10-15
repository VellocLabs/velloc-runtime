/**
 * When the background updater (`src/glic/backgroundCacheUpdate.ts`) first runs: 5 s after the page has both
 * loaded and shown its first screen, so its chunk warm-up never competes with the boot; 60 s after load when no
 * first-screen signal comes. The signal is the event `browser/boot/firstScreenSignal.ts` dispatches.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { signalFirstScreen } from '../browser/boot/firstScreenSignal'

const ROOT = 'https://app.velloc.app/v1/'
const MANIFEST_URL = `${ROOT}assets-manifest.json`
const BUILD = '2026-09-25T04:32:08.561Z'

type Listener = () => void

async function bootUpdater({ readyState = 'interactive' } = {}) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] })
  const fetched: string[] = []
  const listeners: Record<string, Listener[]> = {}
  const win = {
    addEventListener: (type: string, fn: Listener) => { (listeners[type] ??= []).push(fn) },
    dispatchEvent: (event: Event) => {
      for (const fn of listeners[event.type] ?? []) fn()
      return true
    },
  }
  const storage = () => {
    const store = new Map<string, string>()
    return {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v) },
      removeItem: (k: string) => { store.delete(k) },
    }
  }
  vi.stubGlobal('window', win)
  vi.stubGlobal('location', new URL(ROOT))
  vi.stubGlobal('localStorage', storage())
  vi.stubGlobal('sessionStorage', storage())
  vi.stubGlobal('navigator', { language: 'en-US' })
  vi.stubGlobal('document', {
    baseURI: ROOT,
    readyState,
    visibilityState: 'visible',
    addEventListener: () => {},
    querySelector: (sel: string) =>
      sel === 'meta[name="nexus-build-time"]'
        ? { getAttribute: (name: string) => (name === 'content' ? BUILD : null) }
        : null,
    getElementById: () => null,
  })
  vi.stubGlobal('fetch', async (input: string) => {
    fetched.push(String(input))
    return new Response(JSON.stringify({ buildId: BUILD, assets: [] }), { status: 200 })
  })
  vi.resetModules()
  await import('../glic/backgroundCacheUpdate')
  return {
    load: () => win.dispatchEvent(new Event('load')),
    firstScreen: () => signalFirstScreen(win),
    advance: (ms: number) => vi.advanceTimersByTimeAsync(ms),
    manifestFetches: () => fetched.filter(url => url === MANIFEST_URL).length,
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('background updater first run', () => {
  it('waits for the first screen, not just load', async () => {
    const page = await bootUpdater()
    page.load()
    await page.advance(30_000)
    expect(page.manifestFetches()).toBe(0)

    page.firstScreen()
    await page.advance(4_999)
    expect(page.manifestFetches()).toBe(0)
    await page.advance(1)
    expect(page.manifestFetches()).toBe(1)
  })

  it('waits for load when the first screen comes first', async () => {
    const page = await bootUpdater()
    page.firstScreen()
    await page.advance(30_000)
    expect(page.manifestFetches()).toBe(0)

    page.load()
    await page.advance(5_000)
    expect(page.manifestFetches()).toBe(1)
  })

  it('runs once, however often the signals repeat', async () => {
    const page = await bootUpdater()
    page.load()
    page.firstScreen()
    page.firstScreen()
    await page.advance(120_000)
    expect(page.manifestFetches()).toBe(1)
  })

  it('falls back to 60 s after load without a first-screen signal', async () => {
    const page = await bootUpdater()
    page.load()
    await page.advance(64_999)
    expect(page.manifestFetches()).toBe(0)
    await page.advance(1)
    expect(page.manifestFetches()).toBe(1)
  })

  it('counts a page that had already loaded as loaded', async () => {
    const page = await bootUpdater({ readyState: 'complete' })
    page.firstScreen()
    await page.advance(5_000)
    expect(page.manifestFetches()).toBe(1)
  })
})
