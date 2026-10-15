import { describe, expect, it } from 'vitest'

import { en, type MessageKey } from '../browser/webview/i18n/messages/en'
import { zh } from '../browser/webview/i18n/messages/zh'
import { es } from '../browser/webview/i18n/messages/es'
import { fr } from '../browser/webview/i18n/messages/fr'
import { de } from '../browser/webview/i18n/messages/de'
import { ja } from '../browser/webview/i18n/messages/ja'
import { ko } from '../browser/webview/i18n/messages/ko'
import { createTranslate, resolveLocale } from '../browser/webview/i18n'
import { getProductName } from '../branding/productName'

// Catalog-integrity guard for the webview i18n system. The `Messages` type
// enforces that every locale has every KEY, but TypeScript can't catch the two
// failure modes a (often machine-assisted) translation pass actually hits:
//   1. an empty / whitespace-only value (a key "covered" but not translated), and
//   2. a dropped or renamed `{placeholder}` token (so interpolation silently
//      breaks in that one language while English looks fine).
// These tests fail loudly on both, per-locale, so a future catalog edit can't
// drift out of sync with the English source of truth.

const NON_EN = { zh, es, fr, de, ja, ko } as const
const ALL = { en, ...NON_EN } as const

const enKeys = Object.keys(en) as MessageKey[]

/** The set of `{token}` names referenced by a message value. */
function placeholders(value: string): Set<string> {
  const out = new Set<string>()
  for (const m of value.matchAll(/\{(\w+)\}/g)) out.add(m[1]!)
  return out
}

describe('i18n catalogs', () => {
  for (const [locale, catalog] of Object.entries(NON_EN)) {
    describe(locale, () => {
      it('has exactly the English key set (no missing, no stray)', () => {
        expect(Object.keys(catalog).sort()).toEqual([...enKeys].sort())
      })

      it('has a non-empty string for every key', () => {
        const blank = enKeys.filter((k) => {
          const v = (catalog as Record<string, string>)[k]
          return typeof v !== 'string' || v.trim() === ''
        })
        expect(blank).toEqual([])
      })

      it('preserves every {placeholder} token from the English source', () => {
        const mismatched = enKeys.filter((k) => {
          const want = placeholders(en[k])
          const got = placeholders((catalog as Record<string, string>)[k]!)
          if (want.size !== got.size) return true
          for (const token of want) if (!got.has(token)) return true
          return false
        })
        expect(mismatched).toEqual([])
      })
    })
  }

  // A sentence is ONE key with `{placeholder}`s, never two keys concatenated
  // around a value at the call site (G-1).
  // Word order is not universal: a `…Prefix`/`…Suffix` pair forces every locale
  // into the English arrangement, and the split is invisible to the type system
  // and to an English-only review — so name the pattern here instead.
  it('has no sentence-fragment key pairs (…Prefix / …Suffix)', () => {
    const fragments = enKeys.filter((k) => {
      const base = k.replace(/(Prefix|Suffix)$/, '')
      return base !== k && enKeys.includes(base as MessageKey)
    })
    expect(fragments).toEqual([])
  })

  // The visible product name must follow the build's branding
  // (`branding_path_component` → getProductName()), never the internal "Nexus"
  // codename. Catalogs reference it via the implicit `{product}` token (see
  // `interpolate` in i18n/index.tsx), so a literal "Nexus" in ANY locale is a
  // brand leak.
  for (const [locale, catalog] of Object.entries(ALL)) {
    it(`${locale}: never hard-codes the internal "Nexus" codename`, () => {
      const leaked = enKeys.filter((k) =>
        /nexus/i.test((catalog as Record<string, string>)[k]!),
      )
      expect(leaked).toEqual([])
    })
  }

  // User-facing strings/links carry only Velloc's own brand: none of the
  // third-party tool names the regex below lists, and no `claude.com` URL
  // (e.g. the bypass-dialog "Learn more about security" link points at the
  // product's own docs). Real third-party product names the user picks —
  // model labels like "Claude Opus 4.8", the "Anthropic" provider — live in the
  // model/provider config, NOT these catalogs, so a bare "Claude"/"claude.com"
  // here is always a leak.
  for (const [locale, catalog] of Object.entries(ALL)) {
    it(`${locale}: never leaks third-party branding`, () => {
      const leaked = enKeys.filter((k) =>
        /claude\.com|claude code|\bCC\b/i.test(
          (catalog as Record<string, string>)[k]!,
        ),
      )
      expect(leaked).toEqual([])
    })
  }

  // The provider-API-error card's summary is the string the e2e suite asserts
  // verbatim, and it is
  // also where the card used to interpolate `getProductName()` into a hard-
  // coded English sentence. Pinning the rendered English here keeps the
  // catalog migration byte-identical to what the specs expect, and proves the
  // implicit `{product}` token resolves — a catalog value that spelled the
  // product name out would pass every other test in this file.
  describe('provider-API-error card summary', () => {
    const t = createTranslate('en')
    const product = getProductName()

    it('renders the retried summary the e2e suite asserts', () => {
      expect(t('thread.providerRetriedSummary', { count: 10 })).toBe(
        `${product} retried the request 10 times and stopped so you can decide what to do next.`,
      )
      expect(t('thread.providerRetriedSummaryOne', { count: 1 })).toBe(
        `${product} retried the request 1 time and stopped so you can decide what to do next.`,
      )
      expect(t('thread.providerNoRetrySummary')).toContain(
        `${product} did not retry`,
      )
    })

    it('carries the product token into every locale', () => {
      for (const locale of Object.keys(NON_EN) as (keyof typeof NON_EN)[]) {
        const translated = createTranslate(locale)('thread.providerRetriedSummary', {
          count: 3,
        })
        expect(translated, locale).toContain(product)
        expect(translated, locale).toContain('3')
        expect(translated, locale).not.toContain('{')
      }
    })
  })
})

describe('resolveLocale', () => {
  it('maps BCP-47 tags to the supported catalogs', () => {
    expect(resolveLocale('zh-CN')).toBe('zh')
    expect(resolveLocale('zh')).toBe('zh')
    expect(resolveLocale('es-419')).toBe('es')
    expect(resolveLocale('fr-FR')).toBe('fr')
    expect(resolveLocale('de-AT')).toBe('de')
    expect(resolveLocale('ja-JP')).toBe('ja')
    expect(resolveLocale('ja')).toBe('ja')
    expect(resolveLocale('ko-KR')).toBe('ko')
    // `kr` is the country code, not the language code, but it turns up in
    // hand-written locale settings and plainly means Korean.
    expect(resolveLocale('kr')).toBe('ko')
    expect(resolveLocale('en-US')).toBe('en')
  })

  it('falls back to English for unknown / missing tags', () => {
    // `ja` used to stand in for "unsupported" here — it ships now, so this
    // needs a tag that genuinely has no catalog.
    expect(resolveLocale('it')).toBe('en')
    expect(resolveLocale('')).toBe('en')
    expect(resolveLocale(undefined)).toBe('en')
    expect(resolveLocale(null)).toBe('en')
  })
})
