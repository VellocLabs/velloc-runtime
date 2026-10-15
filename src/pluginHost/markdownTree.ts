/**
 * Recursive `*.md` visitor for plugin trees.
 * See docs F-14 "Markdown trees".
 */
import { processFs, type RuntimeFs } from '../utils/fs/runtimeFs'
import { joinRuntimePath } from '../utils/runtimePaths'

export type MarkdownVisitor = (
  path: string,
  folders: string[],
) => void | Promise<void>

export type MarkdownTreeOptions = {
  fs?: RuntimeFs
  /** A directory holding a SKILL.md is not descended into. */
  skillDirsAreLeaves?: boolean
}

const isMarkdown = (name: string) => name.toLowerCase().endsWith('.md')

export async function visitMarkdownFiles(
  root: string,
  visit: MarkdownVisitor,
  options: MarkdownTreeOptions = {},
): Promise<void> {
  const fs = options.fs ?? processFs()
  const pending: Promise<unknown>[] = []

  async function walk(dir: string, folders: string[]): Promise<void> {
    let entries
    try {
      entries = await fs.readdir(dir)
    } catch {
      return
    }
    const leaf =
      options.skillDirsAreLeaves === true &&
      entries.some(e => e.isFile() && e.name.toLowerCase() === 'skill.md')
    const subdirs: Promise<void>[] = []
    for (const entry of entries) {
      const path = joinRuntimePath(dir, entry.name)
      if (entry.isDirectory()) {
        if (!leaf) subdirs.push(walk(path, [...folders, entry.name]))
      } else if (entry.isFile() && isMarkdown(entry.name)) {
        pending.push(Promise.resolve().then(() => visit(path, folders)))
      }
    }
    await Promise.all(subdirs)
  }

  await walk(root, [])
  await Promise.allSettled(pending)
}
