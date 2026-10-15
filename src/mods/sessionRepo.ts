/**
 * `$.session.repo()`: the git repository the session runs in, read through the
 * runtime's fs (no git process); a worktree resolves to the main working tree.
 * `internal` and `name` read false and null. Pure.
 */

import type { ModSessionRepo } from './modNouns'

export type RepoFs = {
  stat(path: string): Promise<{ isDirectory(): boolean; isFile(): boolean }>
  readFile(path: string, options: { encoding: string }): Promise<string>
}

/** Forward slashes, no trailing slash, `.` and `..` segments resolved. */
function normalize(path: string): string {
  const slashed = path.replace(/\\/g, '/')
  const absolute = slashed.startsWith('/')
  const drive = /^[A-Za-z]:/.exec(slashed)?.[0] ?? ''
  const rest = drive ? slashed.slice(drive.length) : slashed
  const out: string[] = []
  for (const segment of rest.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop()
      else if (!absolute && !drive) out.push('..')
      continue
    }
    out.push(segment)
  }
  const joined = out.join('/')
  if (drive) return `${drive}/${joined}`
  if (absolute) return `/${joined}`
  return joined === '' ? '.' : joined
}

function dirname(path: string): string {
  const at = path.lastIndexOf('/')
  if (at < 0) return ''
  if (at === 0) return '/'
  // `C:/` stays a root.
  if (/^[A-Za-z]:$/.test(path.slice(0, at))) return path.slice(0, at + 1)
  return path.slice(0, at)
}

function isRoot(path: string): boolean {
  return path === '' || path === '/' || /^[A-Za-z]:\/?$/.test(path)
}

function join(dir: string, name: string): string {
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`
}

async function statKind(fs: RepoFs, path: string): Promise<'dir' | 'file' | null> {
  try {
    const stat = await fs.stat(path)
    if (stat.isDirectory()) return 'dir'
    if (stat.isFile()) return 'file'
    return null
  } catch {
    return null
  }
}

/** The `origin` remote's URL from a git `config` text, push URL preferred. */
export function originUrlOf(config: string): string | null {
  let inOrigin = false
  let url: string | null = null
  let pushUrl: string | null = null
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue
    const section = /^\[(.+)\]$/.exec(line)
    if (section) {
      inOrigin = /^remote\s+"origin"$/.test(section[1]!.trim())
      continue
    }
    if (!inOrigin) continue
    const at = line.indexOf('=')
    if (at < 0) continue
    const key = line.slice(0, at).trim().toLowerCase()
    const value = line.slice(at + 1).trim()
    if (key === 'url' && url === null) url = value
    if (key === 'pushurl' && pushUrl === null) pushUrl = value
  }
  return pushUrl ?? url
}

/**
 * Where the repository's metadata lives, and its main working tree's root,
 * for the `.git` found at `gitPath` (a directory or a `gitdir:` file).
 * Null when the file points somewhere that cannot be read.
 */
async function followGitPointer(
  fs: RepoFs,
  workTree: string,
  gitPath: string,
  kind: 'dir' | 'file',
): Promise<{ gitDir: string; root: string } | null> {
  if (kind === 'dir') return { gitDir: gitPath, root: workTree }
  let text: string
  try {
    text = await fs.readFile(gitPath, { encoding: 'utf-8' })
  } catch {
    return null
  }
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(text)
  if (!match) return null
  let gitDir = normalize(match[1]!)
  if (!/^(\/|[A-Za-z]:)/.test(gitDir)) gitDir = normalize(join(workTree, gitDir))
  // A linked worktree: `<main>/.git/worktrees/<name>` — the main tree's root
  // is above its `.git`. A submodule: `<super>/.git/modules/<path>` — its own
  // working tree is where it was found.
  const parts = gitDir.split('/')
  const worktreesAt = parts.lastIndexOf('worktrees')
  if (worktreesAt >= 2 && parts[worktreesAt - 1] === '.git') {
    const mainGit = parts.slice(0, worktreesAt).join('/')
    return { gitDir: mainGit, root: dirname(mainGit) || '/' }
  }
  return { gitDir, root: workTree }
}

/** The repository `cwd` is inside, or null. Never rejects. */
export async function readSessionRepo(fs: RepoFs, cwd: string): Promise<ModSessionRepo | null> {
  let dir = normalize(cwd)
  for (let depth = 0; depth < 256; depth += 1) {
    const gitPath = join(dir, '.git')
    const kind = await statKind(fs, gitPath)
    if (kind) {
      const resolved = await followGitPointer(fs, dir, gitPath, kind)
      if (!resolved) return null
      let remote: string | null = null
      try {
        remote = originUrlOf(await fs.readFile(join(resolved.gitDir, 'config'), { encoding: 'utf-8' }))
      } catch {
        remote = null
      }
      return { root: resolved.root, remote, internal: false, name: null }
    }
    if (isRoot(dir)) return null
    const parent = dirname(dir)
    if (parent === dir || parent === '') return null
    dir = parent
  }
  return null
}
