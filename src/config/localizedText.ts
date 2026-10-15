/**
 * Text a plugin's manifest states for the person to read — a provider's name,
 * a field's title, a sign-in prompt. It is the vendor's own text and is not in
 * Velloc's message catalogs, so it comes as a plain string or a
 * `{ locale: text }` map, and the reader picks one.
 *
 * Pure: no imports, safe for the runtime and the page alike.
 */

export type LocalizedText = string | { readonly [locale: string]: string }

const LOCALE_KEY = /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/
/** One text is a label or a sentence, never a document. */
export const LOCALIZED_TEXT_MAX_LENGTH = 2000

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validText(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.length <= LOCALIZED_TEXT_MAX_LENGTH
}

/** Whether `value` is a string, or a non-empty map of locale tags to strings. */
export function isLocalizedText(value: unknown): value is LocalizedText {
  if (typeof value === 'string') return validText(value)
  if (!isPlainRecord(value)) return false
  const entries = Object.entries(value)
  return entries.length > 0 && entries.every(([locale, text]) => LOCALE_KEY.test(locale) && validText(text))
}

/** Why `value` is not a LocalizedText, for a validation message. */
export function whyNotLocalizedText(value: unknown): string {
  if (typeof value === 'string') return 'is empty or too long'
  if (!isPlainRecord(value)) return 'must be text or a { locale: text } object'
  if (Object.keys(value).length === 0) return 'has no entries'
  for (const [locale, text] of Object.entries(value)) {
    if (!LOCALE_KEY.test(locale)) return `has "${locale}", which is not a locale tag`
    if (!validText(text)) return `has an empty or non-text entry for "${locale}"`
  }
  return 'is not valid'
}

const norm = (locale: string): string => locale.replace(/_/g, '-').toLowerCase()
const languageOf = (locale: string): string => norm(locale).split('-')[0]!

/**
 * The text for `locale`: the person's locale (case and `_`/`-` insensitive),
 * then another region of the same language, then English, then the first
 * entry. `undefined` text reads as `''`.
 */
export function resolveLocalizedText(text: LocalizedText | undefined, locale?: string): string {
  if (text === undefined) return ''
  if (typeof text === 'string') return text
  const entries = Object.entries(text)
  if (entries.length === 0) return ''
  const pick = (match: (key: string) => boolean): string | undefined =>
    entries.find(([key]) => match(key))?.[1]
  if (locale) {
    const wanted = norm(locale)
    const exact = pick(key => norm(key) === wanted)
    if (exact !== undefined) return exact
    const sameLanguage = pick(key => languageOf(key) === languageOf(locale))
    if (sameLanguage !== undefined) return sameLanguage
  }
  return pick(key => languageOf(key) === 'en') ?? entries[0]![1]
}
