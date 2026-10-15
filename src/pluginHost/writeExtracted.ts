/**
 * Write extracted-tarball files under a target root. Security: relies on
 * `extract.ts` sanitization; no second path check here.
 */

import type { RuntimeFs } from '../utils/fs/runtimeFs'
import type { ExtractedFile } from './extract'

/**
 * Ensure `dirPath` exists, creating missing ancestors top-down (a failed mkdir
 * is the existence check). Filesystem roots are skipped.
 */
export async function ensureDirRecursive(
  fs: RuntimeFs,
  dirPath: string,
): Promise<void> {
  const ancestors = collectAncestors(dirPath)
  for (const ancestor of ancestors) {
    try {
      await fs.mkdir(ancestor)
    } catch (e) {
      // EEXIST + permission-denied-on-existing-dir + ENOENT-of-parent
      // all surface here. We can't reliably tell which without `stat`,
      // so we swallow them and let the eventual `writeFile` fail with
      // a clearer error if the directory genuinely can't be created.
      // (`writeFile` to a missing directory throws ENOENT with the
      // full target path — much better diagnostics than mkdir would
      // give us.)
      void e
    }
  }
}

/** Collect every ancestor path from the deepest level down to the
 *  filesystem root, INCLUDING `dirPath` itself. Returned in
 *  root-to-leaf order so the caller mkdirs them top-down. */
function collectAncestors(dirPath: string): string[] {
  if (!dirPath || dirPath === '/' || /^[A-Za-z]:[/\\]?$/.test(dirPath)) {
    return []
  }
  const out: string[] = []
  let current = dirPath
  // Stop when the next slash-strip would put us at the root.
  while (true) {
    out.unshift(current)
    const slashIdx = lastSeparator(current)
    if (slashIdx <= 0) break // top of POSIX or top of Windows root
    const parent = current.slice(0, slashIdx)
    // Windows drive root: `C:` — push the next-level path then stop.
    if (/^[A-Za-z]:$/.test(parent)) break
    current = parent
  }
  return out
}

function lastSeparator(p: string): number {
  const fwd = p.lastIndexOf('/')
  const back = p.lastIndexOf('\\')
  return Math.max(fwd, back)
}

/** Split a file path into `[dirname, basename]`. Returns `['', name]`
 *  for a path with no separator. */
function splitPath(filePath: string): [string, string] {
  const idx = lastSeparator(filePath)
  if (idx < 0) return ['', filePath]
  return [filePath.slice(0, idx), filePath.slice(idx + 1)]
}

/** Join `dir` and `rel` with a forward slash, collapsing duplicates. */
function joinUnderRoot(dir: string, rel: string): string {
  if (!dir) return rel
  if (!rel) return dir
  const trimmedDir = dir.replace(/[/\\]+$/, '')
  const trimmedRel = rel.replace(/^[/\\]+/, '')
  return `${trimmedDir}/${trimmedRel}`
}

export type WriteOutcome = {
  /** Files actually written. Same order as input. */
  written: number
  /** First file index that failed. `null` when every file succeeded. */
  firstFailureIndex: number | null
}

/**
 * Write every entry under `targetRoot`, creating directories on demand. Aborts
 * on the first failure (`firstFailureIndex`) with no cleanup. `binaryToString`
 * false writes UTF-8 strings for facades without binary writes.
 */
export async function writeExtractedFiles(
  fs: RuntimeFs,
  targetRoot: string,
  entries: ReadonlyArray<ExtractedFile>,
  options: { decodeAsUtf8?: boolean } = {},
): Promise<WriteOutcome> {
  let written = 0
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!
    const fullPath = joinUnderRoot(targetRoot, entry.path)
    const [parentDir] = splitPath(fullPath)
    if (parentDir) {
      await ensureDirRecursive(fs, parentDir)
    }
    try {
      if (options.decodeAsUtf8) {
        const text = new TextDecoder('utf-8').decode(entry.content)
        await fs.writeFile(fullPath, text, { encoding: 'utf-8' })
      } else {
        await fs.writeFile(fullPath, entry.content)
      }
      written++
    } catch {
      return { written, firstFailureIndex: i }
    }
  }
  return { written, firstFailureIndex: null }
}
