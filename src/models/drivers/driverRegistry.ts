/**
 * Which driver serves each provider: the per-session `providerDrivers` URL override,
 * else its catalog entry's `wire`. A provider without a spec is not served.
 */
import { NEXUS_MODEL_CONFIG } from '../../config/nexusModelConfig'
import type { RuntimeConfig } from '../../runtime/interfaces/RuntimeConfig'
import {
  getBrokerProviderBaseUrl,
  getProviderBaseUrl,
} from '../endpoints/endpointTrust'
import { getProviderDefinition } from '../../config/nexusModelConfig/providers'
import type { ProviderSecretField } from '../../config/nexusModelConfig/providerDefinition'
import { hasOAuthPlaceholder } from '../../browser/bridge/nativePrimitives'
import { listedFigures } from '../../config/nexusModelConfig/familyRows'
import type { ProviderDriver, ProviderSpec } from './driverTypes'
import { applyModelWire, sanitizeModelWire } from './modelWire'

const drivers = new Map<string, ProviderDriver>()

/**
 * The host manifest primitive that makes `model.rawStreamOpen` resolve
 * `{{oauth:access_token}}` / `{{oauth:account_id}}` (after running the host's
 * token refresh / exchange). An older host forwards the placeholder text
 * verbatim, so a spec that uses one is only served when the host lists it.
 */
export const RAW_STREAM_OAUTH_PRIMITIVE = 'model.rawStreamOpen.oauth'
/** The host omits a header whose OPTIONAL OAuth value (`{{oauth:account_id}}`)
 *  expands to nothing; without it the placeholder would be refused. */
export const RAW_STREAM_OAUTH_OPTIONAL_PRIMITIVE = 'model.rawStreamOpen.oauthOptional'
/** OAuth values a token may lack — a spec carrying one needs the host to
 *  omit the header when it does. */
const OPTIONAL_OAUTH_PLACEHOLDERS = ['{{oauth:account_id}}']

/**
 * The additive primitives the host manifest lists (`primitives`), for this
 * realm's model transport. `undefined` until a runtime with a manifest is
 * created — and until then a spec that needs a primitive is not served.
 * One host serves a realm, so a single value is right; a runtime created
 * without a manifest (tests, a partial config) leaves it alone.
 */
let hostPrimitives: ReadonlySet<string> | undefined

export function setHostPrimitives(primitives: readonly string[] | undefined): void {
  hostPrimitives = primitives ? new Set(primitives) : undefined
}

export function hostServesPrimitive(primitive: string): boolean {
  return !!hostPrimitives?.has(primitive)
}

/** A spec whose credential is the host's OAuth token (`{{oauth:NAME}}`). */
function usesOAuth(wire: Omit<ProviderSpec, 'id'>): boolean {
  return hasOAuthPlaceholder(wire.headers) || hasOAuthPlaceholder(wire.queryParams)
}

/** A spec carrying an OAuth value a token may lack (`{{oauth:account_id}}`). */
function usesOptionalOAuth(wire: Omit<ProviderSpec, 'id'>): boolean {
  const values = [...Object.values(wire.headers ?? {}), ...Object.values(wire.queryParams ?? {})]
  return values.some(value => OPTIONAL_OAUTH_PLACEHOLDERS.some(placeholder => value.includes(placeholder)))
}

/** The host can sign this spec's requests: OAuth values substituted, and
 *  an optional one that expands to nothing omitted. */
function hostSignsOAuth(wire: Omit<ProviderSpec, 'id'>): boolean {
  if (!usesOAuth(wire)) return true
  if (!hostServesPrimitive(RAW_STREAM_OAUTH_PRIMITIVE)) return false
  return !usesOptionalOAuth(wire) || hostServesPrimitive(RAW_STREAM_OAUTH_OPTIONAL_PRIMITIVE)
}

/**
 * The catalog `wire` of a provider, or undefined when it has none. The
 * catalog's stream idle timeout (`streamIdleTimeoutSeconds`) becomes the
 * spec's no-bytes abort unless the wire sets its own.
 */
function catalogWire(providerId: string): Omit<ProviderSpec, 'id'> | undefined {
  const entry = NEXUS_MODEL_CONFIG.providers.find(p => p.providerId === providerId)
  if (!entry?.wire) return undefined
  if (entry.wire.idleTimeoutMs !== undefined || entry.streamIdleTimeoutSeconds === undefined) {
    return entry.wire
  }
  return { ...entry.wire, idleTimeoutMs: entry.streamIdleTimeoutSeconds * 1000 }
}

/**
 * A provider that exists only in the runtime (`ProviderDefinition.runtimeOnly`).
 * Read from the definitions, not the codec table, so the settings page, the catalog
 * splice and the transport agree.
 */
export function isRuntimeOnlyProvider(providerId: string | undefined): boolean {
  return !!getProviderDefinition(providerId)?.runtimeOnly
}

/**
 * The runtime fetches this provider's model listing
 * (`ProviderDefinition.models`) — a runtime-only provider, or a built-in
 * whose discovery moved off its host class.
 */
export function listsModelsInRuntime(providerId: string | undefined): boolean {
  const definition = getProviderDefinition(providerId)
  return !!(definition?.models || definition?.codeListing)
}

/**
 * The runtime probes this provider's key (`providers.verify`): it speaks a
 * catalog wire and lists its models in the runtime. The probe sends the
 * STORED key, host-substituted, so the settings page stores it first.
 */
export function verifiesInRuntime(providerId: string | undefined): boolean {
  return listsModelsInRuntime(providerId) && !!catalogWire(providerId ?? '')
}

/** The credentials beyond the API key this provider takes (its settings
 *  page's optional secret fields). Empty for most providers. A provider mod's
 *  fields are the vendor's own text, carried on its catalog row — not here. */
export function providerSecretFields(providerId: string | undefined): ProviderSecretField[] {
  return getProviderDefinition(providerId)?.secrets ?? []
}

export function runtimeOnlyProviderIds(): string[] {
  return NEXUS_MODEL_CONFIG.providers
    .map(p => p.providerId)
    .filter(isRuntimeOnlyProvider)
}

export function registerProviderDriver(driver: ProviderDriver): void {
  drivers.set(driver.id, driver)
}

export function getProviderDriver(id: string): ProviderDriver | undefined {
  return drivers.get(id)
}

export const PROVIDER_DRIVERS_ENV_KEY = 'providerDrivers'

function specOverrides(runtimeConfig?: RuntimeConfig): Record<string, Omit<ProviderSpec, 'id'>> {
  // Partial configs exist (callers that only need UUIDs and timestamps): no
  // `getEnv` = no per-session overrides.
  const raw = typeof runtimeConfig?.getEnv === 'function'
    ? runtimeConfig.getEnv(PROVIDER_DRIVERS_ENV_KEY)
    : undefined
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, Omit<ProviderSpec, 'id'>> = {}
    for (const [providerId, value] of Object.entries(parsed)) {
      // `{"openai": "openai-chat"}` shorthand, or a full spec object.
      if (typeof value === 'string' && value) out[providerId] = { format: value }
      else if (value && typeof value === 'object' && typeof (value as { format?: unknown }).format === 'string') {
        out[providerId] = value as Omit<ProviderSpec, 'id'>
      }
    }
    return out
  } catch {
    return {}
  }
}

/**
 * Contract: the runtime provider spec for an id: the per-session `providerDrivers`
 * override first, else the catalog entry's `wire`. Undefined (not served) for an
 * unknown id, a format with no codec, or an OAuth spec whose host manifest lacks
 * `model.rawStreamOpen.oauth` (or `oauthOptional` for an optional value). The
 * catalog's `maxConcurrentStreams` applies to every spec. With a `model`, its
 * listing row's wire is laid over the spec; a row whose `format` has no codec is
 * not served, since a model must never be sent in a format it did not ask for.
 */
export function resolveProviderSpec(
  providerId: string | undefined,
  runtimeConfig?: RuntimeConfig,
  model?: string,
): ProviderSpec | undefined {
  if (!providerId) return undefined
  const wire = specOverrides(runtimeConfig)[providerId] ?? catalogWire(providerId)
  if (!wire || !drivers.has(wire.format)) {
    return undefined
  }
  if (!hostSignsOAuth(wire)) return undefined
  const cap = NEXUS_MODEL_CONFIG.providers.find(p => p.providerId === providerId)?.maxConcurrentStreams
  const spec: ProviderSpec = {
    ...wire,
    ...(wire.maxConcurrentStreams === undefined && cap !== undefined ? { maxConcurrentStreams: cap } : {}),
    id: providerId,
  }
  const modelWire = model ? listedFigures(providerId, model)?.wire : undefined
  if (!modelWire) return spec
  // Re-confined on every resolution: the user's base URL may have changed
  // since the row was applied, and the origin is the one the host locks to.
  const safe = sanitizeModelWire(providerId, modelWire, spec.baseUrl ?? resolveDriverBaseUrl(providerId))
  if (!safe) return spec
  if (safe.format && !drivers.has(safe.format)) return undefined
  return applyModelWire(spec, safe)
}

/**
 * The base URL a model's own `baseUrl` is held to the origin of: the one
 * `resolveProviderSpec` hands the provider's requests (the spec's, else the
 * settings / host / catalog base URL).
 */
export function providerWireBaseUrl(providerId: string): string | undefined {
  return catalogWire(providerId)?.baseUrl ?? resolveDriverBaseUrl(providerId)
}

/**
 * The base URL the request goes to: the user's settings override, else the
 * host broker's (launch prefs / legacy path), else the catalog default — the
 * same precedence the host applies. Trailing slashes are trimmed; drivers
 * append their own path.
 */
export function resolveDriverBaseUrl(providerId: string): string | undefined {
  const url =
    getProviderBaseUrl(providerId)
    ?? getBrokerProviderBaseUrl(providerId)
    ?? NEXUS_MODEL_CONFIG.providers.find(p => p.providerId === providerId)?.defaultBaseUrl
  const trimmed = url?.trim().replace(/\/+$/, '')
  return trimmed ? trimmed : undefined
}
