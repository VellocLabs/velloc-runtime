/**
 * The Files pane filter box's modes (F-9): what the typed text asks for, where "go up" leads in a
 * folder scope, and how a result's highlight ranges split its text. Pure.
 */

/**
 * - `tree`: nothing typed; the folder tree.
 * - `files`: rank file names for `query` below `folder` ('' = the session root).
 * - `folder`: the entries of `folder`, flat.
 * - `content`: search file contents for `query` ('' = only the hint).
 */
export type FilterInput =
  | { mode: 'tree' }
  | { mode: 'files'; folder: string; query: string }
  | { mode: 'folder'; folder: string }
  | { mode: 'content'; query: string }

/** `folder` with '/' separators, no `.` segments, and no leading, trailing or doubled separators. */
export function normalizeFolder(folder: string): string {
  return folder
    .split(/[\\/]+/)
    .filter(segment => segment !== '' && segment !== '.')
    .join('/')
}

export function parseFilterInput(text: string): FilterInput {
  if (text.trim() === '') return { mode: 'tree' }
  if (text.startsWith('?')) return { mode: 'content', query: text.slice(1) }
  const lastSep = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'))
  if (lastSep < 0) return { mode: 'files', folder: '', query: text.trim() }
  const folder = normalizeFolder(text.slice(0, lastSep))
  const query = text.slice(lastSep + 1).trim()
  if (query === '') return folder === '' ? { mode: 'tree' } : { mode: 'folder', folder }
  return { mode: 'files', folder, query }
}

/** Where the go-up row of a folder scope leads: the tree, or the parent folder's scope. */
export type GoUpTarget = { kind: 'root' } | { kind: 'folder'; name: string; input: string }

export function goUpTarget(folder: string): GoUpTarget {
  const segments = normalizeFolder(folder).split('/').filter(Boolean)
  if (segments.length <= 1) return { kind: 'root' }
  const parent = segments.slice(0, -1)
  return { kind: 'folder', name: parent[parent.length - 1]!, input: `${parent.join('/')}/` }
}

/** `relative` ('/'-separated) under `base`, in the separator `base` already uses. */
export function joinUnder(base: string, relative: string): string {
  const parts = relative.split('/').filter(Boolean)
  if (parts.length === 0) return base
  const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/'
  return `${base.replace(/[\\/]+$/, '')}${sep}${parts.join(sep)}`
}

/** A found path split into its name and its parent folders (both '/'-separated). */
export function splitFoundPath(path: string): { name: string; parent: string; nameStart: number } {
  const nameStart = path.lastIndexOf('/') + 1
  return { name: path.slice(nameStart), parent: path.slice(0, Math.max(0, nameStart - 1)), nameStart }
}

export type TextSegment = { text: string; hit: boolean }

/**
 * `text` as plain and highlighted runs, from flat `[start, end)` `ranges` measured from `offset`
 * (the position of `text` inside the string the ranges were computed on).
 */
export function highlightSegments(text: string, ranges: readonly number[], offset = 0): TextSegment[] {
  const segments: TextSegment[] = []
  let at = 0
  const push = (to: number, hit: boolean) => {
    if (to > at) segments.push({ text: text.slice(at, to), hit })
    at = Math.max(at, to)
  }
  for (let i = 0; i + 1 < ranges.length; i += 2) {
    const start = Math.max(0, Math.min(text.length, ranges[i]! - offset))
    const end = Math.max(0, Math.min(text.length, ranges[i + 1]! - offset))
    if (end <= start || end <= at) continue
    push(start, false)
    push(end, true)
  }
  push(text.length, false)
  return segments
}
