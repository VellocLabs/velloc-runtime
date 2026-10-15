/**
 * Remote locale-catalog recovery (F-24): when the build entry's catalog is gone, take the current one
 * listed in the runtime origin's `assets-manifest.json` (a public cross-origin `no-cache` read); the
 * catalog itself loads through the relay. One deadline bounds it; never rejects.
 */
import {
  ensureCatalog,
  isCatalogLoaded,
  type Locale,
} from '../webview/i18n/translate'

export type LocaleRecoveryOutcome =
  /** The page's own catalog loaded; nothing to recover. */
  | { outcome: 'not_needed' }
  /** No build entry to find the origin by (older runtime, dev server). */
  | { outcome: 'no_entry' }
  /** The deadline passed while the page's own attempt was still pending. */
  | { outcome: 'timed_out' }
  | { outcome: 'manifest_failed'; message: string }
  /** The current manifest names no catalog for the locale, nor for English. */
  | { outcome: 'not_in_manifest' }
  | { outcome: 'catalog_failed'; message: string }
  /** `locale` is the catalog that loaded: the page's, or English. */
  | { outcome: 'recovered'; locale: Locale; url: string }

type ManifestAsset = { url?: unknown; type?: unknown }

export async function recoverLocaleCatalog(options: {
  locale: Locale
  /** `runtime.getBuildEntry`'s `entryUrl`, e.g.
   *  `https://beta.velloc.app/v1/b/20260924T014234067Z/`. */
  entryUrl: string | null | undefined
  /** The page's own origin: the relay the catalog is fetched through. */
  pageOrigin: string
  /** The page's own catalog load (`startLocalePreload`), which never rejects. */
  ownAttempt: Promise<unknown>
  deadlineMs: number
}): Promise<LocaleRecoveryOutcome> {
  const { locale, entryUrl, pageOrigin, ownAttempt, deadlineMs } = options
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<void>(resolve => {
    timer = setTimeout(() => {
      controller.abort()
      resolve()
    }, deadlineMs)
  })
  try {
    await Promise.race([ownAttempt, deadline])
    if (isCatalogLoaded(locale)) return { outcome: 'not_needed' }
    if (controller.signal.aborted) return { outcome: 'timed_out' }

    const origin = versionRootOf(entryUrl)
    if (!origin) return { outcome: 'no_entry' }

    let assets: ManifestAsset[]
    try {
      const res = await fetch(`${origin.origin}${origin.root}assets-manifest.json`, {
        cache: 'no-cache',
        credentials: 'omit',
        // The page path names the build entry; the origin needs none of it.
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const manifest = (await res.json()) as { assets?: unknown }
      if (!Array.isArray(manifest?.assets)) throw new Error('no assets list')
      assets = manifest.assets as ManifestAsset[]
    } catch (error) {
      return { outcome: 'manifest_failed', message: messageOf(error) }
    }

    // The page's locale first. English only when it is not loaded already:
    // `t()` falls back to English on its own, so an English catalog that
    // DID load from the page's own table needs no replacing.
    const wanted: Locale[] = [locale]
    if (locale !== 'en' && !isCatalogLoaded('en')) wanted.push('en')
    let lastError: unknown = null
    let named = false
    for (const candidate of wanted) {
      const path = catalogPathIn(assets, candidate)
      if (!path) continue
      named = true
      const url = new URL(origin.root + path, pageOrigin).href
      try {
        await ensureCatalog(candidate, url, { signal: controller.signal })
        return { outcome: 'recovered', locale: candidate, url }
      } catch (error) {
        lastError = error
      }
    }
    if (!named) return { outcome: 'not_in_manifest' }
    return { outcome: 'catalog_failed', message: messageOf(lastError) }
  } finally {
    clearTimeout(timer)
  }
}

/** `https://host/v1/b/<key>/` → `{ origin: 'https://host', root: '/v1/' }`.
 *  The version segment leads the path, as in `buildEntryUrl`. */
function versionRootOf(
  entryUrl: string | null | undefined,
): { origin: string; root: string } | null {
  if (!entryUrl) return null
  let url: URL
  try {
    url = new URL(entryUrl)
  } catch {
    return null
  }
  const m = /^(\/v[0-9]+\/)b\/[^/]+\/$/.exec(url.pathname)
  return m ? { origin: url.origin, root: m[1] } : null
}

/** The manifest's `assets/locales/<locale>-<hash>.json`, or null. */
function catalogPathIn(assets: ManifestAsset[], locale: Locale): string | null {
  const shape = new RegExp(`^assets/locales/${locale}-[A-Za-z0-9_-]+\\.json$`)
  for (const asset of assets) {
    if (asset?.type === 'locale' && typeof asset.url === 'string' && shape.test(asset.url)) {
      return asset.url
    }
  }
  return null
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
