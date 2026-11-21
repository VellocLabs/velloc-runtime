import { describe, expect, it } from 'vitest'
import { withCatalogCost } from '../mods/provider/nouns/peerModelCost'
import type { Peer } from '../mods/provider/nouns/providerPeersTypes'
import type { CatalogHit } from '../catalog/types'

const peer = (definition: string, ids: string[]): Peer => ({
  id: definition,
  definition,
  label: definition,
  kind: 'provider',
  source: 'builtin',
  connected: true,
  models: ids.map(id => ({ id, picked: true, supportsTools: true })),
  state: {},
})

const hit = (cost?: CatalogHit['cost']): CatalogHit =>
  ({ name: 'm', inputModalities: ['text'], match: 'exact', ...(cost ? { cost } : {}) }) as unknown as CatalogHit

describe('peer models take the catalog price', () => {
  const prices: Record<string, CatalogHit['cost']> = {
    'cat/paid': { input: 0.3, output: 1.2, cacheRead: 0.03 },
    'cat/zero': { input: 0, output: 0 },
    'own/self': { input: 2, output: 8 },
  }
  const deps = {
    keysOf: (definition: string) => (definition === 'alpha' ? ['none', 'cat'] : []),
    lookup: async (key: string, id: string) => {
      if (id === 'boom') throw new Error('read failed')
      const cost = prices[`${key}/${id}`]
      return cost ? hit(cost) : key === 'none' ? hit() : undefined
    },
  }

  it('sets the cost, marks a zero price free, tries keys in order and leaves unpriced models alone', async () => {
    const [alpha, own] = await withCatalogCost([peer('alpha', ['paid', 'zero', 'gone', 'boom']), peer('own', ['self'])], deps)
    expect(alpha!.models[0]).toEqual({ id: 'paid', picked: true, supportsTools: true, cost: { input: 0.3, output: 1.2, cacheRead: 0.03 } })
    expect(alpha!.models[1]).toMatchObject({ cost: { input: 0, output: 0 }, free: true })
    expect(alpha!.models[2]).toEqual({ id: 'gone', picked: true, supportsTools: true })
    expect(alpha!.models[3]).toEqual({ id: 'boom', picked: true, supportsTools: true })
    expect(own!.models[0]!.cost).toEqual({ input: 2, output: 8 })
  })
})
