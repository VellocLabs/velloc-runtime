import { READ_TOOL_ID } from '../prompting/fileToolNames'
import { RUNTIME_DIR_NAME } from '../branding/runtimeDir'
import {
  absoluteGlobBaseDirectory,
  isAbsoluteRuntimePath,
  joinRuntimePath,
  relativeRuntimePath,
  resolveRuntimePath,
} from '../utils/runtimePaths'
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
  /** Read-only: loaded skill directories (never a plugin command's folder). */
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
 * The directory a confined file tool call reaches, or undefined when it cannot
 * be checked. Glob / Grep without a `path` search the cwd. Glob's `pattern` is
 * a second path: the host searches from an absolute pattern's static base and
 * ignores `path`, so that base is the target; a pattern with no static base or
 * with a `..` segment is refused. Grep's `glob` only filters the walk under
 * `path` and needs no check of its own.
 */
function confinedTarget(toolName: string, input: Record<string, unknown>, cwd: string): string | undefined {
  const target = extractFilePath(input) ?? cwd
  if (toolName !== 'Glob' || typeof input.pattern !== 'string') return target
  const pattern = input.pattern
  if (pattern.split(/[\\/]/).includes('..')) return undefined
  if (!isAbsoluteRuntimePath(pattern)) return target
  return absoluteGlobBaseDirectory(pattern) || undefined
}

/**
 * Contract: the denial message for a file tool call a confined session may not
 * make, or null when the call stays inside its roots or is not a file tool.
 */
export function confinedFileAccessDenial(
  toolName: string,
  input: Record<string, unknown>,
  roots: ConfinedRoots,
): string | null {
  const reads = READ_ONLY_FILE_TOOLS.has(toolName)
  if (!reads && !WRITING_FILE_TOOLS.has(toolName)) return null
  const target = confinedTarget(toolName, input, roots.cwd)
  if (target !== undefined) {
    const inMemory = roots.memoryDir !== undefined && isInside(target, roots.memoryDir, roots.cwd)
    if (inMemory) return null
    if (reads) {
      const readRoots = [...roots.skillRoots, uploadsDirOf(roots.cwd)]
      if (readRoots.some(root => isInside(target, root, roots.cwd))) return null
    }
  }
  const named = target ?? String(input.pattern)
  return `${toolName} is not available for ${named} in a chat session: chat can only use its memory folder${
    reads ? ', loaded skills and attached files' : ''
  }. Local files and commands need a Code session.`
}
