/**
 * Contract: background HTTP-cache warmer for content-hashed assets (every
 * manifest asset but the inactive locales), a
 * dependency-free entry run 5 s after the first screen, then every 30 min and on hide /
 * blur (at least 5 min apart). Validates `assets-manifest.json` (`no-cache`); a
 * known `buildId` for that path returns at once. Chunks resolve against the
 * version root, fetched `force-cache`, `priority: "low"`, 4 at a time, bodies
 * drained. Only after every chunk is warm, and only for a different build, the
 * HTML is refreshed. A staged build is applied by reload only while hidden,
 * with no unsaved-edit holds, and when the runtime's restart gate allows it.
 */

// This entry's ONLY import, inlined by Rollup because nothing else reaches it:
// the built chunk is a classic script and must stay import-free — see
// manifestAssetBase's header and vite/backgroundCacheUpdatePlugin.ts.
import { manifestAssetBase } from './manifestAssetBase'

// { <manifest path>: <buildId> }, most recently warmed last. It was one
// buildId per origin (`__nexusPrefetchedBuildId`), so an origin that booted
// the version root and a build's immutable entry (`b/<key>/`) in turn — two
// different builds — overwrote the other's record every time and re-walked
// the whole manifest on every boot. The old key is left alone: an older
// build's warmer (still booted from its immutable entry) keeps reading it,
// and sharing one key with it would restore the ping-pong.
const BUILD_IDS_KEY = '__nexusPrefetchedBuildIds'
// Every new build adds a `b/<key>/` path; keep only the latest few.
const MAX_RECORDED_ENTRIES = 8
const CONCURRENCY = 4

/** Fetch Priority — supported in Chromium, not yet in lib.dom's RequestInit. */
type LowPriorityInit = RequestInit & { priority?: 'low' }

/** Stream-drain a response body so the HTTP-cache write completes. */
function drainBody(body: ReadableStream<Uint8Array>): Promise<void> {
  const reader = body.getReader()
  return (function drain(): Promise<void> {
    return reader.read().then((chunk) => {
      if (chunk.done) return
      return drain()
    })
  })().then(() => reader.releaseLock())
}

/**
 * Fetch a URL and fully drain the response body so the HTTP-cache write
 * is guaranteed to complete.  Shared by the HTML revalidation (Step 0,
 * `cache: "no-cache"`) and the asset warmer (Step 2, `cache: "force-cache"`).
 * Returns the Response so callers can inspect `res.ok` / `res.json()`.
 */
function fetchAndDrain(url: string, cache: RequestCache): Promise<Response> {
  const init: LowPriorityInit = {
    method: 'GET',
    cache,
    credentials: 'same-origin',
    mode: 'same-origin',
    priority: 'low',
  }
  return fetch(url, init).then((res) => {
    if (res.body) return drainBody(res.body).then(() => res)
    return res.arrayBuffer().then(() => res)
  })
}

/**
 * Fetch a content-hashed asset and drain its response body so the
 * HTTP cache write completes.  Uses `force-cache` so already-cached
 * URLs hit disk instantly.  Throws on non-OK responses so warmBatch
 * can count failures.
 */
function warmOne(url: string): Promise<void> {
  return fetchAndDrain(url, 'force-cache').then((res) => {
    if (!res.ok) throw new Error('warm failed: ' + res.status)
  })
}

/**
 * Warm an array of asset URLs with controlled concurrency.
 * Returns succeeded + failed counts so the caller can decide
 * whether to persist buildId.
 */
function warmBatch(urls: string[]): Promise<{ succeeded: number; failed: number }> {
  const total = urls.length
  if (total === 0) return Promise.resolve({ succeeded: 0, failed: 0 })

  return new Promise((resolve) => {
    let succeeded = 0
    let failed = 0
    let completed = 0
    let nextIdx = 0

    function run() {
      const idx = nextIdx++
      if (idx >= total) return

      warmOne(urls[idx]).then(
        () => { succeeded++; finish() },
        () => { failed++; finish() },
      )
      run()
    }

    function finish() {
      completed++
      if (completed >= total) resolve({ succeeded, failed })
    }

    const poolSize = Math.min(CONCURRENCY, total)
    for (let i = 0; i < poolSize; i++) run()
  })
}

/**
 * The locale catalog this client loads next boot; only that one is prewarmed.
 * Resolution is duplicated to keep this entry dependency-free; a mismatch costs
 * only a missed prewarm.
 */
function activeLocaleFromMap(): string | null {
  const raw = document.getElementById('nexus-locales')?.textContent
  if (!raw) return null
  let map: Record<string, unknown>
  try {
    map = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return null
  }
  let lang = (navigator.language || '').toLowerCase()
  if (lang.startsWith('kr')) lang = 'ko'
  for (const locale of Object.keys(map)) {
    if (locale !== 'en' && lang.startsWith(locale)) return locale
  }
  return 'en'
}

/** The recorded map; anything unreadable or malformed reads as empty. */
function readPrefetched(): Record<string, string> {
  const out: Record<string, string> = {}
  try {
    const raw = localStorage.getItem(BUILD_IDS_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [path, buildId] of Object.entries(parsed)) {
        if (typeof buildId === 'string') out[path] = buildId
      }
    }
  } catch { /* noop */ }
  return out
}

/**
 * Record `buildId` as warm for `path`, moving it to the end and dropping the
 * oldest beyond MAX_RECORDED_ENTRIES. Re-reads first, so a record written by
 * another tab meanwhile is kept. Paths start with `/`, so no key is
 * integer-like and insertion order is the object's key order.
 */
function recordPrefetched(path: string, buildId: string): void {
  const map = readPrefetched()
  delete map[path]
  map[path] = buildId
  const paths = Object.keys(map)
  for (const stale of paths.slice(0, Math.max(0, paths.length - MAX_RECORDED_ENTRIES))) {
    delete map[stale]
  }
  try { localStorage.setItem(BUILD_IDS_KEY, JSON.stringify(map)) } catch { /* noop */ }
}

/** Minimum spacing between two network checks, whatever triggered them. */
const MIN_CHECK_INTERVAL_MS = 5 * 60 * 1000
/** The periodic check; the triggers below only ever run it sooner. */
const CHECK_PERIOD_MS = 30 * 60 * 1000
/** The first check's delay after the page has loaded and shown its first screen. */
const FIRST_RUN_DELAY_MS = 5 * 1000
/** Without a first-screen signal (a boot that ended on an error card or the
 *  pairing page), the first screen is taken as shown this long after load. */
const FIRST_SCREEN_FALLBACK_MS = 60 * 1000
/** Dispatched on `window` by the shell when the boot splash is dismissed. The
 *  literal is kept in step with `FIRST_SCREEN_EVENT` in
 *  `browser/boot/firstScreenSignal.ts`; importing it would give this
 *  import-free entry a chunk import. */
const FIRST_SCREEN_EVENT = 'nexus:first-screen'
// sessionStorage (survives the reload, per tab): the build this page last
// reloaded itself to apply. A reload that comes back on the same old page —
// the new HTML did not stick — must not reload again for that build, or it
// would loop on every trigger.
const RELOADED_FOR_KEY = 'nexus.updateReloadedFor'

/** The build this page booted from — the `nexus-build-time` meta, which is the
 *  same commit-derived value as the manifest's `buildId` (vite.config.ts).
 *  Read here rather than from branding/buildInfo: this entry imports nothing
 *  (see the header). '' when absent. */
function pageBuildId(): string {
  const meta = document.querySelector?.('meta[name="nexus-build-time"]')
  return meta?.getAttribute('content') ?? ''
}

/**
 * The page's restart gate: `true` only when restarting the runtime loses
 * nothing (no turn, task, ask, team, routine run or other client). Registered
 * by the desktop boot (browser/boot/updateRestartGate.ts); absent — a remote
 * page, a dev boot, a boot that failed — means never reload.
 */
type RestartGate = () => Promise<boolean>

// Per page lifetime. A fresh boot starts over from the page's own meta, so
// nothing here can outlive the page it describes (a localStorage record could
// outlive a cleared HTTP cache and pin the page to the old build).
let htmlRefreshedFor: string | null = null
let stagedBuild: string | null = null
let lastCheckAt = 0
let checking: Promise<void> | null = null
let reloading = false
let scheduled = false

/**
 * One check.  The common case — the manifest says this page's own build — is
 * a single conditional GET answered 304: no HTML, no chunks.
 */
function checkOnce(): Promise<void> {
  // The document's BASE, not its address: a remote page served by the
  // desktop's listener shows its bare origin in the address bar and pins a
  // `<base>` to the entry it was really served from (remotePairing.ts). With
  // no `<base>` — the desktop — the two are the same URL.
  const documentUrl = document.baseURI
  const manifestUrl = new URL('./assets-manifest.json', documentUrl).href
  // The warm-state record's key: the version root and each immutable entry
  // have their own manifest, and may be different builds.
  const manifestPath = new URL(manifestUrl).pathname
  // THIS build's manifest is the one next to the document (an immutable entry
  // carries its own), but the chunks it names live at the version root.
  const assetBase = manifestAssetBase(manifestUrl)
  const pageBuild = pageBuildId()

  // Step 1: fetch manifest with revalidation.  res.json() consumes the
  // body (completing the cache write), so no separate drain is needed.
  const manifestInit: LowPriorityInit = {
    method: 'GET',
    cache: 'no-cache',
    credentials: 'same-origin',
    mode: 'same-origin',
    priority: 'low',
  }
  return fetch(manifestUrl, manifestInit).then((res) => {
    if (!res.ok) return null
    return res.json().catch(() => null)
  }).then((data: { buildId?: string; assets?: Array<{ url: string; type: string }> } | null) => {
    if (!data || !data.buildId || !data.assets || !data.assets.length) return
    const buildId = data.buildId

    // Refresh the HTML only once every chunk is warm, so an interrupted batch never
    // leaves the new document over a half-warm chunk set. Marked only on success.
    const refreshHtml = (): Promise<unknown> =>
      buildId !== pageBuild && htmlRefreshedFor !== buildId
        ? fetchAndDrain(documentUrl, 'no-cache').then(
            (res) => { if (res.ok) htmlRefreshedFor = buildId },
            () => { /* network error — the next check retries */ },
          )
        : Promise.resolve()

    const markStaged = () => {
      if (
        buildId !== pageBuild &&
        htmlRefreshedFor === buildId &&
        readPrefetched()[manifestPath] === buildId
      ) {
        stagedBuild = buildId
      }
    }

    // The record alone ends the check only when THIS page has nothing left to
    // do for the build: it is the page's own, or its HTML is already swapped.
    // A record can outlive the HTTP cache (cleared or evicted while
    // localStorage survived), so until the swap the batch runs again —
    // force-cache: a set that is still warm costs no download — and the HTML
    // follows an all-OK batch only, never the record.
    if (
      readPrefetched()[manifestPath] === buildId &&
      (buildId === pageBuild || htmlRefreshedFor === buildId)
    ) {
      markStaged()
      return
    }

    const activeLocale = activeLocaleFromMap()
    const localePrefix = activeLocale ? `assets/locales/${activeLocale}-` : null
    const urls: string[] = []
    for (const a of data.assets) {
      if (a.type !== 'locale') {
        // Every non-locale asset (js, css, fonts, images), so a build staged
        // offline-ready has no file left to fetch on demand.
        urls.push(new URL(a.url, assetBase).href)
      } else if (localePrefix && a.url.startsWith(localePrefix)) {
        // The active locale only — see activeLocaleFromMap.  Warming it here
        // means the next boot resolves the new catalog straight from the HTTP
        // cache, so a redeploy never costs a non-English user a network wait
        // before first render.
        urls.push(new URL(a.url, assetBase).href)
      }
    }
    if (urls.length === 0) return refreshHtml()

    return warmBatch(urls).then((result) => {
      if (result.failed !== 0 || result.succeeded !== urls.length) return
      recordPrefetched(manifestPath, buildId)
      return refreshHtml().then(markStaged)
    })
  }).then(() => undefined, () => undefined)
}

function readReloadedFor(): string | null {
  try { return sessionStorage.getItem(RELOADED_FOR_KEY) } catch { return null }
}

/** True while the page holds unsaved page-local state — a dirty Settings
 *  form, an open dialog, a composer draft. The holds are registered by the
 *  page (glic/unsavedEditsGate.ts) and counted on this global — this entry
 *  stays import-free (see the header), so it cannot import the registry.
 *  Absent reads as none. */
function pageHasUnsavedEdits(): boolean {
  const holds = (window as { __nexusUnsavedEdits?: unknown }).__nexusUnsavedEdits
  return typeof holds === 'number' && holds > 0
}

/**
 * Apply a staged build by reloading, only while hidden, with no page holds
 * (`glic/unsavedEditsGate.ts`), and when the runtime says a restart loses
 * nothing. Never throws.
 */
function maybeReload(): Promise<void> {
  if (reloading || !stagedBuild) return Promise.resolve()
  if (document.visibilityState !== 'hidden') return Promise.resolve()
  if (pageHasUnsavedEdits()) return Promise.resolve()
  if (readReloadedFor() === stagedBuild) return Promise.resolve()
  const gate = (window as { __nexusRestartGate?: RestartGate }).__nexusRestartGate
  if (typeof gate !== 'function') return Promise.resolve()
  const build = stagedBuild
  return gate().then(
    (ready) => {
      // Re-check: the user may have come back, or opened a form, while the
      // runtime answered.
      if (
        ready !== true ||
        reloading ||
        document.visibilityState !== 'hidden' ||
        pageHasUnsavedEdits()
      ) return
      reloading = true
      try { sessionStorage.setItem(RELOADED_FOR_KEY, build) } catch { /* noop */ }
      location.reload()
    },
    () => { /* gate failed — treat as not ready */ },
  )
}

/**
 * A check, unless one ran less than MIN_CHECK_INTERVAL_MS ago or is still
 * running; then, either way, a reload attempt — the throttle spaces the
 * network, not the chance to apply what is already staged.
 */
function runCheck(): Promise<void> {
  const now = Date.now()
  if (!checking && (lastCheckAt === 0 || now - lastCheckAt >= MIN_CHECK_INTERVAL_MS)) {
    lastCheckAt = now
    checking = checkOnce().finally(() => { checking = null })
  }
  return (checking ?? Promise.resolve()).then(maybeReload)
}

/**
 * Background cache-update entry point.  Called by `scheduleFirstRun`; the
 * first call also schedules the periodic check and the triggers — the page
 * going hidden, and the page losing focus. Returns the first check's
 * completion (for tests); callers ignore it.
 */
function runBackgroundCacheUpdate(): Promise<void> {
  if (!scheduled) {
    scheduled = true
    setInterval(() => { void runCheck() }, CHECK_PERIOD_MS)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') void runCheck()
    })
    window.addEventListener('blur', () => { void runCheck() })
  }
  return runCheck()
}

/**
 * The first run: FIRST_RUN_DELAY_MS after the page has both fired `load` and
 * shown its first screen (FIRST_SCREEN_EVENT), so the warm-up's chunk fetches
 * never compete with the boot's own. A page that never signals its first
 * screen is treated as shown FIRST_SCREEN_FALLBACK_MS after load, so a fixed
 * build can still be staged behind a failed boot.
 */
function scheduleFirstRun(): void {
  let loaded = false
  let firstScreen = false
  let started = false
  const maybeStart = (): void => {
    if (started || !loaded || !firstScreen) return
    started = true
    setTimeout(() => { void runBackgroundCacheUpdate() }, FIRST_RUN_DELAY_MS)
  }
  const onFirstScreen = (): void => {
    firstScreen = true
    maybeStart()
  }
  const onLoad = (): void => {
    loaded = true
    setTimeout(onFirstScreen, FIRST_SCREEN_FALLBACK_MS)
    maybeStart()
  }
  window.addEventListener(FIRST_SCREEN_EVENT, onFirstScreen)
  if (document.readyState === 'complete') onLoad()
  else window.addEventListener('load', onLoad)
}

;(window as { __runBackgroundCacheUpdate?: () => Promise<void> }).__runBackgroundCacheUpdate =
  runBackgroundCacheUpdate
scheduleFirstRun()
