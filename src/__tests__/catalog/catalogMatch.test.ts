import { describe, expect, it } from 'vitest'
import { findNormalized, normalizeModelId } from '../../catalog/catalogMatch'
import { adaptDocument } from '../../catalog/modelsDevAdapter'
import type { CatalogProviderRecords } from '../../catalog/types'
import sample from './fixtures/models-dev-sample.json'

const tail = (id: string) => id.trim().toLowerCase().replace(/^.*\//, '')
const undated = (id: string) => tail(id).replace(/-\d{8}$/, '')

describe('normalized ids on the real sample document', () => {
  it('two different models of one provider never share a normalized id', () => {
    const providers = adaptDocument(sample)!
    const collisions: string[][] = []
    for (const records of Object.values(providers)) {
      const groups = new Map<string, string[]>()
      for (const id of Object.keys(records)) {
        const n = normalizeModelId(id)
        groups.set(n, [...(groups.get(n) ?? []), id])
      }
      for (const ids of groups.values()) if (ids.length > 1) collisions.push(ids)
    }
    // Only dated/undated names of one model may collide (the sample has one).
    expect(collisions.length).toBeGreaterThan(0)
    for (const ids of collisions) {
      expect(new Set(ids.map(undated)).size, ids.join(', ')).toBe(1)
    }
  })
})

describe('findNormalized', () => {
  const rec = { name: 'm', inputModalities: ['text'] }
  const records = (ids: string[]): CatalogProviderRecords =>
    Object.fromEntries(ids.map(id => [id, rec])) as unknown as CatalogProviderRecords

  it('picks the same sibling whatever the document order', () => {
    const ids = ['x-4-5-20250101', 'b/x-4-5', 'x-4-5-20251101', 'x-4-5', 'a/x-4-5']
    const n = normalizeModelId('x-4-5')
    for (const order of [ids, [...ids].reverse(), [ids[2], ids[0], ids[4], ids[3], ids[1]]]) {
      expect(findNormalized(records(order), n)).toBe('x-4-5')
    }
  })

  it('prefers unrouted, then undated, then the newest date, then the lower id', () => {
    const n = normalizeModelId('x-4-5')
    expect(findNormalized(records(['x-4-5-20250101', 'x-4-5-20251101']), n)).toBe('x-4-5-20251101')
    expect(findNormalized(records(['a/x-4-5', 'x-4-5-20250101']), n)).toBe('x-4-5-20250101')
    expect(findNormalized(records(['b/x-4-5', 'a/x-4-5']), n)).toBe('a/x-4-5')
    expect(findNormalized(records(['x-4.5', 'x-4-5']), n)).toBe('x-4-5')
    expect(findNormalized(records(['y']), n)).toBeUndefined()
  })
})
