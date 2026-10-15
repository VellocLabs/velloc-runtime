import { describe, expect, it } from 'vitest'
import { listedProviderIdsOf } from '../browser/webview/settings/clients'

const changed = (payload: unknown) => ({
  route: { namespace: 'nexus', capability: 'providers', action: 'changed' },
  payload,
})

describe('listedProviderIdsOf', () => {
  it('names the providers of a listing change', () => {
    expect(listedProviderIdsOf(changed({ reason: 'listing', listedProviderIds: ['a', 'b'], configs: {} }))).toEqual(['a', 'b'])
  })
  it('is empty for any other providers.changed, other events and bad payloads', () => {
    expect(listedProviderIdsOf(changed({ configs: {} }))).toEqual([])
    expect(listedProviderIdsOf(changed({ reason: 'order' }))).toEqual([])
    expect(listedProviderIdsOf(changed({ reason: 'listing', listedProviderIds: 'a' }))).toEqual([])
    expect(listedProviderIdsOf({ route: { capability: 'agent', action: 'changed' }, payload: { reason: 'listing', listedProviderIds: ['a'] } })).toEqual([])
    expect(listedProviderIdsOf(changed({ reason: 'listing', listedProviderIds: ['a', 3] }))).toEqual(['a'])
  })
})
