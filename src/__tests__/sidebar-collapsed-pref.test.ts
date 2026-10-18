// @vitest-environment happy-dom
/**
 * The sidebar collapse choice is one global preference (F-9): a write in this
 * window and a `storage` event from another window both reach subscribers.
 */
import { describe, expect, it, vi } from 'vitest'

import {
  SIDEBAR_COLLAPSED_STORAGE_KEY,
  readSidebarCollapsed,
  subscribeSidebarCollapsed,
  writeSidebarCollapsed,
} from '@/browser/webview/sidebarCollapsedPref'

function memoryStorage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  }
}

describe('sidebarCollapsedPref', () => {
  it('defaults to expanded and round-trips the choice', () => {
    const storage = memoryStorage()
    expect(readSidebarCollapsed(storage)).toBe(false)
    writeSidebarCollapsed(true, storage)
    expect(storage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY)).toBe('1')
    expect(readSidebarCollapsed(storage)).toBe(true)
    writeSidebarCollapsed(false, storage)
    expect(readSidebarCollapsed(storage)).toBe(false)
  })

  it('notifies on a local write and on another window changing the key, not on other keys', () => {
    const storage = memoryStorage()
    const listener = vi.fn()
    const dispose = subscribeSidebarCollapsed(listener)
    writeSidebarCollapsed(true, storage)
    expect(listener).toHaveBeenCalledTimes(1)
    window.dispatchEvent(new StorageEvent('storage', { key: SIDEBAR_COLLAPSED_STORAGE_KEY }))
    expect(listener).toHaveBeenCalledTimes(2)
    window.dispatchEvent(new StorageEvent('storage', { key: 'something-else' }))
    expect(listener).toHaveBeenCalledTimes(2)
    dispose()
    writeSidebarCollapsed(false, storage)
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('a throwing storage reads as expanded', () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    }
    expect(readSidebarCollapsed(broken)).toBe(false)
    expect(() => writeSidebarCollapsed(true, broken)).not.toThrow()
  })
})
