import { READ_TOOL_ID } from '../prompting/fileToolNames'
import { RUNTIME_DIR_NAME } from '../branding/runtimeDir'
import { joinRuntimePath, relativeRuntimePath, resolveRuntimePath } from '../utils/runtimePaths'
import { extractFilePath } from './filePathRuleMatching'

// Security: a chat session never reaches the user's own files. Its file tools
// are confined to the agent's memory folder (read + write), plus read-only
// access to loaded skill roots and the session uploads dir. (F-13)

/** Session types whose file tools are confined by this gate. */
const CONFINED_TEMPLATE_TYPES: ReadonlySet<string> = new Set(['chat'])

const READ_ONLY_FILE_TOOLS: ReadonlySet<string> = new Set([READ_TOOL_ID, 'Glob', 'Grep'])
const WRITING_FILE_TOOLS: ReadonlySet<string> = new Set(['Write', 'Edit', 'NotebookEdit'])

export function isLocalAccessConfined(templateType: string | undefined): boolean {
  return templateType !== undefined && CONFINED_TEMPLATE_TYPES.has(templateType)
}

export type ConfinedRoots = {
  cwd: string
  /** Read + write. Absent: no memory folder resolved, so no writes at all. */
  memoryDir?: string
  /** Read-only: loaded skill directories. */
  skillRoots: readonly string[]
}

/** The session uploads dir (`<cwd>/<runtime dir>/uploads`), read-only in a confined session. */
export function uploadsDirOf(cwd: string): string {
  return joinRuntimePath(cwd, RUNTIME_DIR_NAME, 'uploads')
}

function isInside(target: string, root: string, cwd: string): boolean {
  const rel = relativeRuntimePath(resolveRuntimePath(cwd, root), resolveRuntimePath(cwd, target))
  if (rel === '.') return true
  if (rel === '' || rel.startsWith('..') || /^([a-zA-Z]:|[\\/])/.test(rel)) return false
  return !rel.split(/[\\/]/).includes('..')
}

/**
 * Contract: the denial message for a file tool call a confined session may not
 * make, or null when the call stays inside its roots or is not a file tool.
 * Glob / Grep without a `path` search the cwd, which is outside every root.
 */
export function confinedFileAccessDenial(
  toolName: string,
  input: Record<string, unknown>,
  roots: ConfinedRoots,
): string | null {
  const reads = READ_ONLY_FILE_TOOLS.has(toolName)
  if (!reads && !WRITING_FILE_TOOLS.has(toolName)) return null
  const target = extractFilePath(input) ?? roots.cwd
  const inMemory = roots.memoryDir !== undefined && isInside(target, roots.memoryDir, roots.cwd)
  if (inMemory) return null
  if (reads) {
    const readRoots = [...roots.skillRoots, uploadsDirOf(roots.cwd)]
    if (readRoots.some(root => isInside(target, root, roots.cwd))) return null
  }
  return `${toolName} is not available for ${target} in a chat session: chat can only use its memory folder${
    reads ? ', loaded skills and attached files' : ''
  }. Local files and commands need a Code session.`
}
