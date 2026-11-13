/**
 * Plugins: the GRANT a person consents to — each provider's `domains`,
 * `secrets`, `readsSecrets`, `requestNeeds`, `signNeeds`, the reach of its proxy pools, the folders an
 * app's background module may reach, and whether it may run the agent (F-40). Consent binds to the grant, not
 * the bytes: an update no wider than the consented grant needs no new consent.
 * Pure.
 */

import { manifestAsksAgent } from '../mods/app/appAgentRun'
import { addedFolderScopes, folderScopesOf, type FolderScopes } from '../mods/app/appFolderScopes'
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
  /** It sends requests through proxies its code chooses while it runs:
   *  `public` ones only, or `local` ones too. Absent: it has no such pool. */
  proxyPools?: ProxyPoolReach
}

export type ProxyPoolReach = 'public' | 'local'

/** A plugin's grant: its providers' grants, by provider key, and the folders its background modules reach. */
export type Grant = {
  providers: Record<string, ProviderGrant>
  /** Absent: no folder beyond the apps' own. */
  folders?: FolderScopes
  /** An app's background module may start headless agent runs. Absent: none may. */
  agent?: true
}

/** What a provider asks for beyond what was consented to. Only the added parts. */
export type ProviderGrantAddition = {
  domains: string[]
  secrets: string[]
  readsSecrets: boolean
  requestNeeds: ProviderRequestNeed[]
  /** The new, wider `signNeeds` value. */
  signNeeds?: ProviderSignNeed
  /** The new, wider reach of its proxy pools. */
  proxyPools?: ProxyPoolReach
}

export type GrantDelta = {
  /** Whether re-consent is needed. */
  widened: boolean
  added: {
    /** Provider keys that were not consented to at all. */
    providers: string[]
    /** What each provider (new ones in full) asks for beyond the consent. */
    perProvider: Record<string, ProviderGrantAddition>
    /** Folders not consented to, or consented read-only and asked for writing. */
    folders?: FolderScopes
    /** Agent runs, not consented to. */
    agent?: true
  }
  /** Provider keys the new version no longer has (never widening). */
  removed: string[]
}

const REQUEST_NEED_ORDER: readonly ProviderRequestNeed[] = ['system', 'tools', 'body', 'cwd']
const SIGN_RANK: Readonly<Record<ProviderSignNeed, number>> = { digest: 1, body: 2 }
const POOL_RANK: Readonly<Record<ProxyPoolReach, number>> = { public: 1, local: 2 }

const sortedUnique = (values: readonly string[]): string[] => [...new Set(values)].sort()

/** The grant of one provider manifest. */
export function providerGrantOf(manifest: ProviderManifest): ProviderGrant {
  const needs = new Set(manifest.requestNeeds ?? [])
  const pools = Object.values(manifest.egressPools ?? {})
  const proxyPools: ProxyPoolReach | undefined =
    pools.length === 0 ? undefined : pools.some(pool => pool.local) ? 'local' : 'public'
  return {
    domains: sortedUnique(manifest.domains.map(domain => domain.trim().toLowerCase())),
    secrets: sortedUnique((manifest.credentials.secrets ?? []).map(secret => secret.name)),
    readsSecrets: manifest.credentials.readsSecrets === true,
    requestNeeds: REQUEST_NEED_ORDER.filter(need => needs.has(need)),
    ...(manifest.signNeeds !== undefined ? { signNeeds: manifest.signNeeds } : {}),
    ...(proxyPools ? { proxyPools } : {}),
  }
}

/** The grant of a plugin's `providers` map, of its declared folders, and of its agent runs. */
export function grantOf(providers: Readonly<Record<string, ProviderManifest>>, folders?: FolderScopes, agent?: boolean): Grant {
  const out: Record<string, ProviderGrant> = {}
  for (const key of Object.keys(providers).sort()) out[key] = providerGrantOf(providers[key]!)
  return {
    providers: out,
    ...(folders && (folders.read.length > 0 || folders.write.length > 0) ? { folders } : {}),
    ...(agent ? { agent: true as const } : {}),
  }
}

/** The grant of a whole plugin manifest: its providers and its apps' folders. */
export function pluginGrantOf(manifest: unknown): Grant {
  const providers = (manifest as { providers?: Record<string, ProviderManifest> } | null)?.providers ?? {}
  return grantOf(providers, folderScopesOf(manifest), manifestAsksAgent(manifest))
}

function additionOf(consented: ProviderGrant | undefined, next: ProviderGrant): ProviderGrantAddition | undefined {
  const had = <T>(list: readonly T[] | undefined, value: T): boolean => list?.includes(value) ?? false
  const domains = next.domains.filter(domain => !had(consented?.domains, domain))
  const secrets = next.secrets.filter(secret => !had(consented?.secrets, secret))
  const readsSecrets = next.readsSecrets && consented?.readsSecrets !== true
  const requestNeeds = next.requestNeeds.filter(need => !had(consented?.requestNeeds, need))
  const wider =
    next.signNeeds !== undefined && SIGN_RANK[next.signNeeds] > (consented?.signNeeds ? SIGN_RANK[consented.signNeeds] : 0)
  const widerPools =
    next.proxyPools !== undefined && POOL_RANK[next.proxyPools] > (consented?.proxyPools ? POOL_RANK[consented.proxyPools] : 0)
  if (domains.length === 0 && secrets.length === 0 && !readsSecrets && requestNeeds.length === 0 && !wider && !widerPools) {
    return undefined
  }
  return {
    domains,
    secrets,
    readsSecrets,
    requestNeeds,
    ...(wider ? { signNeeds: next.signNeeds } : {}),
    ...(widerPools ? { proxyPools: next.proxyPools } : {}),
  }
}

/**
 * Whether `next` asks for more than `consented`. A new provider key, a new
 * domain, a new secret name, `readsSecrets` turned on, a new `requestNeeds`
 * value, a wider proxy pool (none < public < local), or a larger `signNeeds`
 * (none < digest < body) is wider, as is a
 * folder not consented to, a read-only one asked for writing, or agent runs
 * not consented to. Dropping or
 * reducing any of them, or dropping a provider, is not.
 */
export function widened(consented: Grant, next: Grant): GrantDelta {
  const folders = addedFolderScopes(consented.folders, next.folders)
  const agent = next.agent === true && consented.agent !== true
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
    widened: Object.keys(perProvider).length > 0 || folders !== undefined || agent,
    added: { providers: addedProviders, perProvider, ...(folders ? { folders } : {}), ...(agent ? { agent: true as const } : {}) },
    removed,
  }
}
