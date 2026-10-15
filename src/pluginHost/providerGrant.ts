/**
 * Provider mods: the GRANT a person consents to (`domains`, `secrets`,
 * `readsSecrets`, `requestNeeds`, `signNeeds`). Consent binds to the grant, not
 * the bytes: an update no wider than the consented grant needs no new consent.
 * Pure.
 */

import type {
  ProviderManifest,
  ProviderRequestNeed,
  ProviderSignNeed,
} from '../mods/provider/providerManifest'

export type ProviderGrant = {
  /** Lower case, sorted, unique. */
  domains: string[]
  /** Sorted, unique. */
  secrets: string[]
  readsSecrets: boolean
  /** In the order `system`, `tools`, `body`, `cwd`. */
  requestNeeds: ProviderRequestNeed[]
  /** Absent: the provider does not sign. */
  signNeeds?: ProviderSignNeed
}

/** A plugin's grant: its providers' grants, by provider key. */
export type Grant = {
  providers: Record<string, ProviderGrant>
}

/** What a provider asks for beyond what was consented to. Only the added parts. */
export type ProviderGrantAddition = {
  domains: string[]
  secrets: string[]
  readsSecrets: boolean
  requestNeeds: ProviderRequestNeed[]
  /** The new, wider `signNeeds` value. */
  signNeeds?: ProviderSignNeed
}

export type GrantDelta = {
  /** Whether re-consent is needed. */
  widened: boolean
  added: {
    /** Provider keys that were not consented to at all. */
    providers: string[]
    /** What each provider (new ones in full) asks for beyond the consent. */
    perProvider: Record<string, ProviderGrantAddition>
  }
  /** Provider keys the new version no longer has (never widening). */
  removed: string[]
}

const REQUEST_NEED_ORDER: readonly ProviderRequestNeed[] = ['system', 'tools', 'body', 'cwd']
const SIGN_RANK: Readonly<Record<ProviderSignNeed, number>> = { digest: 1, body: 2 }

const sortedUnique = (values: readonly string[]): string[] => [...new Set(values)].sort()

/** The grant of one provider manifest. */
export function providerGrantOf(manifest: ProviderManifest): ProviderGrant {
  const needs = new Set(manifest.requestNeeds ?? [])
  return {
    domains: sortedUnique(manifest.domains.map(domain => domain.trim().toLowerCase())),
    secrets: sortedUnique((manifest.credentials.secrets ?? []).map(secret => secret.name)),
    readsSecrets: manifest.credentials.readsSecrets === true,
    requestNeeds: REQUEST_NEED_ORDER.filter(need => needs.has(need)),
    ...(manifest.signNeeds !== undefined ? { signNeeds: manifest.signNeeds } : {}),
  }
}

/** The grant of a plugin's `providers` map. */
export function grantOf(providers: Readonly<Record<string, ProviderManifest>>): Grant {
  const out: Record<string, ProviderGrant> = {}
  for (const key of Object.keys(providers).sort()) out[key] = providerGrantOf(providers[key]!)
  return { providers: out }
}

function additionOf(consented: ProviderGrant | undefined, next: ProviderGrant): ProviderGrantAddition | undefined {
  const had = <T>(list: readonly T[] | undefined, value: T): boolean => list?.includes(value) ?? false
  const domains = next.domains.filter(domain => !had(consented?.domains, domain))
  const secrets = next.secrets.filter(secret => !had(consented?.secrets, secret))
  const readsSecrets = next.readsSecrets && consented?.readsSecrets !== true
  const requestNeeds = next.requestNeeds.filter(need => !had(consented?.requestNeeds, need))
  const wider =
    next.signNeeds !== undefined && SIGN_RANK[next.signNeeds] > (consented?.signNeeds ? SIGN_RANK[consented.signNeeds] : 0)
  if (domains.length === 0 && secrets.length === 0 && !readsSecrets && requestNeeds.length === 0 && !wider) return undefined
  return {
    domains,
    secrets,
    readsSecrets,
    requestNeeds,
    ...(wider ? { signNeeds: next.signNeeds } : {}),
  }
}

/**
 * Whether `next` asks for more than `consented`. A new provider key, a new
 * domain, a new secret name, `readsSecrets` turned on, a new `requestNeeds`
 * value, or a larger `signNeeds` (none < digest < body) is wider. Dropping or
 * reducing any of them, or dropping a provider, is not.
 */
export function widened(consented: Grant, next: Grant): GrantDelta {
  const perProvider: Record<string, ProviderGrantAddition> = {}
  const addedProviders: string[] = []
  for (const key of Object.keys(next.providers).sort()) {
    const before = consented.providers[key]
    if (before === undefined) addedProviders.push(key)
    const addition = additionOf(before, next.providers[key]!)
    if (addition) perProvider[key] = addition
    else if (before === undefined) {
      // A provider with an empty grant is still a provider nobody consented to.
      perProvider[key] = { domains: [], secrets: [], readsSecrets: false, requestNeeds: [] }
    }
  }
  const removed = Object.keys(consented.providers)
    .filter(key => next.providers[key] === undefined)
    .sort()
  return {
    widened: Object.keys(perProvider).length > 0,
    added: { providers: addedProviders, perProvider },
    removed,
  }
}
