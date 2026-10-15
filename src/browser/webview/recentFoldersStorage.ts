/**
 * Recent project folders: a newest-first MRU list (capped at {@link MAX_RECENT_FOLDERS}) in the
 * runtime-owned workspace index, mirrored by `workspaceStore.ts`.
 */
import { MAX_RECENT_FOLDERS, type RecentFolder } from '../../utils/workspaceState'
import { getWorkspaceStore } from './workspaceStore'

export { MAX_RECENT_FOLDERS, type RecentFolder }

export function readRecentFolders(): RecentFolder[] {
  return [...getWorkspaceStore().getState().recentFolders]
}

/**
 * Record a bind: the folder moves to the front with a refreshed timestamp
 * (deduped by exact trimmed path). A blank path changes nothing. Returns the
 * new list so callers can update UI state without a re-read.
 */
export function addRecentFolder(path: string): RecentFolder[] {
  return [...getWorkspaceStore().addRecentFolder(path).recentFolders]
}
