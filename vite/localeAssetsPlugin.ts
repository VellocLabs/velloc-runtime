import { createHash } from 'node:crypto'
import type { Plugin } from 'vite'
import { en } from '../src/browser/webview/i18n/messages/en'
import { zh } from '../src/browser/webview/i18n/messages/zh'
import { es } from '../src/browser/webview/i18n/messages/es'
import { fr } from '../src/browser/webview/i18n/messages/fr'
import { de } from '../src/browser/webview/i18n/messages/de'
import { ja } from '../src/browser/webview/i18n/messages/ja'
import { ko } from '../src/browser/webview/i18n/messages/ko'
import { LOCALE_MAP_ELEMENT_ID } from '../src/browser/webview/i18n/translate'

/**
 * Ships each message catalog as a content-hashed JSON asset instead of a JS
 * import, so a string edit re-hashes only its own catalog rather than every
 * chunk up to the entry. index.html carries the locale map: it is unhashed,
 * revalidated by the background updater and read synchronously at boot. The
 * `messages/*.ts` files stay the single authoring source; the JSON is emitted
 * from them.
 */
const CATALOGS: Record<string, unknown> = { en, zh, es, fr, de, ja, ko }

/** Dev-server path prefix; production uses content-hashed assets instead. */
const DEV_LOCALE_PREFIX = '__nexus_locale__'

function serialize(catalog: unknown): string {
  // Stable by construction: key order is the source object's insertion order
  // and nothing here reads a clock or a random value, so two builds of one
  // commit emit byte-identical files (and identical hashes).
  return JSON.stringify(catalog) + '\n'
}

function hashOf(source: string): string {
  return createHash('sha256').update(source).digest('base64url').slice(0, 8)
}

export type LocaleAssetEntry = {
  locale: string
  fileName: string
  source: string
}

/** The emitted set, computed from content alone — no bundle dependency. */
export function buildLocaleAssets(): LocaleAssetEntry[] {
  return Object.entries(CATALOGS).map(([locale, catalog]) => {
    const source = serialize(catalog)
    return {
      locale,
      fileName: `assets/locales/${locale}-${hashOf(source)}.json`,
      source,
    }
  })
}

export function localeAssetsPlugin(): Plugin {
  const assets = buildLocaleAssets()
  let base = '/'
  let isBuild = false

  return {
    name: 'locale-assets',

    configResolved(config) {
      base = config.base
      isBuild = config.command === 'build'
    },

    // Dev has no generateBundle, so serve the catalogs from a stable path.
    // Same shape the runtime expects, so boot code takes one path in both
    // modes.
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split('?')[0] ?? ''
        const match = /\/__nexus_locale__\/([a-z-]+)\.json$/.exec(url)
        if (!match) return next()
        const entry = assets.find((a) => a.locale === match[1])
        if (!entry) return next()
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        // No caching in dev: edits to a catalog should show up on reload.
        res.setHeader('Cache-Control', 'no-store')
        res.end(entry.source)
      })
    },

    generateBundle() {
      for (const entry of assets) {
        this.emitFile({
          type: 'asset',
          fileName: entry.fileName,
          source: entry.source,
        })
      }
    },

    transformIndexHtml: {
      order: 'post',
      handler() {
        const map: Record<string, string> = {}
        for (const entry of assets) {
          map[entry.locale] = isBuild
            ? `${base}${entry.fileName}`
            : `${base}${DEV_LOCALE_PREFIX}/${entry.locale}.json`
        }
        return [
          {
            tag: 'script',
            attrs: { type: 'application/json', id: LOCALE_MAP_ELEMENT_ID },
            children: JSON.stringify(map),
            injectTo: 'head-prepend',
          },
        ]
      },
    },
  }
}
