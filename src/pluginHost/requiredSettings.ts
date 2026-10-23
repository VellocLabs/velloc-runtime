/**
 * The settings a plugin declares and the required ones still unset: its
 * `userConfig` fields and its providers' `settings`, which share the plugin's
 * stored options (`pluginConfigs.<id>.options`). A required field with a
 * default is never missing (F-25).
 */

import { resolveLocalizedText } from '../config/localizedText'
import { checkOptions } from '../mods/optionValues'
import type { PluginDescriptor, PluginUserConfigField } from './pluginModel'

export type DeclaredSettings = Record<string, PluginUserConfigField>

/** An own property even for a name such as `__proto__`. */
const put = <T>(target: Record<string, T>, name: string, value: T): void => {
  Object.defineProperty(target, name, { value, enumerable: true, configurable: true, writable: true })
}

const isBlank = (value: unknown): boolean =>
  value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)

/**
 * Every field the manifests declare, by option name, with a provider
 * setting's text resolved for `locale`. The first declaration of a name wins:
 * `userConfig` before provider settings, then manifest order.
 */
export function declaredSettings(manifests: readonly PluginDescriptor[], locale?: string): DeclaredSettings {
  const out: DeclaredSettings = {}
  const add = (name: string, field: PluginUserConfigField) => {
    if (!Object.hasOwn(out, name)) put(out, name, field)
  }
  for (const manifest of manifests) {
    for (const [name, field] of Object.entries(manifest.userConfig ?? {})) add(name, field)
  }
  for (const manifest of manifests) {
    for (const provider of Object.values(manifest.providers ?? {})) {
      for (const [name, field] of Object.entries(provider.settings ?? {})) {
        add(name, {
          ...field,
          title: resolveLocalizedText(field.title, locale) || name,
          description: resolveLocalizedText(field.description, locale),
        })
      }
    }
  }
  return out
}

/** The `required` fields with neither a stored value nor a default. */
export function missingRequiredSettings(
  fields: Readonly<DeclaredSettings>,
  stored: Readonly<Record<string, unknown>> | undefined,
): DeclaredSettings {
  const missing: DeclaredSettings = {}
  for (const [name, field] of Object.entries(fields)) {
    if (field.required !== true) continue
    const value = stored !== undefined && Object.hasOwn(stored, name) ? stored[name] : undefined
    if (isBlank(value ?? field.default)) put(missing, name, field)
  }
  return missing
}

/**
 * One message per way `values` fails the declared fields: a name the plugin
 * does not declare, or a value that does not fit its field. A blank value
 * passes (it leaves the field unset).
 */
export function settingValueProblems(
  fields: Readonly<DeclaredSettings>,
  values: Readonly<Record<string, unknown>>,
): string[] {
  const problems: string[] = []
  const named: DeclaredSettings = {}
  for (const name of Object.keys(values)) {
    if (!Object.hasOwn(fields, name)) problems.push(`\`${name}\` is not a setting this plugin declares`)
    else put<PluginUserConfigField>(named, name, { ...fields[name]!, required: false })
  }
  return [...problems, ...checkOptions(values, named)]
}
