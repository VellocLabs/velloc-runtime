/**
 * Per-provider User-Agent overrides, added to each config right before
 * `model.publishProviderConfigs` and never persisted. Every config carries the
 * field (`''` = no preset), since the broker keeps an omitted field. Wire contract:
 * a non-empty `userAgent` replaces the header; `''` or absent = host default.
 */

import { NEXUS_MODEL_CONFIG } from './nexusModelConfig'
import { OPENCODE_ZEN_USER_AGENT, isOpencodeZenBaseUrl } from './opencodeZen'
import type { NexusProviderConfig } from '../settings/settingsTypes'

/** The preset User-Agent for one provider config, if it has one. */
export function resolveProviderUserAgent(
  providerId: string,
  config: NexusProviderConfig | undefined,
): string | undefined {
  const builtIn = NEXUS_MODEL_CONFIG.providers.find(
    p => p.providerId === providerId,
  )?.userAgent
  if (builtIn) return builtIn
  if (config?.isCustomProvider) {
    return customProviderUserAgent(config.baseUrl ?? '')
  }
  return undefined
}

/**
 * The preset User-Agent for a custom-provider connection, keyed by its base
 * URL alone — what the settings form's connection probe sends for a draft
 * that has no stored config yet.
 */
export function customProviderUserAgent(baseUrl: string): string | undefined {
  return isOpencodeZenBaseUrl(baseUrl) ? OPENCODE_ZEN_USER_AGENT : undefined
}

/** `configs` with every entry's `userAgent` set: its preset value, or `''`
 *  (host default). Anything stored under the key is replaced. */
export function withProviderUserAgents(
  configs: Record<string, NexusProviderConfig>,
): Record<string, NexusProviderConfig> {
  const out: Record<string, NexusProviderConfig> = {}
  for (const [id, config] of Object.entries(configs)) {
    out[id] = { ...config, userAgent: resolveProviderUserAgent(id, config) ?? '' }
  }
  return out
}
