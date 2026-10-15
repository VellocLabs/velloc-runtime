/**
 * Security: each top-level session's working directory, for a provider mod that
 * declared `requestNeeds: ["cwd"]`. A lookup beside the request, not a field on it:
 * only a provider the person consented to may see a path. No entry = no `cwd`.
 */

const workingDirs = new Map<string, string>()

/** Record `cwd` for `sessionId`; the returned function drops it again (and
 *  only if it is still this entry, so a newer registration is not undone). */
export function registerSessionWorkingDir(sessionId: string, cwd: string): () => void {
  workingDirs.set(sessionId, cwd)
  return () => {
    if (workingDirs.get(sessionId) === cwd) workingDirs.delete(sessionId)
  }
}

export function sessionWorkingDirOf(sessionId: string | undefined): string | undefined {
  return sessionId === undefined ? undefined : workingDirs.get(sessionId)
}
