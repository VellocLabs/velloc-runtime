/**
 * Endpoint trust classification and the runtime's copy of every provider's effective
 * base URL; resident and trivial. "Unofficial" = no vendor-curated catalog to appeal
 * to: custom passthrough providers, ollama, or a built-in whose `baseUrl` leaves the
 * vendor's domains. The domain question itself is `officialEndpoints.ts`'s.
 */

import { isLoopbackHost, isOfficialEndpointUrl, endpointHostname } from './officialEndpoints'

export type EndpointTrustReason =
  | 'custom-endpoint-provider'
  | 'local-provider'
  | 'base-url-override'
  | 'insecure-base-url'
  | 'user-marked-untrusted'

export type EndpointTrustClassification = {
  /** True → the endpoint is not a vendor's own (a relay, a custom or local endpoint). */
  unofficial: boolean
  reasons: EndpointTrustReason[]
  /** Plaintext, non-loopback endpoint: API key + full transcript in clear. */
  insecure: boolean
}

/** Providers whose catalog is supplied by the endpoint itself. */
export const CUSTOM_ENDPOINT_PROVIDER_IDS: ReadonlySet<string> = new Set([
  'custom-openai',
  'custom-anthropic',
])

/** Providers serving local weights (identity = a mutable tag, not a vendor id). */
export const LOCAL_PROVIDER_IDS: ReadonlySet<string> = new Set(['ollama'])

/**
 * providerId → configured base URL. Published by the settings path (the same
 * write that calls `model.publishProviderConfigs`); until that wiring lands
 * the map is simply empty and classification falls back to providerId alone.
 * Kept as an injected map rather than a settings import so this module stays
 * dependency-free and safely resident.
 */
let baseUrlByProvider: Record<string, string> = {}

export function publishProviderBaseUrls(map: Record<string, string>): void {
  baseUrlByProvider = { ...map }
}

/**
 * Security: providerId → the trust the USER declared, the one trust value in the
 * product. It wins both ways: untrusted makes even a vendor domain unofficial,
 * trusted makes an off-domain endpoint official. Only explicit values; an unset
 * provider falls through to the domain rules.
 */
let trustOverrideByProvider: Record<string, 'trusted' | 'untrusted'> = {}

export function publishProviderTrustOverrides(
  map: Record<string, 'trusted' | 'untrusted'>,
): void {
  trustOverrideByProvider = { ...map }
}

/**
 * Convenience for the two provider-config publish points (worker boot +
 * providers adapter writes): extract just the baseUrl view from the full
 * config map. Replaces the whole map, so a removed override reverts the
 * provider to official classification on the next publish.
 */
export function publishProviderBaseUrlsFromConfigs(
  configs: Record<string, { baseUrl?: string; trust?: string; apiKey?: string; hasApiKey?: boolean }>,
): void {
  const map: Record<string, string> = {}
  const trust: Record<string, 'trusted' | 'untrusted'> = {}
  const keyed = new Set<string>()
  for (const [id, cfg] of Object.entries(configs)) {
    if (cfg?.baseUrl && cfg.baseUrl.trim().length > 0) {
      map[id] = cfg.baseUrl
    }
    if (cfg?.trust === 'trusted' || cfg?.trust === 'untrusted') {
      trust[id] = cfg.trust
    }
    if (cfg?.apiKey || cfg?.hasApiKey) keyed.add(id)
  }
  settingsKeyedProviders = keyed
  publishProviderBaseUrls(map)
  // Same replace-wholesale rule as the base URLs: a cleared trust marker
  // reverts the provider to the domain-derived answer on the next publish.
  publishProviderTrustOverrides(trust)
}

export function getProviderBaseUrl(providerId: string): string | undefined {
  const value = baseUrlByProvider[providerId]
  return value && value.trim().length > 0 ? value : undefined
}

/**
 * providerId → the base URL the host's broker holds (`providerAuth.list`), since
 * launch prefs can configure a provider outside settings.json. Refreshed at worker
 * boot and after every providers write; empty until the first refresh answers.
 */
let brokerBaseUrlByProvider: Record<string, string> = {}

export function publishBrokerProviderBaseUrls(
  providers: readonly { id: string; baseUrl?: string; hasStoredApiKey?: boolean }[],
): void {
  const map: Record<string, string> = {}
  const keyed = new Set<string>()
  for (const provider of providers) {
    if (provider?.id && provider.baseUrl && provider.baseUrl.trim().length > 0) {
      map[provider.id] = provider.baseUrl
    }
    if (provider?.id && provider.hasStoredApiKey) keyed.add(provider.id)
  }
  brokerBaseUrlByProvider = map
  brokerKeyedProviders = keyed
}

export function getBrokerProviderBaseUrl(providerId: string): string | undefined {
  const value = brokerBaseUrlByProvider[providerId]
  return value && value.trim().length > 0 ? value : undefined
}

/**
 * Which providers hold an API key — what the host's `{{secret:api_key}}`
 * resolves for them. settings.json's view (a sealed `apiKey`, published with
 * the base URLs) OR the broker's (`providerAuth.list` `hasStoredApiKey`, for a
 * key set through launch prefs or the legacy path). Read by a ModelProvider
 * whose provider may run keyless (`ProviderSpec.apiKeyOptional`).
 */
let settingsKeyedProviders = new Set<string>()
let brokerKeyedProviders = new Set<string>()

export function providerHasStoredApiKey(providerId: string): boolean {
  return settingsKeyedProviders.has(providerId) || brokerKeyedProviders.has(providerId)
}

export function __resetEndpointTrustForTest(): void {
  baseUrlByProvider = {}
  brokerBaseUrlByProvider = {}
  trustOverrideByProvider = {}
  settingsKeyedProviders = new Set()
  brokerKeyedProviders = new Set()
}

/**
 * True for a plaintext http:// URL whose host is not loopback. Loopback is
 * exempted because that is the normal Ollama / LM Studio shape
 * (`http://localhost:11434`) and there is no network to sniff.
 *
 * Parses through `endpointHostname`, so a bare host or a non-http(s) scheme
 * is not insecure — it is not an endpoint this can reason about at all.
 */
export function isInsecureBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false
  if (!/^http:\/\//i.test(baseUrl.trim())) return false
  return !isLoopbackHost(endpointHostname(baseUrl))
}

export function classifyEndpoint(
  providerId: string | undefined,
  baseUrlOverride?: string,
  opts?: {
    /**
     * Classify from the DOMAIN rules alone, as if the user had declared
     * nothing. `defaultProviderTrust` asks this: its contract is the answer
     * BEFORE any marker, and a published `trusted` override would otherwise
     * short-circuit the rules below and make an off-domain relay default
     * `trusted` in any realm where that override happens to be published.
     */
    ignoreDeclaredTrust?: boolean
  },
): EndpointTrustClassification {
  // No providerId → the host resolves its own default provider and we have
  // nothing to classify. Treat as official: never guess.
  if (!providerId) {
    return { unofficial: false, reasons: [], insecure: false }
  }
  const baseUrl = baseUrlOverride ?? getProviderBaseUrl(providerId)
  // The user's declaration is the single trust value and it wins outright —
  // both directions, ahead of every domain rule below.
  const declared = opts?.ignoreDeclaredTrust
    ? undefined
    : trustOverrideByProvider[providerId]
  if (declared === 'untrusted') {
    return {
      unofficial: true,
      reasons: ['user-marked-untrusted'],
      insecure: isInsecureBaseUrl(baseUrl),
    }
  }
  if (declared === 'trusted') {
    return { unofficial: false, reasons: [], insecure: isInsecureBaseUrl(baseUrl) }
  }
  const reasons: EndpointTrustReason[] = []
  if (CUSTOM_ENDPOINT_PROVIDER_IDS.has(providerId)) {
    reasons.push('custom-endpoint-provider')
  }
  if (LOCAL_PROVIDER_IDS.has(providerId)) {
    reasons.push('local-provider')
  }
  // A base URL on a provider that isn't inherently endpoint-defined means the
  // user pointed a vendor provider at something else (proxy / gateway /
  // relay) — UNLESS it still lands on an official vendor domain, which is
  // the regional-host / pinned-version case and reaches the vendor exactly
  // as the built-in default would.
  if (
    baseUrl
    && !isOfficialEndpointUrl(baseUrl)
    && !CUSTOM_ENDPOINT_PROVIDER_IDS.has(providerId)
    && !LOCAL_PROVIDER_IDS.has(providerId)
  ) {
    reasons.push('base-url-override')
  }
  const insecure = isInsecureBaseUrl(baseUrl)
  if (insecure) {
    reasons.push('insecure-base-url')
  }
  return { unofficial: reasons.length > 0, reasons, insecure }
}
