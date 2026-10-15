/**
 * Security: provider trust, one derivation for the settings UI and the teammate
 * spawn. An UNTRUSTED provider is a third party that sees every request, so a
 * child session on it is locked down (`safe_code` + own git worktree + a read
 * boundary). Default: custom providers untrusted; a built-in trusted only while
 * on its vendor endpoint; local weights trusted. An explicit setting overrides
 * the default everywhere, request-time classification included.
 */
import { isCustomBackendId } from '../config/customProviderRegistry'
import { classifyEndpoint } from '../models/endpoints/endpointTrust'
import { NEXUS_MODEL_CONFIG } from '../config/nexusModelConfig'
import type { NexusProvidersSettings } from './settingsTypes'

export type ProviderTrust = 'trusted' | 'untrusted'

/**
 * The providers the host registers WITHOUT the user configuring anything —
 * the built-in catalog minus the two `custom-*` backend slots, which are
 * execution slots for user-created providers, not providers in their own
 * right (`config/customProviderRegistry.ts`).
 */
const BUILT_IN_PROVIDER_IDS: ReadonlySet<string> = new Set(
  NEXUS_MODEL_CONFIG.providers
    .map(p => p.providerId)
    .filter(id => !isCustomBackendId(id)),
)

/**
 * Security: whether `providerId` is configured or a config-free built-in. The
 * host routes an unknown id to the ACTIVE provider, so callers deciding
 * isolation must refuse an unknown id rather than judge it.
 */
export function isKnownProvider(
  providers: NexusProvidersSettings | undefined,
  providerId: string,
): boolean {
  const configs = providers?.configs
  if (configs && Object.prototype.hasOwnProperty.call(configs, providerId)) {
    return true
  }
  return BUILT_IN_PROVIDER_IDS.has(providerId)
}

/**
 * The trust a provider carries when the user has NOT set one — the built-in
 * "safe provider list" default. Any provider may be marked untrusted (or
 * trusted) explicitly; this is only what applies until they do, and what a
 * "reset to default" restores by dropping the explicit marker.
 */
export function defaultProviderTrust(
  providers: NexusProvidersSettings | undefined,
  providerId: string,
): ProviderTrust {
  const config = providers?.configs?.[providerId]
  if (config) {
    // A configured `custom-*` slot without the marker is a legacy "Custom
    // endpoint" row — a relay by construction, so it takes the custom default.
    if (config.isCustomProvider || isCustomBackendId(providerId)) return 'untrusted'
    // Otherwise the endpoint decides: a built-in on its vendor endpoint is trusted,
    // one on a gateway or plaintext host is not. `''` is the "no override" sentinel
    // so a stale publish cannot decide. `local-provider` is not a trust reason (no
    // third party sees the bytes). The user's marker and the published override map
    // are ignored: this is the answer before any marker.
    const reasons = classifyEndpoint(providerId, config.baseUrl ?? '', {
      ignoreDeclaredTrust: true,
    }).reasons.filter(reason => reason !== 'local-provider')
    return reasons.length > 0 ? 'untrusted' : 'trusted'
  }
  // No config at all: a built-in provider is trusted by default; anything
  // else is an id nobody registered, and "no idea" is not "safe".
  return BUILT_IN_PROVIDER_IDS.has(providerId) ? 'trusted' : 'untrusted'
}

export function resolveProviderTrust(
  providers: NexusProvidersSettings | undefined,
  providerId: string,
): ProviderTrust {
  const config = providers?.configs?.[providerId]
  if (config?.trust === 'trusted' || config?.trust === 'untrusted') {
    return config.trust
  }
  return defaultProviderTrust(providers, providerId)
}
