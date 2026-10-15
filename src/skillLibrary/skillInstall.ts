/**
 * Install a skill from a GitHub repo into `~/.velloc/skills/<name>/`: each file
 * from the raw CDN, written with `writeExtractedFiles`. The file list comes from
 * the prebuilt `public/skills-catalog.json`, so install makes no GitHub API
 * calls.
 */

import { joinPath } from '../memory/memoryPaths'
import {
  descriptionAsText,
  readMarkdownHeader,
} from '../utils/frontmatter'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import type { ExtractedFile } from '../pluginHost/extract'
import { writeExtractedFiles } from '../pluginHost/writeExtracted'
import { NEXUS_DIR_NAME } from '../settings/settingSources'

export const SKILLS_DIR_NAME = 'skills'
/** Sidecar written into each installed skill dir to record where it came from
 *  (so `listInstalled` can report the catalog id and `uninstall` can match it).
 *  A dotfile + `.json` so the skills loader (which only loads SKILL.md / *.md)
 *  ignores it. */
export const SKILL_PROVENANCE_FILE = `${NEXUS_DIR_NAME}-skill.json`

/**
 * Defensive cap — a tampered catalog can't make us fetch unbounded files. Sized
 * to clear the largest real skills (e.g. `openai/cloudflare-deploy` ≈ 312 files)
 * with headroom. EXCEEDING the cap is a hard error, NOT a silent truncation —
 * we never write a partial skill and then report success.
 */
const MAX_SKILL_FILES = 1000

/** How many file downloads to run at once. Parallelism keeps even a few-hundred
 *  file skill well under the settings-bridge request timeout (sequential
 *  fetches of 300+ files would blow past it, the worker would keep going, and
 *  the UI would wrongly report failure). */
const FETCH_CONCURRENCY = 8

/** Upper bound on collision-suffix probes when even the publisher-namespaced
 *  dir is occupied by an UNRELATED skill — far above any realistic count of
 *  same-named skills, purely a backstop against an unbounded loop. */
const MAX_DIR_COLLISION_PROBES = 1000

/** A catalog skill, as passed from the UI's `skills-catalog.json` entry. */
export type SkillInstallInput = {
  id: string
  name: string
  publisher: string
  repo: string
  branch: string
  /** The skill's directory within the repo (e.g. `skills/pdf`). */
  path: string
  /** Relative paths of every file under `path` (e.g. `SKILL.md`,
   *  `scripts/run.py`). */
  files: string[]
}

export type InstalledSkillEntry = {
  id: string
  name: string
  publisher?: string
  repo?: string
  /** Directory name under `~/.velloc/skills/`. */
  dir: string
  installedAt?: string
  fileCount?: number
  /** One-line description read from the dir's SKILL.md at LIST time (never
   *  persisted in the sidecar). The settings page needs it for a skill the
   *  marketplace catalog does not know — a manually-placed or imported one. */
  description?: string
}

/** Description length cap for a skill list row. */
const MAX_ROW_DESC_CHARS = 200

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`
}

/** First non-blank body line, heading marker stripped (matches the loader's
 *  `deriveDescription` shape, minus the 100-char cap we replace with our own). */
function firstMeaningfulLine(body: string): string | undefined {
  for (const raw of body.split(/\r?\n/)) {
    const trimmed = raw.trim()
    if (trimmed.length === 0) continue
    const heading = trimmed.match(/^#+\s+(.+)$/)
    return (heading ? heading[1]!.trim() : trimmed) || undefined
  }
  return undefined
}

/**
 * The display name + one-line description of a SKILL.md, for a list row:
 * frontmatter `name` (else `fallbackName`), frontmatter `description` (else the
 * first body line, else the name), whitespace-collapsed and capped. Shared by
 * the Import dialog's rows and the settings page's installed rows.
 */
export function describeSkillMarkdown(
  raw: string,
  filePath: string,
  nameIfMissing: string,
): { name: string; description: string } {
  const { frontmatter, content: body } = readMarkdownHeader(raw, filePath)
  const name =
    (typeof frontmatter.name === 'string' ? frontmatter.name.trim() : '')
    || nameIfMissing
  const description = truncate(
    (
      descriptionAsText(frontmatter.description, name)
      ?? firstMeaningfulLine(body)
      ?? name
    )
      .replace(/\s+/g, ' ')
      .trim(),
    MAX_ROW_DESC_CHARS,
  )
  return { name, description }
}

export type SkillInstallContext = {
  homeDir: string
  fs: RuntimeFs
  fetchImpl: typeof fetch
  /** Injected for tests; defaults to `new Date().toISOString()`. */
  now?: () => string
}

export function getSkillsDirectory(homeDir: string): string {
  return joinPath(homeDir, NEXUS_DIR_NAME, SKILLS_DIR_NAME)
}

/** A safe single path segment for a skill directory name. */
export function sanitizeSkillDirName(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? name
  const cleaned = base
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|-+$/g, '')
  return cleaned || 'skill'
}

/** Normalize a relative file path; return null if it escapes the skill dir
 *  (zip-slip guard — we don't reuse the tar extractor's sanitizer here because
 *  this path never goes through `extract.ts`). */
export function sanitizeRelPath(rel: string): string | null {
  const norm = rel.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!norm || norm.includes('\0')) return null
  const segs: string[] = []
  for (const seg of norm.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') return null
    if (/^[A-Za-z]:$/.test(seg)) return null // windows drive
    segs.push(seg)
  }
  return segs.length ? segs.join('/') : null
}

function rawUrl(skill: SkillInstallInput, rel: string): string {
  // Percent-encode each path SEGMENT (preserving the `/` separators) so a file
  // or skill path containing spaces / `#` / `?` / other reserved characters
  // produces a valid URL instead of a truncated or malformed one. `repo` and
  // `branch` are left as-is — they're structural single segments on the raw
  // host and may legitimately not need (or want) re-encoding.
  const encPath = (p: string) =>
    p.split('/').map(encodeURIComponent).join('/')
  return `https://raw.githubusercontent.com/${skill.repo}/${skill.branch}/${encPath(skill.path)}/${encPath(rel)}`
}

/**
 * Download every file of a skill from the raw CDN, into memory. Throws on the
 * FIRST failed download (or if the skill exceeds `MAX_SKILL_FILES`) — the caller
 * relies on this to abort BEFORE touching the existing on-disk install, so a
 * 404 (or an over-cap skill) never destroys a working install or leaves a
 * partial one. Downloads run in parallel (`FETCH_CONCURRENCY`) so a large skill
 * still finishes well under the bridge request timeout.
 */
export async function fetchSkillFiles(
  skill: SkillInstallInput,
  fetchImpl: typeof fetch,
): Promise<ExtractedFile[]> {
  // Sanitize + de-dupe the paths up front, dropping the provenance sidecar so a
  // remote file can never clobber it.
  const rels: string[] = []
  const seen = new Set<string>()
  for (const rawRel of skill.files) {
    const rel = sanitizeRelPath(rawRel)
    if (!rel || rel === SKILL_PROVENANCE_FILE || seen.has(rel)) continue
    seen.add(rel)
    rels.push(rel)
  }
  if (rels.length === 0) {
    throw new Error('Skill has no downloadable files')
  }
  // Hard error rather than a silent truncation + bogus "success".
  if (rels.length > MAX_SKILL_FILES) {
    throw new Error(
      `Skill "${skill.id}" has ${rels.length} files, exceeding the install limit of ${MAX_SKILL_FILES}.`,
    )
  }

  const out: ExtractedFile[] = new Array(rels.length)
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++
      if (i >= rels.length) return
      const rel = rels[i]!
      const res = await fetchImpl(rawUrl(skill, rel))
      if (!res.ok) {
        throw new Error(`Failed to download "${rel}" (HTTP ${res.status})`)
      }
      out[i] = { path: rel, content: new Uint8Array(await res.arrayBuffer()) }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(FETCH_CONCURRENCY, rels.length) }, worker),
  )
  return out
}

/**
 * The catalog id recorded in a dir's provenance sidecar; `null` for a
 * provenance-less but SKILL.md-bearing dir (a manually-placed skill — treat as
 * owned by an unknown party); `undefined` when the dir is free.
 */
async function readDirOwnerId(
  fs: RuntimeFs,
  dirPath: string,
): Promise<string | null | undefined> {
  try {
    const p = JSON.parse(
      await fs.readFile(joinPath(dirPath, SKILL_PROVENANCE_FILE), {
        encoding: 'utf-8',
      }),
    ) as { id?: string }
    return p.id ?? null
  } catch {
    try {
      await fs.readFile(joinPath(dirPath, 'SKILL.md'), { encoding: 'utf-8' })
      return null // occupied by an unknown (manually-placed) skill
    } catch {
      return undefined // free
    }
  }
}

/**
 * Resolve the install directory. Prefer the natural skill-name dir (so the skill
 * keeps its `/<name>` invocation), but if a DIFFERENT skill already owns it —
 * the cross-publisher collision (e.g. `anthropic/pdf` vs `openai/pdf`) — fall
 * back to a publisher-namespaced dir so the two coexist instead of clobbering.
 * A reinstall of the SAME skill keeps its natural dir (clean-replace).
 */
export async function resolveInstallDir(
  skill: SkillInstallInput,
  ctx: SkillInstallContext,
): Promise<string> {
  const skillsDir = getSkillsDirectory(ctx.homeDir)
  // A candidate dir is safe to install into when it's free OR already owned by
  // THIS skill (a clean-replace of our own prior copy). It is NOT safe when a
  // DIFFERENT catalog skill — or a provenance-less, manually-placed skill
  // (owner === null) — occupies it, because installSkill `rm`s the dir before
  // writing and would destroy that other skill.
  const usable = async (candidate: string): Promise<boolean> => {
    const owner = await readDirOwnerId(ctx.fs, joinPath(skillsDir, candidate))
    return owner === undefined || owner === skill.id
  }

  const natural = sanitizeSkillDirName(skill.name || skill.path)
  if (await usable(natural)) return natural

  // Cross-skill collision on the natural name (e.g. `anthropic/pdf` vs
  // `openai/pdf`). Fall back to a publisher-namespaced dir so the two coexist —
  // but PROBE that dir too: the user may have a hand-authored `openai-pdf`, or
  // another catalog skill may already own it. On a further collision, suffix a
  // counter until we hit a free / self-owned slot, so we never `rm` a dir that
  // belongs to an unrelated skill.
  const namespaced = sanitizeSkillDirName(
    `${skill.publisher}-${skill.name}`.replace(/^-+|-+$/g, '') || skill.path,
  )
  if (await usable(namespaced)) return namespaced
  for (let n = 2; n < MAX_DIR_COLLISION_PROBES; n++) {
    const candidate = `${namespaced}-${n}`
    if (await usable(candidate)) return candidate
  }
  throw new Error(
    `Could not find a free install directory for "${skill.id}" (too many name collisions).`,
  )
}

export async function installSkill(
  skill: SkillInstallInput,
  ctx: SkillInstallContext,
): Promise<{ entry: InstalledSkillEntry; fileCount: number }> {
  // 1. Download the WHOLE skill into memory FIRST. A 404 / over-cap throws here,
  //    before we touch any existing install — so a failed download can never
  //    destroy a working install or leave a half-written one.
  const files = await fetchSkillFiles(skill, ctx.fetchImpl)

  // 1b. A dir is only loadable with an exact-case SKILL.md (the runtime loader,
  //     localSkills.ts, reads `<dir>/SKILL.md`). If the catalog entry's files
  //     lack one (tampered catalog, generator bug, casing mismatch), installing
  //     would still write the provenance sidecar — making listInstalled report
  //     a skill the loader silently skips. Refuse up front, before touching
  //     disk, so we never destroy an existing install for an unloadable one.
  if (!files.some((f) => f.path === 'SKILL.md')) {
    throw new Error(
      `Skill "${skill.id}" has no SKILL.md — refusing to install an unloadable skill.`,
    )
  }

  // 2. Pick the dir — natural name, namespaced only on a real cross-skill
  //    collision (see resolveInstallDir).
  const skillsDir = getSkillsDirectory(ctx.homeDir)
  const dir = await resolveInstallDir(skill, ctx)
  const skillDir = joinPath(skillsDir, dir)

  // 3. Remove any OTHER dir already owned by THIS skill id. A prior collision
  //    may have parked us in a namespaced dir (`openai-pdf`); if the natural dir
  //    later freed up we now resolve back to it, and without this the old dir
  //    lingers as an orphan that keeps loading (and that listInstalled/uninstall
  //    can't cleanly reconcile by id). Guarantees exactly one dir per id.
  for (const owned of await listInstalledDirs(ctx.homeDir, ctx.fs)) {
    if (owned.id === skill.id && owned.dir !== dir) {
      try {
        await ctx.fs.rm(joinPath(skillsDir, owned.dir), {
          recursive: true,
          force: true,
        })
      } catch {
        /* best-effort orphan cleanup */
      }
    }
  }

  // 4. Replace only now that the download fully succeeded. (Clean-replace clears
  //    stale files from a previous version of THIS skill's dir.)
  try {
    await ctx.fs.rm(skillDir, { recursive: true, force: true })
  } catch {
    /* nothing to remove — fresh install */
  }

  // 5. Write resource files first, then SKILL.md, then the provenance sidecar
  //    LAST. If a write fails partway, the dir has NO SKILL.md and no sidecar —
  //    so the loader skips it (no loadable half-skill) and `listInstalled`
  //    doesn't report a broken entry.
  const skillMd = files.filter((f) => f.path === 'SKILL.md')
  const rest = files.filter((f) => f.path !== 'SKILL.md')
  let outcome = await writeExtractedFiles(ctx.fs, skillDir, rest)
  if (outcome.firstFailureIndex === null && skillMd.length > 0) {
    outcome = await writeExtractedFiles(ctx.fs, skillDir, skillMd)
  }
  if (outcome.firstFailureIndex !== null) {
    throw new Error(`Failed writing a skill file (index ${outcome.firstFailureIndex}).`)
  }

  const entry: InstalledSkillEntry = {
    id: skill.id,
    name: skill.name,
    publisher: skill.publisher,
    repo: skill.repo,
    dir,
    installedAt: ctx.now ? ctx.now() : new Date().toISOString(),
    fileCount: files.length,
  }
  const provenance = { ...entry, path: skill.path, branch: skill.branch }
  await ctx.fs.writeFile(
    joinPath(skillDir, SKILL_PROVENANCE_FILE),
    new TextEncoder().encode(JSON.stringify(provenance, null, 2)),
  )
  return { entry, fileCount: files.length }
}

/**
 * Every install dir paired with the catalog id it belongs to — the provenance
 * sidecar's id, or `local/<dir>` for a provenance-less but SKILL.md-bearing
 * (manually-placed) dir. One entry per dir, with NO dedup: callers that must
 * remove every dir for an id (orphan cleanup on install, uninstall) depend on
 * seeing them all.
 */
async function listInstalledDirs(
  homeDir: string,
  fs: RuntimeFs,
): Promise<Array<{ dir: string; id: string }>> {
  const skillsDir = getSkillsDirectory(homeDir)
  let entries
  try {
    entries = await fs.readdir(skillsDir)
  } catch {
    return []
  }
  const out: Array<{ dir: string; id: string }> = []
  for (const ent of entries) {
    if (!ent.isDirectory()) continue
    const owner = await readDirOwnerId(fs, joinPath(skillsDir, ent.name))
    if (owner === undefined) continue // not a skill dir (no SKILL.md, no sidecar)
    out.push({ dir: ent.name, id: owner ?? `local/${ent.name}` })
  }
  return out
}

export async function listInstalledSkills(
  homeDir: string,
  fs: RuntimeFs,
): Promise<InstalledSkillEntry[]> {
  const skillsDir = getSkillsDirectory(homeDir)
  let entries
  try {
    entries = await fs.readdir(skillsDir)
  } catch {
    return [] // skills dir doesn't exist yet
  }
  const out: InstalledSkillEntry[] = []
  for (const ent of entries) {
    if (!ent.isDirectory()) continue
    const dir = ent.name
    const provPath = joinPath(skillsDir, dir, SKILL_PROVENANCE_FILE)
    // Read SKILL.md once per dir: it supplies the row description, and its
    // presence is what makes an un-sidecar'd dir a (manually-placed) skill.
    const skillMdPath = joinPath(skillsDir, dir, 'SKILL.md')
    let description: string | undefined
    let hasSkillMd = false
    try {
      const raw = await fs.readFile(skillMdPath, { encoding: 'utf-8' })
      hasSkillMd = true
      description = describeSkillMarkdown(raw, skillMdPath, dir).description
    } catch {
      /* no SKILL.md — a sidecar-only dir still lists, without a description */
    }
    try {
      const p = JSON.parse(
        await fs.readFile(provPath, { encoding: 'utf-8' }),
      ) as InstalledSkillEntry
      out.push({
        id: p.id ?? `local/${dir}`,
        name: p.name ?? dir,
        publisher: p.publisher,
        repo: p.repo,
        dir,
        installedAt: p.installedAt,
        fileCount: p.fileCount,
        ...(description ? { description } : {}),
      })
    } catch {
      // No provenance — a manually-placed skill. Include it only if it really
      // looks like a skill (has SKILL.md), tagged as a local skill. The name
      // stays the DIR: that is what the loader names it, so what `/name` takes.
      if (hasSkillMd) {
        out.push({
          id: `local/${dir}`,
          name: dir,
          dir,
          ...(description ? { description } : {}),
        })
      }
    }
  }
  // Dedup by id (keep the first dir seen). A correct install keeps exactly one
  // dir per id, but a legacy orphan could surface the same id twice — the UI
  // should list it once. `local/<dir>` ids are unique per dir, so distinct
  // manually-placed skills never collapse together.
  const seen = new Set<string>()
  const deduped: InstalledSkillEntry[] = []
  for (const e of out) {
    if (seen.has(e.id)) continue
    seen.add(e.id)
    deduped.push(e)
  }
  return deduped
}

export async function uninstallSkill(
  id: string,
  homeDir: string,
  fs: RuntimeFs,
): Promise<boolean> {
  // Remove EVERY dir owned by this id, not just the first match — a buggy
  // earlier version could have left more than one dir carrying the same id, and
  // removing only one would leave an orphan that keeps loading.
  const dirs = (await listInstalledDirs(homeDir, fs)).filter((e) => e.id === id)
  if (dirs.length === 0) return false
  for (const { dir } of dirs) {
    await fs.rm(joinPath(getSkillsDirectory(homeDir), dir), {
      recursive: true,
      force: true,
    })
  }
  return true
}
