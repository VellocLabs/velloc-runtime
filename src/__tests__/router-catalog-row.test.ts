import { describe, expect, it } from 'vitest'
import { routerCatalogRow } from '../models/drivers/runtimeProviders'
import { applyModelEntries } from '../models/drivers/modelEntryCatalog'
import type { BrowserLlmProvider } from '../browser/bridge/protocol/nexus_llm'

/**
 * A router's catalog row (F-27): every route its latest listing names, by the
 * listing's name, with nothing picked by hand; the entry rewrite leaves it as is.
 */

const base: BrowserLlmProvider = { id: 'mod.switch.main', label: 'Switch', iconSvg: '', enabled: true, models: [] }

describe('routerCatalogRow', () => {
  it('lists every listed route with its listed name, ids as listed', () => {
    const row = routerCatalogRow(base, [
      { id: 'route-1', name: 'Free pool', contextWindow: 64000, supportsTools: true },
      { id: 'route-2', name: 'Paid backup', supportsTools: true },
    ])
    expect(row.models.map(model => [model.id, model.label])).toEqual([
      ['route-1', 'Free pool'],
      ['route-2', 'Paid backup'],
    ])
    expect(row.models.every(model => model.enabled)).toBe(true)
    expect(row.models[0]!.contextWindow).toBe(64000)
    expect(row.enabled).toBe(true)
  })

  it('a renamed route reads by its new name on the next listing', () => {
    expect(routerCatalogRow(base, [{ id: 'route-1', name: 'Route 1', supportsTools: true }]).models[0]!.label).toBe('Route 1')
    expect(routerCatalogRow(base, [{ id: 'route-1', name: 'Free pool', supportsTools: true }]).models[0]!.label).toBe('Free pool')
  })

  it('keeps a stored default that is still listed, else the first route; none with no routes', () => {
    const listed = [{ id: 'route-1', name: 'A', supportsTools: true }, { id: 'route-2', name: 'B', supportsTools: true }]
    expect(routerCatalogRow({ ...base, defaultModelId: 'route-2' }, listed).defaultModelId).toBe('route-2')
    expect(routerCatalogRow({ ...base, defaultModelId: 'route@1' }, listed).defaultModelId).toBe('route-1')
    const empty = routerCatalogRow({ ...base, defaultModelId: 'route-1' }, [])
    expect(empty.defaultModelId).toBeUndefined()
    expect(empty.enabled).toBe(false)
  })

  it('the entry rewrite does not turn its routes into family entries', () => {
    const row = routerCatalogRow(base, [{ id: 'route-1', name: 'Free pool', supportsTools: true }])
    const out = applyModelEntries({ providers: [row] }, { [base.id]: { source: 'mod', modelEntries: [] } })
    expect(out.providers[0]!.models.map(model => [model.id, model.label])).toEqual([['route-1', 'Free pool']])
  })
})
