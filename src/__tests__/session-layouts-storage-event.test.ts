// @vitest-environment happy-dom
/**
 * Another window's write to the layout blob reaches this store through the
 * `storage` event: the snapshot takes the stored records (F-9).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { flushLayoutStorage, LAYOUT_STORAGE_KEY } from '@/browser/webview/layout/layoutStorage'
import { defaultSessionPaneRecord, openPane, panesIn } from '@/browser/webview/layout/paneLayout'
import { createSessionLayoutsStore } from '@/browser/webview/layout/sessionLayouts'

// This vitest realm's `localStorage` is not a working Storage; a Map-backed
// stub stands in. The `storage` event itself comes from `window`.
const memoryStorage = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => memoryStorage.get(k) ?? null,
  setItem: (k: string, v: string) => void memoryStorage.set(k, String(v)),
  removeItem: (k: string) => void memoryStorage.delete(k),
  clear: () => memoryStorage.clear(),
})

function storageEvent(key: string): Event {
  return typeof StorageEvent === 'function'
    ? new StorageEvent('storage', { key })
    : Object.assign(new Event('storage'), { key })
}

describe('createSessionLayoutsStore — the storage event', () => {
  beforeEach(() => {
    memoryStorage.clear()
  })
  afterEach(() => {
    flushLayoutStorage()
    memoryStorage.clear()
  })

  it('refreshes the snapshot from storage when another window writes the key', () => {
    const store = createSessionLayoutsStore(() => 1)
    let notified = 0
    store.subscribe(() => notified++)
    expect(store.getSnapshot().records.size).toBe(0)
    // What another window would have written.
    localStorage.setItem(
      LAYOUT_STORAGE_KEY,
      JSON.stringify({ sessions: { x: { ...openPane(defaultSessionPaneRecord(), 'diff', {}), usedAt: 5 } }, paneWeightByKind: { diff: 2 } }),
    )
    window.dispatchEvent(storageEvent(LAYOUT_STORAGE_KEY))
    expect(notified).toBe(1)
    expect(panesIn(store.get('x').layout)).toEqual(['diff'])
    expect(store.getSnapshot().weights).toEqual({ diff: 2 })
    // Another key is not ours.
    window.dispatchEvent(storageEvent('shift-sidebar-width'))
    expect(notified).toBe(1)
    store.dispose()
    window.dispatchEvent(storageEvent(LAYOUT_STORAGE_KEY))
    expect(notified).toBe(1)
  })
})
