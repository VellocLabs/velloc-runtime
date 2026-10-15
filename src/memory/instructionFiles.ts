/**
 * Project-instruction hierarchy. Each location is a SLOT of candidates, first
 * present wins: `AGENTS.md`, then the `CLAUDE.md` names, then the legacy
 * `VELLOC.md` last. Order: user, project (each ancestor), local
 * (`CLAUDE.local.md`); higher priority loads LAST. `@include` resolves outside
 * code fences, depth 5, cycles and missing files ignored. Paths compare as
 * strings (no realpath dedup).
 */

import type { RuntimeConfig } from '../runtime/interfaces/RuntimeConfig'
import {
  processFs,
  type RuntimeFs,
} from '../utils/fs/runtimeFs'
import { joinPath } from './memoryPaths'
import {
  INSTRUCTION_FILE,
  LEGACY_INSTRUCTION_FILE,
  RUNTIME_DIR_NAME,
} from '../branding/runtimeDir'
import { pathCompareKey } from '../utils/runtimePaths'
import { clampMemoryIndex, memoryIndexPath } from './memoryPrompt'
import { isMemoryEnabled, type ResolvedMemorySettings } from './memoryPaths'
import { PROJECT_NOTES_BULLETS_STANDALONE } from './memoryKinds'
import { walkParentDirs } from '../utils/walkParentDirs'
import { isFsTransportFailure } from '../utils/fsTransportFailure'
import { checkWithinRoot } from '../permissions/untrustedReadBoundary'
import { pathMatchesRule } from '../permissions/filePathRuleMatching'

// ============================================================================
// Types
// ============================================================================

export type MemoryType = 'User' | 'Project' | 'Local' | 'AutoMem'

export type InstructionDoc = {
  path: string
  type: MemoryType
  content: string
  /** Path of the file that included this one via `@include`. */
  parent?: string
  /** Glob patterns from frontmatter `paths`. Undefined = match-all. */
  globs?: string[]
}

export type GetMemoryFilesParams = {
  cwd: string
  /**
   * THIS session's fs (`ToolUseContext.options.fsOperations`). Omitted →
   * the realm-global slot, which belongs to whichever runtime wrote it last.
   */
  fs?: RuntimeFs
  /**
   * Per-session project root (Nexus's `getProjectRoot()` analogue). When
   * set, the Project + Local walk-up starts here instead of from `cwd`,
   * anchoring the instruction-file walk to a stable
   * session-startup directory rather than the live shell cwd. When
   * omitted, the walk falls back to `cwd` for back-compat.
   */
  projectRoot?: string
  /**
   * Host-resolved user home dir (`resolveHomeDirViaBridge`). Preferred over
   * the worker env `HOME`/`USERPROFILE` (empty in production). Anchors the
   * user-tier walk, `@include ~/` resolution, and the AutoMem entrypoint
   * (`<configHome>/projects/<slug>/memory/MEMORY.md`) so the index resolves
   * to the SAME directory `buildMemorySystemPrompt` writes its instructions about.
   */
  homeDir?: string
  /**
   * Session-boot snapshot of the user's `memory` settings — gates the
   * AutoMem (`MEMORY.md`) tier and supplies the `directory` override.
   * Threaded from `QueryEngineConfig.memorySettings`.
   */
  memorySettings?: ResolvedMemorySettings
  /**
   * Security: read boundary of a child on an UNTRUSTED provider. Set → the
   * hierarchy comes only from inside this root (no user or AutoMem tier, no
   * walk above it, outside `@include`s dropped): the prompt is uploaded.
   */
  readRoot?: string
  runtimeConfig: RuntimeConfig
}

// Header text injected before the assembled file block.
export const INSTRUCTION_BLOCK_PREAMBLE =
  'Codebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.'

// Recommended max chars per memory file. Display-time hint only — not
// enforced.
export const INSTRUCTION_DOC_SOFT_CHARS = 40_000

const IMPORT_CHAIN_LIMIT = 5

// ============================================================================
// Frontmatter parsing
// ============================================================================

function stripWrappingQuotes(value: string): string {
  if (value.length < 2) return value
  const first = value.charAt(0)
  const last = value.charAt(value.length - 1)
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1)
  }
  return value
}

function parseStringList(raw: string | undefined): string[] {
  if (!raw) return []
  // Two shapes supported: comma-separated (`a, b, c`) and JSON-array-ish
  // (`["a", "b"]`). Mirrors `localSkills.ts:parseStringList`. We do NOT
  // support YAML block lists (`-` per line); nexus stays on the shallow
  // single-line subset.
  const trimmed = raw.trim()
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed
      .slice(1, -1)
      .split(',')
      .map(s => stripWrappingQuotes(s.trim()))
      .filter(s => s.length > 0)
  }
  return trimmed
    .split(',')
    .map(s => stripWrappingQuotes(s.trim()))
    .filter(s => s.length > 0)
}

function splitYamlHeader(content: string): {
  frontmatter: Record<string, string>
  body: string
} {
  if (!content.startsWith('---\n')) {
    return { frontmatter: {}, body: content }
  }
  const closingIndex = content.indexOf('\n---\n', 4)
  if (closingIndex === -1) {
    return { frontmatter: {}, body: content }
  }
  const rawFrontmatter = content.slice(4, closingIndex)
  const body = content.slice(closingIndex + 5)
  const frontmatter: Record<string, string> = {}

  for (const line of rawFrontmatter.split(/\r?\n/)) {
    const separatorIndex = line.indexOf(':')
    if (separatorIndex === -1) continue
    const key = line.slice(0, separatorIndex).trim()
    const rawValue = line.slice(separatorIndex + 1).trim()
    if (key) {
      frontmatter[key] = stripWrappingQuotes(rawValue)
    }
  }

  return { frontmatter, body }
}

// ============================================================================
// HTML comment stripping
// ============================================================================

/**
 * Strip `<!-- ... -->` comments (inline too), except inside ``` / ~~~ fences;
 * an unclosed `<!--` is left in place.
 */
export function dropMarkupNotes(content: string): {
  content: string
  stripped: boolean
} {
  if (!content.includes('<!--')) return { content, stripped: false }

  // Split into segments: alternating prose / fence regions. Fences are
  // detected line-by-line. We rebuild by stripping comments only in
  // prose segments.
  const lines = content.split('\n')
  const out: string[] = []
  let inFence = false
  let fenceMarker = ''
  let stripped = false

  for (const line of lines) {
    const fenceMatch = line.match(/^([`~]{3,})/)
    if (fenceMatch) {
      const marker = fenceMatch[1]!
      if (!inFence) {
        inFence = true
        fenceMarker = marker
      } else if (line.trimStart().startsWith(fenceMarker)) {
        inFence = false
        fenceMarker = ''
      }
      out.push(line)
      continue
    }

    if (inFence) {
      out.push(line)
      continue
    }

    // Prose line — strip well-formed comment spans. Multi-line
    // comments are handled by stripping across the joined-prose
    // segment afterwards.
    out.push(line)
  }

  let result = out.join('\n')
  const commentSpan = /<!--[\s\S]*?-->/g
  if (commentSpan.test(result)) {
    // Reset the regex after `.test()` and strip only outside fences.
    // Approach: walk segments using the same fence detector, strip
    // comments inside prose, leave fenced content untouched.
    commentSpan.lastIndex = 0
    const segmentedOut: string[] = []
    let segInFence = false
    let segMarker = ''
    let proseBuffer = ''
    const flushProse = () => {
      if (proseBuffer === '') return
      const replaced = proseBuffer.replace(commentSpan, '')
      if (replaced !== proseBuffer) stripped = true
      segmentedOut.push(replaced)
      proseBuffer = ''
    }
    for (const line of result.split('\n')) {
      const fenceMatch = line.match(/^([`~]{3,})/)
      if (fenceMatch) {
        const marker = fenceMatch[1]!
        if (!segInFence) {
          flushProse()
          segInFence = true
          segMarker = marker
          segmentedOut.push(line)
          continue
        }
        if (line.trimStart().startsWith(segMarker)) {
          segInFence = false
          segMarker = ''
          segmentedOut.push(line)
          continue
        }
      }
      if (segInFence) {
        segmentedOut.push(line)
      } else {
        proseBuffer += (proseBuffer ? '\n' : '') + line
      }
    }
    flushProse()
    result = segmentedOut.join('\n')
  }

  return { content: result, stripped }
}

// ============================================================================
// @include resolution
// ============================================================================

function dirname(filePath: string): string {
  const idx = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  if (idx <= 0) return filePath
  return filePath.slice(0, idx)
}

function isAbsolutePath(value: string): boolean {
  if (value.length === 0) return false
  if (value[0] === '/' || value[0] === '\\') return true
  return /^[A-Za-z]:[\\/]/.test(value)
}

function resolveIncludePath(
  pathRef: string,
  homeDir: string | undefined,
  baseDir: string,
): string | undefined {
  // Strip fragment identifiers (#heading).
  const hashIdx = pathRef.indexOf('#')
  const cleaned = hashIdx === -1 ? pathRef : pathRef.slice(0, hashIdx)
  if (cleaned.length === 0) return undefined

  if (cleaned.startsWith('~/') || cleaned.startsWith('~\\')) {
    if (!homeDir) return undefined
    return joinPath(homeDir, cleaned.slice(2))
  }
  if (cleaned.startsWith('./') || cleaned.startsWith('.\\')) {
    return joinPath(baseDir, cleaned.slice(2))
  }
  if (isAbsolutePath(cleaned)) return cleaned
  // Bare path → relative to baseDir.
  return joinPath(baseDir, cleaned)
}

/**
 * Extract `@`-prefixed include references from a block of prose. Skips
 * fenced code blocks entirely (no `@import` inside a ```` ``` ```` example
 * should fire): only text outside code is scanned.
 */
export function extractIncludeRefs(content: string): string[] {
  const refs: string[] = []
  // Match `@` preceded by start-of-line or whitespace, then a
  // non-whitespace path (escapes for spaces handled via `\ `).
  const includeRegex = /(?:^|\s)@((?:[^\s\\]|\\ )+)/g

  const lines = content.split('\n')
  let inFence = false
  let fenceMarker = ''

  for (const line of lines) {
    const fenceMatch = line.match(/^([`~]{3,})/)
    if (fenceMatch) {
      const marker = fenceMatch[1]!
      if (!inFence) {
        inFence = true
        fenceMarker = marker
      } else if (line.trimStart().startsWith(fenceMarker)) {
        inFence = false
        fenceMarker = ''
      }
      continue
    }
    if (inFence) continue

    let match: RegExpExecArray | null
    while ((match = includeRegex.exec(line)) !== null) {
      const raw = match[1]?.replace(/\\ /g, ' ')
      if (!raw) continue
      // Reject things that obviously aren't paths.
      if (raw.startsWith('@')) continue
      if (/^[#%^&*()]+/.test(raw)) continue
      refs.push(raw)
    }
  }

  return refs
}

// ============================================================================
// Read a memory file
// ============================================================================

function getHomeDir(runtimeConfig: RuntimeConfig): string | undefined {
  return (
    runtimeConfig.getEnv('HOME') ??
    runtimeConfig.getEnv('USERPROFILE') ??
    undefined
  )
}

type ReadAndParseOptions = {
  fs: RuntimeFs
  filePath: string
  type: MemoryType
  homeDir: string | undefined
}

type ReadAndParseResult = {
  info: InstructionDoc | null
  includes: string[]
}

async function readAndParse({
  fs,
  filePath,
  type,
  homeDir,
}: ReadAndParseOptions): Promise<ReadAndParseResult> {
  let raw: string
  try {
    raw = await fs.readFile(filePath, { encoding: 'utf-8' })
  } catch {
    return { info: null, includes: [] }
  }

  const { frontmatter, body } = splitYamlHeader(raw)
  const stripped = dropMarkupNotes(body).content
  const trimmed = stripped.trim()
  if (trimmed.length === 0) {
    return { info: null, includes: [] }
  }

  // MEMORY.md (AutoMem entrypoint) gets the same truncation caps as
  // the auto-memory prompt path.
  const finalContent =
    type === 'AutoMem' ? clampMemoryIndex(stripped).content : stripped

  const globs = parseStringList(frontmatter.paths)
  const baseDir = dirname(filePath)
  const includeRefs = extractIncludeRefs(stripped)
  const includes: string[] = []
  for (const ref of includeRefs) {
    const resolved = resolveIncludePath(ref, homeDir, baseDir)
    if (resolved) includes.push(resolved)
  }

  return {
    info: {
      path: filePath,
      type,
      content: finalContent,
      globs: globs.length > 0 ? globs : undefined,
    },
    includes,
  }
}

/**
 * Recursively process a memory file and its `@include` chain. Returns
 * the file plus included files in depth-first order (parent first,
 * children appended after).
 */
async function expandInstructionDoc(
  fs: RuntimeFs,
  filePath: string,
  type: MemoryType,
  homeDir: string | undefined,
  visitedDocs: Set<string>,
  depth: number,
  parent: string | undefined,
  readRoot?: string,
): Promise<InstructionDoc[]> {
  if (depth >= IMPORT_CHAIN_LIMIT) return []
  // Under a read boundary, a file outside the root is not read — including an
  // `@include` target: `@~/secrets.md` from an in-root file is exactly the
  // escape a slot-level check would miss.
  if (readRoot && !checkWithinRoot(filePath, readRoot).ok) return []
  const key = pathCompareKey(filePath)
  if (visitedDocs.has(key)) return []
  visitedDocs.add(key)

  const { info, includes } = await readAndParse({
    fs,
    filePath,
    type,
    homeDir,
  })
  if (!info) return []

  if (parent) info.parent = parent
  const out: InstructionDoc[] = [info]

  for (const includePath of includes) {
    const included = await expandInstructionDoc(
      fs,
      includePath,
      type,
      homeDir,
      visitedDocs,
      depth + 1,
      filePath,
      readRoot,
    )
    out.push(...included)
  }

  return out
}

/**
 * One instruction file as the memory loader reads it (frontmatter and HTML
 * comments stripped, an empty file not read) and then each file its
 * `@include`s brought, in load order. What F-25's `$.fs.ancestors` serves as
 * an entry's `parts`, so a plugin's file and the engine's agree on the text.
 */
export async function readInstructionFileParts(
  fs: RuntimeFs,
  filePath: string,
  homeDir?: string,
  readRoot?: string,
): Promise<InstructionDoc[]> {
  return expandInstructionDoc(fs, filePath, 'Project', homeDir, new Set(), 0, undefined, readRoot)
}

// ============================================================================
// Instruction-file slots — the first candidate present loads, read in place
// ============================================================================

/**
 * Classify one slot candidate: `'present'`; `'unreadable'` (a non-ENOENT
 * error or dead bridge, so the slot stops there); `'absent'` (ENOENT or a
 * code-less error, so the next candidate is tried).
 */
async function probeInstructionFile(
  fs: RuntimeFs,
  path: string,
): Promise<'present' | 'absent' | 'unreadable'> {
  try {
    await fs.readFile(path, { encoding: 'utf-8' })
    return 'present'
  } catch (err) {
    const code = (err as { code?: unknown }).code
    if (typeof code === 'string' && code !== 'ENOENT') return 'unreadable'
    if (
      isFsTransportFailure(err) ||
      (err as { bridgeCode?: unknown }).bridgeCode === 'bridge_timeout'
    ) {
      return 'unreadable'
    }
    return 'absent'
  }
}

/**
 * The USER tier's slot: `~/.velloc/AGENTS.md`, then
 * `~/.claude/CLAUDE.md`. One list for the loader, the read-only discovery and
 * the Settings → Instructions editor — three copies of it is how the editor
 * once drifted onto a path the loader did not agree with.
 */
export function userInstructionCandidates(homeDir: string): string[] {
  return [
    joinPath(homeDir, RUNTIME_DIR_NAME, INSTRUCTION_FILE),
    joinPath(homeDir, '.claude', 'CLAUDE.md'),
    // Legacy, last: what Velloc read before AGENTS.md (see `runtimeDir.ts`).
    joinPath(homeDir, RUNTIME_DIR_NAME, 'CLAUDE.md'),
    joinPath(homeDir, RUNTIME_DIR_NAME, LEGACY_INSTRUCTION_FILE),
  ]
}

/** A project directory's two PROJECT slots: `<dir>/AGENTS.md` then
 *  `<dir>/CLAUDE.md`, and `<dir>/.claude/CLAUDE.md`. */
export function projectInstructionSlots(dir: string): string[][] {
  return [
    [
      joinPath(dir, INSTRUCTION_FILE),
      joinPath(dir, 'CLAUDE.md'),
      joinPath(dir, LEGACY_INSTRUCTION_FILE),
    ],
    [
      joinPath(dir, '.claude', 'CLAUDE.md'),
      joinPath(dir, RUNTIME_DIR_NAME, LEGACY_INSTRUCTION_FILE),
    ],
  ]
}

/** A project directory's LOCAL (gitignored) slot:
 *  `CLAUDE.local.md` — AGENTS.md has no local form. */
export function localInstructionCandidates(dir: string): string[] {
  return [joinPath(dir, 'CLAUDE.local.md')]
}

/**
 * A project directory's candidates minus the USER tier's own files. The
 * default project sits under `~/.velloc/`, so that directory is an ancestor
 * the project walk visits — and `~/.velloc/CLAUDE.md` / `~/.velloc/VELLOC.md`
 * are both its project candidates and the user slot's legacy ones. Left in,
 * a user slot won by `~/.claude/CLAUDE.md` would still have them loaded a
 * second time as Project files. Those paths are the user tier's alone.
 */
function withoutUserTierFiles(
  candidates: readonly string[],
  homeDir: string | undefined,
): string[] {
  if (!homeDir) return [...candidates]
  const userKeys = new Set(userInstructionCandidates(homeDir).map(pathCompareKey))
  return candidates.filter(path => !userKeys.has(pathCompareKey(path)))
}

/** The slot's file: its first candidate not absent, or `null`. */
async function resolveInstructionSlot(
  fs: RuntimeFs,
  candidates: readonly string[],
): Promise<string | null> {
  for (const path of candidates) {
    if ((await probeInstructionFile(fs, path)) !== 'absent') return path
  }
  return null
}

/**
 * The USER-tier instruction file an EDITOR (or the global-memory import)
 * should read and write: the file the loader loads, so an edit lands on what
 * reaches the prompt — creating `~/.velloc/AGENTS.md` beside a loaded
 * `~/.claude/CLAUDE.md` would shadow that file. `~/.velloc/AGENTS.md` when
 * no candidate exists yet: the place to create one.
 */
export async function resolveUserInstructionPath(
  fs: RuntimeFs,
  homeDir: string,
): Promise<string> {
  const candidates = userInstructionCandidates(homeDir)
  return (await resolveInstructionSlot(fs, candidates)) ?? candidates[0]!
}

/** Resolve a slot then process the chosen file (+ its @includes). */
async function loadInstructionSlot(
  fs: RuntimeFs,
  candidates: readonly string[],
  type: MemoryType,
  homeDir: string | undefined,
  visitedDocs: Set<string>,
  readRoot?: string,
): Promise<InstructionDoc[]> {
  const resolved = await resolveInstructionSlot(fs, candidates)
  if (!resolved) return []
  return expandInstructionDoc(
    fs,
    resolved,
    type,
    homeDir,
    visitedDocs,
    0,
    undefined,
    readRoot,
  )
}

// ============================================================================
// Tier loaders
// ============================================================================

async function loadUserTier(
  fs: RuntimeFs,
  homeDir: string | undefined,
  visitedDocs: Set<string>,
): Promise<InstructionDoc[]> {
  if (!homeDir) return []
  const out: InstructionDoc[] = []
  const visitedRulesDirs = new Set<string>()

  // User instruction file: `~/.velloc/AGENTS.md`, else
  // `~/.claude/CLAUDE.md`, read in place.
  out.push(
    ...(await loadInstructionSlot(
      fs,
      userInstructionCandidates(homeDir),
      'User',
      homeDir,
      visitedDocs,
    )),
  )

  // User-tier rules: walk both `~/.velloc/rules/` (preferred) and
  // `~/.claude/rules/` (legacy). Recursive `*.md` discovery.
  for (const sub of [RUNTIME_DIR_NAME, '.claude']) {
    const rulesDir = joinPath(homeDir, sub, 'rules')
    const ruleFiles = await processRulesDir(
      fs,
      rulesDir,
      'User',
      homeDir,
      visitedDocs,
      visitedRulesDirs,
      // Eager pass: only always-on rules (no `paths:` globs). Path-scoped
      // rules load on-demand per file-read (getConditionalRulesForPath).
      false,
    )
    out.push(...ruleFiles)
  }
  return out
}

/**
 * Recursively load `*.md` rules under `.velloc/rules` / `.claude/rules`,
 * frontmatter `paths` onto `InstructionDoc.globs`. Best-effort.
 */
async function processRulesDir(
  fs: RuntimeFs,
  rulesDir: string,
  type: MemoryType,
  homeDir: string | undefined,
  visitedDocs: Set<string>,
  visitedDirs: Set<string>,
  /**
   * `false` → only rules without `paths:` (always-on); `true` → only globbed
   * rules; `undefined` → all.
   */
  conditionalRule?: boolean,
  readRoot?: string,
): Promise<InstructionDoc[]> {
  if (visitedDirs.has(rulesDir)) return []
  visitedDirs.add(rulesDir)

  let entries
  try {
    entries = await fs.readdir(rulesDir)
  } catch {
    return []
  }

  // Enumerate: recurse subdirectories now; defer top-level `.md` files so we
  // can order them includer-before-include (see the pre-scan below).
  const out: InstructionDoc[] = []
  const mdFiles: string[] = []
  for (const entry of entries) {
    const entryPath = joinPath(rulesDir, entry.name)
    if (entry.isDirectory()) {
      out.push(
        ...(await processRulesDir(
          fs,
          entryPath,
          type,
          homeDir,
          visitedDocs,
          visitedDirs,
          conditionalRule,
          readRoot,
        )),
      )
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      mdFiles.push(entryPath)
    }
  }

  // A sibling an included rule `@include`s must inherit the includer's
  // conditional-ness, and `readdir` order is not guaranteed: process sibling
  // include-targets after their includers.
  const fileKeys = new Set(mdFiles.map(pathCompareKey))
  const includeTargets = new Set<string>()
  for (const filePath of mdFiles) {
    const { includes } = await readAndParse({ fs, filePath, type, homeDir })
    for (const inc of includes) {
      const incKey = pathCompareKey(inc)
      if (fileKeys.has(incKey)) includeTargets.add(incKey)
    }
  }
  const ordered = [
    ...mdFiles.filter(f => !includeTargets.has(pathCompareKey(f))),
    ...mdFiles.filter(f => includeTargets.has(pathCompareKey(f))),
  ]

  for (const filePath of ordered) {
    const files = await expandInstructionDoc(
      fs,
      filePath,
      type,
      homeDir,
      visitedDocs,
      0,
      undefined,
      readRoot,
    )
    // Classify the WHOLE `[rule, ...@include children]` chain by the ROOT rule
    // file's globs (`files[0]`), NOT per-file. An `@include` child carries no
    // `paths:` globs of its own, so a per-file filter would mis-route it: the
    // EAGER pass would keep it (the scoped rule's included body LEAKS into
    // every turn's prompt) and the CONDITIONAL pass would drop it (no globs to
    // match → the body is MISSING when the rule fires). Keying the whole chain
    // off the root keeps the included body exactly as conditional as the rule
    // that pulls it in.
    const root = files[0]
    if (!root) continue
    const rootHasGlobs = !!(root.globs && root.globs.length > 0)
    if (conditionalRule === true && !rootHasGlobs) continue
    if (conditionalRule === false && rootHasGlobs) continue
    out.push(...files)
  }

  return out
}

async function loadProjectAndLocalTiers(
  fs: RuntimeFs,
  cwd: string,
  homeDir: string | undefined,
  visitedDocs: Set<string>,
  readRoot?: string,
): Promise<{ project: InstructionDoc[]; local: InstructionDoc[] }> {
  // Walk from cwd up, collecting Project + Local files, closer-to-cwd
  // loaded last → highest priority. We collect bottom-up then reverse: the
  // assembled prompt ends with the file closest to cwd, since later files
  // have higher priority.
  const projectBottomUp: InstructionDoc[] = []
  const localBottomUp: InstructionDoc[] = []
  const visitedRulesDirs = new Set<string>()

  for (const entry of walkParentDirs(cwd, { homeDir })) {
    if (entry.isHome) {
      // The User loader handles the home dir itself; the project walk
      // should not re-pick `~/CLAUDE.md` or `~/.claude/CLAUDE.md`.
      break
    }
    // Under a read boundary the walk stops at the root: the first ancestor
    // above it is outside, and so is everything further up.
    if (readRoot && !checkWithinRoot(entry.dir, readRoot).ok) break

    // Two Project slots per dir (`projectInstructionSlots`):
    //   • `<dir>/AGENTS.md` ← `<dir>/CLAUDE.md`
    //   • `<dir>/.claude/CLAUDE.md`
    for (const candidates of projectInstructionSlots(entry.dir)) {
      projectBottomUp.push(
        ...(await loadInstructionSlot(
          fs,
          withoutUserTierFiles(candidates, homeDir),
          'Project',
          homeDir,
          visitedDocs,
          readRoot,
        )),
      )
    }

    // Recursively pull in everything under the rules directories at
    // this tier. Rule files are categorized as Project memory — they're
    // checked into the repo alongside AGENTS.md / CLAUDE.md.
    for (const sub of [RUNTIME_DIR_NAME, '.claude']) {
      const rulesDir = joinPath(entry.dir, sub, 'rules')
      const ruleFiles = await processRulesDir(
        fs,
        rulesDir,
        'Project',
        homeDir,
        visitedDocs,
        visitedRulesDirs,
        // Eager pass: only always-on rules. Path-scoped (`paths:`) rules are
        // injected on-demand when a matching file is read.
        false,
        readRoot,
      )
      projectBottomUp.push(...ruleFiles)
    }

    // Local (gitignored) slot: `<dir>/CLAUDE.local.md`.
    localBottomUp.push(
      ...(await loadInstructionSlot(
        fs,
        withoutUserTierFiles(localInstructionCandidates(entry.dir), homeDir),
        'Local',
        homeDir,
        visitedDocs,
        readRoot,
      )),
    )
  }

  return {
    project: projectBottomUp.reverse(),
    local: localBottomUp.reverse(),
  }
}

/**
 * Path of `targetPath` relative to `baseDir`, or `null` when `targetPath` is
 * not strictly under `baseDir`. Normalizes slashes + Windows drive-letter case.
 * A file outside the base can't match base-relative globs.
 */
function relativeUnder(baseDir: string, targetPath: string): string | null {
  const base = pathCompareKey(baseDir)
  const target = pathCompareKey(targetPath)
  if (!base || !target || target === base) return null
  if (target.startsWith(`${base}/`)) return target.slice(base.length + 1)
  return null
}

/**
 * The `paths:`-scoped rules matching a just-read file, over every ancestor of
 * the file up to home. Project globs are relative to the dir holding
 * `.velloc`/`.claude`, user globs to the project root. Deduped; best-effort.
 */
export async function getConditionalRulesForPath(
  targetPath: string,
  params: {
    projectRoot?: string
    homeDir?: string
    /** Same contract as `GetMemoryFilesParams.readRoot`. */
    readRoot?: string
    runtimeConfig: RuntimeConfig
    /** Same contract as `GetMemoryFilesParams.fs`. */
    fs?: RuntimeFs
  },
): Promise<InstructionDoc[]> {
  if (!targetPath || typeof targetPath !== 'string') return []
  const readRoot = params.readRoot
  const fs = params.fs ?? processFs()
  const homeDir = params.homeDir ?? getHomeDir(params.runtimeConfig)
  const visitedDocs = new Set<string>()
  const visitedRulesDirs = new Set<string>()
  const matched: InstructionDoc[] = []

  const collect = async (
    rulesDir: string,
    type: MemoryType,
    baseDir: string,
  ): Promise<void> => {
    // conditionalRule=true → only chains whose ROOT rule has `paths:` globs
    // (processRulesDir now classifies by the root, so an `@include` child of a
    // globbed rule rides along even though it has no globs of its own).
    const rules = await processRulesDir(
      fs,
      rulesDir,
      type,
      homeDir,
      visitedDocs,
      visitedRulesDirs,
      true,
      readRoot,
    )
    // Roots whose glob matched this read. Their `@include` descendants (no
    // globs of their own) must be injected alongside the matched root — they
    // carry `parent` and follow their parent in depth-first iteration order,
    // so a parent is always recorded before we reach its descendants.
    const matchedRoots = new Set<string>()
    for (const rule of rules) {
      if (
        rule.parent &&
        matchedRoots.has(pathCompareKey(rule.parent))
      ) {
        matched.push(rule)
        // Record this child too, so a grandchild (`@include` nested in the
        // included file) chains through.
        matchedRoots.add(pathCompareKey(rule.path))
        continue
      }
      if (!rule.globs || rule.globs.length === 0) continue
      const rel = relativeUnder(baseDir, targetPath)
      if (rel === null) continue
      if (rule.globs.some(glob => pathMatchesRule(glob, rel))) {
        matched.push(rule)
        matchedRoots.add(pathCompareKey(rule.path))
      }
    }
  }

  // User-tier conditional rules: `~/.velloc/rules`, `~/.claude/rules`. Their
  // globs are keyed off the project root.
  if (homeDir && !readRoot) {
    const userBase = params.projectRoot ?? homeDir
    for (const sub of [RUNTIME_DIR_NAME, '.claude']) {
      await collect(joinPath(homeDir, sub, 'rules'), 'User', userBase)
    }
  }

  // Project-tier conditional rules: a rule in `<dir>/.velloc/rules` (or
  // `.claude/rules`) applies to files under `<dir>`. Walk the read file's
  // ancestor dirs up to home.
  for (const entry of walkParentDirs(dirname(targetPath), { homeDir })) {
    if (readRoot && !checkWithinRoot(entry.dir, readRoot).ok) break
    for (const sub of [RUNTIME_DIR_NAME, '.claude']) {
      await collect(joinPath(entry.dir, sub, 'rules'), 'Project', entry.dir)
    }
    if (entry.isHome) break
  }

  return matched
}

/**
 * What several `getNestedInstructionFilesForPath` calls over one batch of
 * reads share, so a directory two read files sit under is read once, not once
 * per file: the include-cycle guard and the directories already walked.
 */
export type NestedInstructionWalkMemo = {
  visitedDocs: Set<string>
  dirs: Set<string>
}

export function createNestedInstructionWalkMemo(): NestedInstructionWalkMemo {
  return { visitedDocs: new Set(), dirs: new Set() }
}

/**
 * Instruction files of the directories strictly BELOW the anchor that hold a
 * just-read file, parent first, with the eager walk's slots. Anchor: the
 * untrusted read boundary, else the project root, else cwd; outside it,
 * nothing. Under a read boundary nothing outside the root is read.
 */
export async function getNestedInstructionFilesForPath(
  targetPath: string,
  params: {
    cwd?: string
    projectRoot?: string
    homeDir?: string
    /** Same contract as `GetMemoryFilesParams.readRoot`. */
    readRoot?: string
    runtimeConfig: RuntimeConfig
    /** Same contract as `GetMemoryFilesParams.fs`. */
    fs?: RuntimeFs
    /** Share one walk across a batch of reads: a directory already in it
     *  yields nothing again (its files came back with the first call). */
    memo?: NestedInstructionWalkMemo
  },
): Promise<InstructionDoc[]> {
  if (!targetPath || typeof targetPath !== 'string') return []
  const anchor = params.readRoot ?? params.projectRoot ?? params.cwd
  if (!anchor) return []
  const rel = relativeUnder(anchor, dirname(targetPath))
  if (rel === null) return []
  const fs = params.fs ?? processFs()
  const homeDir = params.homeDir ?? getHomeDir(params.runtimeConfig)
  const visitedDocs = params.memo?.visitedDocs ?? new Set<string>()
  const out: InstructionDoc[] = []
  let dir = anchor.replace(/[\\/]+$/, '')
  for (const segment of rel.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') return out
    dir = joinPath(dir, segment)
    if (params.readRoot && !checkWithinRoot(dir, params.readRoot).ok) return out
    const dirKey = pathCompareKey(dir)
    if (params.memo?.dirs.has(dirKey)) continue
    for (const candidates of projectInstructionSlots(dir)) {
      out.push(
        ...(await loadInstructionSlot(fs, candidates, 'Project', homeDir, visitedDocs, params.readRoot)),
      )
    }
    out.push(
      ...(await loadInstructionSlot(
        fs,
        localInstructionCandidates(dir),
        'Local',
        homeDir,
        visitedDocs,
        params.readRoot,
      )),
    )
    // Marked only once the whole directory loaded: a throw above leaves it
    // unvisited, so the next read file under it tries again.
    params.memo?.dirs.add(dirKey)
  }
  return out
}

async function loadAutoMemTier(
  fs: RuntimeFs,
  cwd: string,
  runtimeConfig: RuntimeConfig,
  visitedDocs: Set<string>,
  options: {
    projectRoot?: string
    homeDir?: string
    memorySettings?: ResolvedMemorySettings
  } = {},
): Promise<InstructionDoc[]> {
  if (!isMemoryEnabled(runtimeConfig, options.memorySettings)) return []
  const homeDir = options.homeDir ?? getHomeDir(runtimeConfig)
  const entrypoint = memoryIndexPath(cwd, runtimeConfig, {
    projectRoot: options.projectRoot,
    homeDir,
    memorySettings: options.memorySettings,
  })
  return expandInstructionDoc(
    fs,
    entrypoint,
    'AutoMem',
    homeDir,
    visitedDocs,
    0,
    undefined,
  )
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Every instruction file reachable from `cwd` plus `@include` chains, in
 * prompt order: User, Project (root → cwd), Local (root → cwd), AutoMem. No
 * caching.
 */
export async function gatherInstructionDocs(
  params: GetMemoryFilesParams,
): Promise<InstructionDoc[]> {
  const fs = params.fs ?? processFs()
  // Prefer the host-resolved home (the worker env has no HOME/USERPROFILE in
  // production); fall back to the env for tests that stub it.
  const homeDir = params.homeDir ?? getHomeDir(params.runtimeConfig)
  const visitedDocs = new Set<string>()

  // Project + Local walk-up anchors to projectRoot when provided
  // (Nexus's stable per-session anchor), else falls back to cwd, so the
  // walk is decoupled from the live cwd.
  //
  // Under a read boundary the anchor is the ROOT itself, not projectRoot: a
  // worktree-isolated untrusted child's projectRoot is the canonical repo
  // (its memory/skills anchor), which lies outside its own worktree.
  const readRoot = params.readRoot
  const walkAnchor = readRoot ?? params.projectRoot ?? params.cwd

  // The user tier lives under the home directory — outside any read root by
  // construction — and the AutoMem entrypoint under `<configHome>/projects/`.
  // Neither is read for a bounded session (memory is also forced off for one
  // in `createAgentRuntime`; this is the belt to that brace).
  const user = readRoot ? [] : await loadUserTier(fs, homeDir, visitedDocs)
  const { project, local } = await loadProjectAndLocalTiers(
    fs,
    walkAnchor,
    homeDir,
    visitedDocs,
    readRoot,
  )
  const autoMem = readRoot
    ? []
    : await loadAutoMemTier(fs, params.cwd, params.runtimeConfig, visitedDocs, {
        projectRoot: params.projectRoot,
        homeDir,
        memorySettings: params.memorySettings,
      })

  return [...user, ...project, ...local, ...autoMem]
}

/**
 * Format a list of InstructionDoc entries into a single prompt block.
 * The lead `INSTRUCTION_BLOCK_PREAMBLE` line plus
 * one section per file labeled with its path.
 *
 * Returns an empty string when there are no files; callers can use that
 * to skip injecting the field entirely.
 */
export function formatMemoryFilesForPrompt(files: InstructionDoc[]): string {
  if (files.length === 0) return ''
  const sections: string[] = [INSTRUCTION_BLOCK_PREAMBLE, '']
  for (const file of files) {
    sections.push(`Contents of ${file.path}:`)
    sections.push('')
    sections.push(file.content.trim())
    sections.push('')
  }
  return sections.join('\n').trim()
}

/**
 * The instruction-file tier rules as their own prompt part, for auto-memory
 * OFF only; not in `formatMemoryFilesForPrompt`, which is skipped when there
 * are no instruction files.
 */
export function instructionPersistenceFallbackPrompt(): string {
  return PROJECT_NOTES_BULLETS_STANDALONE.join('\n')
}

/** Instruction-file tier (excludes `AutoMem` — MEMORY.md is a memory, not an
 *  authored instruction file). */
export type InstructionTier = 'User' | 'Project' | 'Local'

export type InstructionFileInfo = {
  path: string
  tier: InstructionTier
}

/**
 * Read-only discovery of the files `gatherInstructionDocs` would load (path
 * per slot, no content, no `@include`), for Settings → Memory. AutoMem is
 * omitted.
 */
export async function discoverInstructionFiles(params: {
  cwd: string
  projectRoot?: string
  homeDir?: string
  /** The caller's own fs; omitted → the realm-global slot. */
  fs?: RuntimeFs
}): Promise<InstructionFileInfo[]> {
  const fs = params.fs ?? processFs()
  const homeDir = params.homeDir
  const out: InstructionFileInfo[] = []
  const seen = new Set<string>()

  const exists = async (p: string): Promise<boolean> => {
    try {
      await fs.readFile(p, { encoding: 'utf-8' })
      return true
    } catch {
      return false
    }
  }
  // The path a slot loads: its first candidate present.
  const slot = async (candidates: readonly string[]): Promise<string | null> => {
    for (const path of candidates) {
      if (await exists(path)) return path
    }
    return null
  }
  const push = (path: string | null, tier: InstructionTier): void => {
    if (!path) return
    const key = pathCompareKey(path)
    if (seen.has(key)) return
    seen.add(key)
    out.push({ path, tier })
  }
  const pushRules = async (
    rulesDir: string,
    tier: InstructionTier,
  ): Promise<void> => {
    let entries
    try {
      entries = await fs.readdir(rulesDir)
    } catch {
      return
    }
    for (const entry of entries) {
      const p = joinPath(rulesDir, entry.name)
      if (entry.isDirectory()) await pushRules(p, tier)
      else if (entry.isFile() && entry.name.endsWith('.md')) push(p, tier)
    }
  }

  // User tier: `~/.velloc/AGENTS.md` ← `~/.claude/CLAUDE.md`, + rules.
  if (homeDir) {
    push(await slot(userInstructionCandidates(homeDir)), 'User')
    for (const sub of [RUNTIME_DIR_NAME, '.claude']) {
      await pushRules(joinPath(homeDir, sub, 'rules'), 'User')
    }
  }

  // Project + Local tiers: walk up from projectRoot (or cwd) to home.
  const walkAnchor = params.projectRoot ?? params.cwd
  for (const entry of walkParentDirs(walkAnchor, { homeDir })) {
    if (entry.isHome) break
    for (const candidates of projectInstructionSlots(entry.dir)) {
      push(await slot(withoutUserTierFiles(candidates, homeDir)), 'Project')
    }
    for (const sub of [RUNTIME_DIR_NAME, '.claude']) {
      await pushRules(joinPath(entry.dir, sub, 'rules'), 'Project')
    }
    push(
      await slot(withoutUserTierFiles(localInstructionCandidates(entry.dir), homeDir)),
      'Local',
    )
  }

  return out
}
