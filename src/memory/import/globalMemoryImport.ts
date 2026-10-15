/**
 * Import Codex's global memory (`~/.codex/memories/` markdown plus
 * `~/.codex/AGENTS.md`; never the sqlite) into the user-tier
 * `~/.velloc/AGENTS.md`, loaded every turn (F-8, F-11). ADD-ONLY and
 * reversible: one delimited block, replaced on re-import; lines outside it are
 * never touched.
 */

import { joinPath } from '../memoryPaths'
import { resolveUserInstructionPath } from '../instructionFiles'
import type { ImportSource } from '../../sessionImport/protocol'
import {
  TERMINAL_AGENT_DISPLAY_NAME,
  TERMINAL_AGENT_SOURCE_ID,
} from '../../sessionImport/sources/claude-code/sourceIdentity'
import type { RuntimeFs } from '../../utils/fs/runtimeFs'
import { ensureDirRecursive } from '../../pluginHost/writeExtracted'

/** A single source file that contributes to a source's global memory import. */
type GlobalMemorySpecFile = {
  /** Absolute source path. */
  path: string
  /** Heading the file's body is placed under inside the imported block. */
  heading: string
  /** Short relative label for the UI file list. */
  label: string
}

/** Defensive cap — a single absurdly large source file is truncated in the
 *  block rather than pasted whole into the always-loaded user instruction file. */
const MAX_GLOBAL_FILE_BYTES = 256 * 1024

/** Human name for a source, for the block heading written into the user instruction file. This
 *  is file content (like the skill provenance sidecar), not UI chrome, so it is
 *  not a translation catalog entry. */
function sourceDisplayName(source: ImportSource): string {
  switch (source) {
    case TERMINAL_AGENT_SOURCE_ID:
      return TERMINAL_AGENT_DISPLAY_NAME
    case 'codex':
      return 'Codex'
  }
}

/**
 * The source files whose content forms a source's GLOBAL memory import, in
 * concatenation order. Exhaustive over `ImportSource`. Returns `[]` for a source
 * with no global-memory concept (Claude Code — its memory is per-project). Codex
 * keeps memory globally under `~/.codex/`.
 */
export function globalMemorySourceFiles(
  source: ImportSource,
  homeDir: string,
): GlobalMemorySpecFile[] {
  switch (source) {
    case TERMINAL_AGENT_SOURCE_ID:
      return []
    case 'codex': {
      const codex = joinPath(homeDir, '.codex')
      const memories = joinPath(codex, 'memories')
      return [
        {
          path: joinPath(codex, 'AGENTS.md'),
          heading: 'Instructions (AGENTS.md)',
          label: 'AGENTS.md',
        },
        {
          path: joinPath(memories, 'memory_summary.md'),
          heading: 'Memory summary',
          label: 'memories/memory_summary.md',
        },
        {
          path: joinPath(memories, 'MEMORY.md'),
          heading: 'Memory',
          label: 'memories/MEMORY.md',
        },
      ]
    }
  }
}

/** The user-tier instruction file every global import merges into: the one
 *  the loader reads — `~/.velloc/AGENTS.md`, or `~/.claude/CLAUDE.md` where
 *  only that exists (a new AGENTS.md beside it would replace it). */
export function userInstructionFilePath(
  fs: RuntimeFs,
  homeDir: string,
): Promise<string> {
  return resolveUserInstructionPath(fs, homeDir)
}

function blockBegin(source: ImportSource): string {
  return `<!-- velloc:imported source=${source} kind=memory begin -->`
}
function blockEnd(source: ImportSource): string {
  return `<!-- velloc:imported source=${source} kind=memory end -->`
}

type GlobalMemoryReadFile = { label: string; bytes: number }
type GlobalMemoryRead = {
  /** Source files that actually had content (for the UI list). */
  files: GlobalMemoryReadFile[]
  /** The assembled INNER content (headings + bodies), or `''` when nothing had
   *  content. */
  content: string
}

/** Defuse any Velloc import-marker comment embedded in source content, so a
 *  source file whose body contains `<!-- velloc:imported … -->` cannot forge the
 *  block boundaries this module parses on. A zero-width space breaks the exact
 *  marker string the parser matches while staying invisible in the rendered md. */
function neutralizeMarkers(text: string): string {
  // A zero-width space (U+200B) breaks the exact marker string the parser
  // searches for, while staying invisible in the rendered markdown.
  return text.replace(/<!--(\s*)velloc:imported\b/gi, '<!--$1velloc\u200b:imported')
}

/** Read each spec file, skip the absent/empty ones, and assemble the block's
 *  inner content (a `### heading` + body per file). Never throws — an unreadable
 *  file is skipped. */
async function readGlobalMemorySource(
  fs: RuntimeFs,
  spec: GlobalMemorySpecFile[],
): Promise<GlobalMemoryRead> {
  const files: GlobalMemoryReadFile[] = []
  const sections: string[] = []
  for (const f of spec) {
    let raw: string
    try {
      raw = await fs.readFile(f.path, { encoding: 'utf-8' })
    } catch {
      continue // absent / unreadable — skip
    }
    if (raw.trim() === '') continue // empty file — nothing to import
    const bytes = new TextEncoder().encode(raw).length
    // Neutralize any embedded import marker before it can reach the user instruction file, so
    // source content cannot forge the block boundaries (see mergeGlobalMemoryBlock).
    let body = neutralizeMarkers(raw.replace(/\s+$/, ''))
    // Cap by BYTES, not string length, so a multibyte file is actually bounded
    // at MAX_GLOBAL_FILE_BYTES rather than that many characters.
    const bodyBytes = new TextEncoder().encode(body)
    if (bodyBytes.length > MAX_GLOBAL_FILE_BYTES) {
      body =
        new TextDecoder().decode(bodyBytes.slice(0, MAX_GLOBAL_FILE_BYTES)) +
        '\n\n…(truncated on import)'
    }
    files.push({ label: f.label, bytes })
    sections.push(`### ${f.heading}\n\n${body}`)
  }
  return { files, content: sections.join('\n\n') }
}

/** The full delimited block (markers + heading + inner content) written into
 *  user instruction file. Byte-identical inputs produce a byte-identical block — the basis
 *  for the `imported` vs `update` status check. */
function assembleBlock(source: ImportSource, innerContent: string): string {
  return (
    `${blockBegin(source)}\n` +
    `## Imported from ${sourceDisplayName(source)} memory\n\n` +
    `${innerContent}\n` +
    `${blockEnd(source)}`
  )
}

/** Extract the existing imported block for `source` from `dest`, or `null` when
 *  there is none. */
function extractBlock(dest: string, source: ImportSource): string | null {
  const begin = blockBegin(source)
  const end = blockEnd(source)
  const bi = dest.indexOf(begin)
  if (bi === -1) return null
  const ei = dest.indexOf(end, bi)
  if (ei === -1) return null
  return dest.slice(bi, ei + end.length)
}

/**
 * Merge a source's block into the user instruction file, ADD-ONLY: content
 * outside the `<!-- velloc:imported source=… -->` markers is untouched; a
 * block for the same source is replaced, other sources' kept. One trailing
 * newline.
 */
export function mergeGlobalMemoryBlock(
  destContent: string | null | undefined,
  source: ImportSource,
  innerContent: string,
): string {
  let dest = destContent ?? ''
  const begin = blockBegin(source)
  const bi = dest.indexOf(begin)
  if (bi !== -1) {
    const end = blockEnd(source)
    const ei = dest.indexOf(end, bi)
    // Only strip a WELL-FORMED existing block (begin + a matching end after it).
    // A lone begin marker with no end (a hand edit, or stray marker text) is left
    // untouched — stripping to EOF would delete the user's content below it.
    if (ei !== -1) {
      dest = dest.slice(0, bi) + dest.slice(ei + end.length)
    }
  }
  const base = dest.replace(/\s+$/, '')
  const block = assembleBlock(source, innerContent)
  return (base === '' ? block : `${base}\n\n${block}`) + '\n'
}

/** Per-row import state (spec): `import` = no block yet; `update` = a block is
 *  present but the source content changed (regenerated memory); `imported` =
 *  the block matches the current source (nothing to sync — button disabled). */
export type GlobalMemoryImportStatus = 'import' | 'update' | 'imported'

export type ImportableGlobalMemory = {
  source: ImportSource
  /** `~/.velloc/AGENTS.md`. */
  destPath: string
  /** Source files that contributed content (absent/empty ones excluded). */
  files: GlobalMemoryReadFile[]
  status: GlobalMemoryImportStatus
}

/**
 * Describe a source's importable global memory, or `null` when the source has
 * none — either it has no global-memory concept (Claude Code) or the files are
 * absent/empty (a Codex profile that has not accrued memory yet). `null` → the
 * Memory tab shows no global-memory row. Never throws.
 */
export async function listImportableGlobalMemory(
  source: ImportSource,
  homeDir: string,
  fs: RuntimeFs,
): Promise<ImportableGlobalMemory | null> {
  const spec = globalMemorySourceFiles(source, homeDir)
  if (spec.length === 0) return null
  const read = await readGlobalMemorySource(fs, spec)
  if (read.files.length === 0 || read.content.trim() === '') return null

  const destPath = await userInstructionFilePath(fs, homeDir)
  let destContent = ''
  try {
    destContent = await fs.readFile(destPath, { encoding: 'utf-8' })
  } catch {
    /* no user instruction file yet — status is `import` */
  }
  const currentBlock = assembleBlock(source, read.content)
  const existing = extractBlock(destContent, source)
  const status: GlobalMemoryImportStatus =
    existing === null ? 'import' : existing === currentBlock ? 'imported' : 'update'
  return { source, destPath, files: read.files, status }
}

export type GlobalMemoryImportContext = {
  homeDir: string
  fs: RuntimeFs
}

export type GlobalMemoryImportResult = {
  imported: boolean
  /** Number of source files whose content was merged in. */
  filesImported: number
  /** `~/.velloc/AGENTS.md`. */
  destPath: string
}

/** Create the parent directory of `filePath` (and any missing ancestors). */
async function ensureParentDir(fs: RuntimeFs, filePath: string): Promise<void> {
  const idx = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  if (idx > 0) await ensureDirRecursive(fs, filePath.slice(0, idx))
}

/**
 * Import a source's global memory into `~/.velloc/AGENTS.md` (add-only block
 * merge — {@link mergeGlobalMemoryBlock}). Throws when the source has no global
 * memory to import (no files, or all absent/empty). Re-running is the "Update"
 * action — it re-reads the source and replaces the block.
 */
export async function importGlobalMemory(
  source: ImportSource,
  ctx: GlobalMemoryImportContext,
): Promise<GlobalMemoryImportResult> {
  const spec = globalMemorySourceFiles(source, ctx.homeDir)
  if (spec.length === 0) {
    throw new Error(`Source "${source}" has no global memory to import.`)
  }
  const read = await readGlobalMemorySource(ctx.fs, spec)
  if (read.files.length === 0 || read.content.trim() === '') {
    throw new Error(`No global memory found for "${source}".`)
  }
  const destPath = await userInstructionFilePath(ctx.fs, ctx.homeDir)
  let destContent = ''
  try {
    destContent = await ctx.fs.readFile(destPath, { encoding: 'utf-8' })
  } catch {
    /* fresh file */
  }
  const merged = mergeGlobalMemoryBlock(destContent, source, read.content)
  await ensureParentDir(ctx.fs, destPath)
  await ctx.fs.writeFile(destPath, merged, { encoding: 'utf-8' })
  return { imported: true, filesImported: read.files.length, destPath }
}
