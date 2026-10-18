/**
 * The layout blob's storage (F-9): one key, the retired key removed on the
 * first read without carrying its values, writes coalesced to one `setItem`
 * per task, and each writer keeping the other fields.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { defaultLayoutStorage } from '@/browser/webview/layout/layoutSanitize'
import {
  flushLayoutStorage,
  LAYOUT_STORAGE_KEY,
  loadLayoutStorage,
  loadSessionCardPrefs,
  saveSessionCardPrefs,
  updateLayoutStorage,
} from '@/browser/webview/layout/layoutStorage'
import { defaultSessionCardPrefs } from '@/browser/webview/layout/sessionCards'

describe('layout storage (localStorage stub)', () => {
  let store: Map<string, string>
  let writes: number

  beforeEach(() => {
    store = new Map()
    writes = 0
    ;(globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => {
        writes += 1
        store.set(k, v)
      },
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    }
  })

  afterEach(() => {
    flushLayoutStorage()
    delete (globalThis as { localStorage?: unknown }).localStorage
  })

  it('returns defaults when nothing is stored, or the JSON is corrupt', () => {
    expect(loadLayoutStorage()).toEqual(defaultLayoutStorage())
    store.set(LAYOUT_STORAGE_KEY, '{ not json')
    expect(loadLayoutStorage()).toEqual(defaultLayoutStorage())
  })

  it('removes the retired key on the first read and carries nothing from it', () => {
    store.set('nexus.layout.v1', JSON.stringify({ version: 1, sessionCards: { hidden: ['changes'] } }))
    expect(loadLayoutStorage()).toEqual(defaultLayoutStorage())
    expect(store.has('nexus.layout.v1')).toBe(false)
    expect(store.has(LAYOUT_STORAGE_KEY)).toBe(false)
  })

  it('coalesces the updates of one task into one write, and reads the pending result', async () => {
    updateLayoutStorage(prev => ({ ...prev, paneWeightByKind: { diff: 2 } }))
    updateLayoutStorage(prev => ({ ...prev, paneWeightByKind: { ...prev.paneWeightByKind, tasks: 1.5 } }))
    expect(loadLayoutStorage().paneWeightByKind).toEqual({ diff: 2, tasks: 1.5 })
    expect(writes).toBe(0)
    await Promise.resolve()
    expect(writes).toBe(1)
    expect(JSON.parse(store.get(LAYOUT_STORAGE_KEY)!).paneWeightByKind).toEqual({ diff: 2, tasks: 1.5 })
  })

  it('an update returning its input writes nothing', async () => {
    updateLayoutStorage(prev => prev)
    await Promise.resolve()
    expect(writes).toBe(0)
  })

  it('each writer keeps the other fields', async () => {
    updateLayoutStorage(prev => ({ ...prev, paneWeightByKind: { diff: 2 } }))
    flushLayoutStorage()
    saveSessionCardPrefs({ ...defaultSessionCardPrefs(), hidden: ['changes'] })
    flushLayoutStorage()
    const stored = JSON.parse(store.get(LAYOUT_STORAGE_KEY)!)
    expect(stored.paneWeightByKind).toEqual({ diff: 2 })
    expect(stored.sessionCards.hidden).toEqual(['changes'])
    expect(loadSessionCardPrefs().hidden).toEqual(['changes'])
    expect(stored).not.toHaveProperty('version')
  })
})
