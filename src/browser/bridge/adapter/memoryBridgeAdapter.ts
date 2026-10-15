/**
 * Worker-side handlers for the `memory` bridge namespace; owns the flat
 * auto-memory keys of `~/.velloc/settings.json`. An explicit boolean toggle
 * persists; only `null` reverts it to its unset default. Toggles apply LIVE.
 * `autoMemoryDirectory` is settings.json-only: `snapshot` leaves it out and
 * `setField` refuses it.
 */

import type {
  MemoryBridgeActionMap,
  MemoryFieldValues,
  MemoryFileEntry,
  MemoryProjectEntry,
  BrowserBridgeRequest,
  BrowserBridgeResponse,
} from '../protocol'
import type { RuntimeFs } from '../../../utils/fs/runtimeFs'
import type { NexusSettingsV1 } from '../../../settings/settingsTypes'
import { parseMemoryMaintenance, joinPath } from '../../../memory/memoryPaths'
import { resolveUserInstructionPath } from '../../../memory/instructionFiles'
import { dirnameRuntimePath as dirname } from '../../../utils/runtimePaths'
import { projectsHome } from '../../../utils/conversationStoragePaths'
import {
  importMemoryProject,
  listImportableMemoryProjects,
  memoryImportProjectsRoot,
} from '../../../memory/import/memoryImport'
import {
  importGlobalMemory,
  listImportableGlobalMemory,
} from '../../../memory/import/globalMemoryImport'
import {
  readUserLayer,
  updateMemorySettings,
  type MemorySettingsPatch,
} from '../../../settings/settingsStore'

export type MemoryAdapterContext = {
  /** User home directory the settings file anchors to (same chain
   *  features/agent/profile use — one `settings.json`). */
  homeDir: string
  /** The same `processFs()` the rest of nexus uses. */
  fs: RuntimeFs
  /**
   * Fire after a successful `setField` write. The registration site
   * broadcasts `memory.changed` to attached WebUI ports (cross-tab
   * consistency) AND fans the toggles out to running sessions'
   * `engine.applyMemorySettings`. Optional so unit tests don't have to wire it.
   */
  broadcastChanged?: (payload: { values: MemoryFieldValues }) => void
  /**
   * Enumerate EVERY memory directory to surface in `list` / clearable by
   * `clear`: every existing `~/.velloc/projects/<slug>/memory/`, plus any custom
   * `autoMemoryDirectory` override and the legacy bare-sandbox dir. Injected by
   * the registration site (this adapter is a global settings handler with no
   * session context of its own). Each entry is `{ label, dir }`; the dir has a
   * trailing separator. Omitted in unit tests that don't exercise list/clear.
   */
  listMemoryDirs?: () => Promise<Array<{ label: string; dir: string }>>
  /**
   * List the user-authored instruction files (`AGENTS.md` hierarchy + rules)
   * for `instructions`. Injected by the registration site (it walks the
   * instruction-file tiers from the named session's `projectRoot`, read-only). Omitted
   * in unit tests that don't exercise it.
   */
  listInstructionFiles?: (sessionId: string | undefined) => Promise<
    MemoryBridgeActionMap['instructions']['result']['files']
  >
}

/** Best-effort extraction of a memory file's frontmatter `type` (`user` /
 *  `feedback` / `project` / `reference`). Handles both the flat `type: user`
 *  and the nested `metadata:`/`  type: user` shapes (a single `type:` line in
 *  the frontmatter block). Returns `undefined` for `MEMORY.md` / no frontmatter. */
function extractMemoryType(content: string): string | undefined {
  if (!content.startsWith('---\n')) return undefined
  const end = content.indexOf('\n---\n', 4)
  if (end === -1) return undefined
  for (const line of content.slice(4, end).split(/\r?\n/)) {
    const m = line.match(/^\s*type\s*:\s*(.+?)\s*$/)
    if (m?.[1]) {
      const v = m[1].replace(/^['"]|['"]$/g, '').trim().toLowerCase()
      return v || undefined
    }
  }
  return undefined
}

export type MemoryAction = keyof MemoryBridgeActionMap

/** A payload the caller must not send. The dispatch reports it as
 *  `invalid_payload` (the hub's `bad_payload`), not as a handler failure. */
class MemoryPayloadError extends Error {}

/**
 * Defaults for unset fields: `autoMemoryEnabled` and
 * `memoryRecallEnabled` default ON; the two background mechanisms default OFF
 * (opt-in) — `memoryMaintenance` (the background consolidation mode) and
 * `autoExtractEnabled` (the end-of-turn
 * capture fork).
 */
const MEMORY_DEFAULTS: MemoryFieldValues = {
  autoMemoryEnabled: true,
  memoryMaintenance: 'off',
  autoExtractEnabled: false,
  memoryRecallEnabled: true,
}

function mergeWithDefaults(settings: NexusSettingsV1): MemoryFieldValues {
  return {
    autoMemoryEnabled:
      settings.autoMemoryEnabled ?? MEMORY_DEFAULTS.autoMemoryEnabled,
    memoryMaintenance:
      parseMemoryMaintenance(settings.memoryMaintenance) ??
      MEMORY_DEFAULTS.memoryMaintenance,
    autoExtractEnabled:
      settings.autoExtractEnabled ?? MEMORY_DEFAULTS.autoExtractEnabled,
    memoryRecallEnabled:
      settings.memoryRecallEnabled ?? MEMORY_DEFAULTS.memoryRecallEnabled,
  }
}

// --- individual handlers (typed; tested directly by unit tests) ---------

async function handleSnapshot(
  ctx: MemoryAdapterContext,
): Promise<MemoryBridgeActionMap['snapshot']['result']> {
  const { settings, source } = await readUserLayer(ctx.homeDir, ctx.fs)
  return {
    values: mergeWithDefaults(settings),
    source,
  }
}

async function handleSetField(
  payload: MemoryBridgeActionMap['setField']['payload'],
  ctx: MemoryAdapterContext,
): Promise<MemoryBridgeActionMap['setField']['result']> {
  // The directory is a host path outside any session, and this action is
  // `control`. Refuse the whole patch, so a toggle riding along with it is
  // not written either.
  const patch = payload?.patch
  if (patch && typeof patch === 'object' && 'autoMemoryDirectory' in patch) {
    throw new MemoryPayloadError(
      'memory.setField does not set autoMemoryDirectory: the memory directory is a host path, set only in ~/.velloc/settings.json',
    )
  }
  // The patch shape IS the flat-key updater's patch shape — a boolean sets
  // the key, `null` clears it, an absent key leaves the stored value untouched.
  const updated = await updateMemorySettings(
    ctx.homeDir,
    ctx.fs,
    patch as MemorySettingsPatch,
  )
  const values = mergeWithDefaults(updated)
  ctx.broadcastChanged?.({ values })
  return {
    ok: true,
    values,
  }
}

/** Read the top-level `.md` memory files in ONE dir (so `MEMORY.md` + topic
 *  files; the `.consolidate-lock` and subdirs are skipped). Returns `null` when
 *  the dir doesn't exist (so the caller can drop it), else the name-sorted files
 *  (possibly empty if the dir exists but holds no `.md`). */
async function readMemoryFiles(
  ctx: MemoryAdapterContext,
  dir: string,
): Promise<MemoryFileEntry[] | null> {
  let entries
  try {
    entries = await ctx.fs.readdir(dir)
  } catch {
    return null // dir doesn't exist yet
  }
  const files: MemoryFileEntry[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue
    let bytes = 0
    let type: string | undefined
    try {
      const content = await ctx.fs.readFile(joinPath(dir, entry.name), {
        encoding: 'utf-8',
      })
      bytes = new TextEncoder().encode(content).length
      type = extractMemoryType(content)
    } catch {
      /* keep defaults — still list the file */
    }
    files.push({ name: entry.name, bytes, type })
  }
  files.sort((a, b) => a.name.localeCompare(b.name))
  return files
}

/** Enumerate every project memory dir (via `listMemoryDirs`) and list each one's
 *  files, so the user sees memory ACROSS all projects. A dir that doesn't exist
 *  on disk is dropped; an existing-but-empty dir is kept (so a freshly-bound
 *  project still shows up). Groups are label-sorted. Best-effort throughout. */
async function handleList(
  ctx: MemoryAdapterContext,
): Promise<MemoryBridgeActionMap['list']['result']> {
  const dirs = (await ctx.listMemoryDirs?.()) ?? []
  const projects: MemoryProjectEntry[] = []
  for (const { label, dir } of dirs) {
    const files = await readMemoryFiles(ctx, dir)
    if (files === null) continue // dir doesn't exist — skip
    projects.push({ label, dir, files })
  }
  projects.sort((a, b) => a.label.localeCompare(b.label))
  return { projects }
}

/** List the user-authored instruction files (read-only — never deleted). */
async function handleInstructions(
  payload: MemoryBridgeActionMap['instructions']['payload'] | undefined,
  ctx: MemoryAdapterContext,
): Promise<MemoryBridgeActionMap['instructions']['result']> {
  const sessionId = typeof payload?.sessionId === 'string' && payload.sessionId ? payload.sessionId : undefined
  const files = (await ctx.listInstructionFiles?.(sessionId)) ?? []
  return { files }
}

/**
 * Absolute path of the USER-tier instruction file to edit — resolved through
 * the SAME slot the loader uses (`resolveUserInstructionPath`), not
 * `~/.velloc/AGENTS.md` alone: a user whose instructions live only in
 * `~/.claude/CLAUDE.md` would otherwise see an empty editor, and a single
 * blur would create an AGENTS.md that `resolveInstructionSlot` then prefers
 * (first present wins, never both), shadowing them.
 */
function userInstructionsPath(ctx: MemoryAdapterContext): Promise<string> {
  return resolveUserInstructionPath(ctx.fs, ctx.homeDir)
}

/**
 * True only for a POSITIVELY identified missing file (`code`, else a leading
 * wire `ENOENT`). Anchored: "absent" lets the conflict guard pass, so prose that
 * merely embeds `ENOENT` must not flip it.
 */
const ENOENT_MESSAGE_PATTERN = /^(?:[A-Z_]+: )?ENOENT\b/

function isMissingFileError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code
  if (typeof code === 'string') return code === 'ENOENT'
  const message = (err as { message?: unknown } | null)?.message
  return typeof message === 'string' && ENOENT_MESSAGE_PATTERN.test(message)
}

/**
 * Read it. A genuinely missing file is empty, not an error — but EVERY other
 * failure (locked file / perms / `transport_disposed` / `bridge_timeout` / an
 * error of unknown shape) is reported as `readable: false`, because the file
 * may EXIST with content we could not read. Collapsing that into `''` would
 * let the conflict guard compare `'' === ''` and clobber real instructions.
 * Same tri-state `probeInstructionFile` applies.
 */
async function readUserInstructions(
  ctx: MemoryAdapterContext,
  path: string,
): Promise<{ content: string; exists: boolean; readable: boolean }> {
  try {
    const content = await ctx.fs.readFile(path, { encoding: 'utf-8' })
    return { content, exists: true, readable: true }
  } catch (err) {
    if (isMissingFileError(err)) {
      return { content: '', exists: false, readable: true }
    }
    return { content: '', exists: true, readable: false }
  }
}

async function handleUserInstructions(
  ctx: MemoryAdapterContext,
): Promise<MemoryBridgeActionMap['userInstructions']['result']> {
  const path = await userInstructionsPath(ctx)
  const { content, exists, readable } = await readUserInstructions(ctx, path)
  return { path, content, exists, readable }
}

/**
 * Write the user-tier instruction file, refusing to clobber a concurrent
 * edit. `expected` is the content the caller last synced to; when disk has
 * moved on we return `{ ok: false, conflict: true }` WITH the on-disk text
 * so the caller can resync and let the user redo the edit. Losing a user's
 * (or the model's) instructions to a stale textarea is the failure this
 * guard exists for — a settings page can sit open for hours.
 */
async function handleWriteUserInstructions(
  payload: MemoryBridgeActionMap['writeUserInstructions']['payload'],
  ctx: MemoryAdapterContext,
): Promise<MemoryBridgeActionMap['writeUserInstructions']['result']> {
  // A non-string `content` would reach `writeFile` as an empty byte payload
  // (the bridge's `toUint8Array` maps anything it can't read to 0 bytes) and
  // silently truncate the file. Refuse it as a payload error.
  if (typeof payload?.content !== 'string') {
    throw new MemoryPayloadError(
      'memory.writeUserInstructions: content must be a string',
    )
  }
  const path = await userInstructionsPath(ctx)
  if (payload.expected !== undefined && payload.expected !== null) {
    const { content: onDisk, readable } = await readUserInstructions(ctx, path)
    // An UNREADABLE file is not an empty one: refuse the write and report it as
    // a conflict (handing back what we have) rather than overwriting content we
    // could not see. Losing instructions to a failed read is the exact failure
    // this guard exists to prevent.
    if (!readable || onDisk !== payload.expected) {
      return { ok: false, path, content: onDisk, conflict: true }
    }
  }
  try {
    await ctx.fs.mkdir(dirname(path))
  } catch {
    /* already exists, or the facade no-ops mkdir — writeFile surfaces a
       real failure as a rejected handler (`{ ok: false, error }`). */
  }
  await ctx.fs.writeFile(path, payload.content, { encoding: 'utf-8' })
  return { ok: true, path, content: payload.content }
}

/** Memory-tab import: list a source's per-project memory (`~/.claude/projects/
 *  <slug>/memory/`) importable into Velloc's matching `~/.velloc/projects/<slug>/
 *  memory/`. Pure disk scan via `ctx.fs` — no session context needed. */
async function handleListImportableProjects(
  payload: MemoryBridgeActionMap['listImportableProjects']['payload'],
  ctx: MemoryAdapterContext,
): Promise<MemoryBridgeActionMap['listImportableProjects']['result']> {
  const rootPath = memoryImportProjectsRoot(payload.source, ctx.homeDir)
  const projects = await listImportableMemoryProjects(
    rootPath,
    projectsHome(ctx.homeDir),
    ctx.fs,
  )
  return {
    source: payload.source,
    rootPath,
    projects: projects.map((p) => ({
      slug: p.slug,
      fileCount: p.files.length,
      files: p.files.map((f) => ({
        relPath: f.relPath,
        bytes: f.bytes,
        imported: f.imported,
      })),
      status: p.status,
    })),
  }
}

/** Memory-tab import: copy one source project's memory into its Velloc store
 *  (add-only — new topic files copied, existing left untouched; `MEMORY.md`
 *  merged). */
async function handleImportProject(
  payload: MemoryBridgeActionMap['importProject']['payload'],
  ctx: MemoryAdapterContext,
): Promise<MemoryBridgeActionMap['importProject']['result']> {
  const rootPath = memoryImportProjectsRoot(payload.source, ctx.homeDir)
  const { slug, filesCopied, filesSkipped, indexMerged } =
    await importMemoryProject(payload.slug, rootPath, {
      homeDir: ctx.homeDir,
      fs: ctx.fs,
      source: payload.source,
    })
  return { ok: true, slug, filesCopied, filesSkipped, indexMerged }
}

/** Memory-tab import: describe a source's importable GLOBAL memory (Codex:
 *  `~/.codex/AGENTS.md` + `~/.codex/memories/*.md`), or `null` when it has none.
 *  Pure disk read via `ctx.fs`. */
async function handleListImportableGlobalMemory(
  payload: MemoryBridgeActionMap['listImportableGlobalMemory']['payload'],
  ctx: MemoryAdapterContext,
): Promise<MemoryBridgeActionMap['listImportableGlobalMemory']['result']> {
  const global = await listImportableGlobalMemory(
    payload.source,
    ctx.homeDir,
    ctx.fs,
  )
  return { source: payload.source, global }
}

/** Memory-tab import: merge a source's global memory add-only into the user-tier
 *  `~/.velloc/AGENTS.md` (provenance-marked block; the user's own content is
 *  never touched). */
async function handleImportGlobalMemory(
  payload: MemoryBridgeActionMap['importGlobalMemory']['payload'],
  ctx: MemoryAdapterContext,
): Promise<MemoryBridgeActionMap['importGlobalMemory']['result']> {
  const { imported, filesImported, destPath } = await importGlobalMemory(
    payload.source,
    { homeDir: ctx.homeDir, fs: ctx.fs },
  )
  return { ok: true, source: payload.source, imported, filesImported, destPath }
}

/** Delete every entry in ONE memory dir (files + subdirs like `logs/`), leaving
 *  the directory itself. Only ever operates on direct children of the target dir
 *  (no traversal), and ONLY if that dir is one the enumerator returned — never an
 *  arbitrary caller-supplied path. Best-effort per entry. */
async function handleClear(
  payload: MemoryBridgeActionMap['clear']['payload'],
  ctx: MemoryAdapterContext,
): Promise<MemoryBridgeActionMap['clear']['result']> {
  const target = payload?.dir
  if (!target) return { ok: true, cleared: 0, dir: null }
  // Safety gate: only clear a dir the enumerator actually surfaced, compared on
  // the trailing-separator-normalized path so a stray separator can't bypass it.
  const norm = (p: string) => p.replace(/[\\/]+$/, '')
  const known = (await ctx.listMemoryDirs?.()) ?? []
  const match = known.find((d) => norm(d.dir) === norm(target))
  if (!match) return { ok: true, cleared: 0, dir: null }
  const dir = match.dir
  let entries
  try {
    entries = await ctx.fs.readdir(dir)
  } catch {
    return { ok: true, cleared: 0, dir } // nothing to clear
  }
  let cleared = 0
  for (const entry of entries) {
    try {
      await ctx.fs.rm(joinPath(dir, entry.name), {
        recursive: true,
        force: true,
      })
      cleared++
    } catch {
      /* best-effort — skip an entry that won't delete */
    }
  }
  return { ok: true, cleared, dir }
}

// Exported for unit tests that want to call the handlers directly without
// constructing a fake bridge request envelope.
export const memoryHandlers = {
  snapshot: handleSnapshot,
  setField: handleSetField,
  list: handleList,
  clear: handleClear,
  instructions: handleInstructions,
  userInstructions: handleUserInstructions,
  writeUserInstructions: handleWriteUserInstructions,
  listImportableProjects: handleListImportableProjects,
  importProject: handleImportProject,
  listImportableGlobalMemory: handleListImportableGlobalMemory,
  importGlobalMemory: handleImportGlobalMemory,
}

/**
 * Dispatch a `memory/*` bridge request to its handler. Same envelope shape as
 * `handleProfileBridgeRequest`. Per-handler runtime errors are caught here and
 * surfaced as `{ ok: false, error }` instead of a bridge transport timeout.
 */
export async function handleMemoryBridgeRequest(
  request: BrowserBridgeRequest,
  ctx: MemoryAdapterContext,
): Promise<BrowserBridgeResponse> {
  const action = request.route.action as MemoryAction
  try {
    let result: unknown
    switch (action) {
      case 'snapshot':
        result = await handleSnapshot(ctx)
        break
      case 'setField':
        result = await handleSetField(
          request.payload as MemoryBridgeActionMap['setField']['payload'],
          ctx,
        )
        break
      case 'list':
        result = await handleList(ctx)
        break
      case 'clear':
        result = await handleClear(
          request.payload as MemoryBridgeActionMap['clear']['payload'],
          ctx,
        )
        break
      case 'instructions':
        result = await handleInstructions(
          request.payload as MemoryBridgeActionMap['instructions']['payload'] | undefined,
          ctx,
        )
        break
      case 'userInstructions':
        result = await handleUserInstructions(ctx)
        break
      case 'writeUserInstructions':
        result = await handleWriteUserInstructions(
          request.payload as MemoryBridgeActionMap['writeUserInstructions']['payload'],
          ctx,
        )
        break
      case 'listImportableProjects':
        result = await handleListImportableProjects(
          request.payload as MemoryBridgeActionMap['listImportableProjects']['payload'],
          ctx,
        )
        break
      case 'importProject':
        result = await handleImportProject(
          request.payload as MemoryBridgeActionMap['importProject']['payload'],
          ctx,
        )
        break
      case 'listImportableGlobalMemory':
        result = await handleListImportableGlobalMemory(
          request.payload as MemoryBridgeActionMap['listImportableGlobalMemory']['payload'],
          ctx,
        )
        break
      case 'importGlobalMemory':
        result = await handleImportGlobalMemory(
          request.payload as MemoryBridgeActionMap['importGlobalMemory']['payload'],
          ctx,
        )
        break
      default: {
        const _exhaustive: never = action
        return {
          id: request.id,
          route: request.route,
          ok: false,
          error: {
            code: 'unknown_action',
            message: `Unknown memory action: ${String(_exhaustive)}`,
          },
        }
      }
    }
    return {
      id: request.id,
      route: request.route,
      ok: true,
      result,
    } as BrowserBridgeResponse
  } catch (e) {
    return {
      id: request.id,
      route: request.route,
      ok: false,
      error: {
        code:
          e instanceof MemoryPayloadError
            ? 'invalid_payload'
            : 'memory_handler_error',
        message: e instanceof Error ? e.message : String(e),
      },
    }
  }
}
