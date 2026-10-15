import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { en } from '../browser/webview/i18n/messages/en'
import { zh } from '../browser/webview/i18n/messages/zh'
import {
  BOOTSTRAP_MESSAGES,
  createTranslate,
  ensureCatalog,
  isMessageKey,
  LOCALES,
  primeEnCatalog,
  readLocaleAssetMap,
  resetCatalogs,
  resolveLocaleAssetUrl,
  setCatalog,
  whenEnCatalogReady,
  type Locale,
} from '../browser/webview/i18n/translate'
import { buildLocaleAssets } from '../../vite/localeAssetsPlugin'

// Catalogs ship as content-hashed JSON assets fetched at boot rather than JS
// imports, so a translation edit cannot re-hash the JS graph (see
// vite/localeAssetsPlugin.ts for the measured cascade this avoids). These
// tests pin the loader's contract: one fetch per (locale, url), retry after
// failure, live registry reads, and a fallback ladder that never puts a raw
// message key on screen.

const CATALOGS: Record<string, unknown> = { en, zh }

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response
}

/** Reinstall what src/__tests__/setup.ts installs, for tests after this file. */
function restoreSuiteCatalogs(): void {
  resetCatalogs()
  setCatalog('en', en)
  setCatalog('zh', zh)
}

describe('ensureCatalog', () => {
  beforeEach(() => {
    resetCatalogs()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    restoreSuiteCatalogs()
  })

  it('installs a fetched catalog and serves it through createTranslate', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(zh)),
    )

    const t = createTranslate('zh')
    // Before the load there is no catalog at all: the ladder ends at the raw
    // key, which is what the boot deadline renders past.
    expect(t('sidebar.recents')).toBe('sidebar.recents')

    await ensureCatalog('zh', 'https://example.test/zh-abc.json')

    expect(t('sidebar.recents')).toBe(zh['sidebar.recents'])
  })

  it('serves a translator built BEFORE the catalog loaded', async () => {
    // The registry is read on every t() call rather than captured at
    // construction. Module-scope translators (ThreadErrorBoundary's
    // DEFAULT_TRANSLATE, index.tsx's EN_TRANSLATE) are built before any
    // catalog can exist; snapshotting would freeze them for the page's life.
    const t = createTranslate('en')
    expect(t('sidebar.recents')).toBe('sidebar.recents')

    setCatalog('en', en)

    expect(t('sidebar.recents')).toBe(en['sidebar.recents'])
  })

  it('fetches once for concurrent callers of the same url', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(zh))
    vi.stubGlobal('fetch', fetchMock)

    await Promise.all([
      ensureCatalog('zh', 'https://example.test/zh-abc.json'),
      ensureCatalog('zh', 'https://example.test/zh-abc.json'),
      ensureCatalog('zh', 'https://example.test/zh-abc.json'),
    ])

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not refetch a locale already loaded from the same url', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(zh))
    vi.stubGlobal('fetch', fetchMock)

    await ensureCatalog('zh', 'https://example.test/zh-abc.json')
    await ensureCatalog('zh', 'https://example.test/zh-abc.json')

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('refetches when the url changes, because the hash is the version', async () => {
    // A SharedWorker can outlive the page that started it, so a redeploy must
    // be detectable. `registry.has(locale)` would keep serving the old
    // strings; the content-hashed url is the catalog's version identity.
    const updated = { ...zh, 'sidebar.recents': 'REDEPLOYED' }
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(zh))
      .mockResolvedValueOnce(jsonResponse(updated))
    vi.stubGlobal('fetch', fetchMock)

    const t = createTranslate('zh')
    await ensureCatalog('zh', 'https://example.test/zh-old.json')
    expect(t('sidebar.recents')).toBe(zh['sidebar.recents'])

    await ensureCatalog('zh', 'https://example.test/zh-new.json')

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(t('sidebar.recents')).toBe('REDEPLOYED')
  })

  it('clears the in-flight entry on failure so a later call retries', async () => {
    // A cached rejected promise would make every later attempt fail without
    // ever hitting the network again.
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(jsonResponse(zh))
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      ensureCatalog('zh', 'https://example.test/zh-abc.json'),
    ).rejects.toThrow('offline')

    await ensureCatalog('zh', 'https://example.test/zh-abc.json')

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(createTranslate('zh')('sidebar.recents')).toBe(
      zh['sidebar.recents'],
    )
  })

  it('rejects a non-OK response instead of installing garbage', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 404 }) as unknown as Response),
    )

    await expect(
      ensureCatalog('zh', 'https://example.test/zh-missing.json'),
    ).rejects.toThrow('404')
  })

  it('requests with force-cache so a hashed url costs no network after the first load', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(zh))
    vi.stubGlobal('fetch', fetchMock)

    await ensureCatalog('zh', 'https://example.test/zh-abc.json')

    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.test/zh-abc.json',
      expect.objectContaining({ cache: 'force-cache' }),
    )
  })
})

describe('translation fallback ladder', () => {
  beforeEach(() => {
    resetCatalogs()
  })

  afterEach(restoreSuiteCatalogs)

  it('falls back to English when the active locale is not loaded', () => {
    setCatalog('en', en)

    expect(createTranslate('zh')('sidebar.recents')).toBe(
      en['sidebar.recents'],
    )
  })

  it('falls back to the bootstrap set when no catalog is loaded', () => {
    // The crash card can render before any catalog exists, so its strings are
    // the one set that lives in JS.
    expect(createTranslate('zh')('thread.crashedTitle')).toBe(
      BOOTSTRAP_MESSAGES['thread.crashedTitle'],
    )
  })

  it('renders the raw key only when nothing else has the string', () => {
    expect(createTranslate('en')('sidebar.recents')).toBe('sidebar.recents')
  })

  it('still interpolates params when serving a fallback value', () => {
    setCatalog('en', en)

    expect(createTranslate('zh')('sidebar.showMore', { count: 3 })).toBe(
      'Show 3 more',
    )
  })
})

describe('BOOTSTRAP_MESSAGES', () => {
  it('matches the English catalog exactly', () => {
    // These are the only English strings that live in JS. If en.ts changes and
    // this copy does not, a crashing session would show text the rest of the
    // app no longer uses — a second, contradictory source of English.
    for (const [key, value] of Object.entries(BOOTSTRAP_MESSAGES)) {
      expect(en[key as keyof typeof en]).toBe(value)
    }
  })

  it('holds only what code must render with no catalog loaded', () => {
    // Not a size limit for its own sake: every entry is English duplicated
    // into the JS graph, so editing one of THESE en.ts values re-hashes the
    // chunks importing translate.ts. That is the price of never showing a raw
    // key, and it is paid only for the crash card, the chunk-load failure
    // overlay (it fires when a chunk — possibly the catalog's — cannot load)
    // and the slash surface — adding an ordinary UI key here would take
    // churn-free editing away from it for no reason.
    const allowed = /^(thread\.crashed|chunkLoad\.|slash\.)/
    const stray = Object.keys(BOOTSTRAP_MESSAGES).filter(
      key => !allowed.test(key),
    )
    expect(stray).toEqual([])
  })

  it('covers every slash key the worker renders without a catalog', () => {
    // The dispatcher composes the model-facing `message` from the English
    // catalog. A slash key missing here becomes a raw dotted string in the
    // transcript AND in the next request's system turn whenever the worker
    // has no catalog (no `enCatalogUrl` in the init payload, or a failed
    // fetch) — which is exactly the case this map exists for.
    const slashKeys = Object.keys(en).filter(key => key.startsWith('slash.'))
    const covered = Object.keys(BOOTSTRAP_MESSAGES)

    expect(slashKeys.length).toBeGreaterThan(0)
    expect(slashKeys.filter(key => !covered.includes(key))).toEqual([])
  })
})

describe('isMessageKey', () => {
  beforeEach(() => {
    resetCatalogs()
  })

  afterEach(restoreSuiteCatalogs)

  it('accepts a real key and rejects an unknown one', () => {
    setCatalog('en', en)

    expect(isMessageKey('sidebar.recents')).toBe(true)
    expect(isMessageKey('sidebar.notARealKey')).toBe(false)
  })

  it('answers from the bootstrap set before any catalog loads', () => {
    // Answering `false` for everything else routes wire-received keys to their
    // English fallback — the same degradation t() makes, never a raw key.
    expect(isMessageKey('thread.crashedTitle')).toBe(true)
    expect(isMessageKey('sidebar.recents')).toBe(false)
  })
})

describe('locale asset map', () => {
  afterEach(restoreSuiteCatalogs)

  it('reads the map the build injects into index.html', () => {
    const doc = {
      getElementById: () => ({
        textContent: JSON.stringify({
          en: '/assets/locales/en-aaa.json',
          zh: '/assets/locales/zh-bbb.json',
          bogus: '/assets/locales/bogus.json',
        }),
      }),
    } as unknown as Document

    const map = readLocaleAssetMap(doc)

    expect(map.en).toBe('/assets/locales/en-aaa.json')
    expect(map.zh).toBe('/assets/locales/zh-bbb.json')
    expect('bogus' in map).toBe(false)
  })

  it('returns an empty map rather than throwing on malformed or absent input', () => {
    const missing = {
      getElementById: () => null,
    } as unknown as Document
    const malformed = {
      getElementById: () => ({ textContent: '{not json' }),
    } as unknown as Document

    expect(readLocaleAssetMap(missing)).toEqual({})
    expect(readLocaleAssetMap(malformed)).toEqual({})
  })

  it('resolves to an absolute url against the deploy base', () => {
    // Absolute from here on: the worker has no document.baseURI, and nothing
    // downstream should need to know about /v<N>/.
    const url = resolveLocaleAssetUrl(
      'zh',
      { zh: 'assets/locales/zh-bbb.json' },
      'https://beta.velloc.app/v42/index.html',
    )

    expect(url).toBe('https://beta.velloc.app/v42/assets/locales/zh-bbb.json')
  })

  it('returns undefined for a locale the build did not emit', () => {
    expect(resolveLocaleAssetUrl('ja', {}, 'https://x.test/')).toBeUndefined()
  })
})

describe('primeEnCatalog', () => {
  beforeEach(() => {
    resetCatalogs()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    restoreSuiteCatalogs()
  })

  it('lets the worker await English readiness without knowing who started it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(en)),
    )

    primeEnCatalog('https://example.test/en-abc.json')
    await whenEnCatalogReady()

    expect(createTranslate('en')('sidebar.recents')).toBe(
      en['sidebar.recents'],
    )
  })

  it('resolves rather than rejecting when the catalog cannot be fetched', async () => {
    // Callers await readiness, not success — a failed load must not take down
    // the slash dispatcher that awaits it.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline')
      }),
    )

    primeEnCatalog('https://example.test/en-abc.json')

    await expect(whenEnCatalogReady()).resolves.toBeUndefined()
  })

  it('is a no-op without a url, so a host that sends none still boots', async () => {
    primeEnCatalog(undefined)

    await expect(whenEnCatalogReady()).resolves.toBeUndefined()
  })
})

describe('emitted locale assets', () => {
  it('emits one content-hashed asset per supported locale', () => {
    const assets = buildLocaleAssets()

    expect(assets.map((a) => a.locale).sort()).toEqual([...LOCALES].sort())
    for (const asset of assets) {
      expect(asset.fileName).toMatch(
        new RegExp(`^assets/locales/${asset.locale}-[\\w-]{8}\\.json$`),
      )
    }
  })

  it('emits exactly the catalog the source module holds', () => {
    // The .ts catalogs stay the single authoring source: the plugin emits FROM
    // them, so what ships cannot drift from what i18n-catalogs.test.ts and
    // i18n-glossary.test.ts check.
    const assets = buildLocaleAssets()

    for (const locale of ['en', 'zh'] as Locale[]) {
      const asset = assets.find((a) => a.locale === locale)
      expect(JSON.parse(asset!.source)).toEqual(CATALOGS[locale])
    }
  })

  it('hashes from content alone, so rebuilding one commit is byte-identical', () => {
    // Any clock or random value here would churn every locale asset on every
    // deploy — the failure `resolveBuildTime` exists to prevent.
    expect(buildLocaleAssets()).toEqual(buildLocaleAssets())
  })

  it('gives different locales different hashes', () => {
    const hashes = buildLocaleAssets().map((a) => a.fileName)
    expect(new Set(hashes).size).toBe(hashes.length)
  })
})
