/**
 * Import a skill from another product's local skills folder (`claude-code` →
 * `~/.claude/skills/`) into `~/.velloc/skills/<dir>/` as a Velloc-owned copy:
 * a local-disk copy through `writeExtractedFiles` plus a provenance sidecar, so
 * it lists and uninstalls like a marketplace install.
 */

import { joinPath } from '../memory/memoryPaths'
import type { ImportSource } from '../sessionImport/protocol'
import { TERMINAL_AGENT_SOURCE_ID } from '../sessionImport/sources/claude-code/sourceIdentity'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import type { ExtractedFile } from '../pluginHost/extract'
import { writeExtractedFiles } from '../pluginHost/writeExtracted'
import {
  describeSkillMarkdown,
  getSkillsDirectory,
  type InstalledSkillEntry,
  sanitizeRelPath,
  sanitizeSkillDirName,
  SKILL_PROVENANCE_FILE,
} from './skillInstall'

const SKILL_FILE_NAME = 'SKILL.md'

/** Defensive caps mirroring `skillInstall.ts` — a skill dir with an absurd
 *  file count or a symlink loop can't make us walk/copy unbounded work. */
const MAX_SKILL_FILES = 1000
const MAX_WALK_DEPTH = 12

/** One skill found under a source's on-disk skills folder, as the Import
 *  dialog's Skills tab lists it. Structurally the protocol's
 *  `ImportableSkillRow` (`bridge/protocol/skills.ts`). */
export type ImportableSkill = {
  dir: string
  path: string
  name: string
  description: string
  fileCount: number
  alreadyImported: boolean
}

async function hasSkillMd(fs: RuntimeFs, dir: string): Promise<boolean> {
  try {
    await fs.readFile(joinPath(dir, SKILL_FILE_NAME), { encoding: 'utf-8' })
    return true
  } catch {
    return false
  }
}

/**
 * The on-disk skills folder a source keeps its user skills in. The
 * `claude-code` source uses `~/.claude/skills/`. Exhaustive over
 * `ImportSource` — a new source is a
 * compile error here until its root is added.
 */
export function skillImportSourceRoot(
  source: ImportSource,
  homeDir: string,
): string {
  switch (source) {
    case TERMINAL_AGENT_SOURCE_ID:
      return joinPath(homeDir, '.claude', 'skills')
    // Codex keeps user skills under `~/.codex/skills/<name>/` in the SAME
    // `SKILL.md` (YAML frontmatter `name`/`description`) + resource-dir layout
    // as the `claude-code` source, so the whole importer below works unchanged. OpenAI ships
    // its BUILT-IN skills under `~/.codex/skills/.system/<name>/`; those are
    // skipped as dot-dirs by `listImportableSkills` so only the user's own
    // skills are offered.
    case 'codex':
      return joinPath(homeDir, '.codex', 'skills')
  }
}

/**
 * Recursively collect every file under `skillDir` as an `ExtractedFile`
 * (relative slash-path + bytes), ready for `writeExtractedFiles`. Directories
 * are descended (depth-capped); the provenance sidecar and path-unsafe entries
 * are skipped. Never throws for a missing dir — returns what it found.
 */
async function collectSkillFiles(
  fs: RuntimeFs,
  skillDir: string,
): Promise<ExtractedFile[]> {
  const out: ExtractedFile[] = []
  const walk = async (rel: string, depth: number): Promise<void> => {
    if (depth > MAX_WALK_DEPTH || out.length > MAX_SKILL_FILES) return
    const abs = rel ? joinPath(skillDir, rel) : skillDir
    let entries
    try {
      entries = await fs.readdir(abs)
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink?.()) continue // don't follow symlinks (loop guard)
      const childRel = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        await walk(childRel, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      // The provenance sidecar is ours to write, never copied from the source.
      if (childRel === SKILL_PROVENANCE_FILE) continue
      const safe = sanitizeRelPath(childRel)
      if (!safe) continue
      out.push({
        path: safe,
        content: await fs.readFileBytes(joinPath(skillDir, childRel)),
      })
    }
  }
  await walk('', 0)
  return out
}

/**
 * List the skills under a source root (`~/.claude/skills/`) that can be
 * imported: each immediate subdirectory holding a `SKILL.md`. `vellocSkillsDir`
 * is the Velloc store (`getSkillsDirectory(homeDir)`) — a row's
 * `alreadyImported` is a live check for `<vellocSkillsDir>/<sanitized dir>/SKILL.md`.
 * A missing source root yields an empty list, never an error.
 */
export async function listImportableSkills(
  sourceRoot: string,
  vellocSkillsDir: string,
  fs: RuntimeFs,
): Promise<ImportableSkill[]> {
  let entries
  try {
    entries = await fs.readdir(sourceRoot)
  } catch {
    return []
  }

  const rows: ImportableSkill[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    // Skip dot-prefixed dirs. Codex ships its BUILT-IN skills under
    // `~/.codex/skills/.system/<name>/` (marked `.codex-system-skills.marker`) —
    // OpenAI's, not the user's authored skills — so they must never be offered
    // for import. The scan is one level deep and every row needs a *direct*
    // `SKILL.md`, so `.system` (which has none) was already skipped; this makes
    // the intent explicit and stays correct if the walk is ever deepened.
    if (entry.name.startsWith('.')) continue
    const dir = entry.name
    const skillDir = joinPath(sourceRoot, dir)
    let raw: string
    try {
      raw = await fs.readFile(joinPath(skillDir, SKILL_FILE_NAME), {
        encoding: 'utf-8',
      })
    } catch {
      continue // no SKILL.md — not a loadable skill; skip
    }
    const { name, description } = describeSkillMarkdown(
      raw,
      joinPath(skillDir, SKILL_FILE_NAME),
      dir,
    )
    const files = await collectSkillFiles(fs, skillDir)
    rows.push({
      dir,
      path: skillDir,
      name,
      description,
      fileCount: files.length,
      alreadyImported: await hasSkillMd(
        fs,
        joinPath(vellocSkillsDir, sanitizeSkillDirName(dir)),
      ),
    })
  }

  rows.sort((left, right) => left.name.localeCompare(right.name))
  return rows
}

export type SkillImportContext = {
  homeDir: string
  fs: RuntimeFs
  source: ImportSource
  /** Injected for tests; defaults to `new Date().toISOString()`. */
  now?: () => string
}

/**
 * Copy one source skill directory into the Velloc store with a provenance
 * sidecar. Idempotent: an existing destination `SKILL.md` returns
 * `skipped:true`. Resource files first, `SKILL.md` last, then the sidecar.
 * Throws when the source has no `SKILL.md`.
 */
export async function importLocalSkill(
  dir: string,
  sourceRoot: string,
  ctx: SkillImportContext,
): Promise<{ entry: InstalledSkillEntry; skipped: boolean; fileCount: number }> {
  // `dir` names one entry directly under the source root (what
  // `listImportableSkills` offers) — never a path. It arrives from a client,
  // and a remote grant may call this (F-24), so `..` or a separator would read
  // a directory outside the root and copy it into the store.
  if (
    dir.length === 0 ||
    dir === '.' ||
    dir === '..' ||
    dir.includes('/') ||
    dir.includes('\\') ||
    dir.includes('\0')
  ) {
    throw new Error(`Invalid skill directory: "${dir}"`)
  }
  const safeDir = sanitizeSkillDirName(dir)
  const skillsDir = getSkillsDirectory(ctx.homeDir)
  const destDir = joinPath(skillsDir, safeDir)
  const srcDir = joinPath(sourceRoot, dir)
  const id = `imported/${ctx.source}/${safeDir}`

  // Collect the source files first (also gives the SKILL.md we read the name
  // from). A source that isn't a skill throws before we touch the store.
  const files = await collectSkillFiles(ctx.fs, srcDir)
  const skillMd = files.filter((f) => f.path === SKILL_FILE_NAME)
  if (skillMd.length === 0) {
    throw new Error(`"${dir}" has no ${SKILL_FILE_NAME} — not an importable skill.`)
  }
  if (files.length > MAX_SKILL_FILES) {
    throw new Error(
      `Skill "${dir}" has ${files.length} files, exceeding the import limit of ${MAX_SKILL_FILES}.`,
    )
  }

  const { name } = describeSkillMarkdown(
    new TextDecoder('utf-8').decode(skillMd[0]!.content),
    joinPath(srcDir, SKILL_FILE_NAME),
    safeDir,
  )

  // Idempotent adoption: leave an existing Velloc copy untouched.
  if (await hasSkillMd(ctx.fs, destDir)) {
    return {
      entry: { id, name, dir: safeDir },
      skipped: true,
      fileCount: 0,
    }
  }

  // Clean-replace any stale non-loadable remnant (no SKILL.md) at the dest.
  try {
    await ctx.fs.rm(destDir, { recursive: true, force: true })
  } catch {
    /* nothing to remove — fresh import */
  }

  const rest = files.filter((f) => f.path !== SKILL_FILE_NAME)
  let outcome = await writeExtractedFiles(ctx.fs, destDir, rest)
  if (outcome.firstFailureIndex === null) {
    outcome = await writeExtractedFiles(ctx.fs, destDir, skillMd)
  }
  if (outcome.firstFailureIndex !== null) {
    throw new Error(
      `Failed writing an imported skill file (index ${outcome.firstFailureIndex}).`,
    )
  }

  const installedAt = ctx.now ? ctx.now() : new Date().toISOString()
  const entry: InstalledSkillEntry = {
    id,
    name,
    dir: safeDir,
    installedAt,
    fileCount: files.length,
  }
  const provenance = {
    ...entry,
    importedFrom: { source: ctx.source, path: srcDir, importedAt: installedAt },
  }
  await ctx.fs.writeFile(
    joinPath(destDir, SKILL_PROVENANCE_FILE),
    new TextEncoder().encode(JSON.stringify(provenance, null, 2)),
  )
  return { entry, skipped: false, fileCount: files.length }
}
