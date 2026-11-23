/**
 * Contract: the identity of a file as the usage log ranks it (F-27). For an
 * absolute path, `repo` is the main working tree of the repository the file
 * belongs to (a linked worktree folds into it), `worktree` is the linked
 * worktree's root or absent in the main checkout, and `path` is relative to
 * the file's own working tree. Outside any repository `repo` is absent and
 * `path` is the absolute path. Every value is in `normalizePathKey` form.
 * The nearest `.git` wins, so a nested repository and a submodule are each
 * their own repository. The walk stops at the home directory. Answers are
 * cached per directory for the resolver's life; a read error counts as no
 * `.git` there. Nothing here throws.
 */

import type { RuntimeFs } from './fs/runtimeFs'
import { normalizePathKey } from './paths'
import { getParentDir } from './walkParentDirs'

export type FileIdentity = {
  repo?: string
  worktree?: string
  path: string
}

/** The working tree a directory belongs to. */
type Tree = { top: string; repo: string; worktree?: string }

export type FileIdentityResolver = (absolutePath: string) => Promise<FileIdentity>

/** Directories a resolver remembers before it starts over. */
export const FILE_IDENTITY_CACHE_MAX = 4096

const comparable = (path: string): string => {
  const key = normalizePathKey(path).replace(/\/+$/, '')
  return /^[a-z]:$/.test(key) ? `${key}/` : key
}

const join = (dir: string, name: string): string => `${dir.replace(/[\\/]+$/, '')}/${name}`

const isAbsolute = (path: string): boolean => /^([\\/]|[A-Za-z]:[\\/])/.test(path)

/** `a/b/../c` → `a/c`, on forward slashes. */
function collapse(path: string): string {
  const out: string[] = []
  for (const part of path.split('/')) {
    if (part === '..' && out.length > 1) out.pop()
    else if (part !== '.' && (part !== '' || out.length === 0)) out.push(part)
  }
  return out.join('/')
}

const resolveFrom = (base: string, target: string): string =>
  collapse(normalizePathKey(isAbsolute(target) ? target : join(base, target)))

export function createFileIdentityResolver(fs: RuntimeFs, options: { homeDir?: string } = {}): FileIdentityResolver {
  const home = options.homeDir ? comparable(options.homeDir) : undefined
  const cache = new Map<string, Promise<Tree | null>>()

  /** The tree of a working tree whose `.git` is a file: a linked worktree, a submodule, or a separate git dir. */
  async function fromGitFile(dir: string, dotGit: string): Promise<Tree> {
    const own = comparable(dir)
    let body: string
    try {
      body = await fs.readFile(dotGit, { encoding: 'utf-8' })
    } catch {
      return { top: own, repo: own }
    }
    const target = body.match(/^gitdir:\s*(.+)$/m)?.[1]?.trim()
    if (!target) return { top: own, repo: own }
    const gitDir = resolveFrom(own, target)
    const at = gitDir.lastIndexOf('/worktrees/')
    // A submodule or a separate git dir: the directory holding `.git` is the whole working tree.
    if (at === -1) return { top: own, repo: own }
    const common = gitDir.slice(0, at)
    if (common.endsWith('/.git')) return { top: own, repo: common.slice(0, -'/.git'.length), worktree: own }
    // A worktree of a submodule: the module's config names its main working tree.
    try {
      const config = await fs.readFile(join(common, 'config'), { encoding: 'utf-8' })
      const named = config.match(/^\s*worktree\s*=\s*(.+?)\s*$/m)?.[1]
      if (named) return { top: own, repo: resolveFrom(common, named), worktree: own }
    } catch {
      // Unreadable config: the worktree stands as its own repository.
    }
    return { top: own, repo: own }
  }

  async function treeOf(dir: string): Promise<Tree | null> {
    const walked: string[] = []
    let current = dir
    let found: Promise<Tree | null> | undefined
    for (let depth = 0; depth < 64; depth += 1) {
      const key = comparable(current)
      const known = cache.get(key)
      if (known) {
        found = known
        break
      }
      walked.push(key)
      const dotGit = join(current, '.git')
      let stat: Awaited<ReturnType<RuntimeFs['stat']>> | undefined
      try {
        stat = await fs.stat(dotGit)
      } catch {
        stat = undefined
      }
      if (stat?.isDirectory()) {
        found = Promise.resolve({ top: key, repo: key })
        break
      }
      if (stat?.isFile()) {
        found = fromGitFile(current, dotGit)
        break
      }
      const parent = getParentDir(current)
      if (key === home || comparable(parent) === key) {
        found = Promise.resolve(null)
        break
      }
      current = parent
    }
    const answer = found ?? Promise.resolve(null)
    if (cache.size + walked.length > FILE_IDENTITY_CACHE_MAX) cache.clear()
    for (const key of walked) cache.set(key, answer)
    return answer
  }

  return async absolutePath => {
    const file = normalizePathKey(absolutePath)
    const tree = await treeOf(getParentDir(absolutePath))
    if (!tree || !file.startsWith(`${tree.top.replace(/\/$/, '')}/`)) return { path: file }
    return {
      repo: tree.repo,
      ...(tree.worktree !== undefined ? { worktree: tree.worktree } : {}),
      path: file.slice(tree.top.replace(/\/$/, '').length + 1),
    }
  }
}
