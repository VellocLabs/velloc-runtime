/**
 * An app's own text in the person's language (F-40): the plugin's
 * `locales/<tag>.json` files merged into one flat table, which the app's
 * surfaces read under `/text`: English, then the language, then the tag.
 * Security: the files are the plugin's own and are read as data alone; a
 * table is bounded in entries and text length, and a key that would not be
 * one segment of a data path is left out.
 */

import { LOCALIZED_TEXT_MAX_LENGTH } from '../../config/localizedText'
import { joinRuntimePath } from '../../utils/runtimePaths'
import { normalizeModLocale } from '../modLocale'

/** The entries one app's table may hold; the rest of a larger one are left out. */
export const APP_TEXT_MAX_KEYS = 2000
/** Keys of the plugin's manifest text, which is not the app's. */
const RESERVED_PREFIX = 'plugin.'
const TAG = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/

/** The language files of `locale`, least specific first: `en`, the language, the tag as given. */
export function appTextFiles(locale: string | undefined): string[] {
  const tag = normalizeModLocale(locale)
  if (!TAG.test(tag)) return ['en']
  return [...new Set(['en', tag.split('-')[0]!.toLowerCase(), tag])]
}

/** The entries of one parsed file an app may bind to. */
export function appTextEntries(table: unknown): Array<[string, string]> {
  if (typeof table !== 'object' || table === null || Array.isArray(table)) return []
  const entries: Array<[string, string]> = []
  for (const [key, value] of Object.entries(table)) {
    if (key === '' || key.includes('/') || key.includes('~') || key.startsWith(RESERVED_PREFIX)) continue
    if (typeof value !== 'string' || value.length > LOCALIZED_TEXT_MAX_LENGTH) continue
    entries.push([key, value])
  }
  return entries
}

/**
 * The plugin's text for `locale`, or undefined when no file gave an entry.
 * `read` answers a file's text, or undefined when it cannot be read; a file
 * that is missing or is not JSON counts as empty.
 */
export async function readAppText(
  read: (path: string) => Promise<string | undefined>,
  pluginRoot: string,
  locale: string | undefined,
): Promise<Record<string, string> | undefined> {
  const text = new Map<string, string>()
  for (const name of appTextFiles(locale)) {
    const raw = await read(joinRuntimePath(pluginRoot, 'locales', `${name}.json`))
    if (raw === undefined) continue
    let table: unknown
    try {
      table = JSON.parse(raw)
    } catch {
      continue
    }
    for (const [key, value] of appTextEntries(table)) {
      if (text.has(key) || text.size < APP_TEXT_MAX_KEYS) text.set(key, value)
    }
  }
  return text.size > 0 ? Object.fromEntries(text) : undefined
}
