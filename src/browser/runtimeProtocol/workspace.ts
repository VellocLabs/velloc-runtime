/**
 * The `workspace` capability and topic — the user's workspace index (P-3), owned by
 * the runtime; the topic carries the whole state and each action answers it too.
 * Security: bringing a NEW host path in (add project) is `full`; recording a
 * recent or last folder is `control`, but below `full` the folder must be a project
 * the runtime already knows (`runtimeHub/knownProjects.ts`). Forgetting a project is
 * `manager`; the search history is `control`; reading is `observe` via the topic.
 */
import type { ScopeMode } from './frames'

export const WORKSPACE_CAPABILITY = 'workspace'

export const WORKSPACE_ACTION_SCOPES = {
  addProject: 'full',
  removeProject: 'manager',
  addRecentFolder: 'control',
  setLastFolderForType: 'control',
  rememberSearchQuery: 'control',
  clearSearchHistory: 'control',
} as const satisfies Record<string, ScopeMode>

export type WorkspaceAction = keyof typeof WORKSPACE_ACTION_SCOPES

/** `evt.type` of every event on the `workspace` topic; the payload is the whole `WorkspaceState`. */
export const WORKSPACE_STATE_EVENT = 'state'

export type AddedProject = { path: string; addedAt: number }
export type RecentFolder = { path: string; name: string; lastUsedAt: number }

export type WorkspaceState = {
  readonly projects: readonly AddedProject[]
  readonly recentFolders: readonly RecentFolder[]
  readonly lastFolderByType: Readonly<Record<string, string>>
  readonly searchHistory: readonly string[]
}

export type WorkspacePathPayload = { path: string }
export type WorkspaceLastFolderPayload = { templateType: string; path: string }
export type WorkspaceSearchQueryPayload = { query: string }
