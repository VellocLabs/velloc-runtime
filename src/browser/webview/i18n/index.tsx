import { createContext, useContext, useMemo, type ReactNode } from 'react'
import {
  createTranslate,
  resolveLocale,
  type Locale,
  type TranslateFn,
} from './translate'

/**
 * Dependency-free i18n for the webview, REACT half; the registry, loader and `t()`
 * live in `./translate` (re-exported here). The locale follows the boot/host locale
 * (?? `navigator.language`); there is no in-app switcher or persisted override.
 */
export {
  BOOTSTRAP_MESSAGES,
  createTranslate,
  ensureCatalog,
  interpolate,
  isCatalogLoaded,
  isMessageKey,
  LOCALE_MAP_ELEMENT_ID,
  LOCALES,
  primeEnCatalog,
  readLocaleAssetMap,
  resetCatalogs,
  resolveLocale,
  resolveLocaleAssetUrl,
  setCatalog,
  whenEnCatalogReady,
  type Locale,
  type TranslateFn,
} from './translate'

type I18nContextValue = { locale: Locale; t: TranslateFn }

const I18nContext = createContext<I18nContextValue | null>(null)

export function I18nProvider({
  locale: localeProp,
  children,
}: {
  /** BCP-47 tag from the host / boot (Chrome's language). Falls back to
   *  `navigator.language`. */
  locale?: string
  // Optional so `React.createElement(I18nProvider, { locale }, child)` (used
  // by nexusBoot) type-checks — createElement supplies children via its
  // 3rd argument, not the props object.
  children?: ReactNode
}) {
  const value = useMemo<I18nContextValue>(() => {
    const locale = resolveLocale(
      localeProp ??
        (typeof navigator !== 'undefined' ? navigator.language : 'en'),
    )
    return { locale, t: createTranslate(locale) }
  }, [localeProp])

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

/**
 * Returns the `t(key, params?)` translator for the active locale. Outside a
 * provider (e.g. an isolated component test) it falls back to the English
 * catalog so strings never render as raw keys.
 */
const EN_TRANSLATE = createTranslate('en')

export function useT(): TranslateFn {
  return useContext(I18nContext)?.t ?? EN_TRANSLATE
}

/** The active resolved locale (e.g. for `dir="rtl"` or `Intl` formatting). */
export function useLocale(): Locale {
  return useContext(I18nContext)?.locale ?? 'en'
}
