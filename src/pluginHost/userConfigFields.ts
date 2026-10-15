import type { PluginUserConfigField } from './pluginModel'

const FIELD_KEYS = new Set([
  'type', 'title', 'description', 'required', 'default',
  'multiple', 'sensitive', 'min', 'max', 'options',
])
const FIELD_TYPES = ['string', 'number', 'boolean', 'directory', 'file'] as const
const OPTION_MAX_LENGTH = 64
const IDENTIFIER = /^[A-Za-z_]\w*$/
const HIDDEN_CHARS = /[\p{Cc}\p{Cf}\u2028\u2029]/u

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const isFiniteNumber = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v)
const isStringList = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string')

/** Problems with an options list on its own, in reporting order. */
function optionListProblems(options: string[]): string[] {
  if (options.length === 0) return ['the option list is empty']
  const found = new Set<string>()
  const seen = new Set<string>()
  for (const option of options) {
    if (option === '') found.add('an option is an empty string')
    else if (option.length > OPTION_MAX_LENGTH) {
      found.add(`an option is longer than ${OPTION_MAX_LENGTH} characters`)
    } else if (HIDDEN_CHARS.test(option)) {
      found.add('an option holds a control or invisible character')
    } else if (option.trim() !== option) {
      found.add('an option has spaces at its start or end')
    }
    const folded = option.toLowerCase()
    if (seen.has(folded)) found.add('two options differ only in letter case or are equal')
    seen.add(folded)
  }
  return [...found]
}

/** Problems with one field; the first structural failure stops the check. */
function fieldProblems(key: string, raw: unknown): string[] {
  if (!IDENTIFIER.test(key)) {
    return ['the key is used as the CLAUDE_PLUGIN_OPTION_<KEY> variable name, so it must be letters, digits and _ and not start with a digit']
  }
  if (!isRecord(raw)) return ['the field must be an object']
  const extra = Object.keys(raw).filter((k) => !FIELD_KEYS.has(k))
  if (extra.length > 0) {
    const list = extra.map((k) => `"${k}"`).join(', ')
    return [`unknown field property ${list}`]
  }
  if (!(FIELD_TYPES as readonly unknown[]).includes(raw.type)) {
    return [`type is not one of ${FIELD_TYPES.join(' / ')}`]
  }
  if (typeof raw.title !== 'string') {
    return ['title is missing or not text']
  }
  if (typeof raw.description !== 'string') {
    return ['description is missing or not text']
  }

  const out: string[] = []
  for (const flag of ['required', 'multiple', 'sensitive'] as const) {
    if (raw[flag] !== undefined && typeof raw[flag] !== 'boolean') out.push(`${flag} is not true or false`)
  }
  for (const bound of ['min', 'max'] as const) {
    if (raw[bound] !== undefined && !isFiniteNumber(raw[bound])) out.push(`${bound} is not a finite number`)
  }
  const dflt = raw.default
  if (
    dflt !== undefined &&
    typeof dflt !== 'string' && typeof dflt !== 'boolean' &&
    !isFiniteNumber(dflt) && !isStringList(dflt)
  ) {
    out.push('default has an unsupported value')
  }
  if (raw.options !== undefined) {
    if (!isStringList(raw.options)) {
      out.push('options is not a list of text values')
    } else {
      const listProblems = optionListProblems(raw.options)
      out.push(...listProblems)
      if (listProblems.length === 0) {
        if (raw.type !== 'string' || raw.multiple === true || raw.sensitive === true) {
          out.push('options apply only to a single, non-secret string field')
        } else if (dflt === undefined) {
          if (raw.required !== true) {
            out.push('a field with options needs a default or required: true')
          }
        } else if (!raw.options.includes(dflt as string)) {
          out.push(`default is not in the option list (${raw.options.join(' | ')})`)
        }
      }
    }
  }
  return out
}

/** Keeps each valid field; every rejected field adds `userConfig.<key>: …` errors. */
export function readUserConfigFields(
  value: Record<string, unknown>,
  errors: string[],
): Record<string, PluginUserConfigField> {
  const fields: Record<string, PluginUserConfigField> = {}
  for (const [key, raw] of Object.entries(value)) {
    const problems = fieldProblems(key, raw)
    if (problems.length === 0) fields[key] = raw as PluginUserConfigField
    else for (const p of problems) errors.push(`userConfig.${key}: ${p}`)
  }
  return fields
}
