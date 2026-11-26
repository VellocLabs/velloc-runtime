/**
 * Contract: a router's `borrows` (F-27 RP-21). A router may name provider
 * definitions it does not own and have instances of them that only it uses.
 * A borrowed instance is an instance of the definition it was made of: that
 * definition's module serves it, with the definition's own domains. What
 * the router gets is the ownership of the instance: it alone sends through
 * it, the person meets it in the router's settings app, and it goes when
 * the router does. The stored entry names the router in `managedBy`.
 *
 * Security: a borrowed instance is registered only while a registered
 * router lists its definition in `borrows`, so a hand-written entry cannot
 * hand a provider to a router that never asked.
 */

import type { NexusProviderConfig } from '../../settings/settingsTypes'
import type { ProviderManifest, ResolvedProvider } from './providerManifest'

export const BORROWS_MAX = 16

/**
 * A router entry's `borrows`: up to 16 provider definition ids, none twice,
 * none of the router's own plugin (a provider of the same plugin is managed
 * with `managedBy`). A definition that is not installed is not an error: it
 * is simply not there to borrow.
 */
export function checkBorrows(
  value: unknown,
  ownId: string,
  ownKey: string,
  isProviderId: (id: string) => boolean,
  bad: (message: string) => void,
): string[] | undefined {
  if (!Array.isArray(value) || !value.every((id): id is string => typeof id === 'string') || value.length > BORROWS_MAX) {
    bad(`borrows: expected a list of at most ${BORROWS_MAX} provider ids`)
    return undefined
  }
  const ownPrefix = ownId.slice(0, ownId.length - ownKey.length)
  for (const id of value) {
    if (!isProviderId(id)) {
      bad(`borrows: "${id}" is not a provider id (a built-in id, or mod.<plugin>.<key>)`)
      return undefined
    }
    if (id.startsWith(ownPrefix)) {
      bad(`borrows: "${id}" is a provider of this plugin; a router manages its own plugin's providers with managedBy`)
      return undefined
    }
  }
  const twice = value.find((id, index) => value.indexOf(id) !== index)
  if (twice !== undefined) {
    bad(`borrows: "${twice}" is listed twice`)
    return undefined
  }
  return [...value]
}

/** Whether a definition may be lent: a plain provider nobody manages. */
export function isBorrowable(manifest: Pick<ProviderManifest, 'kind' | 'managedBy'>): boolean {
  return manifest.kind !== 'router' && manifest.managedBy === undefined
}

/** What each router may borrow: router id → the definition ids it lists. */
export type BorrowTable = ReadonlyMap<string, ReadonlySet<string>>

/** The borrow table of the given plugins' routers. */
export function borrowTableOf(plugins: ReadonlyArray<{ providers?: readonly ResolvedProvider[] }>): Map<string, Set<string>> {
  const table = new Map<string, Set<string>>()
  for (const plugin of plugins) {
    for (const provider of plugin.providers ?? []) {
      const borrows = provider.manifest.kind === 'router' ? provider.manifest.borrows : undefined
      if (borrows?.length) table.set(provider.id, new Set(borrows))
    }
  }
  return table
}

/** The router a stored entry says it is lent to, when the entry is an instance of a definition. */
export function lentTo(config: NexusProviderConfig | undefined): string | undefined {
  return config?.definition !== undefined && config.managedBy ? config.managedBy : undefined
}

/**
 * The stored borrowed instances whose router is gone: its plugin was
 * switched off (`disabledRouters`) or taken away while the app ran
 * (`departedRouters`). An instance whose router is merely not there at the
 * first look is left alone: a plugin that failed to load is not a plugin the
 * person removed.
 */
export function orphanedBorrowedInstances(
  configs: Readonly<Record<string, NexusProviderConfig>>,
  disabledRouters: ReadonlySet<string>,
  departedRouters: ReadonlySet<string>,
): string[] {
  return Object.entries(configs)
    .filter(([, config]) => {
      const router = lentTo(config)
      return router !== undefined && (disabledRouters.has(router) || departedRouters.has(router))
    })
    .map(([id]) => id)
    .sort()
}
