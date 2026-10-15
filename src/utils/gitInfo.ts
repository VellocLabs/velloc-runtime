/**
 * Canonical git-root resolver: inside a worktree, returns the MAIN repo's
 * working tree, so worktrees of one repo share a memory directory.
 */

import { walkParentDirs } from './walkParentDirs'
import type { RuntimeFs } from './fs/runtimeFs'

function trimTrailingSeparators(value: string): string {
  return value.replace(/[\\/]+$/, '')
}

function detectSeparator(value: string): '/' | '\\' {
  return value.includes('\\') && !value.includes('/') ? '\\' : '/'
}

function joinPath(base: string, ...parts: string[]): string {
  const sep = detectSeparator(base)
  let result = trimTrailingSeparators(base)
  for (const part of parts) {
    const trimmed = part.replace(/^[\\/]+/, '').replace(/[\\/]+$/, '')
    if (!trimmed) continue
    result = result ? `${result}${sep}${trimmed}` : trimmed
  }
  return result
}

function isAbsolutePath(value: string): boolean {
  if (value.length === 0) return false
  if (value[0] === '/' || value[0] === '\\') return true
  return /^[A-Za-z]:[\\/]/.test(value)
}

/**
 * Parse a worktree's `.git` file (`gitdir: <main>/.git/worktrees/<name>`) into
 * the main repo's `.git` directory; `undefined` if it is not a worktree gitdir.
 */
function parseGitDirFile(
  fileBody: string,
  worktreeDotGitPath: string,
): string | undefined {
  const match = fileBody.trim().match(/^gitdir:\s*(.+)$/m)
  if (!match) return undefined
  let target = match[1]!.trim()
  // Resolve relative `gitdir:` against the .git file's directory.
  if (!isAbsolutePath(target)) {
    const baseDir = worktreeDotGitPath.replace(/[\\/][^\\/]+$/, '')
    target = joinPath(baseDir, target)
  }
  // Walk back to the main `.git` by stripping `/worktrees/<name>` if
  // present. If it's not a worktree pointer, return the gitdir as-is
  // so the caller can derive `<main>/.git` → `<main>`.
  const worktreesIdx = target
    .replace(/\\/g, '/')
    .lastIndexOf('/worktrees/')
  if (worktreesIdx === -1) return target
  // Convert back to native separators using the original target's slash style.
  const usesBackslash = target.includes('\\') && !target.includes('/')
  const norm = target.replace(/\\/g, '/')
  const truncated = norm.slice(0, worktreesIdx)
  return usesBackslash ? truncated.replace(/\//g, '\\') : truncated
}

export type FindCanonicalGitRootOptions = {
  /** Stop walking at the home directory. */
  homeDir?: string
}

/**
 * The canonical git working tree for `cwd`, following a worktree's `.git` file
 * to the main repo. `undefined` when no `.git` is found; read errors count as
 * "not a repo".
 */
export async function mainRepoRoot(
  cwd: string,
  fs: RuntimeFs,
  options: FindCanonicalGitRootOptions = {},
): Promise<string | undefined> {
  for (const entry of walkParentDirs(cwd, { homeDir: options.homeDir })) {
    const dotGit = joinPath(entry.dir, '.git')
    let stat
    try {
      stat = await fs.stat(dotGit)
    } catch {
      if (entry.isRoot || entry.isHome) return undefined
      continue
    }

    if (stat.isDirectory()) {
      return entry.dir
    }

    if (stat.isFile()) {
      let body: string
      try {
        body = await fs.readFile(dotGit, { encoding: 'utf-8' })
      } catch {
        return undefined
      }
      const mainGitDir = parseGitDirFile(body, dotGit)
      if (!mainGitDir) return undefined
      // mainGitDir is the path to the main repo's `.git` dir; its
      // parent is the canonical working tree.
      return mainGitDir.replace(/[\\/]\.git[\\/]?$/, '')
    }

    if (entry.isRoot || entry.isHome) return undefined
  }
  return undefined
}
