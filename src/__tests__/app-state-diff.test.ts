/**
 * An app's state as patches (F-40): the diff names leaves, arrays of one
 * length by index and of two lengths whole; a patch applies without touching
 * the value it was applied to; a batch the document refuses, and why; the
 * document's byte cap and the patches it publishes.
 */
import { describe, expect, it } from 'vitest'

import {
  APP_PATCH_BATCH_MAX,
  appStateBytes,
  applyAppPatch,
  applyAppPatches,
  checkAppPatches,
  diffJson,
  parseAppPointer,
} from '../mods/app/appStateDiff'
import type { AppStateEvent } from '../mods/app/appStateBus'
import { AppStateDocument } from '../mods/app/appStateDocument'

describe('the diff', () => {
  it('names the leaves that changed, a key gone as a removal, and nothing for equal values', () => {
    const before = { orders: [{ id: 1, status: 'new' }, { id: 2, status: 'paid' }], summary: { paid: 1, open: 1 }, note: 'x' }
    const after = { orders: [{ id: 1, status: 'shipped' }, { id: 2, status: 'paid' }], summary: { paid: 1, open: 0, shipped: 1 } }
    expect(diffJson(before, after)).toEqual([
      { path: '/note' },
      { path: '/orders/0/status', value: 'shipped' },
      { path: '/summary/open', value: 0 },
      { path: '/summary/shipped', value: 1 },
    ])
    expect(diffJson(after, after)).toEqual([])
    expect(diffJson({ a: Number.NaN }, { a: Number.NaN })).toEqual([])
  })

  it('an array of another length, a type change and a primitive root are replaced whole', () => {
    expect(diffJson({ list: [1, 2] }, { list: [1, 2, 3] })).toEqual([{ path: '/list', value: [1, 2, 3] }])
    expect(diffJson({ a: { b: 1 } }, { a: [1] })).toEqual([{ path: '/a', value: [1] }])
    expect(diffJson(1, { a: 1 })).toEqual([{ path: '', value: { a: 1 } }])
    expect(diffJson(undefined, { a: 1 })).toEqual([{ path: '', value: { a: 1 } }])
  })

  it('escapes "/" and "~" in keys and skips prototype keys', () => {
    expect(diffJson({}, { 'a/b': 1, 'c~d': 2 })).toEqual([
      { path: '/a~1b', value: 1 },
      { path: '/c~0d', value: 2 },
    ])
    expect(diffJson({}, JSON.parse('{"__proto__": {"x": 1}, "ok": 1}') as unknown)).toEqual([{ path: '/ok', value: 1 }])
  })
})

describe('applying a patch', () => {
  it('copies the containers on the path and shares the rest; the given value is unchanged', () => {
    const before = { orders: [{ id: 1, status: 'new' }, { id: 2 }], summary: { open: 1 } }
    const after = applyAppPatch(before, { path: '/orders/0/status', value: 'shipped' }) as typeof before
    expect(after.orders[0]).toEqual({ id: 1, status: 'shipped' })
    expect(before.orders[0]).toEqual({ id: 1, status: 'new' })
    expect(after.orders[1]).toBe(before.orders[1])
    expect(after.summary).toBe(before.summary)
  })

  it('removes a key or an array item, appends with "-" or the length, and creates missing containers', () => {
    expect(applyAppPatch({ a: 1, b: 2 }, { path: '/a' })).toEqual({ b: 2 })
    expect(applyAppPatch({ list: [1, 2, 3] }, { path: '/list/1' })).toEqual({ list: [1, 3] })
    expect(applyAppPatch({ list: [1] }, { path: '/list/-', value: 2 })).toEqual({ list: [1, 2] })
    expect(applyAppPatch({ list: [1] }, { path: '/list/1', value: 2 })).toEqual({ list: [1, 2] })
    expect(applyAppPatch(undefined, { path: '/a/0/b', value: 1 })).toEqual({ a: [{ b: 1 }] })
    expect(applyAppPatch({}, { path: '/missing/x' })).toEqual({})
    expect(applyAppPatch({ a: 1 }, { path: '', value: { b: 2 } })).toEqual({ b: 2 })
    expect(applyAppPatch({ a: 1 }, { path: '' })).toEqual({})
  })

  it('refuses a path through a primitive, past an array, or with a forbidden segment', () => {
    expect(() => applyAppPatch({ a: 1 }, { path: '/a/b', value: 1 })).toThrow(/not an object or array/)
    expect(() => applyAppPatch({ list: [1] }, { path: '/list/5', value: 1 })).toThrow(/outside the array/)
    expect(() => applyAppPatch({ list: [1] }, { path: '/list/x', value: 1 })).toThrow(/outside the array/)
    expect(() => applyAppPatch({}, { path: '/__proto__/x', value: 1 })).toThrow(/not one the state takes/)
    expect(() => applyAppPatch({}, { path: 'a', value: 1 })).toThrow(/not one the state takes/)
  })

  it('a diff applied gives the value diffed, over a batch', () => {
    const before = { a: [1, 2, { b: 'x' }], c: { d: 1 }, e: 'gone' }
    const after = { a: [1, 3, { b: 'y' }], c: { d: 1, f: [true] } }
    expect(applyAppPatches(before, diffJson(before, after))).toEqual(after)
  })
})

describe('the check', () => {
  it('takes a list of {path, value?} with pointers the state takes, up to the cap; names the refusal', () => {
    expect(checkAppPatches([{ path: '/a', value: 1 }, { path: '/b' }])).toBeNull()
    expect(checkAppPatches('nope')).toMatch(/must be an array/)
    expect(checkAppPatches([{ value: 1 }])).toMatch(/each patch is/)
    expect(checkAppPatches([{ path: 'a' }])).toMatch(/not a JSON pointer/)
    expect(checkAppPatches([{ path: '/constructor/x', value: 1 }])).toMatch(/not a JSON pointer/)
    expect(checkAppPatches([{ path: '' }])).toMatch(/root cannot be removed/)
    expect(checkAppPatches(Array.from({ length: APP_PATCH_BATCH_MAX + 1 }, () => ({ path: '/a', value: 1 })))).toMatch(/at most 256/)
    expect(parseAppPointer('/a~1b/c~0d')).toEqual(['a/b', 'c~d'])
  })
})

describe('the document', () => {
  const make = (maxBytes?: number) => {
    const events: AppStateEvent[] = []
    const document = new AppStateDocument({
      appId: 'pay-board',
      file: 'C:/app/data/state.json',
      fs: { readFile: () => Promise.reject(new Error('none')), writeFile: async () => undefined },
      ensureDir: async () => undefined,
      report: () => undefined,
      publish: event => events.push(event),
      ...(maxBytes !== undefined ? { maxBytes } : {}),
    })
    return { document, events }
  }

  it('caps the state at the UTF-8 size of the file it writes', () => {
    const value = { name: 'é'.repeat(20) }
    const bytes = appStateBytes(value)
    expect(bytes).toBe(new TextEncoder().encode(JSON.stringify(value, null, 2)).length)
    expect(bytes).toBeGreaterThan(JSON.stringify(value).length)
    expect(() => make(bytes - 1).document.apply([{ path: '', value }])).toThrow(/at most/)
    expect(make(bytes).document.apply([{ path: '', value }])).toEqual({ version: 1 })
  })

  it('publishes the change as the diff of the state, so an append or a removal reaches every reader alike', () => {
    const { document, events } = make()
    document.apply([{ path: '/list', value: ['a'] }])
    document.apply([{ path: '/list/-', value: 'b' }])
    expect(events.at(-1)!.patches).toEqual([{ path: '/list', value: ['a', 'b'] }])
    document.apply([{ path: '/list/0' }])
    expect(events.at(-1)!.patches).toEqual([{ path: '/list', value: ['b'] }])
    expect(events.map(e => e.owner)).toEqual([document.owner, document.owner, document.owner])
    expect(make().document.owner).not.toBe(document.owner)
  })
})
