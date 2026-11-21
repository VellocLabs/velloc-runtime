/**
 * Prices on peer models (F-28): each model of a peers table takes the
 * catalog's `cost` (US dollars per million tokens), and a cost of 0 for input
 * and output marks it free. A model the catalog does not price is left as it is.
 */

import type { CatalogHit } from '../../../catalog/types'
import type { Peer, PeerModel } from './providerPeersTypes'

export type PeerCostDeps = {
  /** The catalog keys a provider definition reads, in order; empty = its own id. */
  keysOf: (definition: string) => string[]
  lookup: (providerKey: string, modelId: string) => Promise<CatalogHit | undefined>
}

async function costOf(model: PeerModel, keys: string[], deps: PeerCostDeps): Promise<PeerModel> {
  for (const key of keys) {
    const hit = await deps.lookup(key, model.id).catch(() => undefined)
    const cost = hit?.cost
    if (!cost || !Number.isFinite(cost.input) || !Number.isFinite(cost.output)) continue
    const free = cost.input === 0 && cost.output === 0
    return {
      ...model,
      cost: { input: cost.input, output: cost.output, ...(cost.cacheRead !== undefined ? { cacheRead: cost.cacheRead } : {}) },
      ...(free || model.free !== undefined ? { free: free || model.free === true } : {}),
    }
  }
  return model
}

/** The table with each model's catalog price; never throws. */
export async function withCatalogCost(peers: Peer[], deps: PeerCostDeps): Promise<Peer[]> {
  return Promise.all(peers.map(async peer => {
    const named = deps.keysOf(peer.definition)
    const keys = named.length > 0 ? named : [peer.definition]
    return { ...peer, models: await Promise.all(peer.models.map(model => costOf(model, keys, deps))) }
  }))
}

/** The runtime's binding: the realm's catalog and the built-in rows' catalog keys. */
export async function runtimePeerCostDeps(): Promise<PeerCostDeps | undefined> {
  const [{ acquireModelCatalog }, { catalogKeysOf }, { NEXUS_MODEL_CONFIG }] = await Promise.all([
    import('../../../catalog/modelCatalogHolder'),
    import('../../../config/nexusModelConfig/catalogFigures'),
    import('../../../config/nexusModelConfig'),
  ])
  const catalog = await acquireModelCatalog().catch(() => undefined)
  if (!catalog) return undefined
  return {
    keysOf: definition => catalogKeysOf(NEXUS_MODEL_CONFIG, definition),
    lookup: (key, id) => catalog.lookup(key, id),
  }
}
