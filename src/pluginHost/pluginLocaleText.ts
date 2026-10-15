/**
 * A plugin's own text in the person's language from `<plugin>/locales/<tag>.json`
 * (key `plugin.description`), replacing the manifest's English string. Reads the
 * tag, then the bare language; never English (F-25).
 */

import type { RuntimeFs } from '../utils/fs/runtimeFs'
import { joinRuntimePath } from '../utils/runtimePaths'
import { LOCALIZED_TEXT_MAX_LENGTH } from '../config/localizedText'

/** The language files' key for the manifest's `description`. */
export const PLUGIN_DESCRIPTION_KEY = 'plugin.description'

const TAG = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/

/** The files to try for `locale`, most specific first; none for English. */
export function pluginLocaleCandidates(locale: string | undefined): string[] {
  const tag = typeof locale === 'string' ? locale.trim().replace(/_/g, '-') : ''
  if (!TAG.test(tag)) return []
  const language = tag.split('-')[0]!.toLowerCase()
  if (language === 'en') return []
  return [...new Set([tag, language])]
}

/**
 * `key` from the plugin's file for `locale`, or undefined: no such file, no
 * such key, not text, blank or over the length a label may have. A file that
 * exists but lacks the key falls through to the language's own file.
 */
export async function readPluginLocaleText(
  fs: RuntimeFs,
  pluginPath: string,
  locale: string | undefined,
  key: string,
): Promise<string | undefined> {
  for (const name of pluginLocaleCandidates(locale)) {
    let table: unknown
    try {
      table = JSON.parse(String(await fs.readFile(joinRuntimePath(pluginPath, 'locales', `${name}.json`), { encoding: 'utf-8' })))
    } catch {
      continue
    }
    const value = typeof table === 'object' && table !== null ? (table as Record<string, unknown>)[key] : undefined
    if (typeof value === 'string' && value.trim() !== '' && value.length <= LOCALIZED_TEXT_MAX_LENGTH) return value
  }
  return undefined
}
