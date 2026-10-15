/**
 * The file names under a folder, a few levels deep, for the model's first
 * turn (F-19): names only, folders first then files, each level sorted,
 * heavy folders skipped by name, symbolic links not followed, cut at an
 * entry cap. A `.git` entry is not listed; its folder is marked a repository
 * instead. Read over the runtime fs; a folder that cannot be listed, or that
 * `mayEnter` refuses (asked for each, the root too), is named but never read.
 */

export const GIT_FOLDER = '.git'
export const REPOSITORY_MARK = ' (git repository)'

export const FOLDER_TREE_MAX_DEPTH = 3
export const FOLDER_TREE_MAX_ENTRIES = 200
/** How long the first turn waits for the listing before going out without it. */
export const FOLDER_TREE_TIMEOUT_MS = 5_000

/** Folders whose contents are never worth the model's attention at a glance:
 *  dependency, build and tool caches. The folder itself is still listed. */
export const FOLDER_TREE_SKIPPED = new Set([
  '.git',
  'node_modules',
  '.velloc',
  'out',
  'dist',
  'build',
  'target',
  '.next',
  '.venv',
  'venv',
  '__pycache__',
  '.cache',
  'coverage',
  '.idea',
  '.vs',
])

export type FolderTreeEntry = {
  name: string
  isDirectory(): boolean
  isSymbolicLink(): boolean
}

export type FolderTreeFs = {
  readdir(path: string): Promise<FolderTreeEntry[]>
}

export type FolderTree = {
  lines: string[]
  truncated: boolean
}

function joinFolder(parent: string, name: string): string {
  const separator = parent.includes('\\') ? '\\' : '/'
  return parent.endsWith(separator) || parent.endsWith('/') ? `${parent}${name}` : `${parent}${separator}${name}`
}

export async function readFolderTree(
  fs: FolderTreeFs,
  root: string,
  limits: {
    maxDepth?: number
    maxEntries?: number
    mayEnter?: (folder: string) => Promise<boolean>
  } = {},
): Promise<FolderTree> {
  const maxDepth = limits.maxDepth ?? FOLDER_TREE_MAX_DEPTH
  const maxEntries = limits.maxEntries ?? FOLDER_TREE_MAX_ENTRIES
  const lines: string[] = []
  let truncated = false

  /** Lists `folder` at `depth`; answers whether it holds a `.git` entry. */
  const walk = async (folder: string, depth: number): Promise<boolean> => {
    let entries: FolderTreeEntry[]
    try {
      if (limits.mayEnter && !(await limits.mayEnter(folder))) return false
      entries = await fs.readdir(folder)
    } catch {
      return false
    }
    const repository = entries.some(entry => entry.name === GIT_FOLDER)
    const ordered = [...entries]
      .filter(entry => !entry.isSymbolicLink() && entry.name !== GIT_FOLDER)
      .sort((a, b) => {
        const byKind = Number(b.isDirectory()) - Number(a.isDirectory())
        return byKind !== 0 ? byKind : a.name.localeCompare(b.name)
      })
    for (const entry of ordered) {
      if (lines.length >= maxEntries) {
        truncated = true
        return repository
      }
      const indent = '  '.repeat(depth)
      if (entry.isDirectory()) {
        const at = lines.push(`${indent}${entry.name}/`) - 1
        if (depth + 1 < maxDepth && !FOLDER_TREE_SKIPPED.has(entry.name)) {
          const nested = await walk(joinFolder(folder, entry.name), depth + 1)
          if (nested) lines[at] += REPOSITORY_MARK
          if (truncated) return repository
        }
      } else {
        lines.push(`${indent}${entry.name}`)
      }
    }
    return repository
  }

  await walk(root, 0)
  return { lines, truncated }
}
