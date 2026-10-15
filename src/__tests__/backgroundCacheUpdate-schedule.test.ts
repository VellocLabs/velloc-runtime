/**
 * The background updater's check-and-apply cycle (`src/glic/backgroundCacheUpdate.ts`): the common check is one
 * manifest request; a newer build refreshes the HTML once per page; checks are MIN_CHECK_INTERVAL_MS apart; a
 * staged build reloads only while hidden, with no unsaved edits and the restart gate's yes, once per build per tab.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const ORIGIN = 'https://app.velloc.app'
const ROOT = `${ORIGIN}/v1/`
const MANIFEST_URL = `${ROOT}assets-manifest.json`
const PAGE_BUILD = '2026-09-25T04:32:08.561Z'
const NEW_BUILD = '2026-09-28T10:00:00.000Z'
const NEWER_BUILD = '2026-09-29T10:00:00.000Z'
const FIVE_MIN = 5 * 60 * 1000

function memoryStorage(): Storage {
  const store = new Map<string, string>()
  return {
    get length() { return store.size },
    clear: () => store.clear(),
    getItem: (k: string) => store.get(k) ?? null,
    key: (i: number) => [...store.keys()][i] ?? null,
    removeItem: (k: string) => { store.delete(k) },
    setItem: (k: string, v: string) => { store.set(k, String(v)) },
  }
}

type Listener = () => void

type Harness = {
  fetched: string[]
  /** Advance the clock the throttle reads. */
  advance(ms: number): void
  setServedBuild(buildId: string): void
  failHtml(fail: boolean): void
  failChunks(fail: boolean): void
  setVisibility(state: 'visible' | 'hidden'): void
  /** Fire `visibilitychange` / window `blur`, as the browser would. */
  fire(event: 'visibilitychange' | 'blur'): Promise<void>
  /** The periodic tick. */
  tick(): Promise<void>
  run(): Promise<void>
  reload: ReturnType<typeof vi.fn>
  gate: ReturnType<typeof vi.fn> | null
  /** The page's unsaved-edits hold count (`__nexusUnsavedEdits`). */
  setUnsavedEdits(holds: number): void
  session: Storage
  htmlFetches(): number
  manifestFetches(): number
}

async function bootUpdater({
  pageBuild = PAGE_BUILD,
  servedBuild = PAGE_BUILD,
  visibility = 'visible' as 'visible' | 'hidden',
  // null = no gate registered (undefined would take this default).
  gate = vi.fn(async () => true) as ReturnType<typeof vi.fn> | null,
  session = memoryStorage(),
} = {}): Promise<Harness> {
  const fetched: string[] = []
  let now = 1_000_000
  let served = servedBuild
  let htmlFails = false
  let chunksFail = false
  let state = visibility
  const docListeners: Record<string, Listener[]> = {}
  const winListeners: Record<string, Listener[]> = {}
  let interval: Listener | null = null
  const reload = vi.fn()

  const win: Record<string, unknown> = {
    addEventListener: (type: string, fn: Listener) => { (winListeners[type] ??= []).push(fn) },
  }
  if (gate) win.__nexusRestartGate = gate

  vi.spyOn(Date, 'now').mockImplementation(() => now)
  vi.stubGlobal('window', win)
  vi.stubGlobal('location', Object.assign(new URL(ROOT), { reload }))
  vi.stubGlobal('localStorage', memoryStorage())
  vi.stubGlobal('sessionStorage', session)
  vi.stubGlobal('navigator', { language: 'en-US' })
  vi.stubGlobal('setInterval', (fn: Listener) => { interval = fn; return 1 })
  vi.stubGlobal('document', {
    baseURI: ROOT,
    get visibilityState() { return state },
    addEventListener: (type: string, fn: Listener) => { (docListeners[type] ??= []).push(fn) },
    querySelector: (sel: string) =>
      sel === 'meta[name="nexus-build-time"]' && pageBuild
        ? { getAttribute: (name: string) => (name === 'content' ? pageBuild : null) }
        : null,
    getElementById: (id: string) =>
      id === 'nexus-locales' ? { textContent: JSON.stringify({ en: 'x' }) } : null,
  })
  vi.stubGlobal('fetch', async (input: string) => {
    const url = String(input)
    fetched.push(url)
    if (url === MANIFEST_URL) {
      return new Response(JSON.stringify({
        buildId: served,
        assets: [{ url: `assets/index-${served}.js`, type: 'js' }],
      }), { status: 200 })
    }
    if (url === ROOT) {
      if (htmlFails) throw new TypeError('network')
      return new Response('<html></html>', { status: 200 })
    }
    if (url.startsWith(`${ROOT}assets/`)) {
      if (chunksFail) throw new TypeError('network')
      return new Response('chunk', { status: 200 })
    }
    return new Response('not found', { status: 404 })
  })

  vi.resetModules()
  await import('../glic/backgroundCacheUpdate')
  const run = win.__runBackgroundCacheUpdate as () => Promise<void>
  expect(typeof run).toBe('function')

  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
  return {
    fetched,
    advance: (ms) => { now += ms },
    setServedBuild: (b) => { served = b },
    failHtml: (f) => { htmlFails = f },
    failChunks: (f) => { chunksFail = f },
    setVisibility: (s) => { state = s },
    fire: async (event) => {
      const list = event === 'blur' ? winListeners.blur : docListeners.visibilitychange
      for (const fn of list ?? []) fn()
      await settle()
      await settle()
    },
    tick: async () => { interval?.(); await settle(); await settle() },
    run: async () => { await run(); await settle() },
    reload,
    gate,
    setUnsavedEdits: (holds) => { win.__nexusUnsavedEdits = holds },
    session,
    htmlFetches: () => fetched.filter((u) => u === ROOT).length,
    manifestFetches: () => fetched.filter((u) => u === MANIFEST_URL).length,
  }
}

describe('backgroundCacheUpdate — check', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('does not download the HTML when the manifest names the page\'s own build', async () => {
    const h = await bootUpdater()
    await h.run()
    expect(h.manifestFetches()).toBe(1)
    expect(h.htmlFetches()).toBe(0)
  })

  it('refreshes the HTML once per new build, and again for the next one', async () => {
    const h = await bootUpdater({ servedBuild: NEW_BUILD })
    await h.run()
    expect(h.htmlFetches()).toBe(1)

    h.advance(FIVE_MIN)
    await h.tick()
    expect(h.manifestFetches()).toBe(2)
    expect(h.htmlFetches()).toBe(1)

    h.setServedBuild(NEWER_BUILD)
    h.advance(FIVE_MIN)
    await h.tick()
    expect(h.htmlFetches()).toBe(2)
  })

  it('retries a failed HTML refresh on the next check', async () => {
    const h = await bootUpdater({ servedBuild: NEW_BUILD })
    h.failHtml(true)
    await h.run()
    expect(h.htmlFetches()).toBe(1)

    h.failHtml(false)
    h.advance(FIVE_MIN)
    await h.tick()
    expect(h.htmlFetches()).toBe(2)
  })

  it('refreshes the HTML only after every chunk is warm', async () => {
    const h = await bootUpdater({ servedBuild: NEW_BUILD })
    await h.run()
    const chunkAt = h.fetched.findIndex((u) => u.startsWith(`${ROOT}assets/`))
    expect(chunkAt).toBeGreaterThanOrEqual(0)
    expect(h.fetched.indexOf(ROOT)).toBeGreaterThan(chunkAt)
  })

  it('keeps the old HTML while a chunk fails, and swaps once the batch completes', async () => {
    // An interrupted batch used to leave the NEW document over a half-warm
    // chunk set: the next offline boot died on a chunk it never fetched.
    const h = await bootUpdater({ servedBuild: NEW_BUILD })
    h.failChunks(true)
    await h.run()
    expect(h.htmlFetches()).toBe(0)

    h.failChunks(false)
    h.advance(FIVE_MIN)
    await h.tick()
    expect(h.htmlFetches()).toBe(1)
  })

  it('re-verifies the chunks before swapping the HTML when the warm record outlived the cache', async () => {
    // Check 1 warms the build and records it, but the HTML refresh fails. The
    // HTTP cache is then evicted while the localStorage record survives: the
    // next check used to take the record's word for it and write the new
    // document over chunks that were gone — the offline boot died on them.
    const h = await bootUpdater({ servedBuild: NEW_BUILD })
    const chunkFetches = () => h.fetched.filter((u) => u.startsWith(`${ROOT}assets/`)).length
    h.failHtml(true)
    await h.run()
    expect(chunkFetches()).toBe(1)
    expect(h.htmlFetches()).toBe(1)

    h.failHtml(false)
    h.failChunks(true)
    h.advance(FIVE_MIN)
    await h.tick()
    // The batch ran again (force-cache: free while warm) and found the chunk
    // gone, so the HTML stayed as it was.
    expect(chunkFetches()).toBe(2)
    expect(h.htmlFetches()).toBe(1)

    h.failChunks(false)
    h.advance(FIVE_MIN)
    await h.tick()
    expect(h.htmlFetches()).toBe(2)
  })

  it('refreshes the HTML when the page carries no build meta', async () => {
    const h = await bootUpdater({ pageBuild: '' })
    await h.run()
    expect(h.htmlFetches()).toBe(1)
  })

  it('spaces checks at least five minutes apart, whatever triggers them', async () => {
    const h = await bootUpdater()
    await h.run()
    await h.fire('blur')
    h.setVisibility('hidden')
    await h.fire('visibilitychange')
    h.advance(FIVE_MIN - 1)
    await h.tick()
    expect(h.manifestFetches()).toBe(1)

    h.advance(1)
    await h.fire('blur')
    expect(h.manifestFetches()).toBe(2)
  })

  it('checks when the page goes hidden, not when it becomes visible', async () => {
    const h = await bootUpdater()
    await h.run()
    h.advance(FIVE_MIN)
    h.setVisibility('visible')
    await h.fire('visibilitychange')
    expect(h.manifestFetches()).toBe(1)
    h.setVisibility('hidden')
    await h.fire('visibilitychange')
    expect(h.manifestFetches()).toBe(2)
  })
})

describe('backgroundCacheUpdate — apply', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('reloads a hidden page once the new build is staged and the gate says ready', async () => {
    const h = await bootUpdater({ servedBuild: NEW_BUILD, visibility: 'hidden' })
    await h.run()
    expect(h.gate).toHaveBeenCalled()
    expect(h.reload).toHaveBeenCalledTimes(1)
    expect(h.session.getItem('nexus.updateReloadedFor')).toBe(NEW_BUILD)
  })

  it('never reloads a visible page — it waits until the page is hidden', async () => {
    const h = await bootUpdater({ servedBuild: NEW_BUILD })
    await h.run()
    expect(h.reload).not.toHaveBeenCalled()

    // Hidden inside the throttle window: no new check, but the staged build
    // is still applied.
    h.setVisibility('hidden')
    await h.fire('visibilitychange')
    expect(h.manifestFetches()).toBe(1)
    expect(h.reload).toHaveBeenCalledTimes(1)
  })

  it('does not reload while the runtime is busy, and does once it is idle', async () => {
    let ready = false
    const gate = vi.fn(async () => ready)
    const h = await bootUpdater({ servedBuild: NEW_BUILD, visibility: 'hidden', gate })
    await h.run()
    expect(h.reload).not.toHaveBeenCalled()

    ready = true
    await h.fire('blur')
    expect(h.reload).toHaveBeenCalledTimes(1)
  })

  it('does not reload while the page holds unsaved edits, and does on the next check once released', async () => {
    // Hidden includes a window merely covered by another app: a half-filled
    // Settings form or an open dialog there is page state the runtime's gate
    // cannot see.
    const h = await bootUpdater({ servedBuild: NEW_BUILD, visibility: 'hidden' })
    h.setUnsavedEdits(1)
    await h.run()
    expect(h.reload).not.toHaveBeenCalled()

    // Released — nothing reloads until a scheduled check runs.
    h.setUnsavedEdits(0)
    expect(h.reload).not.toHaveBeenCalled()
    await h.tick()
    expect(h.reload).toHaveBeenCalledTimes(1)
  })

  it('does not reload when a hold is registered while the runtime gate answers', async () => {
    let answer: (ready: boolean) => void = () => {}
    const gate = vi.fn(() => new Promise<boolean>((resolve) => { answer = resolve }))
    const h = await bootUpdater({ servedBuild: NEW_BUILD, visibility: 'hidden', gate })
    const run = h.run()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(gate).toHaveBeenCalled()
    h.setUnsavedEdits(1)
    answer(true)
    await run
    expect(h.reload).not.toHaveBeenCalled()
  })

  it('treats a failing gate as not ready', async () => {
    const gate = vi.fn(async () => { throw new Error('runtime.getRestartReadiness: unknown action') })
    const h = await bootUpdater({ servedBuild: NEW_BUILD, visibility: 'hidden', gate })
    await h.run()
    expect(gate).toHaveBeenCalled()
    expect(h.reload).not.toHaveBeenCalled()
  })

  it('never reloads without a gate (remote page, dev, scoped window)', async () => {
    const h = await bootUpdater({ servedBuild: NEW_BUILD, visibility: 'hidden', gate: null })
    await h.run()
    expect(h.reload).not.toHaveBeenCalled()
  })

  it('does not reload for a build it already reloaded for in this tab (no loop)', async () => {
    const session = memoryStorage()
    session.setItem('nexus.updateReloadedFor', NEW_BUILD)
    const h = await bootUpdater({ servedBuild: NEW_BUILD, visibility: 'hidden', session })
    await h.run()
    expect(h.reload).not.toHaveBeenCalled()
  })

  it('does not reload for the build it is already running', async () => {
    const h = await bootUpdater({ visibility: 'hidden' })
    await h.run()
    expect(h.gate).not.toHaveBeenCalled()
    expect(h.reload).not.toHaveBeenCalled()
  })

  it('does not reload when the HTML refresh failed — the next boot would still be old', async () => {
    const h = await bootUpdater({ servedBuild: NEW_BUILD, visibility: 'hidden' })
    h.failHtml(true)
    await h.run()
    expect(h.reload).not.toHaveBeenCalled()
  })
})
