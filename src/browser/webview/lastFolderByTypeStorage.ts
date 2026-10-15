/**
 * Per-template-type "last bound folder", so a new session defaults to the folder its own type last
 * used. Part of the runtime-owned workspace index; the runtime decides inheritance at `session.open`, the
 * page only records a bind.
 */

import { getWorkspaceStore } from './workspaceStore'

/**
 * The folder a session of `templateType` last bound, or `undefined` if none.
 * The default for a NEW session of that type (when the session itself has no
 * persisted folder). Keyed by type, so it never returns another type's folder.
 */
export function readLastFolderForType(
  templateType: string,
): string | undefined {
  return getWorkspaceStore().getState().lastFolderByType[templateType]
}

/**
 * Record the folder a session of `templateType` just bound. Overwrites the prior
 * entry for that type only; other types are untouched.
 */
export function writeLastFolderForType(
  templateType: string,
  path: string,
): void {
  getWorkspaceStore().setLastFolderForType(templateType, path)
}
