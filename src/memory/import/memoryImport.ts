/**
 * Import a project's auto-memory from `~/.claude/projects/<slug>/memory/` into
 * `~/.velloc/projects/<slug>/memory/` (same slug via `projectFolderKey`).
 * ADD-ONLY: an existing topic file is never overwritten; `MEMORY.md` is merged
 * by {@link mergeMemoryIndex}.
 */

import { joinPath } from '../memoryPaths'
import { projectsHome } from '../../utils/conversationStoragePaths'
import type { ImportSource } from '../../sessionImport/protocol'
import { TERMINAL_AGENT_SOURCE_ID } from '../../sessionImport/sources/claude-code/sourceIdentity'
import type { RuntimeFs } from '../../utils/fs/runtimeFs'
import { ensureDirRecursive } from '../../pluginHost/writeExtracted'

const MEMORY_DIR_NAME = 'memory'
const MEMORY_INDEX_FILE = 'MEMORY.md'

/** Defensive caps — a memory dir with an absurd file count or a symlink loop
 *  can't make us walk/copy unbounded work. Memory dirs are normally a handful
 *  of files; `logs/YYYY/MM/` is the only nesting daily-log mode adds. */
const IMPORT_FILE_CEILING = 500
const MAX_WALK_DEPTH = 8

/** Whether a memory-dir-relative path is the root `MEMORY.md` index (which is
 *  merged, not matched/overwritten). A nested `sub/MEMORY.md` is a topic file. */
function isIndexFile(relPath: string): boolean {
  return relPath.toLowerCase() === MEMORY_INDEX_FILE.toLowerCase()
}

/** Per-row import state (spec): `import` = nothing in the destination yet;
 *  `update` = some topic files already imported, some not; `imported` = every
 *  source topic file already present (the row's Import button is disabled). */
export type MemoryImportStatus = 'import' | 'update' | 'imported'

/** One `.md` file under a project's memory dir, as the Memory tab lists it. */
export type ImportableMemoryFile = {
  /** Path relative to the memory dir, `'/'`-separated (`MEMORY.md`,
   *  `user_role.md`, `logs/2026/01/2026-01-05.md`). */
  relPath: string
  /** Size in bytes (0 if it couldn't be stat-ed). */
  bytes: number
  /** The destination memory dir already has a file at this relative path
   *  (live check). */
  imported: boolean
}

/** One Claude Code project that has memory to import. */
export type ImportableMemoryProject = {
  /** Source project dir name = the Velloc project slug (`projectFolderKey(root)`). */
  slug: string
  /** Absolute source memory dir (`~/.claude/projects/<slug>/memory/`). */
  sourceDir: string
  /** Absolute destination memory dir (`~/.velloc/projects/<slug>/memory/`). */
  destDir: string
  /** Every `.md` file under the source memory dir, name-sorted. */
  files: ImportableMemoryFile[]
  /** Topic-file import state — `MEMORY.md` is excluded from the tally (it is
   *  merged, so it is present after any import and would falsely read as
   *  "imported"). */
  status: MemoryImportStatus
}

/**
 * The on-disk projects folder a source keeps its per-project memory under.
 * Claude Code: `~/.claude/projects` (each `<slug>/memory/`). Exhaustive over
 * `ImportSource` — a new source is a compile error here until its root is added.
 */
export function memoryImportProjectsRoot(
  source: ImportSource,
  homeDir: string,
): string {
  switch (source) {
    case TERMINAL_AGENT_SOURCE_ID:
      return joinPath(homeDir, '.claude', 'projects')
    // Codex keeps memory globally (`~/.codex/memories`), not under a
    // per-project slug, so it has no projects root. Return a deliberately
    // nonexistent `~/.codex/projects` so the (per-project) memory-import scan
    // surfaces nothing for Codex — codex memory import is out of scope for the
    // session-import feature.
    case 'codex':
      return joinPath(homeDir, '.codex', 'projects')
  }
}

/**
 * Every `.md` file under `memoryDir`, recursively (depth- and count-capped;
 * symlinks and dotfiles like `.consolidate-lock` skipped), as memory-dir
 * relative `'/'`-paths. Never throws for a missing dir — returns what it found.
 */
async function collectMemoryFiles(
  fs: RuntimeFs,
  memoryDir: string,
): Promise<Array<{ relPath: string; bytes: number }>> {
  const out: Array<{ relPath: string; bytes: number }> = []
  const walk = async (rel: string, depth: number): Promise<void> => {
    if (depth > MAX_WALK_DEPTH || out.length > IMPORT_FILE_CEILING) return
    const abs = rel ? joinPath(memoryDir, rel) : memoryDir
    let entries
    try {
      entries = await fs.readdir(abs)
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink?.()) continue // don't follow symlinks (loop guard)
      const name = entry.name
      if (name.startsWith('.')) continue // transient/hidden (.consolidate-lock)
      const childRel = rel ? `${rel}/${name}` : name
      if (entry.isDirectory()) {
        await walk(childRel, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      if (!name.toLowerCase().endsWith('.md')) continue // memory is markdown only
      let bytes = 0
      try {
        bytes = (await fs.stat(joinPath(memoryDir, childRel))).size ?? 0
      } catch {
        /* keep bytes = 0 — still list the file */
      }
      out.push({ relPath: childRel, bytes })
    }
  }
  await walk('', 0)
  out.sort((a, b) => a.relPath.localeCompare(b.relPath))
  return out
}

/** The set of memory-dir-relative `.md` paths (lowercased) already on disk at
 *  `destDir`. Empty when the dir doesn't exist. */
async function destRelPathSet(
  fs: RuntimeFs,
  destDir: string,
): Promise<Set<string>> {
  const files = await collectMemoryFiles(fs, destDir)
  return new Set(files.map((f) => f.relPath.toLowerCase()))
}

/** Import state from the per-file `imported` flags (MEMORY.md excluded). */
function computeStatus(files: ImportableMemoryFile[]): MemoryImportStatus {
  const topics = files.filter((f) => !isIndexFile(f.relPath))
  if (topics.length === 0) {
    // A memory dir with only MEMORY.md: base the state on the index itself.
    const index = files.find((f) => isIndexFile(f.relPath))
    return index?.imported ? 'imported' : 'import'
  }
  const importedCount = topics.filter((f) => f.imported).length
  if (importedCount === 0) return 'import'
  if (importedCount === topics.length) return 'imported'
  return 'update'
}

/**
 * List the Claude Code projects under `sourceProjectsRoot` that have memory to
 * import: each `<slug>/memory/` holding at least one `.md` file. A row's
 * per-file `imported` flag and its `status` are live checks against
 * `<vellocProjectsDir>/<slug>/memory/`. A missing source root yields an empty
 * list, never an error.
 */
export async function listImportableMemoryProjects(
  sourceProjectsRoot: string,
  vellocProjectsDir: string,
  fs: RuntimeFs,
): Promise<ImportableMemoryProject[]> {
  let entries
  try {
    entries = await fs.readdir(sourceProjectsRoot)
  } catch {
    return []
  }

  const rows: ImportableMemoryProject[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const slug = entry.name
    const sourceDir = joinPath(sourceProjectsRoot, slug, MEMORY_DIR_NAME)
    const srcFiles = await collectMemoryFiles(fs, sourceDir)
    if (srcFiles.length === 0) continue // no memory here — not importable

    const destDir = joinPath(vellocProjectsDir, slug, MEMORY_DIR_NAME)
    const destSet = await destRelPathSet(fs, destDir)
    const files: ImportableMemoryFile[] = srcFiles.map((f) => ({
      relPath: f.relPath,
      bytes: f.bytes,
      imported: destSet.has(f.relPath.toLowerCase()),
    }))
    rows.push({ slug, sourceDir, destDir, files, status: computeStatus(files) })
  }

  rows.sort((a, b) => a.slug.localeCompare(b.slug))
  return rows
}

/** The markdown-link target `.md` filename on a MEMORY.md pointer line, keyed
 *  by basename (lowercased) so a `[T](./foo.md)` and a `[T](foo.md)` collide.
 *  `null` for a line with no `.md` link. */
function pointerFileKey(line: string): string | null {
  const m = /\]\(\s*([^)]+?\.md)\s*\)/i.exec(line)
  if (!m) return null
  const target = m[1]!.split(/[\\/]/).pop() ?? m[1]!
  return target.trim().toLowerCase()
}

/**
 * Merge a source `MEMORY.md` into the destination's, ADD-ONLY: a blank
 * destination adopts the source; otherwise destination lines stay unchanged and
 * only source pointer lines linking a file not already listed are appended.
 * One trailing newline.
 */
export function mergeMemoryIndex(
  destContent: string | null | undefined,
  sourceContent: string,
): string {
  const source = sourceContent ?? ''
  if (destContent == null || destContent.trim() === '') {
    // Fresh destination — adopt the source index as-is (one trailing newline).
    return source.replace(/\r?\n+$/, '') + '\n'
  }

  // The files the destination index already points at (by linked-file key).
  const destKeys = new Set<string>()
  for (const line of destContent.split(/\r?\n/)) {
    const key = pointerFileKey(line)
    if (key) destKeys.add(key)
  }

  // Source pointer lines the destination doesn't already list, first-seen
  // order, deduped by key.
  const additions: string[] = []
  const seen = new Set<string>()
  for (const line of source.split(/\r?\n/)) {
    const key = pointerFileKey(line)
    if (!key || destKeys.has(key) || seen.has(key)) continue
    seen.add(key)
    additions.push(line)
  }

  // Keep every destination line; drop trailing blanks, then append the new ones.
  const outLines = destContent.split(/\r?\n/)
  while (outLines.length > 0 && outLines[outLines.length - 1]!.trim() === '') {
    outLines.pop()
  }
  outLines.push(...additions)
  return outLines.length > 0 ? outLines.join('\n') + '\n' : ''
}

export type MemoryImportContext = {
  homeDir: string
  fs: RuntimeFs
  source: ImportSource
}

export type MemoryImportResult = {
  /** The (sanitized) project slug that was imported. */
  slug: string
  /** Topic `.md` files newly copied in — `MEMORY.md` excluded (it is merged).
   *  Add-only: a file already present at the destination is NOT recopied. */
  filesCopied: number
  /** Topic `.md` files left untouched because the destination already had them
   *  (add-only — Velloc's own memory is never overwritten). */
  filesSkipped: number
  /** `MEMORY.md` was merged into (or created at) the destination. */
  indexMerged: boolean
}

/** A project slug names a single directory segment. Reject anything that could
 *  redirect the read/write out of the projects dir (the slug is UI-supplied). */
function assertSafeSlug(slug: string): void {
  if (
    slug.length === 0 ||
    slug === '.' ||
    slug === '..' ||
    slug.includes('/') ||
    slug.includes('\\') ||
    slug.includes('\0')
  ) {
    throw new Error(`Invalid project slug: "${slug}"`)
  }
}

/** Create the parent directory of `filePath` (and any missing ancestors). */
async function ensureParentDir(fs: RuntimeFs, filePath: string): Promise<void> {
  const idx = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  if (idx > 0) await ensureDirRecursive(fs, filePath.slice(0, idx))
}

/**
 * Copy one project's memory into its Velloc store, ADD-ONLY (existing topic
 * files untouched, index merged). Throws when the source has no memory files.
 * Re-running is the "Update": it copies any absent topic file.
 */
export async function importMemoryProject(
  slug: string,
  sourceProjectsRoot: string,
  ctx: MemoryImportContext,
): Promise<MemoryImportResult> {
  assertSafeSlug(slug)
  const sourceDir = joinPath(sourceProjectsRoot, slug, MEMORY_DIR_NAME)
  const destDir = joinPath(projectsHome(ctx.homeDir), slug, MEMORY_DIR_NAME)

  const files = await collectMemoryFiles(ctx.fs, sourceDir)
  if (files.length === 0) {
    throw new Error(`No memory files found for project "${slug}".`)
  }

  // Snapshot the destination's topic files up front: add-only copy compares by
  // filename (relative path), and we only ever add, so this stays accurate.
  const destSet = await destRelPathSet(ctx.fs, destDir)

  let filesCopied = 0
  let filesSkipped = 0
  let indexMerged = false
  for (const { relPath } of files) {
    const destPath = joinPath(destDir, relPath)

    if (isIndexFile(relPath)) {
      let content: string
      try {
        content = await ctx.fs.readFile(joinPath(sourceDir, relPath), {
          encoding: 'utf-8',
        })
      } catch {
        continue // unreadable source index — skip, don't sink the whole import
      }
      await ensureParentDir(ctx.fs, destPath)
      let destContent: string | null = null
      try {
        destContent = await ctx.fs.readFile(destPath, { encoding: 'utf-8' })
      } catch {
        /* no existing index — mergeMemoryIndex adopts the source verbatim */
      }
      await ctx.fs.writeFile(destPath, mergeMemoryIndex(destContent, content), {
        encoding: 'utf-8',
      })
      indexMerged = true
      continue
    }

    // Add-only topic file: leave a destination copy untouched.
    if (destSet.has(relPath.toLowerCase())) {
      filesSkipped++
      continue
    }
    let content: string
    try {
      content = await ctx.fs.readFile(joinPath(sourceDir, relPath), {
        encoding: 'utf-8',
      })
    } catch {
      continue // unreadable source file — skip, don't sink the whole import
    }
    await ensureParentDir(ctx.fs, destPath)
    await ctx.fs.writeFile(destPath, content, { encoding: 'utf-8' })
    filesCopied++
  }

  return { slug, filesCopied, filesSkipped, indexMerged }
}
