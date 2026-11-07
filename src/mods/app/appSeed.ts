/**
 * An app's folder seeded from its plugin (F-40): the first open copies the
 * seed; a higher seed version replaces only files the person did not edit.
 * Nothing is deleted. `.velloc/app.json` records the version and file hashes.
 * Security: only regular files under the seed's real path are copied, and none
 * into a dot-named segment, so the seed never writes the app's `.velloc/`.
 */

import type { RuntimeFs } from '../../utils/fs/runtimeFs'
import { joinRuntimePath, normalizeRuntimePath, pathCompareKey } from '../../utils/runtimePaths'

export const APP_RECORD_PATH = '.velloc/app.json'
export const SEED_MAX_FILES = 200
export const SEED_MAX_FILE_BYTES = 1024 * 1024
const SEED_MAX_DEPTH = 8

export type AppSeedFs = Pick<RuntimeFs, 'readFile' | 'readFileBytes' | 'writeFile' | 'readdir' | 'mkdir' | 'stat' | 'realpath'>

export type AppSeedRequest = {
  fs: AppSeedFs
  /** The plugin's seed folder. */
  seedDir: string
  /** The app's folder. */
  appDir: string
  appId: string
  plugin: string
  seedVersion: number
}

export type AppSeedResult = {
  /** The seed version the folder holds now. */
  version: number
  /** The version it held before this open brought in a newer one. */
  upgradedFrom?: number
  /** App-relative files this open wrote. */
  written: string[]
  /** App-relative files the person edited that a newer seed would have replaced. */
  conflicts: string[]
}

export class AppSeedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AppSeedError'
  }
}

type AppRecord = { appId: string; plugin: string; seedVersion: number; files: Record<string, string> }

function readRecord(text: string | undefined): AppRecord | undefined {
  if (text === undefined) return undefined
  try {
    const value = JSON.parse(text) as Partial<AppRecord>
    if (typeof value.seedVersion !== 'number' || typeof value.files !== 'object' || value.files === null) return undefined
    const files: Record<string, string> = {}
    for (const [path, hash] of Object.entries(value.files)) if (typeof hash === 'string') files[path] = hash
    return { appId: String(value.appId ?? ''), plugin: String(value.plugin ?? ''), seedVersion: value.seedVersion, files }
  } catch {
    return undefined
  }
}

async function hashOf(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

async function readOptional(read: () => Promise<Uint8Array>): Promise<Uint8Array | undefined> {
  try {
    return await read()
  } catch {
    return undefined
  }
}

const underRoot = (root: string, path: string): boolean => {
  const base = pathCompareKey(normalizeRuntimePath(root)).replace(/[\\/]+$/, '')
  const key = pathCompareKey(normalizeRuntimePath(path))
  return key === base || key.startsWith(`${base}/`) || key.startsWith(`${base}\\`)
}

/** The seed's files, app-relative with `/`, in a stable order. */
async function listSeed(fs: AppSeedFs, seedDir: string): Promise<string[]> {
  const real = (path: string) => fs.realpath!(path, { resolveLinks: true })
  const realRoot = fs.realpath ? await real(seedDir) : seedDir
  const out: string[] = []
  const walk = async (dir: string, relative: string, depth: number): Promise<void> => {
    if (depth > SEED_MAX_DEPTH) throw new AppSeedError(`the seed is nested deeper than ${SEED_MAX_DEPTH} folders`)
    // A link is never reported as one, so each folder's real path is checked.
    if (fs.realpath && !underRoot(realRoot, await real(dir))) return
    const entries = [...(await fs.readdir(dir))].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue
      const rel = relative ? `${relative}/${entry.name}` : entry.name
      const path = joinRuntimePath(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(path, rel, depth + 1)
      } else if (entry.isFile()) {
        if (fs.realpath && !underRoot(realRoot, await real(path))) continue
        out.push(rel)
        if (out.length > SEED_MAX_FILES) throw new AppSeedError(`the seed holds more than ${SEED_MAX_FILES} files`)
      }
    }
  }
  await walk(seedDir, '', 0)
  return out
}

const locks = new Map<string, Promise<unknown>>()

/** Seed `appDir` from `seedDir`; at most one seed per folder runs at a time. */
export function seedAppFolder(request: AppSeedRequest): Promise<AppSeedResult> {
  const key = pathCompareKey(normalizeRuntimePath(request.appDir))
  const run = (locks.get(key) ?? Promise.resolve()).catch(() => undefined).then(() => seedNow(request))
  locks.set(key, run)
  void run.finally(() => {
    if (locks.get(key) === run) locks.delete(key)
  }).catch(() => undefined)
  return run
}

async function seedNow({ fs, seedDir, appDir, appId, plugin, seedVersion }: AppSeedRequest): Promise<AppSeedResult> {
  const recordPath = joinRuntimePath(appDir, ...APP_RECORD_PATH.split('/'))
  let recordText: string | undefined
  try {
    recordText = await fs.readFile(recordPath, { encoding: 'utf-8' })
  } catch {
    recordText = undefined
  }
  const record = readRecord(recordText)
  if (record && record.plugin !== plugin) throw new AppSeedError(`the folder belongs to the plugin ${record.plugin}`)
  if (record && record.seedVersion >= seedVersion) return { version: record.seedVersion, written: [], conflicts: [] }

  const files = await listSeed(fs, seedDir)
  const written: string[] = []
  const conflicts: string[] = []
  const hashes: Record<string, string> = {}
  for (const rel of files) {
    const source = joinRuntimePath(seedDir, ...rel.split('/'))
    const target = joinRuntimePath(appDir, ...rel.split('/'))
    const stat = await fs.stat(source)
    if (stat.size > SEED_MAX_FILE_BYTES) throw new AppSeedError(`the seed file ${rel} is larger than ${SEED_MAX_FILE_BYTES} bytes`)
    const bytes = await fs.readFileBytes(source, SEED_MAX_FILE_BYTES + 1)
    if (bytes.length > SEED_MAX_FILE_BYTES) throw new AppSeedError(`the seed file ${rel} is larger than ${SEED_MAX_FILE_BYTES} bytes`)
    const seedHash = await hashOf(bytes)
    const current = await readOptional(() => fs.readFileBytes(target, SEED_MAX_FILE_BYTES + 1))
    if (current === undefined) {
      await fs.mkdir(joinRuntimePath(appDir, ...rel.split('/').slice(0, -1)))
      await fs.writeFile(target, bytes)
      written.push(rel)
      hashes[rel] = seedHash
      continue
    }
    const currentHash = await hashOf(current)
    if (currentHash === seedHash) {
      hashes[rel] = seedHash
    } else if (record?.files[rel] === currentHash) {
      await fs.writeFile(target, bytes)
      written.push(rel)
      hashes[rel] = seedHash
    } else {
      conflicts.push(rel)
      const before = record?.files[rel]
      if (before !== undefined) hashes[rel] = before
    }
  }
  await fs.mkdir(joinRuntimePath(appDir, '.velloc'))
  const next: AppRecord = { appId, plugin, seedVersion, files: { ...record?.files, ...hashes } }
  await fs.writeFile(recordPath, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf-8' })
  return { version: seedVersion, ...(record ? { upgradedFrom: record.seedVersion } : {}), written, conflicts }
}
