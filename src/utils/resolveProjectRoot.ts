/**
 * Resolve the project root for a session: the stable identity for memory,
 * skills and history (`bash cd` cannot move it). Without an override every
 * session shares one workspace, so later conversations see the same memory.
 * An explicit `projectRoot` override is validated (absolute, non-root, no UNC,
 * no null byte) and ignored if invalid.
 */

import type { RuntimeFs } from './fs/runtimeFs'
import { checkNotesDir } from '../memory/memoryPaths'
import {
  NEXUS_WORKSPACE_DIR_NAME,
  getNexusWorkspaceDirForType,
} from './conversationStoragePaths'

/**
 * Name of the shared default project root directory under `.velloc/`. Per-type
 * sessions get a `<type>` subdir; see `getNexusWorkspaceDirForType`.
 */
export const DEFAULT_PROJECT_ROOT_NAME = NEXUS_WORKSPACE_DIR_NAME

function trimTrailingSeparators(value: string): string {
  return value.replace(/[\\/]+$/, '')
}

function detectSeparator(value: string): '/' | '\\' {
  return value.includes('\\') && !value.includes('/') ? '\\' : '/'
}

function ensureTrailingSeparator(value: string): string {
  const trimmed = trimTrailingSeparators(value)
  if (!trimmed) return detectSeparator(value)
  return trimmed + detectSeparator(value || trimmed)
}

export type ResolveProjectRootArgs = {
  /**
   * Optional explicit override from `BrowserRuntimeOptions.projectRoot`.
   * When absent or invalid, the shared default `shared-workspace/` is used
   * instead.
   */
  projectRoot?: string
  /**
   * The user's home (`fs.userHome`). The unbound default is the home-anchored
   * `~/.velloc/shared-workspace/`; with no home only a valid override resolves.
   */
  homeDir?: string
  /**
   * Per-session template type. Without a `projectRoot` override, a per-type-shared
   * type (`isPerTypeSharedTemplateType`) defaults to
   * `~/.velloc/shared-workspace/<type>/`; others keep the bare workspace.
   */
  templateType?: string
  /** Filesystem adapter used to create the directory. */
  fs: RuntimeFs
}

/**
 * Resolve the project-root directory and `mkdir -p` it: a valid `projectRoot`
 * override, else the shared default under the user's home. Returns the path
 * with exactly one trailing separator. Throws when there is neither: the
 * host's working directory is the browser's own folder, not a workspace.
 * `mkdir` failures are swallowed; writers surface real errors later.
 */
export async function resolveProjectRoot(
  args: ResolveProjectRootArgs,
): Promise<string> {
  const override = checkNotesDir(args.projectRoot, { expandTilde: false })
  const resolved =
    override ??
    (args.homeDir
      ? ensureTrailingSeparator(getNexusWorkspaceDirForType(args.homeDir, args.templateType))
      : undefined)
  if (!resolved) {
    throw new Error(
      'resolveProjectRoot: no project folder and no user home; refusing to place the shared workspace',
    )
  }

  try {
    await args.fs.mkdir(trimTrailingSeparators(resolved))
  } catch {
    // Same pattern as `ensureMemoryDirExists`: bootstrap should not
    // fail just because the directory could not be created. The real
    // failure (EACCES / EPERM / EROFS) surfaces at the next read.
  }

  return resolved
}

/**
 * True when {@link resolveProjectRoot} would fall back to the shared sandbox
 * (no usable override), using the same gate. Pure and synchronous.
 */
export function projectRootIsSandbox(
  projectRoot: string | undefined,
): boolean {
  return checkNotesDir(projectRoot, { expandTilde: false }) === undefined
}

// Session path-state accessors, parameterized by the session's projectRoot: the
// original cwd is always projectRoot, and the session project dir is always null.

/**
 * The session's storage/identity anchor: it does not follow `bash cd`, and
 * is always identical to `projectRoot` — pass the session's
 * `QueryEngineConfig.projectRoot`.
 */
export function launchDir(projectRoot: string): string {
  return projectRoot
}

/**
 * The per-session override for the transcript folder. Nexus stores every
 * transcript under one flat `sessionStoragePath` keyed by `sessionId`, so
 * there is no per-session project routing — this is always `null`.
 */
export function sessionProjectRoute(): null {
  return null
}
