import type { ToolCallContext } from '../toolkit/toolCallContext'
import { dirnameRuntimePath, joinRuntimePath, sanitizePathSegment } from './runtimePaths'
import {
  fsForContext,
  processFs,
  type RuntimeFs,
} from './fs/runtimeFs'
import { RUNTIME_DIR_NAME } from '../branding/runtimeDir'

const DEFAULT_PLAN_DIR = `${RUNTIME_DIR_NAME}/plans`

/**
 * Plan-file path for an explicit cwd + sessionId — the context-free core of
 * `planDocPath`, so callers without a `ToolUseContext` (e.g. the fork
 * carry-over copy) can resolve a session's plan path.
 */
export function getPlanFilePathForSession(
  cwd: string,
  sessionId: string,
): string {
  const slug = sanitizePathSegment(sessionId)
  return joinRuntimePath(joinRuntimePath(cwd, DEFAULT_PLAN_DIR), `${slug}.md`)
}

export function planDocPath(context: ToolCallContext): string {
  return getPlanFilePathForSession(
    context.options.cwd,
    context.options.sessionId,
  )
}

/**
 * Copy a source session's plan file to a fork's plan path under the same cwd
 * (content copy, never an alias). True iff copied; false when the source has no
 * plan or the destination already has one (never clobbers).
 */
export async function copyPlanFileForFork(
  cwd: string,
  fromSessionId: string,
  toSessionId: string,
  /** The forked session's own fs; omitted → the realm-global slot (tests). */
  fs: RuntimeFs = processFs(),
): Promise<boolean> {
  if (fromSessionId === toSessionId) {
    return false
  }
  const srcPath = getPlanFilePathForSession(cwd, fromSessionId)
  const dstPath = getPlanFilePathForSession(cwd, toSessionId)
  if (srcPath === dstPath) {
    return false
  }
  let content: string
  try {
    content = await fs.readFile(srcPath, { encoding: 'utf-8' })
  } catch {
    return false // no source plan — nothing to carry over
  }
  try {
    await fs.stat(dstPath)
    return false // destination already has a plan — never clobber
  } catch {
    // destination absent — proceed
  }
  await fs.mkdir(dirnameRuntimePath(dstPath), { mode: 0o755 }).catch(() => {})
  await fs.writeFile(dstPath, content, { encoding: 'utf-8' })
  return true
}

export async function ensurePlanDirectoryExists(
  context: ToolCallContext,
): Promise<void> {
  const fs = fsForContext(context)
  await fs.mkdir(dirnameRuntimePath(planDocPath(context)), {
    mode: 0o755,
  }).catch(() => {})
}

export async function planFileExists(context: ToolCallContext): Promise<boolean> {
  const fs = fsForContext(context)
  try {
    await fs.stat(planDocPath(context))
    return true
  } catch {
    return false
  }
}
