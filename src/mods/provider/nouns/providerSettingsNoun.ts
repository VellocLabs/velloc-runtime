/**
 * `$.provider.settings()`: the manifest-declared settings as the person set them,
 * read-only (`settleOptions`). Security: a `sensitive` field is left out altogether,
 * and secret sign-in answers are withheld; `signin` is a reserved name.
 */

import { settleOptions, type OptionValue } from '../../optionValues'
import type { PluginUserConfigField } from '../../../pluginHost/pluginModel'
import type { ProviderNounCall } from '../ProviderModRuntime'
import type { ProviderManifest } from '../providerManifest'
import { providerOf } from './providerNounTable'

export const SIGNIN_OPTION_PREFIX = 'signin.'

export type ProviderSettingsDeps = {
  /** The registered provider's manifest and its plugin's settings id, or undefined. */
  registrationOf: (providerId: string) => { manifest: ProviderManifest; configId?: string } | undefined
  /** The stored options of a plugin (`pluginConfigs.<id>.options`). */
  readOptions: (configId: string) => Promise<Readonly<Record<string, unknown>> | undefined>
}

export type ProviderSettingValues = Record<string, OptionValue | Record<string, OptionValue>>

function isPlainValue(value: unknown): value is OptionValue {
  return (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    (Array.isArray(value) && value.every(item => typeof item === 'string'))
  )
}

/** The values for one manifest over the stored options. Exported for tests. */
export function providerSettingValues(
  manifest: ProviderManifest,
  stored: Readonly<Record<string, unknown>> | undefined,
): ProviderSettingValues {
  // `settleOptions` reads the field rules; the text a field carries for the
  // settings page is not needed here.
  const fields: Record<string, PluginUserConfigField> = {}
  for (const [key, field] of Object.entries(manifest.settings ?? {})) {
    const { title: _title, description: _description, ...rule } = field
    fields[key] = { ...rule, title: key, description: '' }
  }
  const settled = settleOptions(fields, stored)
  const out: ProviderSettingValues = {}
  for (const [key, value] of Object.entries(settled.values)) {
    if (fields[key]?.sensitive) continue
    out[key] = value
  }

  const secretPrompts = new Set(
    (manifest.credentials.prompts ?? []).filter(prompt => prompt.type === 'text' && prompt.secret === true).map(prompt => prompt.key),
  )
  const signin: Record<string, OptionValue> = {}
  for (const [name, value] of Object.entries(stored ?? {})) {
    if (!name.startsWith(SIGNIN_OPTION_PREFIX)) continue
    const key = name.slice(SIGNIN_OPTION_PREFIX.length)
    if (key === '' || secretPrompts.has(key) || !isPlainValue(value)) continue
    signin[key] = value
  }
  out.signin = signin
  return out
}

export function createProviderSettings(deps: ProviderSettingsDeps): (call: ProviderNounCall) => Promise<ProviderSettingValues> {
  return async call => {
    const providerId = providerOf(call, call.args[0])
    const registration = deps.registrationOf(providerId)
    if (!registration) {
      const error = new Error(`$.provider.settings: ${providerId} is not registered`)
      error.name = 'NotSupportedError'
      throw error
    }
    const stored = registration.configId !== undefined ? await deps.readOptions(registration.configId) : undefined
    return providerSettingValues(registration.manifest, stored)
  }
}
