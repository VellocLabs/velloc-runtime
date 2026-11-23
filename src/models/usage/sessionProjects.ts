/**
 * Security: each top-level session's project root, for the usage log's
 * `project` column. A lookup beside the request, not a field on it, so no
 * provider sees the path. Stored in the sidebar's form (`projectKeyOf`), so
 * a sidebar project names the same rows. No entry = no project.
 */

import { normalizeProjectPath } from '../../utils/workspaceState'

const projects = new Map<string, { key: string }>()

/** A project root as the sidebar groups sessions by it. */
export function projectKeyOf(projectRoot: string): string {
  return normalizeProjectPath(projectRoot)
}

/** Record the project of `sessionId`; the returned function drops it again,
 *  and only while it is still this registration. */
export function registerSessionProject(sessionId: string, projectRoot: string): () => void {
  const key = projectKeyOf(projectRoot)
  if (!key) return () => {}
  const entry = { key }
  projects.set(sessionId, entry)
  return () => {
    if (projects.get(sessionId) === entry) projects.delete(sessionId)
  }
}

/** Record the project of `sessionId` for as long as `scope` lasts. A scope
 *  already ended registers nothing: it would replace a newer runtime's entry
 *  and then drop it. */
export function registerSessionProjectWhile(sessionId: string, projectRoot: string, scope: AbortSignal | undefined): void {
  if (scope?.aborted) return
  const drop = registerSessionProject(sessionId, projectRoot)
  scope?.addEventListener('abort', drop, { once: true })
}

export function sessionProjectOf(sessionId: string | undefined): string | undefined {
  return sessionId === undefined ? undefined : projects.get(sessionId)?.key
}
