/**
 * `skills` WebUI-bridge capability — install an Agent Skill from a GitHub repo
 * into `~/.velloc/skills/<name>/`, or import one from another agent product's
 * on-disk skills folder (worker-side; NOT routed to C++).
 */

import type { ImportSource } from '../../../sessionImport/protocol'

/** A catalog skill as the UI passes it from `skills-catalog.json`. */
export type SkillCatalogInput = {
  id: string
  name: string
  publisher: string
  repo: string
  branch: string
  /** The skill's directory within the repo (e.g. `skills/pdf`). */
  path: string
  /** Relative paths of every file under `path`. */
  files: string[]
}

/** An installed skill as reported back to the UI. */
export type InstalledSkillUiEntry = {
  /** Catalog id (`<publisher>/<name>`) when known, `imported/<source>/<dir>`
   *  for a skill adopted from another product, else `local/<dir>`. */
  id: string
  name: string
  publisher?: string
  repo?: string
  /** Directory name under `~/.velloc/skills/`. */
  dir: string
  installedAt?: string
  fileCount?: number
  /** One-line description from the dir's SKILL.md, read at list time. */
  description?: string
}

/** One skill found under a source's on-disk skills folder
 *  (e.g. `~/.claude/skills/<dir>/`), as the Import dialog's Skills tab lists
 *  it. Structurally the pipeline's `ImportableSkill` (`skillLibrary/skillImport.ts`). */
export type ImportableSkillRow = {
  /** Directory name under the source root — the skill's invocation name. */
  dir: string
  /** Absolute path of the skill directory on disk. */
  path: string
  /** Display name: frontmatter `name`, else the directory name. */
  name: string
  /** Frontmatter/first-line description, capped for display. */
  description: string
  /** Number of files in the skill directory (SKILL.md included). */
  fileCount: number
  /** A Velloc skill already occupies `~/.velloc/skills/<dir>/` — the row
   *  renders the Import button disabled as "Imported". Live check, not
   *  remembered. */
  alreadyImported: boolean
}

export type SkillsBridgeActionMap = {
  listInstalled: {
    payload: Record<string, never>
    result: { skills: InstalledSkillUiEntry[] }
  }
  /** Compare the on-disk skill set with the last one seen (by a rescan or a
   *  mutation) and, when it changed, reload every open session's skills — so a
   *  folder dropped into `~/.velloc/skills/` by hand loads without a new
   *  session. `reloaded` says whether it fanned out. */
  rescan: {
    payload: Record<string, never>
    result: { reloaded: boolean }
  }
  install: {
    payload: { skill: SkillCatalogInput }
    result: {
      ok: true
      entry: InstalledSkillUiEntry
      /** Number of files written to the skill directory. */
      fileCount: number
    }
  }
  uninstall: {
    payload: { id: string }
    result: {
      ok: true
      /** True when an installed skill was removed; false when the id wasn't
       *  installed (idempotent). */
      removed: boolean
    }
  }
  /** Skills the given source keeps on this machine, importable into Velloc's
   *  managed skills store. Reads the source's on-disk skills folder
   *  (Claude Code: `~/.claude/skills/`); a missing folder yields an empty
   *  list, never an error. */
  listImportable: {
    payload: { source: ImportSource }
    result: {
      source: ImportSource
      /** The source skills folder that was scanned. */
      rootPath: string
      skills: ImportableSkillRow[]
    }
  }
  /** Copy one source skill directory into `~/.velloc/skills/<dir>/` (adopting
   *  it into Velloc's managed store, with a provenance sidecar). Idempotent:
   *  a dir already present in the Velloc store is left untouched
   *  (`skipped:true`). */
  importLocal: {
    payload: { source: ImportSource; dir: string }
    result: {
      ok: true
      /** True when a Velloc skill with this dir already existed — nothing was
       *  copied. */
      skipped: boolean
      entry: InstalledSkillUiEntry
    }
  }
}
