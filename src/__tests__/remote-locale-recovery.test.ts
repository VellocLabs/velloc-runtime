import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { en } from '../browser/webview/i18n/messages/en'
import { zh } from '../browser/webview/i18n/messages/zh'
import {
  createTranslate,
  isCatalogLoaded,
  resetCatalogs,
  setCatalog,
} from '../browser/webview/i18n/translate'
import { recoverLocaleCatalog } from '../browser/boot/remoteLocaleRecovery'

// The remote page boots the immutable entry of its desktop runtime's build.
// When the desktop has stayed up across deploys that did not retain that
// build's assets, the entry's locale table names catalogs the origin 404s,
// and every string rendered as its raw key (reported:
// `/v1/assets/locales/en-xVEfEiZC.json` 404 → "locale catalog load failed").
// The recovery reads the CURRENT deploy's manifest from the runtime's origin
// and loads that catalog through the relay.

const RELAY = 'http://192.168.1.10:47615'
const ENTRY = 'https://beta.example/v1/b/20260924T014234067Z/'
const MANIFEST = 'https://beta.example/v1/assets-manifest.json'

const MANIFEST_BODY = {
  buildId: '2026-09-24T01:42:34.067Z',
  assets: [
    { url: 'assets/index-CvEpVC7n.js', size: 1, type: 'script' },
    { url: 'assets/locales/de-ChAV78bi.json', size: 1, type: 'locale' },
    { url: 'assets/locales/en-cK9gL6Rw.json', size: 1, type: 'locale' },
    { url: 'assets/locales/zh-Q1w2E3r4.json', size: 1, type: 'locale' },
  ],
}

function json(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response
}

/** A fetch that answers by URL; anything unlisted is a 404. */
function routes(table: Record<string, unknown>) {
  return vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input)
    return url in table ? json(table[url]) : json(null, 404)
  })
}

const settled = Promise.resolve()

describe('recoverLocaleCatalog', () => {
  beforeEach(() => {
    resetCatalogs()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    // Reinstall what src/__tests__/setup.ts installs, for later files.
    resetCatalogs()
    setCatalog('en', en)
    setCatalog('zh', zh)
  })

  it("loads the current deploy's catalog when the entry's own one is gone", async () => {
    const fetchMock = routes({
      [MANIFEST]: MANIFEST_BODY,
      [`${RELAY}/v1/assets/locales/en-cK9gL6Rw.json`]: en,
    })
    vi.stubGlobal('fetch', fetchMock)
    const t = createTranslate('en')
    // The reported state: no catalog, so the raw key is what renders.
    expect(t('sidebar.recents')).toBe('sidebar.recents')

    const result = await recoverLocaleCatalog({
      locale: 'en',
      entryUrl: ENTRY,
      pageOrigin: RELAY,
      ownAttempt: settled,
      deadlineMs: 1_000,
    })

    expect(result).toEqual({
      outcome: 'recovered',
      locale: 'en',
      url: `${RELAY}/v1/assets/locales/en-cK9gL6Rw.json`,
    })
    expect(t('sidebar.recents')).toBe(en['sidebar.recents'])
    // The manifest from the runtime's origin, revalidated: that path is
    // cached for a year, so only a conditional GET sees the current deploy.
    const [manifestUrl, manifestInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(manifestUrl).toBe(MANIFEST)
    expect(manifestInit).toMatchObject({
      cache: 'no-cache',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    })
    // The catalog through the relay, like every other asset of the page.
    expect(String(fetchMock.mock.calls[1][0])).toBe(
      `${RELAY}/v1/assets/locales/en-cK9gL6Rw.json`,
    )
  })

  it("recovers the page's own locale, not just English", async () => {
    vi.stubGlobal('fetch', routes({
      [MANIFEST]: MANIFEST_BODY,
      [`${RELAY}/v1/assets/locales/zh-Q1w2E3r4.json`]: zh,
    }))

    const result = await recoverLocaleCatalog({
      locale: 'zh',
      entryUrl: ENTRY,
      pageOrigin: RELAY,
      ownAttempt: settled,
      deadlineMs: 1_000,
    })

    expect(result).toMatchObject({ outcome: 'recovered', locale: 'zh' })
    expect(createTranslate('zh')('sidebar.recents')).toBe(zh['sidebar.recents'])
  })

  it('falls back to English when the locale catalog cannot be had', async () => {
    const manifest = {
      assets: MANIFEST_BODY.assets.filter(a => !a.url.includes('/zh-')),
    }
    vi.stubGlobal('fetch', routes({
      [MANIFEST]: manifest,
      [`${RELAY}/v1/assets/locales/en-cK9gL6Rw.json`]: en,
    }))

    const result = await recoverLocaleCatalog({
      locale: 'zh',
      entryUrl: ENTRY,
      pageOrigin: RELAY,
      ownAttempt: settled,
      deadlineMs: 1_000,
    })

    expect(result).toMatchObject({ outcome: 'recovered', locale: 'en' })
    // `t('zh')` walks to English — never the raw key.
    expect(createTranslate('zh')('sidebar.recents')).toBe(en['sidebar.recents'])
  })

  it('does nothing when the page already has its catalog', async () => {
    setCatalog('en', en)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await recoverLocaleCatalog({
      locale: 'en',
      entryUrl: ENTRY,
      pageOrigin: RELAY,
      ownAttempt: settled,
      deadlineMs: 1_000,
    })

    expect(result).toEqual({ outcome: 'not_needed' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('waits for the page\'s own attempt before deciding', async () => {
    // The own load is still in flight when the runtime answers; it succeeds.
    let finishOwn!: () => void
    const ownAttempt = new Promise<void>(resolve => {
      finishOwn = () => {
        setCatalog('en', en)
        resolve()
      }
    })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const pending = recoverLocaleCatalog({
      locale: 'en',
      entryUrl: ENTRY,
      pageOrigin: RELAY,
      ownAttempt,
      deadlineMs: 1_000,
    })
    finishOwn()

    expect(await pending).toEqual({ outcome: 'not_needed' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    ['no entry (an older runtime)', null],
    ['a dev server entry', undefined],
    ['an entry that is not /v<N>/b/<key>/', 'https://beta.example/index.html'],
  ])('skips with %s', async (_label, entryUrl) => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await recoverLocaleCatalog({
      locale: 'en',
      entryUrl,
      pageOrigin: RELAY,
      ownAttempt: settled,
      deadlineMs: 1_000,
    })

    expect(result).toEqual({ outcome: 'no_entry' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports an unreadable manifest without throwing', async () => {
    // A remote with no route to the internet, or an origin that is down.
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    }))

    const result = await recoverLocaleCatalog({
      locale: 'en',
      entryUrl: ENTRY,
      pageOrigin: RELAY,
      ownAttempt: settled,
      deadlineMs: 1_000,
    })

    expect(result).toEqual({ outcome: 'manifest_failed', message: 'Failed to fetch' })
    expect(isCatalogLoaded('en')).toBe(false)
  })

  it('reports a catalog the relay cannot serve', async () => {
    vi.stubGlobal('fetch', routes({ [MANIFEST]: MANIFEST_BODY }))

    const result = await recoverLocaleCatalog({
      locale: 'en',
      entryUrl: ENTRY,
      pageOrigin: RELAY,
      ownAttempt: settled,
      deadlineMs: 1_000,
    })

    expect(result).toMatchObject({ outcome: 'catalog_failed' })
    expect(isCatalogLoaded('en')).toBe(false)
  })

  it('reports a manifest that names no catalog', async () => {
    vi.stubGlobal('fetch', routes({
      [MANIFEST]: { assets: [{ url: 'assets/index-x.js', type: 'script' }] },
    }))

    const result = await recoverLocaleCatalog({
      locale: 'en',
      entryUrl: ENTRY,
      pageOrigin: RELAY,
      ownAttempt: settled,
      deadlineMs: 1_000,
    })

    expect(result).toEqual({ outcome: 'not_in_manifest' })
  })

  it('gives up at the deadline, aborting what is in flight', async () => {
    vi.useFakeTimers()
    // A request that only ends when it is aborted, as a real fetch does.
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('The operation was aborted.', 'AbortError')))
      }))
    vi.stubGlobal('fetch', fetchMock)

    const pending = recoverLocaleCatalog({
      locale: 'en',
      entryUrl: ENTRY,
      pageOrigin: RELAY,
      ownAttempt: settled,
      deadlineMs: 4_000,
    })
    await vi.advanceTimersByTimeAsync(4_000)

    expect(await pending).toMatchObject({ outcome: 'manifest_failed' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('starts no request once the deadline passed on the own attempt', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const pending = recoverLocaleCatalog({
      locale: 'en',
      entryUrl: ENTRY,
      pageOrigin: RELAY,
      // The page's own load hangs: the shell must not wait on it forever.
      ownAttempt: new Promise(() => {}),
      deadlineMs: 4_000,
    })
    await vi.advanceTimersByTimeAsync(4_000)

    expect(await pending).toEqual({ outcome: 'timed_out' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
