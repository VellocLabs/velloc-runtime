/**
 * Security: each top-level session's project root, for the usage log's
 * `project` column. A lookup beside the request, not a field on it, so no
 * provider sees the path. Stored in the sidebar's form (`projectKeyOf`), so
 * a sidebar project names the same rows. No entry = no project.
 */

import { normalizeProjectPath } from '../../utils/workspaceState'

const projects = new Map<string, string>()

/** A project root as the sidebar groups sessions by it. */
export function projectKeyOf(projectRoot: string): string {
  return normalizeProjectPath(projectRoot)
}

/** Record the project of `sessionId`; the returned function drops it again,
 *  and only while it is still this entry. */
export function registerSessionProject(sessionId: string, projectRoot: string): () => void {
  const key = projectKeyOf(projectRoot)
  if (!key) return () => {}
  projects.set(sessionId, key)
  return () => {
    if (projects.get(sessionId) === key) projects.delete(sessionId)
  }
}

export function sessionProjectOf(sessionId: string | undefined): string | undefined {
  return sessionId === undefined ? undefined : projects.get(sessionId)
}
