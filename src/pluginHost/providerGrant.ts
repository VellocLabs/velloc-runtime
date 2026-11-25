/**
 * Plugins: the GRANT a person consents to — each provider's `domains`, the hosts of its sign-in
 * window, the router that manages it (consent to a managed definition covers every instance of it),
 * `secrets`, `readsSecrets`, `requestNeeds`, `signNeeds`, the reach of its proxy pools, a router's
 * `routesTo` (provider definitions, so an added instance of a listed one asks for nothing new), the folders an
 * app's background module may reach, whether it may run the agent (F-40), and
 * whether its app pages may read each session's detail (F-42). Consent binds to the grant, not
 * the bytes: an update no wider than the consented grant needs no new consent. Pure.
 */

import { manifestAsksAgent } from '../mods/app/appAgentRun'
import { manifestAsksSessionDetail } from '../mods/app/appPageTopics'
import { addedFolderScopes, folderScopesOf, type FolderScopes } from '../mods/app/appFolderScopes'
import { insideRoutesTo } from '../models/drivers/providerRouter'
import type {
  ProviderManifest,
  ProviderRequestNeed,
  ProviderSignNeed,
} from '../mods/provider/providerManifest'

/** A router's boundary as consented: any set-up provider, or the listed
 *  provider definitions (sorted, unique). */
export type GrantRoutes = '*' | string[]

export type ProviderGrant = {
  /** Absent: a provider with its own endpoint. */
  kind?: 'router'
  /** On a router alone: the providers its requests may go through. */
  routesTo?: GrantRoutes
  /** Lower case, sorted, unique. */
  domains: string[]
  /** The key of the router of this plugin that sets it up and alone sends
   *  through it. Absent: the person sets it up on the Models page. */
  managedBy?: string
  /** The hosts its sign-in may open a window on (sorted, unique). Absent: none. */
  loginWindow?: string[]
  /** Sorted, unique. */
  secrets: string[]
  readsSecrets: boolean
  /** In the order `system`, `tools`, `body`, `cwd`. */
  requestNeeds: ProviderRequestNeed[]
  /** Absent: the provider does not sign. */
  signNeeds?: ProviderSignNeed
  /** It sends requests through proxies its code chooses while it runs, on
   *  any network. Absent: it has no such pool. */
  proxyPools?: true
}

/** A plugin's grant: its providers' grants, by provider key, and the folders its background modules reach. */
export type Grant = {
  providers: Record<string, ProviderGrant>
  /** Absent: no folder beyond the apps' own. */
  folders?: FolderScopes
  /** An app's background module may start headless agent runs. Absent: none may. */
  agent?: true
  /** Its app pages may read `session/<id>/state` and `turn/<id>`. Absent: they may not. */
  sessionDetail?: true
}

/** What a provider asks for beyond what was consented to. Only the added parts. */
export type ProviderGrantAddition = {
  domains: string[]
  /** Hosts its sign-in window may newly open on. Absent: none. */
  loginWindow?: string[]
  secrets: string[]
  readsSecrets: boolean
  requestNeeds: ProviderRequestNeed[]
  /** The new, wider `signNeeds` value. */
  signNeeds?: ProviderSignNeed
  /** It newly has proxy pools. */
  proxyPools?: true
  /** It newly sends through other providers: `"*"` for any, or the provider
   *  definitions that were not inside the consented boundary. */
  routes?: GrantRoutes
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
    /** Session detail for its pages, not consented to. */
    sessionDetail?: true
  }
  /** Provider keys the new version no longer has (never widening). */
  removed: string[]
}

const REQUEST_NEED_ORDER: readonly ProviderRequestNeed[] = ['system', 'tools', 'body', 'cwd']
const SIGN_RANK: Readonly<Record<ProviderSignNeed, number>> = { digest: 1, body: 2 }

const sortedUnique = (values: readonly string[]): string[] => [...new Set(values)].sort()
const listOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []

/**
 * The part of a router's boundary that the consented grant does not cover:
 * `"*"` over a list or over no router at all, or the listed definitions that
 * are outside the consented boundary. Undefined: nothing new.
 */
function addedRoutes(consented: ProviderGrant | undefined, next: ProviderGrant): GrantRoutes | undefined {
  if (next.kind !== 'router' || next.routesTo === undefined) return undefined
  const before: GrantRoutes = consented?.kind === 'router' ? (consented.routesTo ?? []) : []
  if (next.routesTo === '*') return before === '*' ? undefined : '*'
  const gained = next.routesTo.filter(definition => !insideRoutesTo(before, { definition }))
  // A provider that turns into a router widens even when it lists nothing.
  return gained.length > 0 || consented?.kind !== 'router' ? gained : undefined
}

/** The grant of one provider manifest. */
export function providerGrantOf(manifest: ProviderManifest): ProviderGrant {
  const needs = new Set(manifest.requestNeeds ?? [])
  const proxyPools = Object.keys(manifest.egressPools ?? {}).length > 0
  const loginWindow = sortedUnique(listOf(manifest.credentials.loginWindow?.allow).map(host => host.trim().toLowerCase()))
  // A router whose boundary cannot be read is granted no provider at all.
  const routesTo: GrantRoutes | undefined =
    manifest.kind !== 'router' ? undefined : manifest.routesTo === '*' ? '*' : sortedUnique(listOf(manifest.routesTo))
  return {
    ...(routesTo !== undefined ? { kind: 'router' as const, routesTo } : {}),
    domains: sortedUnique(listOf(manifest.domains).map(domain => domain.trim().toLowerCase())),
    ...(typeof manifest.managedBy === 'string' ? { managedBy: manifest.managedBy } : {}),
    ...(loginWindow.length > 0 ? { loginWindow } : {}),
    secrets: sortedUnique((manifest.credentials.secrets ?? []).map(secret => secret.name)),
    readsSecrets: manifest.credentials.readsSecrets === true,
    requestNeeds: REQUEST_NEED_ORDER.filter(need => needs.has(need)),
    ...(manifest.signNeeds !== undefined ? { signNeeds: manifest.signNeeds } : {}),
    ...(proxyPools ? { proxyPools } : {}),
  }
}

/** The grant of a plugin's `providers` map, of its declared folders, of its agent runs, and of its pages' session detail. */
export function grantOf(
  providers: Readonly<Record<string, ProviderManifest>>,
  folders?: FolderScopes,
  agent?: boolean,
  sessionDetail?: boolean,
): Grant {
  const out: Record<string, ProviderGrant> = {}
  for (const key of Object.keys(providers).sort()) out[key] = providerGrantOf(providers[key]!)
  return {
    providers: out,
    ...(folders && (folders.read.length > 0 || folders.write.length > 0) ? { folders } : {}),
    ...(agent ? { agent: true as const } : {}),
    ...(sessionDetail ? { sessionDetail: true as const } : {}),
  }
}

/** The grant of a whole plugin manifest: its providers and what its apps ask for. */
export function pluginGrantOf(manifest: unknown): Grant {
  const providers = (manifest as { providers?: Record<string, ProviderManifest> } | null)?.providers ?? {}
  return grantOf(providers, folderScopesOf(manifest), manifestAsksAgent(manifest), manifestAsksSessionDetail(manifest))
}

/** Whether a manifest's apps ask for anything the person consents to: folders, agent runs or session detail. */
export function manifestAsksAppGrant(manifest: unknown): boolean {
  return folderScopesOf(manifest) !== undefined || manifestAsksAgent(manifest) || manifestAsksSessionDetail(manifest)
}

function additionOf(consented: ProviderGrant | undefined, next: ProviderGrant): ProviderGrantAddition | undefined {
  const had = <T>(list: readonly T[] | undefined, value: T): boolean => list?.includes(value) ?? false
  const domains = next.domains.filter(domain => !had(consented?.domains, domain))
  const secrets = next.secrets.filter(secret => !had(consented?.secrets, secret))
  const readsSecrets = next.readsSecrets && consented?.readsSecrets !== true
  const requestNeeds = next.requestNeeds.filter(need => !had(consented?.requestNeeds, need))
  const wider =
    next.signNeeds !== undefined && SIGN_RANK[next.signNeeds] > (consented?.signNeeds ? SIGN_RANK[consented.signNeeds] : 0)
  const widerPools = next.proxyPools === true && consented?.proxyPools !== true
  const routes = addedRoutes(consented, next)
  const loginWindow = (next.loginWindow ?? []).filter(host => !had(consented?.loginWindow, host))
  if (loginWindow.length === 0 && domains.length === 0 && secrets.length === 0 && !readsSecrets && requestNeeds.length === 0 && !wider && !widerPools && routes === undefined) {
    return undefined
  }
  return {
    domains,
    ...(loginWindow.length > 0 ? { loginWindow } : {}),
    secrets,
    readsSecrets,
    requestNeeds,
    ...(wider ? { signNeeds: next.signNeeds } : {}),
    ...(widerPools ? { proxyPools: next.proxyPools } : {}),
    ...(routes !== undefined ? { routes } : {}),
  }
}

/**
 * Whether `next` asks for more than `consented`. A new provider key (a managed definition is one),
 * domain, sign-in window host or secret name,
 * `readsSecrets` turned on, a new `requestNeeds` value, a first proxy pool, or a larger `signNeeds`
 * (none < digest < body) is wider, as is a provider turning into a router, a router's `routesTo`
 * gaining a provider or turning to `"*"`, a folder not consented to, a read-only one asked for
 * writing, or agent runs or session detail not consented to. Dropping or reducing any of them,
 * or dropping a provider, is not.
 */
export function widened(consented: Grant, next: Grant): GrantDelta {
  const folders = addedFolderScopes(consented.folders, next.folders)
  const agent = next.agent === true && consented.agent !== true
  const sessionDetail = next.sessionDetail === true && consented.sessionDetail !== true
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
    widened: Object.keys(perProvider).length > 0 || folders !== undefined || agent || sessionDetail,
    added: {
      providers: addedProviders,
      perProvider,
      ...(folders ? { folders } : {}),
      ...(agent ? { agent: true as const } : {}),
      ...(sessionDetail ? { sessionDetail: true as const } : {}),
    },
    removed,
  }
}
