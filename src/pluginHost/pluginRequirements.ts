/**
 * `requires` — what must be true before a plugin's components take effect
 * (F-14). Built: `providers`, keys of the plugin's OWN providers that must be
 * set up on the Models page. A word this Velloc does not know keeps the plugin
 * waiting: never less than the author asked for.
 * The plugin's providers themselves are never gated — they are where the
 * person meets the gate. Pure.
 */

import type { ActivePlugin } from './pluginModel'

export type PluginRequires = {
  /** Keys of this plugin's `providers`. */
  providers?: string[]
  /** `requires` words this Velloc does not serve; any one keeps the plugin waiting. */
  unknown?: string[]
}

/** The `requires` words this Velloc reads. */
export const REQUIRES_WORDS = ['providers'] as const

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Validate `requires`. A provider key the manifest does not declare is an error
 * and is KEPT, so the plugin waits for ever rather than running without it.
 */
export function checkRequires(
  value: unknown,
  declaredProviders: readonly string[],
  errors: string[],
): PluginRequires | undefined {
  if (!isRecord(value)) {
    errors.push('requires: expected an object')
    return { unknown: ['requires'] }
  }
  const out: PluginRequires = {}
  const unknown = Object.keys(value).filter(word => !(REQUIRES_WORDS as readonly string[]).includes(word))
  for (const word of unknown) errors.push(`requires.${word}: this Velloc does not know "${word}"; the plugin stays waiting`)
  if (unknown.length > 0) out.unknown = unknown
  if (value.providers !== undefined) {
    const list = value.providers
    if (!Array.isArray(list) || list.length === 0 || !list.every(key => typeof key === 'string' && key !== '')) {
      errors.push('requires.providers: expected a non-empty list of this plugin\'s provider keys')
      out.unknown = [...(out.unknown ?? []), 'providers']
    } else {
      for (const key of list as string[]) {
        if (!declaredProviders.includes(key)) {
          errors.push(`requires.providers: "${key}" names no provider this plugin declares; the plugin stays waiting`)
        }
      }
      out.providers = [...new Set(list as string[])]
    }
  }
  return out.providers || out.unknown ? out : undefined
}

/** What the gate reads about one provider. */
export type ProviderGateState = {
  /** settings.json's provider configs have been read; before that nothing is met. */
  loaded: boolean
  /** A key, a sign-in or the anonymous choice is stored. */
  isSetUp(providerId: string): boolean
  /** The install identifier the stored entry records as its owner. */
  owner(providerId: string): string | undefined
}

export type UnmetRequirement =
  | { kind: 'provider'; key: string; providerId?: string }
  | { kind: 'unknown'; word: string }

type GatedPlugin = Pick<ActivePlugin, 'name' | 'installIdentifier' | 'manifest' | 'providers'>

/** The install identifier a plugin's stored entries are owned by. */
export function pluginOwnerId(plugin: Pick<ActivePlugin, 'name' | 'installIdentifier'>): string {
  return plugin.installIdentifier ?? `${plugin.name}@inline`
}

/** What keeps `plugin` from taking effect; empty when nothing does. */
export function unmetRequirements(plugin: GatedPlugin, state: ProviderGateState): UnmetRequirement[] {
  const requires = plugin.manifest.requires
  if (!requires) return []
  const unmet: UnmetRequirement[] = (requires.unknown ?? []).map(word => ({ kind: 'unknown', word }))
  const owner = pluginOwnerId(plugin)
  for (const key of requires.providers ?? []) {
    const provider = plugin.providers?.find(entry => entry.key === key)
    if (!provider) {
      unmet.push({ kind: 'provider', key })
      continue
    }
    const met = state.loaded && state.isSetUp(provider.id) && state.owner(provider.id) === owner
    if (!met) unmet.push({ kind: 'provider', key, providerId: provider.id })
  }
  return unmet
}

/** The plugins in effect, and the ones waiting with why. */
export function splitByRequirements<P extends GatedPlugin>(
  plugins: readonly P[],
  state: ProviderGateState,
): { effective: P[]; waiting: Array<{ plugin: P; unmet: UnmetRequirement[] }> } {
  const effective: P[] = []
  const waiting: Array<{ plugin: P; unmet: UnmetRequirement[] }> = []
  for (const plugin of plugins) {
    const unmet = unmetRequirements(plugin, state)
    if (unmet.length === 0) effective.push(plugin)
    else waiting.push({ plugin, unmet })
  }
  return { effective, waiting }
}

/**
 * A stable fingerprint of the gate over `plugins`: it changes exactly when
 * some plugin moves between in effect and waiting.
 */
export function requirementsSignature(plugins: readonly GatedPlugin[], state: ProviderGateState): string {
  return plugins
    .filter(plugin => plugin.manifest.requires)
    .map(plugin => `${pluginOwnerId(plugin)}=${unmetRequirements(plugin, state).length === 0 ? 1 : 0}`)
    .sort()
    .join('|')
}
