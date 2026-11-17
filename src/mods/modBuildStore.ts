/**
 * A module's last successful load (text, read files with size and mtime, scan
 * `uses`), so an unchanged module skips read, compile and scan; admission is still
 * decided at each load. Used only on the same `stamp` and unchanged files (or the
 * same installed version). Any failure is a miss; enabling or disabling a plugin
 * drops its records.
 */

import type { RuntimeFs } from '../utils/fs/runtimeFs'
import { isAbsoluteRuntimePath, joinRuntimePath, normalizeRuntimePath, relativeRuntimePath } from '../utils/runtimePaths'
import { MODS_ABI } from './modAdmission'
import type { ModCompileGraph, ModCompileRecord } from './modCompiler'
import type { ModModuleRef } from './modRuntimeContract'
import type { ModUses } from './modScan'
import { isModLineMap } from './modLineMap'

/** Raise when the compiler, the linker or the scan changes what it produces:
 *  every record made before is then ignored. */
export const MOD_BUILD_REVISION = 3

export const MOD_BUILD_STAMP = `${MODS_ABI}; build ${MOD_BUILD_REVISION}`

export type ModBuildFile = { path: string; size: number; mtimeMs: number }

/** What a compile answers: its text, the files it read, and what lets the
 *  next compile of unchanged files skip the compiler (`graph`). */
export type ModBuiltModule = {
  source: string
  files: readonly string[]
  uses?: ModUses
  graph?: ModCompileGraph
}

/** A loader's compile: `previous` is the module's last compile, when kept. */
export type ModCompileFn = (
  ref: ModModuleRef,
  source: string,
  previous?: ModCompileRecord | null,
) => Promise<string | ModBuiltModule>

export type ModBuild = {
  /** The text the worker runs. */
  source: string
  /** The entry file as read: what the runtime compares a reload against. */
  entrySource: string
  /** Whether `source` is the compiler's output (else it is `entrySource`). */
  compiled: boolean
  /** The files the build read, entry first. */
  files: readonly string[]
  uses?: ModUses
  graph?: ModCompileGraph
}

type ModBuildRecord = {
  stamp: string
  path: string
  pinned?: { provenance: string; version: string }
  files: ModBuildFile[]
  source: string
  entrySource: string
  compiled: boolean
  uses?: ModUses
  graph?: ModCompileGraph
}

export type ModBuildStore = {
  /** The record for `ref` when its files are as they were; else null. */
  lookup(ref: ModModuleRef): Promise<ModBuild | null>
  /** The module's last compile whatever its files' stats, for the compiler
   *  to check by content (`compileModModule`'s `previous`); else null. */
  previous?(ref: ModModuleRef): Promise<ModCompileRecord | null>
  /** Keep what a successful load produced (failures are dropped). */
  remember(ref: ModModuleRef, build: ModBuild): Promise<void>
  /** Drop the module's record (its plugin was switched off or on). */
  forget(ref: ModModuleRef): Promise<void>
}

/** `<name>@<marketplace>`: installed into a folder of its own version. */
function pinOf(ref: ModModuleRef): { provenance: string; version: string } | undefined {
  const provenance = ref.provenance
  if (!provenance || !ref.version) return undefined
  const at = provenance.lastIndexOf('@')
  const source = at === -1 ? '' : provenance.slice(at + 1)
  if (source === '' || source === 'inline' || source === 'builtin') return undefined
  return { provenance, version: ref.version }
}

/** FNV-1a 32 of the path: a stable, short file name per module. */
function pathHash(path: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < path.length; i++) {
    hash ^= path.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** A plugin name as a file name prefix; never holds `@`, which separates it. */
function safeName(plugin: string): string {
  return plugin.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || 'mod'
}

/** `<plugin>@<path hash>.json`: one record per module path. */
function fileNameOf(ref: ModModuleRef): string {
  return `${safeName(ref.plugin)}@${pathHash(ref.path)}.json`
}

const buildsDirOf = (modsDir: string) => joinRuntimePath(modsDir, '.builds')

/** Only a file named as this store names its records is ever deleted. */
const RECORD_NAME = /^[A-Za-z0-9._-]+@[0-9a-f]{8}\.json$/

function isUnder(root: string, path: string): boolean {
  const rel = relativeRuntimePath(normalizeRuntimePath(root), normalizeRuntimePath(path))
  return !isAbsoluteRuntimePath(rel) && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\')
}

/**
 * Drop the records of a plugin switched on or off where no runtime saw it:
 * by its name (an installed plugin's `<name>@<marketplace>` id names it), or
 * by its folder (every module under it). Only the record files of
 * `<modsDir>/.builds/` (`<name>@<hash>.json`) are ever deleted.
 */
export async function forgetModBuilds(
  fs: Pick<RuntimeFs, 'readdir' | 'readFile' | 'unlink'>,
  modsDir: string,
  which: { plugin?: string; root?: string },
): Promise<void> {
  const dir = buildsDirOf(modsDir)
  let entries
  try {
    entries = await fs.readdir(dir)
  } catch {
    return
  }
  const prefix = which.plugin !== undefined ? `${safeName(which.plugin)}@` : undefined
  for (const entry of entries) {
    if (!entry.isFile() || !RECORD_NAME.test(entry.name)) continue
    const file = joinRuntimePath(dir, entry.name)
    let drop = prefix !== undefined && entry.name.startsWith(prefix)
    if (!drop && which.root !== undefined) {
      try {
        const record = JSON.parse(String(await fs.readFile(file, { encoding: 'utf-8' }))) as { path?: unknown }
        drop = typeof record.path === 'string' && isUnder(which.root, record.path)
      } catch {
        drop = false
      }
    }
    if (drop) {
      sharedRecordText.delete(file)
      await fs.unlink(file).catch(() => undefined)
    }
  }
}

function isRecord(value: unknown): value is ModBuildRecord {
  if (typeof value !== 'object' || value === null) return false
  const r = value as Partial<ModBuildRecord>
  return (
    typeof r.stamp === 'string' &&
    typeof r.path === 'string' &&
    typeof r.source === 'string' &&
    typeof r.entrySource === 'string' &&
    typeof r.compiled === 'boolean' &&
    Array.isArray(r.files) &&
    r.files.length > 0 &&
    r.files.every(f => typeof f?.path === 'string' && typeof f.size === 'number' && typeof f.mtimeMs === 'number')
  )
}

function isGraph(value: unknown): value is ModCompileGraph {
  if (typeof value !== 'object' || value === null) return false
  const g = value as Partial<ModCompileGraph>
  return (
    typeof g.compiler === 'string' &&
    typeof g.digest === 'string' &&
    Array.isArray(g.missing) &&
    g.missing.every(path => typeof path === 'string') &&
    (g.lines === undefined || isModLineMap(g.lines))
  )
}

/**
 * Record file path → the text last read from it. Every mod runtime in the
 * worker reads the same records; equal text is answered with this one copy
 * instead of each runtime keeping its own. One entry per record file.
 */
const sharedRecordText = new Map<string, { source: string; entrySource: string }>()
let sharedRecordTextHits = 0

function shareRecordText(recordPath: string, record: ModBuildRecord): ModBuildRecord {
  const held = sharedRecordText.get(recordPath)
  if (held && held.source === record.source && held.entrySource === record.entrySource) {
    sharedRecordTextHits += 1
    return { ...record, source: held.source, entrySource: held.entrySource }
  }
  sharedRecordText.set(recordPath, { source: record.source, entrySource: record.entrySource })
  return record
}

/** Number of record files whose text is pooled (tests). */
export function sharedModBuildTextCount(): number {
  return sharedRecordText.size
}

/** Number of record reads answered with the pooled text (tests). */
export function sharedModBuildTextHitCount(): number {
  return sharedRecordTextHits
}

/** The store over `<modsDir>/builds/`. */
export function fileModBuildStore(
  fs: Pick<RuntimeFs, 'readFile' | 'writeFile' | 'stat' | 'unlink'>,
  modsDir: string,
  options: { ensureDir: (dir: string) => Promise<void> },
): ModBuildStore {
  const dir = buildsDirOf(modsDir)
  const fileOf = (ref: ModModuleRef) => joinRuntimePath(dir, fileNameOf(ref))

  const statOf = async (path: string): Promise<ModBuildFile | null> => {
    try {
      const stat = await fs.stat(path)
      if (typeof stat.size !== 'number' || typeof stat.mtimeMs !== 'number') return null
      return { path, size: stat.size, mtimeMs: stat.mtimeMs }
    } catch {
      return null
    }
  }

  const recordOf = async (ref: ModModuleRef): Promise<ModBuildRecord | null> => {
    const file = fileOf(ref)
    let record: unknown
    try {
      record = JSON.parse(String(await fs.readFile(file, { encoding: 'utf-8' })))
    } catch {
      return null
    }
    return isRecord(record) && record.stamp === MOD_BUILD_STAMP && record.path === ref.path
      ? shareRecordText(file, record)
      : null
  }

  return {
    async lookup(ref) {
      const record = await recordOf(ref)
      if (!record) return null
      const pin = pinOf(ref)
      const pinned =
        pin !== undefined && record.pinned?.provenance === pin.provenance && record.pinned.version === pin.version
      if (!pinned) {
        const now = await Promise.all(record.files.map(file => statOf(file.path)))
        const same = now.every(
          (stat, i) => stat !== null && stat.size === record.files[i]!.size && stat.mtimeMs === record.files[i]!.mtimeMs,
        )
        if (!same) return null
      }
      return {
        source: record.source,
        entrySource: record.entrySource,
        compiled: record.compiled,
        files: record.files.map(file => file.path),
        ...(record.uses ? { uses: record.uses } : {}),
        ...(isGraph(record.graph) && record.graph.lines ? { graph: record.graph } : {}),
      }
    },

    async previous(ref) {
      const record = await recordOf(ref)
      if (!record?.uses || !isGraph(record.graph)) return null
      const { compiler, missing, digest, lines } = record.graph
      return { compiler, missing, digest, ...(lines ? { lines } : {}), files: record.files.map(file => file.path), source: record.source, uses: record.uses }
    },

    async remember(ref, build) {
      const files = await Promise.all(build.files.map(statOf))
      // A file that cannot be stat'ed cannot be checked next time: keep nothing.
      if (files.some(file => file === null)) return
      const pin = pinOf(ref)
      const record: ModBuildRecord = {
        stamp: MOD_BUILD_STAMP,
        path: ref.path,
        ...(pin ? { pinned: pin } : {}),
        files: files as ModBuildFile[],
        source: build.source,
        entrySource: build.entrySource,
        compiled: build.compiled,
        ...(build.uses ? { uses: build.uses } : {}),
        ...(build.graph ? { graph: build.graph } : {}),
      }
      try {
        await options.ensureDir(dir)
        await fs.writeFile(fileOf(ref), JSON.stringify(record), { encoding: 'utf-8' })
        sharedRecordText.set(fileOf(ref), { source: build.source, entrySource: build.entrySource })
      } catch {
        // A speed-up only: the next load builds again.
      }
    },

    async forget(ref) {
      sharedRecordText.delete(fileOf(ref))
      await fs.unlink(fileOf(ref)).catch(() => undefined)
    },
  }
}
