/**
 * Security: guard on `search.queryTranscripts` below `full` (F-16). The host walks the given absolute
 * paths, so each target must be a runtime-written transcript
 * (`<projects root>/<project dir>/<sessionId>/transcript.jsonl`) of a session the grant names. The
 * projects root comes from `resolveHostHome`; fail closed: no home admits nothing.
 */
import { projectsHome } from '../../utils/conversationStoragePaths'
import { scopeAllows } from './CapabilityRegistry'
import { resolveHostHome } from './hostFs'
import type { ConnectionInfo, RuntimeContext } from './types'

const TRANSCRIPT_FILE_NAME = 'transcript.jsonl'

function slashes(path: string): string {
  return path.replace(/\\/g, '/')
}

/**
 * The session id a transcript target names, or `undefined` when the path is
 * not exactly `<projectsRoot>/<project>/<sessionId>/transcript.jsonl`.
 */
export function transcriptTargetSessionId(
  target: string,
  projectsRoot: string,
): string | undefined {
  const root = slashes(projectsRoot).replace(/\/+$/, '')
  const path = slashes(target)
  if (root.length === 0 || !path.startsWith(`${root}/`)) return undefined
  const rest = path.slice(root.length + 1).split('/')
  if (rest.length !== 3) return undefined
  const [project, sessionId, file] = rest as [string, string, string]
  for (const segment of [project, sessionId]) {
    if (segment === '' || segment === '.' || segment === '..' || segment.includes('\0')) {
      return undefined
    }
  }
  return file === TRANSCRIPT_FILE_NAME ? sessionId : undefined
}

/** `ActionSpec.guard` for `search.queryTranscripts`. */
export async function searchTargetsGuard(
  payload: unknown,
  conn: ConnectionInfo,
  ctx: RuntimeContext,
): Promise<boolean> {
  if (scopeAllows(conn.scope.mode, 'full')) return true
  const targets = (payload as { targets?: unknown } | null)?.targets
  if (!Array.isArray(targets)) return false
  const homeDir = await resolveHostHome(ctx).catch(() => '')
  if (!homeDir) return false
  const projectsRoot = projectsHome(homeDir)
  const sessions = conn.scope.sessions
  return targets.every(target => {
    if (typeof target !== 'string') return false
    const sessionId = transcriptTargetSessionId(target, projectsRoot)
    if (sessionId === undefined) return false
    return sessions === 'all' || sessions.includes(sessionId)
  })
}
