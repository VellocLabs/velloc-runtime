/**
 * Recent search queries, part of the runtime-owned workspace index (mirrored by `workspaceStore.ts`).
 * Unlike `transcriptSearchStore`, history survives a restart.
 */
import { getWorkspaceStore } from './workspaceStore'

export function readSearchHistory(): string[] {
  return [...getWorkspaceStore().getState().searchHistory]
}

/**
 * Records a query as the most recent, de-duplicated case-insensitively so
 * refining a search ("chro" → "chrom" → "chromium") doesn't bury the
 * history under its own prefixes... those still land as separate entries,
 * which is why this is called on SELECTION, not on every keystroke.
 */
export function rememberSearchQuery(query: string): string[] {
  return [...getWorkspaceStore().rememberSearchQuery(query).searchHistory]
}

export function clearSearchHistory(): string[] {
  return [...getWorkspaceStore().clearSearchHistory().searchHistory]
}
