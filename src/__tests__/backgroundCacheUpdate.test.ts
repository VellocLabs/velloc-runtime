/**
 * The background HTTP-cache warmer (`src/glic/backgroundCacheUpdate.ts`) end to end: the chunk URLs of a build
 * entry's manifest resolve at the version root (`manifestAssetBase`), not the entry's directory.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const ORIGIN = 'https://beta.velloc.app'
const ROOT = `${ORIGIN}/v1/`
const ENTRY = `${ORIGIN}/v1/b/20260920T230614000Z/`
const BUILD_ID = 'build-abc'
const RECORD_KEY = '__nexusPrefetchedBuildIds'

const manifestOf = (buildId: string, tag: string) => ({
  buildId,
  assets: [
    { url: `assets/index-${tag}.js`, type: 'js' },
    { url: `assets/index-${tag}.css`, type: 'css' },
    { url: `assets/geist-${tag}.woff2`, type: 'font' },
    { url: `assets/logo-${tag}.png`, type: 'other' },
    { url: `assets/locales/fr-${tag}.json`, type: 'locale' },
    // Not the active locale — must not be warmed.
    { url: `assets/locales/de-${tag}.json`, type: 'locale' },
  ],
})
const MANIFEST = manifestOf(BUILD_ID, 'abc')
// What the version root serves: a NEWER build than the entry's.
const ROOT_MANIFEST = manifestOf('build-newer', 'new')

/** The warm-state record: { <manifest path>: <buildId> }. */
function recorded(storage: Storage): Record<string, string> {
  return JSON.parse(storage.getItem(RECORD_KEY) ?? '{}') as Record<string, string>
}

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

function chunkUrls(fetched: string[]): string[] {
  return fetched.filter(
    (u) => u !== ENTRY && u !== ROOT && !u.endsWith('/assets-manifest.json'),
  )
}

/**
 * `address` is what the address bar shows; `baseURI` is what the document resolves against (they differ on a
 * remote page). `pageBuild` is the build the page booted from, by default the one its manifest names.
 */
async function runWarmer(
  {
    address = ENTRY,
    baseURI = ENTRY,
    storage = memoryStorage(),
    expectChunks = 5,
    pageBuild = baseURI === ROOT ? ROOT_MANIFEST.buildId : BUILD_ID,
  }: { address?: string; baseURI?: string; storage?: Storage; expectChunks?: number; pageBuild?: string } = {},
): Promise<{ fetched: string[]; storage: Storage }> {
  const fetched: string[] = []
  const win: { __runBackgroundCacheUpdate?: () => void; addEventListener?: () => void } = {
    addEventListener: () => {},
  }
  const manifestPath = new URL('./assets-manifest.json', baseURI).pathname

  vi.stubGlobal('window', win)
  vi.stubGlobal('location', new URL(address))
  vi.stubGlobal('localStorage', storage)
  vi.stubGlobal('navigator', { language: 'fr-FR' })
  vi.stubGlobal('setInterval', () => 0)
  vi.stubGlobal('document', {
    baseURI,
    addEventListener: () => {},
    querySelector: (sel: string) =>
      sel === 'meta[name="nexus-build-time"]'
        ? { getAttribute: (name: string) => (name === 'content' ? pageBuild : null) }
        : null,
    getElementById: (id: string) =>
      id === 'nexus-locales'
        ? { textContent: JSON.stringify({ en: 'x', fr: 'y', de: 'z' }) }
        : null,
  })
  vi.stubGlobal('fetch', async (input: string) => {
    const url = String(input)
    fetched.push(url)
    if (url === `${ENTRY}assets-manifest.json`) {
      return new Response(JSON.stringify(MANIFEST), { status: 200 })
    }
    if (url === `${ROOT}assets-manifest.json`) {
      return new Response(JSON.stringify(ROOT_MANIFEST), { status: 200 })
    }
    if (url === ENTRY || url === ROOT) return new Response('<html></html>', { status: 200 })
    // What the deploy actually stages: chunks at the version root only.
    if (url.startsWith(`${ORIGIN}/v1/assets/`)) {
      return new Response('chunk', { status: 200 })
    }
    return new Response('not found', { status: 404 })
  })

  vi.resetModules()
  await import('../glic/backgroundCacheUpdate')
  expect(typeof win.__runBackgroundCacheUpdate).toBe('function')
  win.__runBackgroundCacheUpdate!()

  // The manifest is always revalidated, warm or not.
  await vi.waitFor(() => {
    expect(fetched.filter((u) => u.endsWith('/assets-manifest.json'))).toHaveLength(1)
  })
  if (expectChunks === 0) {
    // A warm path stops at the manifest: give a (wrong) batch time to start.
    await new Promise((resolve) => setTimeout(resolve, 20))
    return { fetched, storage }
  }
  // Five chunks: js, css, font, image and the active (fr) locale.
  await vi.waitFor(() => {
    expect(chunkUrls(fetched)).toHaveLength(expectChunks)
  })
  // Let the batch's completion handler record the build id.
  await vi.waitFor(() => {
    expect(recorded(storage)[manifestPath]).toBeDefined()
  }).catch(() => { /* asserted by the caller */ })
  return { fetched, storage }
}

describe('backgroundCacheUpdate at an immutable build entry', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('fetches every chunk from the version root, never from inside the entry', async () => {
    const { fetched } = await runWarmer()
    expect(chunkUrls(fetched).sort()).toEqual([
      `${ORIGIN}/v1/assets/geist-abc.woff2`,
      `${ORIGIN}/v1/assets/index-abc.css`,
      `${ORIGIN}/v1/assets/index-abc.js`,
      `${ORIGIN}/v1/assets/locales/fr-abc.json`,
      `${ORIGIN}/v1/assets/logo-abc.png`,
    ])
    expect(fetched.some((u) => u.includes('/b/20260920T230614000Z/assets/'))).toBe(false)
  })

  it('records the build id once the batch is all-OK, so the next load skips it', async () => {
    const { storage } = await runWarmer()
    expect(recorded(storage)).toEqual({ '/v1/b/20260920T230614000Z/assets-manifest.json': BUILD_ID })
    const again = await runWarmer({ storage, expectChunks: 0 })
    expect(chunkUrls(again.fetched)).toEqual([])
  })

  it('keeps one record per manifest path, so root and entry boots in turn stay warm', async () => {
    // One origin, two different builds: the version root (newest) and an
    // immutable entry (the build a desktop still runs). A single per-origin
    // build id was overwritten by each in turn, so every boot re-walked the
    // whole manifest.
    const storage = memoryStorage()
    await runWarmer({ address: ROOT, baseURI: ROOT, storage })
    await runWarmer({ storage })
    expect(recorded(storage)).toEqual({
      '/v1/assets-manifest.json': 'build-newer',
      '/v1/b/20260920T230614000Z/assets-manifest.json': BUILD_ID,
    })

    const root = await runWarmer({ address: ROOT, baseURI: ROOT, storage, expectChunks: 0 })
    expect(chunkUrls(root.fetched)).toEqual([])
    const entry = await runWarmer({ storage, expectChunks: 0 })
    expect(chunkUrls(entry.fetched)).toEqual([])
  })

  it('reads a malformed or pre-map record as empty, and keeps only the latest entries', async () => {
    const storage = memoryStorage()
    storage.setItem(RECORD_KEY, '"build-abc"')
    const { fetched } = await runWarmer({ storage })
    expect(chunkUrls(fetched)).toHaveLength(5)
    expect(recorded(storage)).toEqual({ '/v1/b/20260920T230614000Z/assets-manifest.json': BUILD_ID })

    // Ten older entries recorded: the newest write survives, the oldest go.
    const old = Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => [`/v1/b/old-${i}/assets-manifest.json`, `b${i}`]))
    storage.setItem(RECORD_KEY, JSON.stringify(old))
    await runWarmer({ storage })
    const paths = Object.keys(recorded(storage))
    expect(paths).toHaveLength(8)
    expect(paths.at(-1)).toBe('/v1/b/20260920T230614000Z/assets-manifest.json')
    expect(paths).not.toContain('/v1/b/old-0/assets-manifest.json')
    expect(paths).toContain('/v1/b/old-9/assets-manifest.json')
  })

  it('on a remote page shown at its bare origin, still reads the entry it was served from', async () => {
    // The listener has no `/assets-manifest.json` at its root; resolving
    // against the address bar would 404 the manifest and warm nothing.
    // An older page than the entry's manifest, so the HTML document is
    // refreshed too — and must be fetched at the entry, not the address.
    const { fetched, storage } = await runWarmer({
      address: 'http://192.168.1.10:47615/',
      baseURI: ENTRY,
      pageBuild: 'build-old',
    })
    expect(fetched).toContain(`${ENTRY}assets-manifest.json`)
    expect(fetched).toContain(ENTRY)
    expect(fetched.some((u) => u.startsWith('http://192.168.1.10:47615'))).toBe(false)
    expect(recorded(storage)['/v1/b/20260920T230614000Z/assets-manifest.json']).toBe(BUILD_ID)
  })
})
