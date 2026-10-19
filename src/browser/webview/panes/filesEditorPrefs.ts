import { useSyncExternalStore } from 'react'

import type { FilesEditorPrefs } from '../layout/filesEditor'
import { loadFilesEditorPrefs, saveFilesEditorPrefs } from '../layout/layoutStorage'

/**
 * The Files pane's editor prefs (F-9), shared by every Files pane in the
 * window. Read from the layout blob once, written back on every change.
 */
let current: FilesEditorPrefs | null = null
const listeners = new Set<() => void>()

function read(): FilesEditorPrefs {
  current ??= loadFilesEditorPrefs()
  return current
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useFilesEditorPrefs(): FilesEditorPrefs {
  return useSyncExternalStore(subscribe, read, read)
}

export function setFilesEditorPrefs(change: Partial<FilesEditorPrefs>): void {
  const prev = read()
  const next = { ...prev, ...change }
  if (next.wordWrap === prev.wordWrap && next.tabSize === prev.tabSize) return
  current = next
  saveFilesEditorPrefs(next)
  for (const listener of listeners) listener()
}

/** Test-only: drops the cached prefs so the next read loads the blob again. */
export function __resetFilesEditorPrefsForTests(): void {
  current = null
}
