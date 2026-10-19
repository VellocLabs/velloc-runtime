import { useSyncExternalStore } from 'react'

import { clampFilesTreeWidth, type FilesTreePrefs } from '../layout/filesTreeDock'
import { loadFilesTreePrefs, saveFilesTreePrefs } from '../layout/layoutStorage'

/**
 * The Files pane's docked-tree prefs (F-9), shared by every Files pane in the
 * window and the pane shortcuts. Read from the layout blob once, written
 * back on every change.
 */
let current: FilesTreePrefs | null = null
const listeners = new Set<() => void>()

function read(): FilesTreePrefs {
  current ??= loadFilesTreePrefs()
  return current
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function write(next: FilesTreePrefs): void {
  const prev = read()
  if (prev.visible === next.visible && prev.width === next.width) return
  current = next
  saveFilesTreePrefs(next)
  for (const listener of listeners) listener()
}

export function useFilesTreePrefs(): FilesTreePrefs {
  return useSyncExternalStore(subscribe, read, read)
}

export function setFilesTreeVisible(visible: boolean): void {
  write({ ...read(), visible })
}

export function toggleFilesTreeVisible(): void {
  setFilesTreeVisible(!read().visible)
}

export function setFilesTreeWidth(width: number): void {
  write({ ...read(), width: clampFilesTreeWidth(width) })
}
