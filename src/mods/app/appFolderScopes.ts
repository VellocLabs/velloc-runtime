/**
 * The folders an app's background module may reach beyond the app's own
 * (F-40): declared in the manifest under `app.background.fs` as `~/`-relative
 * folders, read or write, consented to with the plugin's grant, and expanded
 * under the person's home when the module starts.
 *
 * Security: a folder is a path under the home directory and never the home
 * itself, a hidden folder (`.ssh`, `.velloc`) or a `..`; the declared set is
 * part of the plugin's grant, so a version that asks for more waits for a new
 * consent. Pure.
 */

import { joinRuntimePath } from '../../utils/runtimePaths'

/** `~/`-relative folders, sorted and unique; a folder in `write` is not also in `read`. */
export type FolderScopes = {
  read: string[]
  write: string[]
}

/** Folders a plugin may declare across its apps. */
export const APP_FOLDER_SCOPES_MAX = 8
export const APP_FOLDER_MAX_LENGTH = 200

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const sortedUnique = (values: readonly string[]): string[] => [...new Set(values)].sort()

/** Why `value` is not a folder a background module may declare, or null. */
export function checkScopeFolder(value: unknown): string | null {
  if (typeof value !== 'string') return 'a folder is a string'
  if (value.length > APP_FOLDER_MAX_LENGTH) return `"${value.slice(0, 40)}…" is longer than ${APP_FOLDER_MAX_LENGTH} characters`
  if (!value.startsWith('~/')) return `"${value}" does not start with "~/"`
  if (value.includes('\\')) return `"${value}" holds a backslash; use "/"`
  const segments = value.slice(2).replace(/\/+$/, '').split('/')
  if (segments.length === 0 || segments[0] === '') return `"${value}" is the whole home directory; name a folder under it`
  for (const segment of segments) {
    if (segment === '') return `"${value}" has an empty segment`
    if (segment === '.' || segment === '..') return `"${value}" holds "${segment}"`
    if (segment.startsWith('.')) return `"${value}" names a hidden folder, which a plugin may not declare`
  }
  return null
}

/** The folder as declared, its trailing slashes dropped. */
export function normalizeScopeFolder(folder: string): string {
  return folder.replace(/\/+$/, '')
}

/**
 * The scopes of a manifest's `fs` value — `{ read?: string[], write?: string[] }`
 * — or the reason it is not one.
 */
export function readFolderScopes(value: unknown): FolderScopes | { error: string } {
  if (!isRecord(value)) return { error: 'expected { read?: string[], write?: string[] }' }
  const lists: Record<'read' | 'write', string[]> = { read: [], write: [] }
  for (const access of ['read', 'write'] as const) {
    const list = value[access]
    if (list === undefined) continue
    if (!Array.isArray(list)) return { error: `${access}: expected an array of folders` }
    for (const folder of list) {
      const reason = checkScopeFolder(folder)
      if (reason) return { error: `${access}: ${reason}` }
      lists[access].push(normalizeScopeFolder(folder as string))
    }
  }
  const write = sortedUnique(lists.write)
  const read = sortedUnique(lists.read).filter(folder => !write.includes(folder))
  if (read.length + write.length > APP_FOLDER_SCOPES_MAX) return { error: `at most ${APP_FOLDER_SCOPES_MAX} folders` }
  return { read, write }
}

export function mergeFolderScopes(a: FolderScopes | undefined, b: FolderScopes | undefined): FolderScopes | undefined {
  if (!a) return b
  if (!b) return a
  const write = sortedUnique([...a.write, ...b.write])
  const read = sortedUnique([...a.read, ...b.read]).filter(folder => !write.includes(folder))
  return { read, write }
}

/**
 * The folders a plugin's manifest declares across its app templates, merged;
 * undefined when none. Reads a parsed plugin.json
 * (`templates.<key>.app.background.fs`) and a checked manifest
 * (`templates.<key>.app.backgroundFs`) alike. A value that is not a scopes
 * object counts for nothing here — the manifest check reports it.
 */
export function folderScopesOf(manifest: unknown): FolderScopes | undefined {
  const templates = isRecord(manifest) && isRecord(manifest.templates) ? manifest.templates : undefined
  if (!templates) return undefined
  let merged: FolderScopes | undefined
  for (const decl of Object.values(templates)) {
    const app = isRecord(decl) && isRecord(decl.app) ? decl.app : undefined
    const declared = isRecord(app?.background) ? app.background.fs : app?.backgroundFs
    if (declared === undefined) continue
    const scopes = readFolderScopes(declared)
    if ('error' in scopes) continue
    if (scopes.read.length === 0 && scopes.write.length === 0) continue
    merged = mergeFolderScopes(merged, scopes)
  }
  return merged
}

/** Whether `approved` lets a module reach every folder of `declared`, as declared. */
export function coversFolderScopes(approved: FolderScopes | undefined, declared: FolderScopes): boolean {
  return addedFolderScopes(approved, declared) === undefined
}

/** What `next` asks for beyond `approved`: a folder not approved, or a read-only one asked for writing. */
export function addedFolderScopes(approved: FolderScopes | undefined, next: FolderScopes | undefined): FolderScopes | undefined {
  if (!next) return undefined
  const reads = new Set(approved?.read ?? [])
  const writes = new Set(approved?.write ?? [])
  const read = next.read.filter(folder => !reads.has(folder) && !writes.has(folder))
  const write = next.write.filter(folder => !writes.has(folder))
  if (read.length === 0 && write.length === 0) return undefined
  return { read, write }
}

/** The folder's absolute path under `homeDir`. */
export function expandScopeFolder(folder: string, homeDir: string): string {
  return joinRuntimePath(homeDir, ...normalizeScopeFolder(folder).slice(2).split('/'))
}
