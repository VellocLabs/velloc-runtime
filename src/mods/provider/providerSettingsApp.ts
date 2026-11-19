/**
 * A provider's settings app (F-27, F-40): `providers.<key>.settingsApp` names
 * an app template of the same plugin, which the Models page opens when the
 * provider is added and from its editor. Checked here once, where both the
 * plugin's providers and its templates are known.
 */

import type { UpdateChannel } from '../../branding/updateChannels'
import { appIdOf, UI_KEY, type PluginTemplateDecl } from '../ui/uiManifest'
import type { ProviderManifest } from './providerManifest'

/** Why a declared `settingsApp` value is not a template key, or null. */
export function whyNotSettingsAppKey(value: unknown): string | null {
  if (typeof value === 'string' && UI_KEY.test(value)) return null
  return 'settingsApp: expected the key of one of this plugin\'s templates that has an "app" block'
}

/**
 * Checks each provider's `settingsApp` against the plugin's checked templates.
 * A provider naming a missing template, one without an `app` block, or an app
 * another provider of the plugin already names is left out, its problem
 * appended to `errors`; its siblings stay. On a channel that serves no apps
 * the field is dropped and the provider is kept with its fixed settings.
 * Returns the providers kept, or undefined when none is.
 */
export function checkSettingsApps(
  providers: Readonly<Record<string, ProviderManifest>> | undefined,
  templates: Readonly<Record<string, PluginTemplateDecl>> | undefined,
  errors: string[],
  channel: UpdateChannel,
): Record<string, ProviderManifest> | undefined {
  if (!providers) return undefined
  const out: Record<string, ProviderManifest> = {}
  const named = new Map<string, string>()
  for (const [key, provider] of Object.entries(providers)) {
    const app = provider.settingsApp
    if (app === undefined) {
      out[key] = provider
      continue
    }
    if (channel !== 'beta') {
      const { settingsApp: _dropped, ...rest } = provider
      out[key] = rest
      continue
    }
    const label = `providers.${key}.settingsApp`
    const template = templates?.[app]
    if (!template) {
      errors.push(`${label}: "${app}" is not a template of this plugin`)
      continue
    }
    if (!template.app) {
      errors.push(`${label}: templates.${app} has no "app" block`)
      continue
    }
    const holder = named.get(app)
    if (holder !== undefined) {
      errors.push(`${label}: templates.${app} is already providers.${holder}'s settings app; an app serves one provider`)
      continue
    }
    named.set(app, key)
    out[key] = provider
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** The app id of a provider's settings app, or undefined when it names none. */
export function settingsAppIdOf(plugin: string, provider: Pick<ProviderManifest, 'settingsApp'>): string | undefined {
  return provider.settingsApp === undefined ? undefined : appIdOf(plugin, provider.settingsApp)
}
