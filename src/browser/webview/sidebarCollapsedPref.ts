import { useSyncExternalStore } from 'react'

/**
 * The person's sidebar choice (F-9): expanded, or collapsed to the icon rail.
 * One global view preference in the guest's localStorage — every session and
 * every open window of this origin follows the last choice. Narrow-window
 * forced forms never write it.
 */

export const SIDEBAR_COLLAPSED_STORAGE_KEY = 'shift-sidebar-collapsed'

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

const listeners = new Set<() => void>()

// The last choice when storage is unavailable or throws on write.
let memoryFallback: boolean | undefined

export function readSidebarCollapsed(storage: StorageLike | null = defaultStorage()): boolean {
  try {
    return storage?.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

/** Persist the choice and notify subscribers in this window. */
export function writeSidebarCollapsed(
  collapsed: boolean,
  storage: StorageLike | null = defaultStorage(),
): void {
  let stored = false
  try {
    if (storage) {
      storage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, collapsed ? '1' : '0')
      stored = true
    }
  } catch {
    // Handled below with the absent-storage case.
  }
  memoryFallback = stored ? undefined : collapsed
  for (const listener of listeners) listener()
}

function snapshot(): boolean {
  return memoryFallback ?? readSidebarCollapsed()
}

/**
 * Subscribe to this window's writes and to other windows' (which arrive only
 * as `storage` events). Returns a disposer.
 */
export function subscribeSidebarCollapsed(listener: () => void): () => void {
  listeners.add(listener)
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== SIDEBAR_COLLAPSED_STORAGE_KEY) return
    memoryFallback = undefined
    listener()
  }
  const target = typeof window === 'undefined' ? null : window
  target?.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(listener)
    target?.removeEventListener('storage', onStorage)
  }
}

/** The live preference, re-rendering on every change. */
export function useSidebarCollapsed(): boolean {
  return useSyncExternalStore(subscribeSidebarCollapsed, snapshot, () => false)
}
