/**
 * Plugin references: `<name>` or `<name>@<marketplace>`.
 * See docs F-14 "Plugin references".
 */
import { RESERVED_MARKETPLACE_NAMES } from './marketplaceNaming'

export type PluginRef = { name: string; marketplace?: string }

export type PluginRefErrorCode =
  | 'empty'
  | 'missing_at'
  | 'multiple_at'
  | 'empty_name'
  | 'empty_marketplace'
  | 'invalid_marketplace_char'

export type PluginRefError = { code: PluginRefErrorCode; message: string }

export type StrictPluginRefResult =
  | { ok: true; value: { name: string; marketplace: string } }
  | { ok: false; error: PluginRefError }

/** Lenient split; never throws. Text from a second `@` on is dropped. */
export function splitPluginRef(ref: string): PluginRef {
  const parts = ref.split('@')
  if (parts.length === 1) return { name: ref }
  return { name: parts[0], marketplace: parts[1] }
}

export function joinPluginRef(name: string, marketplace?: string): string {
  return marketplace ? `${name}@${marketplace}` : name
}

export function isCuratedCatalog(marketplace?: string): boolean {
  if (marketplace === undefined) return false
  return RESERVED_MARKETPLACE_NAMES.has(marketplace.toLowerCase())
}

function fail(code: PluginRefErrorCode, message: string): StrictPluginRefResult {
  return { ok: false, error: { code, message } }
}

/** Strict reader: requires exactly one `@` with both sides non-empty. */
export function readStrictPluginRef(input: unknown): StrictPluginRefResult {
  if (typeof input !== 'string' || input.trim() === '') {
    return fail('empty', 'A plugin reference is required.')
  }
  const text = input.trim()
  const parts = text.split('@')
  if (parts.length === 1) {
    return fail('missing_at', `"${text}" needs the form name@marketplace.`)
  }
  if (parts.length > 2) {
    return fail('multiple_at', `"${text}" contains more than one @.`)
  }
  const [name, marketplace] = parts
  if (name === '') return fail('empty_name', 'The plugin name is empty.')
  if (marketplace === '') {
    return fail('empty_marketplace', 'The marketplace name is empty.')
  }
  if (marketplace.includes('/')) {
    return fail(
      'invalid_marketplace_char',
      `"${text}" has a / in the marketplace name.`,
    )
  }
  return { ok: true, value: { name, marketplace } }
}
