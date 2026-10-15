import { describe, expect, it } from 'vitest'

import {
  orderByProviderIds,
  orderCatalogProviders,
} from '../browser/webview/modelCatalog'
import type { BrowserLlmCatalog } from '../browser/bridge/protocol/nexus_llm'

/**
 * The user's provider order (settings.json `providers.order`) sorts the quick
 * model picker. The order is partial by nature — providers added after the
 * last drag, or never configured, are not in it — so the rule that matters is
 * that nothing is ever dropped or shuffled: named ids first, the rest after
 * them in the catalog's own order.
 */
const p = (id: string) => ({ id })

describe('orderByProviderIds', () => {
  it('puts the named ids first, in the order given', () => {
    expect(
      orderByProviderIds([p('a'), p('b'), p('c')], ['c', 'a']).map(x => x.id),
    ).toEqual(['c', 'a', 'b'])
  })

  it('keeps the unnamed ones in their original relative order', () => {
    expect(
      orderByProviderIds([p('a'), p('b'), p('c'), p('d')], ['c']).map(x => x.id),
    ).toEqual(['c', 'a', 'b', 'd'])
  })

  it('ignores ids that are not present, and is a copy for an empty order', () => {
    const items = [p('a'), p('b')]
    expect(orderByProviderIds(items, ['zz', 'b']).map(x => x.id)).toEqual(['b', 'a'])
    const same = orderByProviderIds(items, [])
    expect(same.map(x => x.id)).toEqual(['a', 'b'])
    expect(same).not.toBe(items)
  })
})

describe('orderCatalogProviders', () => {
  const catalog: BrowserLlmCatalog = {
    providers: [
      { id: 'openai', label: 'OpenAI', iconSvg: '', enabled: true, models: [] },
      { id: 'anthropic', label: 'Anthropic', iconSvg: '', enabled: true, models: [] },
    ],
    defaultSelection: { providerId: 'openai', modelId: 'gpt-x' },
  }

  it('reorders providers but never moves the default selection', () => {
    const ordered = orderCatalogProviders(catalog, ['anthropic'])!
    expect(ordered.providers.map(x => x.id)).toEqual(['anthropic', 'openai'])
    // Display only: the default was resolved on the catalog's own order, and
    // the worker resolves its fallback the same way.
    expect(ordered.defaultSelection).toEqual(catalog.defaultSelection)
  })

  it('passes a missing catalog or an empty order straight through', () => {
    expect(orderCatalogProviders(null, ['a'])).toBeNull()
    expect(orderCatalogProviders(undefined, ['a'])).toBeUndefined()
    expect(orderCatalogProviders(catalog, [])).toBe(catalog)
  })
})
