/**
 * Contract: the identity of a file as the usage log ranks it (F-27). For an
 * absolute path, `repo` is the main working tree of the repository the file
 * belongs to (a linked worktree folds into it), `worktree` is the linked
 * worktree's root or absent in the main checkout, and `path` is relative to
 * the file's own working tree. Outside any repository `repo` is absent and
 * `path` is the absolute path. Every value is in `normalizePathKey` form.
 * The nearest `.git` wins, so a nested repository and a submodule are each
 * their own repository. The walk stops at the home directory. Answers are
 * cached per directory for the resolver's life, so a repository created or
 * removed meanwhile is seen only by a new resolver. A `.git` that cannot be
 * stat'ed counts as none; a `.git` file or config that cannot be read leaves
 * its directory as its own repository. Nothing here throws.
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

/** `\\?\C:\x` → `C:\x` and `\\?\UNC\host\share` → `\\host\share`, so a long-path spelling keys like the plain one. */
function withoutLongPrefix(path: string): string {
  const prefix = path.match(/^[\\/]{2}\?[\\/](UNC[\\/])?/i)
  if (!prefix) return path
  return prefix[1] ? `//${path.slice(prefix[0].length)}` : path.slice(prefix[0].length)
}

const keyOf = (path: string): string => normalizePathKey(withoutLongPrefix(path))

const comparable = (path: string): string => {
  const key = keyOf(path).replace(/\/+$/, '')
  return /^[a-z]:$/.test(key) ? `${key}/` : key
}

/** Windows paths compare without case for the home stop, so a differently cased spelling never walks above home. */
const foldCase = (key: string): string => (/^([a-z]:|\/\/)/.test(key) ? key.toLowerCase() : key)

const isShareRoot = (key: string): boolean => /^\/\/[^/]+(\/[^/]+)?$/.test(key)

const join = (dir: string, name: string): string => `${dir.replace(/[\\/]+$/, '')}/${name}`

const isAbsolute = (path: string): boolean => /^([\\/]|[A-Za-z]:[\\/])/.test(path)

/** `a/b/../c` → `a/c`, on forward slashes; a leading `//` (a UNC share) is kept. */
function collapse(path: string): string {
  const out: string[] = []
  for (const part of path.split('/')) {
    if (part === '..' && out.length > 1) out.pop()
    else if (part !== '.' && (part !== '' || out.length === 0)) out.push(part)
  }
  return (path.startsWith('//') ? '/' : '') + out.join('/')
}

const resolveFrom = (base: string, target: string): string =>
  collapse(keyOf(isAbsolute(target) ? target : join(base, target)))

const MAX_DEPTH = 64

export function createFileIdentityResolver(fs: RuntimeFs, options: { homeDir?: string } = {}): FileIdentityResolver {
  const home = options.homeDir ? foldCase(comparable(options.homeDir)) : undefined
  const cache = new Map<string, Promise<Tree | null>>()

  const readText = async (path: string): Promise<string | undefined> => {
    try {
      return await fs.readFile(path, { encoding: 'utf-8' })
    } catch {
      return undefined
    }
  }

  /** The tree of a working tree whose `.git` is a file: a linked worktree, a submodule, or a separate git dir. */
  async function fromGitFile(dir: string, dotGit: string): Promise<Tree> {
    const own = comparable(dir)
    const alone: Tree = { top: own, repo: own }
    const target = (await readText(dotGit))?.match(/^gitdir:\s*(.+)$/m)?.[1]?.trim()
    if (!target) return alone
    const gitDir = resolveFrom(own, target)
    // Only a linked worktree's git dir names a common dir; a submodule's or a separate git dir's does not.
    const commonRef = (await readText(join(gitDir, 'commondir')))?.trim()
    if (!commonRef) return alone
    const common = resolveFrom(gitDir, commonRef)
    if (common.endsWith('/.git')) return { top: own, repo: common.slice(0, -'/.git'.length), worktree: own }
    const config = await readText(join(common, 'config'))
    // A worktree of a submodule: the module's config names its main working tree.
    const named = config?.match(/^\s*worktree\s*=\s*(.+?)\s*$/m)?.[1]
    if (named) return { top: own, repo: resolveFrom(common, named), worktree: own }
    // A worktree of a bare repository: the bare directory stands for the repository.
    if (config && /^\s*bare\s*=\s*true\s*$/im.test(config)) return { top: own, repo: common, worktree: own }
    return alone
  }

  async function lookUp(dir: string, key: string, depth: number): Promise<Tree | null> {
    const dotGit = join(dir, '.git')
    let stat: Awaited<ReturnType<RuntimeFs['stat']>> | undefined
    try {
      stat = await fs.stat(dotGit)
    } catch {
      stat = undefined
    }
    if (stat?.isDirectory()) return { top: key, repo: key }
    if (stat?.isFile()) return fromGitFile(dir, dotGit)
    const parent = getParentDir(dir)
    if (foldCase(key) === home || isShareRoot(key) || comparable(parent) === key || depth + 1 >= MAX_DEPTH) return null
    return treeOf(parent, depth + 1)
  }

  /** Each directory caches the walk from it before the walk runs, so concurrent lookups share one walk. */
  function treeOf(dir: string, depth: number): Promise<Tree | null> {
    const key = comparable(dir)
    const known = cache.get(key)
    if (known) return known
    if (cache.size >= FILE_IDENTITY_CACHE_MAX) cache.clear()
    const answer = lookUp(dir, key, depth)
    cache.set(key, answer)
    return answer
  }

  return async absolutePath => {
    const file = keyOf(absolutePath)
    const tree = await treeOf(getParentDir(file), 0)
    if (!tree || !file.startsWith(`${tree.top.replace(/\/$/, '')}/`)) return { path: file }
    return {
      repo: tree.repo,
      ...(tree.worktree !== undefined ? { worktree: tree.worktree } : {}),
      path: file.slice(tree.top.replace(/\/$/, '').length + 1),
    }
  }
}
