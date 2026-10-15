/**
 * Security: the folders a connection below `full` may name. A new host path is `full` (only the
 * desktop picker produces one); below `full` a path must match a project the runtime already knows —
 * the workspace index, or the folder of a session the connection may see (a session-limited
 * connection knows only those). The match returns the runtime's OWN spelling; separators, trailing
 * separators and Windows case are ignored; a `..` segment is never resolved, so it fails to match.
 */
import { wireError, type Scope, type WorkspaceState } from '../runtimeProtocol'

/** A session's bound folder, as the runtime holds it. */
export type SessionProjectRoot = { readonly sessionId: string; readonly projectRoot: string }

export type KnownProjectSources = {
  /** The workspace index; `null` when it could not be read (then only session folders are known). */
  readonly workspace: WorkspaceState | null
  /** The bound folder of every session the runtime holds. */
  readonly sessions: readonly SessionProjectRoot[]
}

/** Every folder a connection with this session scope may name: workspace first, then sessions. */
export function knownProjectRoots(
  sources: KnownProjectSources,
  sessionScope: Scope['sessions'],
): string[] {
  const out: string[] = []
  if (sessionScope === 'all' && sources.workspace) {
    const { projects, recentFolders, lastFolderByType } = sources.workspace
    for (const project of projects) out.push(project.path)
    for (const folder of recentFolders) out.push(folder.path)
    for (const path of Object.values(lastFolderByType)) out.push(path)
  }
  for (const session of sources.sessions) {
    if (sessionScope === 'all' || sessionScope.includes(session.sessionId)) out.push(session.projectRoot)
  }
  return out.filter(root => projectPathKey(root) !== '')
}

/** The runtime's own spelling of `requested` when it is one of `known`, else `null`. */
export function matchKnownProjectRoot(requested: string, known: Iterable<string>): string | null {
  const key = projectPathKey(requested)
  if (!key) return null
  for (const root of known) {
    if (projectPathKey(root) === key) return root
  }
  return null
}

/**
 * `requested` as the runtime spells it, or a `forbidden_scope` refusal naming
 * `route`. For the handlers that apply the rule to a connection below `full`;
 * a non-string is refused the same way (there is nothing to match).
 */
export function knownProjectRootOrRefuse(requested: unknown, known: Iterable<string>, route: string): string {
  const match = typeof requested === 'string' ? matchKnownProjectRoot(requested, known) : null
  if (match === null) {
    throw wireError(
      'forbidden_scope',
      `${route}: '${String(requested)}' is not a project this runtime knows; only scope 'full' may name a new folder`,
    )
  }
  return match
}

const WINDOWS_SHAPED = /^(?:[a-z]:[\\/]|[\\/]{2})/i

/** The comparison key of a folder path; `''` for a blank one. */
function projectPathKey(path: string): string {
  const trimmed = path.trim()
  const key = trimmed.replace(/\\/g, '/').replace(/\/+$/, '')
  // A bare POSIX root trims to nothing: keep it matchable, as itself.
  const rooted = key === '' && trimmed !== '' ? '/' : key
  return WINDOWS_SHAPED.test(trimmed) ? rooted.toLowerCase() : rooted
}
