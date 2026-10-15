/**
 * Where the memory directory lives, whether memory is on, and the small path
 * helpers the rest of the runtime borrows from here.
 */

import type { RuntimeConfig } from '../runtime/interfaces/RuntimeConfig'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import { RUNTIME_DIR_NAME } from '../branding/runtimeDir'
import { projectHomeFor } from '../utils/conversationStoragePaths'

/** Background memory mode. The string values are stored in settings.json. */
export type MemoryMaintenanceMode = 'off' | 'periodic' | 'dailyLog'

const MAINTENANCE_MODES: readonly MemoryMaintenanceMode[] = ['off', 'periodic', 'dailyLog']

/** The memory part of the user's settings, resolved once per session. */
export type ResolvedMemorySettings = {
  autoMemoryEnabled?: boolean
  autoMemoryDirectory?: string
  memoryMaintenance?: MemoryMaintenanceMode
  autoExtractEnabled?: boolean
  memoryRecallEnabled?: boolean
}

export function isMemoryMaintenanceMode(value: unknown): value is MemoryMaintenanceMode {
  return MAINTENANCE_MODES.includes(value as MemoryMaintenanceMode)
}

/** The stored mode when it is a valid one, otherwise `undefined`. */
export function parseMemoryMaintenance(
  mode: unknown,
): MemoryMaintenanceMode | undefined {
  return isMemoryMaintenanceMode(mode) ? mode : undefined
}

// ---------------------------------------------------------------------------
// Separators
// ---------------------------------------------------------------------------

/** Backslash only for a path written purely with backslashes. */
function separatorFor(path: string): '\\' | '/' {
  return path.includes('\\') && !path.includes('/') ? '\\' : '/'
}

function dropTrailingSeparators(path: string): string {
  return path.replace(/[\\/]+$/, '')
}

function asDirectory(path: string): string {
  const bare = dropTrailingSeparators(path)
  return bare + separatorFor(bare)
}

/**
 * Join path pieces using the base's separator style. Empty pieces are
 * ignored; an empty base starts from the first piece as given.
 */
export function joinPath(base: string, ...parts: string[]): string {
  const sep = separatorFor(base)
  let out = base === '' ? undefined : dropTrailingSeparators(base)
  for (const part of parts) {
    const piece = part.replace(/^[\\/]+/, '').replace(/[\\/]+$/, '')
    if (piece === '') continue
    if (out === undefined) {
      out = part
      continue
    }
    out = `${out}${sep}${piece}`
  }
  return out ?? ''
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

type PathCheckOptions = { expandTilde?: boolean; homeDir?: string }

function expandHome(path: string, homeDir: string | undefined): string | undefined {
  const rest = path.slice(2)
  if (!homeDir) return undefined
  if (rest === '' || rest === '.' || rest === '..') return undefined
  if (/^\.{1,2}[\\/]/.test(rest)) return undefined
  return dropTrailingSeparators(homeDir) + separatorFor(homeDir) + rest
}

function looksAbsolute(path: string): boolean {
  return /^[\\/]/.test(path) || /^[A-Za-z]:[\\/]/.test(path)
}

/**
 * Accepts an absolute, non-network directory path and returns it with one
 * trailing separator; anything unusable yields `undefined`. A boolean second
 * argument is shorthand for `{ expandTilde }`.
 */
export function checkNotesDir(
  raw?: string,
  options?: boolean | PathCheckOptions,
): string | undefined {
  const opts: PathCheckOptions =
    typeof options === 'boolean' ? { expandTilde: options } : options ?? {}
  if (raw === undefined) return undefined
  let path = raw.trim()
  if (path === '') return undefined

  if (opts.expandTilde && /^~[\\/]/.test(path)) {
    const expanded = expandHome(path, opts.homeDir)
    if (expanded === undefined) return undefined
    path = expanded
  }

  if (path.includes('\0')) return undefined
  if (path.startsWith('\\\\') || path.startsWith('//')) return undefined
  if (!looksAbsolute(path)) return undefined
  const bare = dropTrailingSeparators(path)
  if (bare.length < 3 || /^[A-Za-z]:$/.test(bare)) return undefined
  return bare + separatorFor(bare)
}

// ---------------------------------------------------------------------------
// Enabled gate
// ---------------------------------------------------------------------------

/**
 * Reads an on/off environment switch. `off` / `0` / `false` / `no` give
 * false, `on` / `1` / `true` / `yes` give true, anything else (or unset)
 * gives undefined so the caller falls back to settings.
 */
export function readEnvSwitch(rc: RuntimeConfig, name: string): boolean | undefined {
  const value = rc.getEnv(name)?.trim().toLowerCase()
  if (value === undefined || value === '') return undefined
  if (['off', '0', 'false', 'no'].includes(value)) return false
  if (['on', '1', 'true', 'yes'].includes(value)) return true
  return undefined
}

/** `VELLOC_MEMORY=off|on` overrides the settings toggle in either direction. */
export function isMemoryEnabled(
  rc: RuntimeConfig,
  settings?: ResolvedMemorySettings,
): boolean {
  return readEnvSwitch(rc, 'VELLOC_MEMORY') ?? settings?.autoMemoryEnabled ?? true
}

// ---------------------------------------------------------------------------
// Directory resolution
// ---------------------------------------------------------------------------

export type MemoryDirOptions = {
  canonicalRoot?: string
  projectRoot?: string
  homeDir?: string
  memorySettings?: ResolvedMemorySettings
}

function projectSlug(raw: string): string {
  const slug = raw
    .trim()
    .replace(/^[A-Za-z]:/, '')
    .replace(/[\\/]+/g, '-')
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
  return slug === '' ? 'workspace' : slug
}

/** The layout used when nothing overrides the location. Pure. */
export function defaultMemoryDir(where: {
  cwd: string
  projectRoot?: string
  homeDir?: string
}): string {
  if (where.projectRoot && where.homeDir) {
    return asDirectory(joinPath(projectHomeFor(where.homeDir, where.projectRoot), 'memory'))
  }
  if (where.projectRoot) return asDirectory(joinPath(where.projectRoot, 'memory'))
  return asDirectory(joinPath(where.cwd, RUNTIME_DIR_NAME, 'memory'))
}

/** First usable location wins: explicit override, configured directory, remote base, default. */
export function getMemoryDir(
  cwd: string,
  rc: RuntimeConfig,
  opts: MemoryDirOptions = {},
): string {
  const forced = checkNotesDir(rc.getEnv('VELLOC_MEMORY_PIN_DIR'), false)
  if (forced) return forced

  const configured = opts.memorySettings?.autoMemoryDirectory
  const home = opts.homeDir ?? rc.getEnv('HOME') ?? rc.getEnv('USERPROFILE')
  const chosen = checkNotesDir(configured, { expandTilde: true, homeDir: home })
  if (chosen) return chosen

  const remoteBase = checkNotesDir(rc.getEnv('VELLOC_MEMORY_ROOT'), false)
  if (remoteBase) {
    const keyedBy = opts.canonicalRoot ?? opts.projectRoot ?? cwd
    return asDirectory(joinPath(remoteBase, 'projects', projectSlug(keyedBy), 'memory'))
  }

  return defaultMemoryDir({ cwd, projectRoot: opts.projectRoot, homeDir: opts.homeDir })
}

/**
 * Like `getMemoryDir`, but under a remote base the slug comes from the
 * repository's main checkout, so every worktree of one repo shares memory.
 */
export async function resolveMemoryDir(
  cwd: string,
  rc: RuntimeConfig,
  fs: RuntimeFs,
  opts: MemoryDirOptions = {},
): Promise<string> {
  if (!rc.getEnv('VELLOC_MEMORY_ROOT')) return getMemoryDir(cwd, rc, opts)
  const { mainRepoRoot } = await import('../utils/gitInfo')
  const repoRoot = await mainRepoRoot(cwd, fs, { homeDir: opts.homeDir })
  return getMemoryDir(cwd, rc, { ...opts, canonicalRoot: repoRoot ?? opts.canonicalRoot })
}
