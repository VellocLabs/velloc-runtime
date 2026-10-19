/**
 * The Files pane's tree (F-9 browse state): which folders are listed and
 * expanded, flattened into the rows the view draws, plus tree keyboard
 * moves. Folders are listed lazily, one level at a time. Pure.
 */
import { baseName, normalizePathKey } from '@/utils/paths'

export type TreeNodeKind = 'file' | 'dir' | 'link'

/** One listed entry of a folder. */
export type TreeEntry = { name: string; kind: TreeNodeKind }

/** The listing shape the tree consumes (one folder, one level). */
export type FolderListing = {
  entries: Array<{ name: string; isFile: boolean; isDirectory: boolean; isSymbolicLink: boolean }>
  truncated: boolean
}

export type FolderStatus = 'loading' | 'ready' | 'error'

export type FileTreeState = {
  roots: readonly string[]
  /** Listed folders, by the path the tree spelled them with. */
  children: ReadonlyMap<string, readonly TreeEntry[]>
  /** Listed folders whose listing hit the cap. */
  truncated: ReadonlySet<string>
  expanded: ReadonlySet<string>
  status: ReadonlyMap<string, FolderStatus>
}

/** A file, folder or link row. */
export type TreeNode = {
  path: string
  name: string
  kind: TreeNodeKind
  depth: number
  expanded?: boolean
}

/** A row standing for a folder's listing state, under that folder. */
export type TreeStatusRow = {
  kind: 'loading' | 'error' | 'empty' | 'more'
  /** The folder the row belongs to. */
  path: string
  depth: number
}

export type TreeRow = TreeNode | TreeStatusRow

export type TreeKey = 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End'

export function isNodeRow(row: TreeRow): row is TreeNode {
  return row.kind === 'file' || row.kind === 'dir' || row.kind === 'link'
}

/** Rows that take focus: entries, and the error row (its Retry). */
export function isFocusableRow(row: TreeRow): boolean {
  return isNodeRow(row) || row.kind === 'error'
}

/** Stable identity of a row, for React keys and focus. */
export function rowKey(row: TreeRow): string {
  return isNodeRow(row) ? row.path : `${row.kind}:${row.path}`
}

/** A fresh tree over `roots`, the roots expanded and not yet listed. */
export function emptyFileTree(roots: readonly string[]): FileTreeState {
  return {
    roots: [...roots],
    children: new Map(),
    truncated: new Set(),
    expanded: new Set(roots),
    status: new Map(),
  }
}

/** Point the tree at `roots`, keeping what was listed and expanded. A new root comes in expanded. */
export function withRoots(state: FileTreeState, roots: readonly string[]): FileTreeState {
  if (roots.length === state.roots.length && roots.every((root, i) => root === state.roots[i])) {
    return state
  }
  const expanded = new Set(state.expanded)
  for (const root of roots) if (!state.roots.includes(root)) expanded.add(root)
  return { ...state, roots: [...roots], expanded }
}

/** `parent` joined with `name`, in the separator `parent` already uses. */
export function childPath(parent: string, name: string): string {
  const sep = parent.includes('\\') && !parent.includes('/') ? '\\' : '/'
  return /[\\/]$/.test(parent) ? `${parent}${name}` : `${parent}${sep}${name}`
}

function entryKind(entry: FolderListing['entries'][number]): TreeNodeKind {
  if (entry.isDirectory) return 'dir'
  if (entry.isSymbolicLink) return 'link'
  return 'file'
}

function rootName(root: string): string {
  return baseName(root) || root
}

function* walk(state: FileTreeState): Generator<TreeRow> {
  function* folder(path: string, depth: number): Generator<TreeRow> {
    const status = state.status.get(path)
    if (status === 'error') {
      yield { kind: 'error', path, depth }
      return
    }
    const entries = status === 'ready' ? state.children.get(path) : undefined
    if (!entries) {
      yield { kind: 'loading', path, depth }
      return
    }
    if (entries.length === 0) yield { kind: 'empty', path, depth }
    for (const entry of entries) {
      const entryPath = childPath(path, entry.name)
      if (entry.kind !== 'dir') {
        yield { path: entryPath, name: entry.name, kind: entry.kind, depth }
        continue
      }
      const expanded = state.expanded.has(entryPath)
      yield { path: entryPath, name: entry.name, kind: 'dir', depth, expanded }
      if (expanded) yield* folder(entryPath, depth + 1)
    }
    if (state.truncated.has(path)) yield { kind: 'more', path, depth }
  }
  for (const root of state.roots) {
    const expanded = state.expanded.has(root)
    yield { path: root, name: rootName(root), kind: 'dir', depth: 0, expanded }
    if (expanded) yield* folder(root, 1)
  }
}

/** The rows, in order: each root, then its expanded folders depth-first, entries in listing order. */
export function flattenTree(state: FileTreeState): TreeRow[] {
  return [...walk(state)]
}

/**
 * The listed entries whose path below their root contains every
 * space-separated word of `query` (case-insensitive), with the folders above
 * them, drawn expanded (F-9). Only what has been listed is searched; a
 * matching folder with no listed entry below it stays collapsed.
 */
export function filterTree(state: FileTreeState, query: string): TreeNode[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(word => word !== '')
  if (words.length === 0) return []
  const hits = (relative: string) => {
    const lower = relative.toLowerCase()
    return words.every(word => lower.includes(word))
  }
  const out: TreeNode[] = []
  const visit = (path: string, relative: string, depth: number): boolean => {
    const before = out.length
    for (const entry of state.children.get(path) ?? []) {
      const entryPath = childPath(path, entry.name)
      const entryRelative = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.kind !== 'dir') {
        if (hits(entryRelative)) out.push({ path: entryPath, name: entry.name, kind: entry.kind, depth })
        continue
      }
      const at = out.length
      out.push({ path: entryPath, name: entry.name, kind: 'dir', depth, expanded: false })
      if (visit(entryPath, entryRelative, depth + 1)) out[at] = { ...out[at], expanded: true }
      else if (!hits(entryRelative)) out.length = at
    }
    return out.length > before
  }
  for (const root of state.roots) {
    const at = out.length
    out.push({ path: root, name: rootName(root), kind: 'dir', depth: 0, expanded: true })
    if (!visit(root, '', 1)) out.length = at
  }
  return out
}

/** Expanded folders on screen that have no listing yet and none in flight. */
export function pendingListings(state: FileTreeState): string[] {
  const out: string[] = []
  for (const row of walk(state)) {
    if (row.kind === 'loading' && !state.status.has(row.path)) out.push(row.path)
  }
  return out
}

export function toggleDir(state: FileTreeState, path: string): FileTreeState {
  const expanded = new Set(state.expanded)
  if (expanded.has(path)) expanded.delete(path)
  else expanded.add(path)
  return { ...state, expanded }
}

export function markListing(state: FileTreeState, path: string): FileTreeState {
  const status = new Map(state.status)
  status.set(path, 'loading')
  return { ...state, status }
}

/** Record a folder's listing; `null` (unreadable) marks it as failed. */
export function applyListing(
  state: FileTreeState,
  path: string,
  listing: FolderListing | null,
): FileTreeState {
  const status = new Map(state.status)
  const children = new Map(state.children)
  const truncated = new Set(state.truncated)
  if (!listing) {
    status.set(path, 'error')
    children.delete(path)
    truncated.delete(path)
    return { ...state, status, children, truncated }
  }
  status.set(path, 'ready')
  children.set(
    path,
    listing.entries.map(entry => ({ name: entry.name, kind: entryKind(entry) })),
  )
  if (listing.truncated) truncated.add(path)
  else truncated.delete(path)
  return { ...state, status, children, truncated }
}

/** Forget a folder's failed listing so it is listed again. */
export function retryListing(state: FileTreeState, path: string): FileTreeState {
  if (state.status.get(path) !== 'error') return state
  const status = new Map(state.status)
  status.delete(path)
  return { ...state, status }
}

/**
 * Expand every folder from the root holding `path` down to `path`'s parent.
 * `needsLoad` lists those folders that have no listing yet and none in flight.
 * A path under no root leaves the tree as it is.
 */
export function revealPath(
  state: FileTreeState,
  path: string,
): { state: FileTreeState; needsLoad: string[] } {
  const key = normalizePathKey(path)
  const root = state.roots.find(each => {
    const rootKey = normalizePathKey(each).replace(/\/+$/, '')
    return key.startsWith(`${rootKey}/`)
  })
  if (root === undefined) return { state, needsLoad: [] }
  const segments = path
    .slice(root.length)
    .split(/[\\/]+/)
    .filter(Boolean)
  const ancestors = [root]
  for (const segment of segments.slice(0, -1)) {
    ancestors.push(childPath(ancestors[ancestors.length - 1], segment))
  }
  const expanded = new Set(state.expanded)
  for (const each of ancestors) expanded.add(each)
  return {
    state: { ...state, expanded },
    needsLoad: ancestors.filter(each => !state.status.has(each)),
  }
}

/**
 * Where a tree key takes the focus from row `index`: the new focused index
 * and, for ← on an open folder or → on a closed one, the folder to toggle
 * instead of moving. Only focusable rows are landed on.
 */
export function moveFocus(
  rows: readonly TreeRow[],
  index: number,
  key: TreeKey,
): { index: number; toggle?: string } {
  const focusable = (i: number) => i >= 0 && i < rows.length && isFocusableRow(rows[i])
  const step = (from: number, delta: 1 | -1) => {
    for (let i = from + delta; i >= 0 && i < rows.length; i += delta) if (focusable(i)) return i
    return from
  }
  const row = rows[index]
  if (!row) return { index }
  switch (key) {
    case 'ArrowDown':
      return { index: step(index, 1) }
    case 'ArrowUp':
      return { index: step(index, -1) }
    case 'Home':
      return { index: focusable(0) ? 0 : step(0, 1) }
    case 'End': {
      const last = rows.length - 1
      return { index: focusable(last) ? last : step(last, -1) }
    }
    case 'ArrowRight': {
      if (!isNodeRow(row) || row.kind !== 'dir') return { index }
      if (!row.expanded) return { index, toggle: row.path }
      const next = rows[index + 1]
      return next && next.depth > row.depth && focusable(index + 1) ? { index: index + 1 } : { index }
    }
    case 'ArrowLeft': {
      if (isNodeRow(row) && row.kind === 'dir' && row.expanded) return { index, toggle: row.path }
      for (let i = index - 1; i >= 0; i--) {
        if (rows[i].depth < row.depth && isNodeRow(rows[i])) return { index: i }
      }
      return { index }
    }
  }
}
