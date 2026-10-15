/**
 * `$.catalog` (F-28): the model catalog, read-only. No manifest permission and no
 * network; unknown = `undefined`; every answer is a copy. Records which keys each
 * provider read (`readKeysOf`) for re-listing.
 */

import type { ModelCatalog } from '../../../catalog/modelCatalog'
import type { CatalogHit, CatalogStatus } from '../../../catalog/types'
import type { ProviderNounCall, ProviderNounTable } from '../ProviderModRuntime'

/** What the noun reads through; `modelCatalogReader` binds the real service. */
export type CatalogReaderDeps = {
  models: (providerKey: string) => Promise<Record<string, CatalogHit> | undefined>
  model: (providerKey: string, id: string, opts?: { alsoTry?: string[] }) => Promise<CatalogHit | undefined>
  status: () => Promise<CatalogStatus>
}

/** Binds the noun's reads to the real service. `models()` records are 'exact'. */
export function catalogReaderOf(catalog: ModelCatalog): CatalogReaderDeps {
  return {
    models: async providerKey => {
      const records = await catalog.provider(providerKey)
      if (!records) return undefined
      return Object.fromEntries(
        Object.entries(records).map(([id, record]) => [id, { ...record, match: 'exact' as const }]),
      )
    },
    model: (providerKey, id, opts) => catalog.lookup(providerKey, id, opts),
    status: () => catalog.status(),
  }
}

export type ProviderCatalogNoun = {
  table: ProviderNounTable
  /** The catalog provider keys the given provider's module has read, sorted. */
  readKeysOf(providerId: string): string[]
}

function keyArg(call: ProviderNounCall, value: unknown, what: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new TypeError(`$.catalog.${call.method}: ${what} must be a non-empty string`)
  }
  return value
}

function optionsOf(call: ProviderNounCall, value: unknown): { alsoTry?: string[] } | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`$.catalog.${call.method}: the options must be an object`)
  }
  const alsoTry = (value as { alsoTry?: unknown }).alsoTry
  if (alsoTry === undefined) return {}
  if (!Array.isArray(alsoTry) || alsoTry.some(key => typeof key !== 'string' || key === '')) {
    throw new TypeError(`$.catalog.${call.method}: alsoTry must be an array of non-empty provider keys`)
  }
  return { alsoTry: [...alsoTry] }
}

function copyOf<T>(value: T): T {
  return value === undefined ? value : structuredClone(value)
}

export function createProviderCatalogNoun(deps: CatalogReaderDeps): ProviderCatalogNoun {
  const reads = new Map<string, Set<string>>()
  const record = (call: ProviderNounCall, providerKey: string): void => {
    for (const providerId of call.providers) {
      let keys = reads.get(providerId)
      if (!keys) reads.set(providerId, (keys = new Set()))
      keys.add(providerKey)
    }
  }
  const table: ProviderNounTable = Object.freeze({
    models: async call => {
      const providerKey = keyArg(call, call.args[0], 'the provider key')
      record(call, providerKey)
      return copyOf(await deps.models(providerKey))
    },
    model: async call => {
      const providerKey = keyArg(call, call.args[0], 'the provider key')
      const id = keyArg(call, call.args[1], 'the model id')
      const opts = optionsOf(call, call.args[2])
      record(call, providerKey)
      const found = await deps.model(providerKey, id, opts)
      // A borrowed record was read from another provider: that counts too.
      if (found?.match === 'borrowed' && found.from) record(call, found.from)
      return copyOf(found)
    },
    status: async () => copyOf(await deps.status()),
  })
  return { table, readKeysOf: providerId => [...(reads.get(providerId) ?? [])].sort() }
}
