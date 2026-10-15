/**
 * The user's workspace index (sidebar projects, recent folders, last folder per
 * template type, recent searches) as pure data and transitions, applied by the
 * runtime (authoritative) and the page mirror (optimistic). Every reader
 * sanitises whatever shape comes in rather than rejecting it.
 */
import type { AddedProject, RecentFolder, WorkspaceState } from '../browser/runtimeProtocol/workspace'
import { basenameRuntimePath } from './runtimePaths'

export type { AddedProject, RecentFolder, WorkspaceState }

/** Hard cap on added projects — older additions fall off the tail. */
export const MAX_ADDED_PROJECTS = 50
/** Hard cap on the recent-folders MRU. */
export const MAX_RECENT_FOLDERS = 15
/** Hard cap on remembered search queries. */
export const MAX_SEARCH_HISTORY = 12

export const EMPTY_WORKSPACE_STATE: WorkspaceState = Object.freeze({
  projects: [],
  recentFolders: [],
  lastFolderByType: {},
  searchHistory: [],
})

/**
 * A project's identity: trimmed, no trailing separator. Case is preserved on
 * purpose (the on-disk project dir name is case-sensitive). A tree node's path
 * is keyed the same way, so a delete passed back from the tree always matches.
 */
export function normalizeProjectPath(path: string): string {
  return path.trim().replace(/[\\/]+$/, '')
}

type Dict = Record<string, unknown>
const isDict = (value: unknown): value is Dict =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export function sanitizeProjects(value: unknown): AddedProject[] {
  if (!Array.isArray(value)) return []
  const out: AddedProject[] = []
  for (const entry of value) {
    if (!isDict(entry) || typeof entry.path !== 'string') continue
    const path = normalizeProjectPath(entry.path)
    if (!path || out.some(existing => existing.path === path)) continue
    out.push({ path, addedAt: typeof entry.addedAt === 'number' ? entry.addedAt : 0 })
  }
  return out.slice(0, MAX_ADDED_PROJECTS)
}

export function sanitizeRecentFolders(value: unknown): RecentFolder[] {
  if (!Array.isArray(value)) return []
  const out: RecentFolder[] = []
  for (const entry of value) {
    if (!isDict(entry) || typeof entry.path !== 'string' || entry.path.length === 0) continue
    if (out.some(existing => existing.path === entry.path)) continue
    out.push({
      path: entry.path,
      // Re-derived when absent so an older / hand-edited entry still renders.
      name: typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : basenameRuntimePath(entry.path),
      lastUsedAt: typeof entry.lastUsedAt === 'number' ? entry.lastUsedAt : 0,
    })
  }
  return out.slice(0, MAX_RECENT_FOLDERS)
}

export function sanitizeLastFolderByType(value: unknown): Record<string, string> {
  if (!isDict(value)) return {}
  const out: Record<string, string> = {}
  for (const [type, path] of Object.entries(value)) {
    if (type.length > 0 && typeof path === 'string' && path.length > 0) out[type] = path
  }
  return out
}

export function sanitizeSearchHistory(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const trimmed = entry.trim()
    if (trimmed && !out.some(existing => existing.toLowerCase() === trimmed.toLowerCase())) out.push(trimmed)
  }
  return out.slice(0, MAX_SEARCH_HISTORY)
}

/** Any value → a valid state; unknown keys are dropped. */
export function sanitizeWorkspaceState(value: unknown): WorkspaceState {
  const dict = isDict(value) ? value : {}
  return {
    projects: sanitizeProjects(dict.projects),
    recentFolders: sanitizeRecentFolders(dict.recentFolders),
    lastFolderByType: sanitizeLastFolderByType(dict.lastFolderByType),
    searchHistory: sanitizeSearchHistory(dict.searchHistory),
  }
}

// ---- transitions ------------------------------------------------------------

/** Add (or refresh) a project: deduped by normalised path, moved to the front. A blank path changes nothing. */
export function withProjectAdded(state: WorkspaceState, path: string, now: number): WorkspaceState {
  const key = normalizeProjectPath(path)
  if (!key) return state
  const projects = [{ path: key, addedAt: now }, ...state.projects.filter(entry => entry.path !== key)]
  return { ...state, projects: projects.slice(0, MAX_ADDED_PROJECTS) }
}

export function withProjectRemoved(state: WorkspaceState, path: string): WorkspaceState {
  const key = normalizeProjectPath(path)
  return { ...state, projects: state.projects.filter(entry => entry.path !== key) }
}

/** Promote a folder in the MRU (deduped by exact trimmed path). A blank path changes nothing. */
export function withRecentFolder(state: WorkspaceState, path: string, now: number): WorkspaceState {
  const trimmed = path.trim()
  if (!trimmed) return state
  const recentFolders = [
    { path: trimmed, name: basenameRuntimePath(trimmed), lastUsedAt: now },
    ...state.recentFolders.filter(entry => entry.path !== trimmed),
  ]
  return { ...state, recentFolders: recentFolders.slice(0, MAX_RECENT_FOLDERS) }
}

/** Remember `path` as the last folder of `templateType`; other types are untouched. */
export function withLastFolderForType(state: WorkspaceState, templateType: string, path: string): WorkspaceState {
  const trimmed = path.trim()
  if (!templateType || !trimmed) return state
  return { ...state, lastFolderByType: { ...state.lastFolderByType, [templateType]: trimmed } }
}

/** Put a query at the front of the history (case-insensitive dedupe). A blank query changes nothing. */
export function withSearchQuery(state: WorkspaceState, query: string): WorkspaceState {
  const trimmed = query.trim()
  if (!trimmed) return state
  const lowered = trimmed.toLowerCase()
  const searchHistory = [trimmed, ...state.searchHistory.filter(entry => entry.toLowerCase() !== lowered)]
  return { ...state, searchHistory: searchHistory.slice(0, MAX_SEARCH_HISTORY) }
}

export function withSearchHistoryCleared(state: WorkspaceState): WorkspaceState {
  return { ...state, searchHistory: [] }
}

export function workspaceStatesEqual(a: WorkspaceState, b: WorkspaceState): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
