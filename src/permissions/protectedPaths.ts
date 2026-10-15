/**
 * Security: write-target guard. Reasons for a bypass-immune approval:
 * 'suspicious-path' (Windows aliasing shapes), 'sensitive-path' (VCS / editor /
 * agent config, shell start-up files), 'outside-workspace' (a bound session).
 * Pure strings: no fs, no symlink resolution.
 */

import { RUNTIME_DIR_NAME } from '../branding/runtimeDir'
import {
  EDIT_TOOL_ID,
  WRITE_TOOL_ID,
} from '../prompting/fileToolNames'
import { relativeRuntimePath, resolveRuntimePath } from '../utils/runtimePaths'
import { extractFilePath } from './filePathRuleMatching'

export type PathGuardReason = 'sensitive-path' | 'outside-workspace' | 'suspicious-path'

export type PathGuardContext = {
  /** Base for resolving a relative target. */
  cwd: string
  /** Workspace boundary base; absent or sandboxed → boundary not enforced. */
  projectRoot?: string
  /** Keys are additional boundary bases. */
  extraWorkspaceRoots?: Map<string, unknown>
  /** An allow rule with a rule string matched this call. */
  hasExplicitAllowRule?: boolean
  /** The session's auto-memory directory; writes inside it are always fine. */
  memoryDir?: string
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

const GUARDED_TOOLS: ReadonlySet<string> = new Set([
  EDIT_TOOL_ID,
  WRITE_TOOL_ID,
  'NotebookEdit',
])

const RUNTIME_DIR = RUNTIME_DIR_NAME.toLowerCase()

/** Directory names guarded wherever they appear in a path. */
const GUARDED_DIR_NAMES: ReadonlySet<string> = new Set([
  '.git',
  '.vscode',
  '.idea',
  '.claude',
  RUNTIME_DIR,
])

/** File names guarded wherever they sit. */
const GUARDED_FILE_NAMES: ReadonlySet<string> = new Set([
  // Shell startup scripts: run on every new shell.
  '.profile', '.bashrc', '.bash_profile', '.zshrc', '.zprofile',
  // Git configuration.
  '.gitmodules', '.gitconfig',
  // Agent and search-tool configuration.
  '.mcp.json', '.claude.json', '.ripgreprc',
])

/** Runtime-dir children that hold session state the agent may write. */
const RUNTIME_STATE_SUBDIRS: ReadonlySet<string> = new Set([
  'plans',
  'memory',
  'sessions',
  'worktrees',
  'projects',
  'working',
  'shared-workspace',
])

const RUNTIME_SETTINGS_FILES: ReadonlySet<string> = new Set([
  'settings.json',
  'settings.local.json',
])

const SANDBOX_SEGMENT = 'shared-workspace'

const DEVICE_SUFFIX = /\.(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function segmentsOf(path: string): string[] {
  return path.split(/[/\\]+/).filter(s => s.length > 0)
}

function hostLooksWindows(): boolean {
  const ua =
    typeof navigator !== 'undefined' && typeof navigator.userAgent === 'string'
      ? navigator.userAgent
      : ''
  return /Windows|Win32|Win64|WOW64|WSL/i.test(ua)
}

function hasAliasingShape(path: string, windowsHost: boolean): boolean {
  if (windowsHost && path.indexOf(':', 2) !== -1) return true
  if (/~\d/.test(path)) return true
  if (/^(\\\\[?.]\\|\/\/[?.]\/)/.test(path)) return true
  if (/[.\s]$/.test(path)) return true
  if (DEVICE_SUFFIX.test(path)) return true
  if (segmentsOf(path).some(s => /^\.{3,}$/.test(s))) return true
  return false
}

/** True when `target` is `base` or below it (same root required). */
function isWithin(base: string, target: string): boolean {
  const rel = relativeRuntimePath(base, target)
  if (rel === '.') return true
  if (rel === target) {
    // Different root: relativeRuntimePath hands the target back unchanged.
    return false
  }
  const first = segmentsOf(rel)[0]
  return first !== '..'
}

function touchesGuardedName(resolved: string): boolean {
  const segs = segmentsOf(resolved).map(s => s.toLowerCase())
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]
    if (!GUARDED_DIR_NAMES.has(seg)) continue
    if (seg === RUNTIME_DIR && RUNTIME_STATE_SUBDIRS.has(segs[i + 1] ?? '')) {
      continue
    }
    return true
  }
  const leaf = segs[segs.length - 1] ?? ''
  if (GUARDED_FILE_NAMES.has(leaf)) return true
  if (RUNTIME_SETTINGS_FILES.has(leaf) && segs.includes(RUNTIME_DIR)) return true
  return false
}

function boundaryBases(ctx: PathGuardContext): string[] | null {
  const root = ctx.projectRoot
  if (!root) return null
  if (segmentsOf(root).includes(SANDBOX_SEGMENT)) return null
  const bases = [root, ctx.cwd, ...(ctx.extraWorkspaceRoots?.keys() ?? [])]
  return bases.filter(b => typeof b === 'string' && b.length > 0)
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function evaluateWriteTarget(
  toolName: string,
  input: Record<string, unknown>,
  ctx: PathGuardContext,
): PathGuardReason | null {
  if (ctx.hasExplicitAllowRule) return null
  if (!GUARDED_TOOLS.has(toolName)) return null

  const raw = extractFilePath(input)
  if (!raw) return null
  const resolved = resolveRuntimePath(ctx.cwd, raw)

  if (ctx.memoryDir && isWithin(ctx.memoryDir, resolved)) return null

  const windowsHost = hostLooksWindows()
  if (hasAliasingShape(raw, windowsHost) || hasAliasingShape(resolved, windowsHost)) {
    return 'suspicious-path'
  }

  if (touchesGuardedName(resolved)) return 'sensitive-path'

  const bases = boundaryBases(ctx)
  if (bases && !bases.some(b => isWithin(b, resolved))) return 'outside-workspace'

  return null
}

/** One-line description used for the approval banner and ask reason. */
export function describePathGuardAsk(
  toolName: string,
  reason: PathGuardReason,
  target: string,
): string {
  switch (reason) {
    case 'sensitive-path':
      return `${toolName} a protected path (${target})`
    case 'suspicious-path':
      return `${toolName} a path with a suspicious pattern (${target})`
    case 'outside-workspace':
      return `${toolName} a file outside the workspace (${target})`
  }
}
