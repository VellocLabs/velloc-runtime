/**
 * Bridge namespace: `memory` — the `memory` section of `~/.velloc/settings.json`.
 * `snapshot` returns every key; `setField` persists explicit booleans (`null`
 * reverts); `clear` empties ONE known memory dir (destructive).
 * Security: `autoMemoryDirectory` is NOT a bridge setting — it names a host
 * directory every later session uses, while `snapshot` / `setField` are only
 * `observe` / `control`; `setField` refuses it.
 */

import type { MemoryMaintenanceMode } from '../../../memory/memoryPaths'
import type { ImportSource } from './sessionImport'

export type NexusMemorySettingsKey =
  | 'autoMemoryEnabled'
  | 'autoMemoryDirectory'
  | 'memoryMaintenance'
  | 'autoExtractEnabled'
  | 'memoryRecallEnabled'

/**
 * Effective memory values — every key present so the React form can bind
 * controlled inputs. Flat keys: `autoMemoryEnabled` /
 * `memoryRecallEnabled` default `true`; `autoExtractEnabled` (the end-of-turn
 * capture fork) defaults `false` (opt-in); `memoryMaintenance` (background memory
 * mode) defaults `'off'`. No `autoMemoryDirectory`: see the header.
 */
export type MemoryFieldValues = {
  autoMemoryEnabled: boolean
  memoryMaintenance: MemoryMaintenanceMode
  autoExtractEnabled: boolean
  memoryRecallEnabled: boolean
}

/** One memory file surfaced by `memory/list`. */
export type MemoryFileEntry = {
  /** File name relative to the memory dir, e.g. `MEMORY.md`, `user_role.md`. */
  name: string
  /** Size in bytes (0 if it couldn't be stat-ed). */
  bytes: number
  /** Frontmatter `type` (`user` / `feedback` / `project` / `reference`), or
   *  `undefined` when absent (e.g. `MEMORY.md`, or a file with no frontmatter).
   *  The UI groups by this. */
  type?: string
}

/**
 * One project's memory directory + its files, surfaced by `memory/list`. The
 * list enumerates EVERY `~/.velloc/projects/<slug>/memory/` (plus any custom
 * `autoMemoryDirectory` override and the legacy bare-sandbox dir) so the user
 * sees memory ACROSS all projects, not just the focused session's — memory is
 * per-project, and a global settings page that showed one dir was misleading.
 */
export type MemoryProjectEntry = {
  /** Display label — the project slug (sanitized path) for `projects/<slug>/`
   *  entries, or a tag like `'Custom directory'` / `'Sandbox'` for the rest. */
  label: string
  /** Absolute memory directory path (with trailing separator). */
  dir: string
  /** Memory files in `dir` (top-level `.md` files), name-sorted. */
  files: MemoryFileEntry[]
}

/** One user-authored instruction file surfaced by `memory/instructions`. */
export type InstructionFileEntry = {
  /** Absolute path on disk. */
  path: string
  /** Which tier it loads at. */
  tier: 'User' | 'Project' | 'Local'
  /** Size in bytes (0 if it couldn't be stat-ed). */
  bytes: number
}

/** One memory file under a Claude Code project's memory dir, as the Import
 *  dialog's Memory tab lists it (`memory/import/memoryImport.ts`). */
export type ImportableMemoryFileRow = {
  /** Path relative to the memory dir, `'/'`-separated (`MEMORY.md`,
   *  `user_role.md`, `logs/2026/01/2026-01-05.md`). */
  relPath: string
  /** Size in bytes (0 if it couldn't be stat-ed). */
  bytes: number
  /** The destination Velloc memory dir already has a file at this relative
   *  path — a live check, not remembered. */
  imported: boolean
}

/** One Claude Code project with memory to import, as the Memory tab lists it. */
export type ImportableMemoryProjectRow = {
  /** Source project dir name = the Velloc project slug (`projectFolderKey(root)`).
   *  The destination is `~/.velloc/projects/<slug>/memory/`. */
  slug: string
  /** Number of `.md` files under the source memory dir (`MEMORY.md` included). */
  fileCount: number
  /** Every `.md` file under the source memory dir, name-sorted. */
  files: ImportableMemoryFileRow[]
  /** Import state (topic files only — `MEMORY.md` is merged, not matched):
   *  `import` = none imported yet; `update` = some imported; `imported` = all
   *  present (the row's Import button renders disabled). */
  status: 'import' | 'update' | 'imported'
}

/** One source's importable GLOBAL memory, as the Memory tab's global row shows
 *  it. Codex keeps memory globally (not per-project); it is merged add-only into
 *  the user-tier `~/.velloc/AGENTS.md`. `null` from `listImportableGlobalMemory`
 *  means the source has none (Claude Code always; Codex before any memory has
 *  accrued) — the tab shows no global row. */
export type ImportableGlobalMemoryRow = {
  source: ImportSource
  /** The destination instruction file (`~/.velloc/AGENTS.md`). */
  destPath: string
  /** The source files that contributed content, in merge order. */
  files: Array<{ label: string; bytes: number }>
  /** `import` = no block yet; `update` = a block is present but the source
   *  changed; `imported` = the block matches the source (button disabled). */
  status: 'import' | 'update' | 'imported'
}

export type MemoryBridgeActionMap = {
  snapshot: {
    payload: Record<string, never>
    result: {
      /** Effective values — stored overrides, with unset ones defaulted. */
      values: MemoryFieldValues
      /** `'file'` once settings.json has any auto-memory key,
       *  `'default'` before the first write. */
      source: 'file' | 'default'
    }
  }
  setField: {
    payload: {
      /** Sparse: only changed fields. A boolean persists that toggle
       *  override; `null` reverts the field to its default. A patch that
       *  carries `autoMemoryDirectory` (any value, `null` too) is refused
       *  whole with `invalid_payload`, and nothing is written. */
      patch: Partial<{
        autoMemoryEnabled: boolean | null
        memoryMaintenance: MemoryMaintenanceMode | null
        autoExtractEnabled: boolean | null
        memoryRecallEnabled: boolean | null
      }>
    }
    result: {
      ok: true
      /** Effective values after the patch — same shape as
       *  `snapshot.result.values`. Saves the UI one round-trip. */
      values: MemoryFieldValues
    }
  }
  list: {
    payload: Record<string, never>
    result: {
      /** Every project memory directory that exists, each with its files,
       *  label-sorted. Empty when nothing has been remembered anywhere yet. */
      projects: MemoryProjectEntry[]
    }
  }
  clear: {
    payload: {
      /** The memory directory to clear — one of the `dir`s returned by `list`.
       *  The handler clears only that dir's direct children, and refuses a dir
       *  that isn't a known memory directory. */
      dir: string
    }
    result: {
      ok: true
      /** Number of entries removed from the memory dir. */
      cleared: number
      /** The dir that was cleared (echoed for the UI), or `null` when refused. */
      dir: string | null
    }
  }
  instructions: {
    /** The session the asking client shows; its `projectRoot` anchors the walk.
     *  Absent → only the user tier (there is no "current session" to assume). */
    payload: { sessionId?: string }
    result: {
      /** The user-authored instruction files (`AGENTS.md` / `CLAUDE.md`
       *  hierarchy + rules) that load for the current project.
       *  READ-ONLY — these are never deleted by `clear`. */
      files: InstructionFileEntry[]
    }
  }
  /**
   * Read the USER-tier instruction file, resolved via `resolveUserInstructionPath`
   * so editing lands on the file that actually reaches the prompt.
   */
  userInstructions: {
    payload: Record<string, never>
    result: {
      /** Absolute path — returned whether or not the file exists yet, so the
       *  UI can show the user where the text lands. */
      path: string
      /** File contents; `''` when the file does not exist OR could not be
       *  read — check `readable` before treating `''` as "empty". */
      content: string
      exists: boolean
      /**
       * `false` when the file could not be read for a NON-ENOENT reason
       * (locked / permissions / transient bridge failure). The content may
       * exist on disk unseen, so the editor must not offer to overwrite it.
       */
      readable: boolean
    }
  }
  /**
   * Write the user-tier instruction file. Conflict-checked: `expected` is the
   * content the editor last synced to, and a mismatch REFUSES the write rather
   * than clobbering an edit made on disk (or by the model) in the meantime.
   */
  writeUserInstructions: {
    payload: {
      /** New full contents. `''` empties the file (it is then skipped by the
       *  instruction loader) — the file itself is never deleted. */
      content: string
      /** Content the caller believes is on disk. `null`/omitted forces the
       *  write — the UI always passes its synced baseline. */
      expected?: string | null
    }
    result: {
      /** `false` only on a conflict; a failed write throws instead. */
      ok: boolean
      path: string
      /** Authoritative content after the call — what was written on success,
       *  what is on disk on a conflict, so the UI can resync either way. */
      content: string
      /** Present only when the write was refused. */
      conflict?: true
    }
  }
  /** List another agent product's per-project memory (Claude Code:
   *  `~/.claude/projects/<slug>/memory/`) that can be imported into Velloc's
   *  matching per-project memory store. Backs the Import dialog's Memory tab. A
   *  missing source folder yields an empty list, never an error. */
  listImportableProjects: {
    payload: { source: ImportSource }
    result: {
      source: ImportSource
      /** The source projects folder that was scanned. */
      rootPath: string
      projects: ImportableMemoryProjectRow[]
    }
  }
  /** Copy one source project's memory into `~/.velloc/projects/<slug>/memory/`,
   *  ADD-ONLY: a topic `.md` already present at the destination is left untouched
   *  (Velloc's own memory is never overwritten); only new topic files are copied.
   *  `MEMORY.md` is merged (destination pointer lines kept, only new ones
   *  appended). Re-running is the "Update" action — it pulls in any absent topic
   *  file; the UI disables the button once every source topic file is present. */
  importProject: {
    payload: { source: ImportSource; slug: string }
    result: {
      ok: true
      slug: string
      /** Topic `.md` files newly copied in (`MEMORY.md` excluded — it is
       *  merged; a file already present is not recopied). */
      filesCopied: number
      /** Topic `.md` files left untouched because the destination already had
       *  them (add-only). */
      filesSkipped: number
      /** `MEMORY.md` was merged into (or created at) the destination. */
      indexMerged: boolean
    }
  }
  /** Describe a source's importable GLOBAL memory (Codex: `~/.codex/AGENTS.md` +
   *  `~/.codex/memories/*.md`), or `null` when it has none. Backs the Memory
   *  tab's global-memory row. Never errors for a missing source. */
  listImportableGlobalMemory: {
    payload: { source: ImportSource }
    result: {
      source: ImportSource
      global: ImportableGlobalMemoryRow | null
    }
  }
  /** Merge a source's global memory add-only into `~/.velloc/AGENTS.md` (inside a
   *  provenance-marked block; the user's own content is never touched). Re-running
   *  is the "Update" action — it replaces the block with the regenerated source.
   *  Throws when the source has no global memory to import. */
  importGlobalMemory: {
    payload: { source: ImportSource }
    result: {
      ok: true
      source: ImportSource
      imported: boolean
      /** Number of source files merged in. */
      filesImported: number
      /** `~/.velloc/AGENTS.md`. */
      destPath: string
    }
  }
}
