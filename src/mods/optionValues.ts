import type { PluginUserConfigField } from '../pluginHost/pluginModel'

/** A value a mod's `userConfig` field can hold. */
export type OptionValue = string | number | boolean | readonly string[]

type Fields = Readonly<Record<string, PluginUserConfigField>>

export interface SettledOptions {
  /** What `register` receives: start values overlaid with stored ones. */
  values: Record<string, OptionValue>
  /** Misfits that block the load (from `checkOptions`). */
  problems: string[]
  /** Stored choices that were set aside; they never block the load. */
  notices: string[]
}

const HIDDEN = '••••'

const labelOf = (key: string, field: PluginUserConfigField): string => field.title || key

const isBlank = (value: unknown): boolean => value === undefined || value === null || value === ''

/**
 * True when `field` limits its value to a list of choices and `value` is
 * not one of them.
 */
export function isOffChoice(field: PluginUserConfigField | undefined, value: unknown): boolean {
  if (!field?.options) return false
  return typeof value !== 'string' || !field.options.includes(value)
}

/** Settle the values a plugin's mod gets from its declared fields and the stored settings. */
export function settleOptions(
  fields?: Fields,
  stored?: Readonly<Record<string, unknown>>,
): SettledOptions {
  const values: Record<string, OptionValue> = {}
  const notices: string[] = []
  if (!fields) return { values, problems: [], notices }

  for (const [key, field] of Object.entries(fields)) {
    if (field.default !== undefined) values[key] = field.default
    else if (!field.required) values[key] = ''

    const saved = stored?.[key]
    if (saved === undefined || saved === null) continue
    if (isOffChoice(field, saved)) {
      const fallback = field.default !== undefined
        ? `using the default ${JSON.stringify(field.default)}`
        : 'leaving it unset'
      notices.push(
        `${labelOf(key, field)}: stored value ${JSON.stringify(saved)} is not one of `
          + `${field.options!.map(o => JSON.stringify(o)).join(', ')}; ${fallback}`,
      )
      continue
    }
    values[key] = saved as OptionValue
  }

  return { values, problems: checkOptions(values, fields), notices }
}

/** One message per way `values` fails to fit `fields`. */
export function checkOptions(
  values: Readonly<Record<string, unknown>>,
  fields: Fields,
): string[] {
  const problems: string[] = []
  for (const [key, field] of Object.entries(fields)) {
    const label = labelOf(key, field)
    const value = values[key]
    if (isBlank(value)) {
      if (field.required) problems.push(`${label} is required but has no value`)
      continue
    }
    switch (field.type) {
      case 'string':
        if (Array.isArray(value)) {
          if (!field.multiple) problems.push(`${label} takes a single text value, not a list`)
          else if (!value.every(item => typeof item === 'string')) {
            problems.push(`${label} must be a list of text values`)
          }
        } else if (typeof value !== 'string') {
          problems.push(`${label} must be text`)
        } else if (field.options && !field.options.includes(value)) {
          problems.push(`${label} must be one of ${field.options.join(', ')}`)
        }
        break
      case 'number':
        if (typeof value !== 'number') {
          problems.push(`${label} must be a number`)
          break
        }
        if (field.min !== undefined && value < field.min) problems.push(`${label} must be at least ${field.min}`)
        if (field.max !== undefined && value > field.max) problems.push(`${label} must be at most ${field.max}`)
        break
      case 'boolean':
        if (typeof value !== 'boolean') problems.push(`${label} must be true or false`)
        break
      case 'file':
      case 'directory':
        if (typeof value !== 'string') problems.push(`${label} must be a ${field.type} path`)
        break
    }
  }
  return problems
}

/** The single-line reason a plugin's mod cannot load because of its options. */
export function optionsLoadError(pluginName: string, pluginId: string, problems: readonly string[]): string {
  return `${pluginName}: options do not match the manifest's userConfig — ${problems.join('; ')}. `
    + `Fix them in settings.json pluginConfigs[${JSON.stringify(pluginId)}].options or in Settings → Plugins.`
}

/** `values` safe to show: sensitive non-empty values are hidden. */
export function publicOptions(
  fields: Fields | undefined,
  values: Readonly<Record<string, OptionValue>>,
): Record<string, OptionValue> {
  const shown: Record<string, OptionValue> = {}
  for (const [key, value] of Object.entries(values)) {
    const secret = fields?.[key]?.sensitive
      && typeof value !== 'boolean'
      && value !== ''
      && !(Array.isArray(value) && value.length === 0)
    shown[key] = secret ? HIDDEN : value
  }
  return shown
}
