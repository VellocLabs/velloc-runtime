/**
 * `$.fs` (F-25): read (≤ 4 MiB), write, list, exists, stat and ancestors through the
 * session's fs bridge. Security: no permission prompt (enabling the plugin is the
 * consent), but the read size and the untrusted-session read boundary hold exactly
 * as for the Read tool, writes included. Missing = `ENOENT`; refused =
 * `NotAllowedError`.
 */

import { readInstructionFileParts } from '../memory/instructionFiles'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import { assertUntrustedReadAllowed } from '../permissions/untrustedReadBoundary'
import {
  dirnameRuntimePath,
  joinRuntimePath,
  pathCompareKey,
  resolveRuntimePath,
} from '../utils/runtimePaths'

export const MOD_FS_READ_LIMIT = 4 * 1024 * 1024

export type ModFsKind = 'file' | 'dir' | 'other'

export type ModFsEntry = { name: string; kind: ModFsKind; size: number; mtimeMs: number; isLink: boolean }

export type ModFsStat = { kind: ModFsKind; size: number; mtimeMs: number; isLink: boolean; realPath?: string }

export type ModFsAncestorPart = { path: string; content: string }

export type ModFsAncestor = { dir: string; name: string; content: string; parts: ModFsAncestorPart[] }

export type ModFsAncestorsRequest = { names: readonly string[]; of?: string; below?: string }

/** What `$.fs` needs of the session. */
export type ModFsHost = {
  read(path: string, as: 'text' | 'bytes'): Promise<string | { base64: string }>
  write(path: string, text: string): Promise<void>
  list(path?: string): Promise<ModFsEntry[]>
  exists(path: string): Promise<boolean>
  stat(path: string, resolve: boolean): Promise<ModFsStat>
  ancestors(request: ModFsAncestorsRequest): Promise<ModFsAncestor[]>
}

export type ModFsOptions = {
  /** The session's working directory, absolute: what a relative path is under. */
  cwd: string
  /** A child session on an untrusted provider: the root it may not leave
   *  (`ToolUseContext.options.untrustedReadRoot`). Absent: no boundary. */
  readRoot?: string
  /** The session storage tree, kept out of an untrusted child's reach. */
  sessionStoragePath?: string
  /** The home directory an instruction file's `@~/` import stands under. */
  homeDir?: string
  /** The read cap, for tests. */
  readLimit?: number
}

function named(name: string, message: string, code?: string): Error {
  const error = new Error(message) as Error & { code?: string }
  error.name = name
  if (code) error.code = code
  return error
}

function notFound(path: string, op: string): Error {
  return named('NotFoundError', `ENOENT: no such file or directory, ${op} '${path}'`, 'ENOENT')
}

function kindOf(stat: { isFile(): boolean; isDirectory(): boolean }): ModFsKind {
  if (stat.isFile()) return 'file'
  if (stat.isDirectory()) return 'dir'
  return 'other'
}

function toBase64(bytes: Uint8Array): string {
  const B = (globalThis as { Buffer?: { from(b: Uint8Array): { toString(enc: string): string } } }).Buffer
  if (B) return B.from(bytes).toString('base64')
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

/** `$.fs` over the session's fs bridge. */
/** A directory's spelling for comparing two: one separator, no trailing
 *  one, a drive letter's path in one case. */
function spellingOf(dir: string): string {
  const key = pathCompareKey(dir)
  return /^[A-Za-z]:/.test(key) ? key.toLowerCase() : key
}

export function fileModFs(fs: RuntimeFs, options: ModFsOptions): ModFsHost {
  const limit = options.readLimit ?? MOD_FS_READ_LIMIT

  /** The absolute path, inside the boundary when there is one. */
  const resolve = async (path: string): Promise<string> => {
    if (typeof path !== 'string' || path === '') throw new TypeError('$.fs: path must be a non-empty string')
    const abs = resolveRuntimePath(options.cwd, path)
    if (options.readRoot) {
      const verdict = await assertUntrustedReadAllowed(
        path,
        {
          options: {
            cwd: options.cwd,
            untrustedReadRoot: options.readRoot,
            ...(options.sessionStoragePath ? { sessionStoragePath: options.sessionStoragePath } : {}),
          },
        },
        fs,
      )
      if (!verdict.ok) throw named('NotAllowedError', `$.fs: ${verdict.reason}`)
    }
    return abs
  }

  const statOrNotFound = async (abs: string, op: string) => {
    try {
      return await fs.stat(abs)
    } catch {
      throw notFound(abs, op)
    }
  }

  const isLinkOf = (abs: string): boolean => {
    try {
      return fs.lstatSync(abs).isSymbolicLink()
    } catch {
      return false
    }
  }

  const ensureDir = async (dir: string): Promise<void> => {
    const missing: string[] = []
    let current = dir
    for (;;) {
      try {
        await fs.stat(current)
        break
      } catch {
        missing.unshift(current)
        const parent = dirnameRuntimePath(current)
        if (parent === current || parent === '') break
        current = parent
      }
    }
    for (const path of missing) {
      try {
        await fs.mkdir(path)
      } catch {
        /* made meanwhile, or the write below says what is wrong */
      }
    }
  }

  return {
    async read(path, as) {
      const abs = await resolve(path)
      const stat = await statOrNotFound(abs, 'open')
      if (!stat.isFile()) throw named('NotFoundError', `EISDIR: not a file, read '${abs}'`, 'EISDIR')
      if (stat.size > limit) {
        throw named('RangeError', `$.fs.read: ${abs} is ${stat.size} bytes, over the ${limit}-byte limit of one read`)
      }
      if (as === 'bytes') return { base64: toBase64(await fs.readFileBytes(abs, limit)) }
      return String(await fs.readFile(abs, { encoding: 'utf-8' }))
    },
    async write(path, text) {
      if (typeof text !== 'string') throw new TypeError('$.fs.write(path, text): text must be a string')
      const abs = await resolve(path)
      await ensureDir(dirnameRuntimePath(abs))
      await fs.writeFile(abs, text, { encoding: 'utf-8' })
    },
    async list(path) {
      const abs = await resolve(path ?? '.')
      const stat = await statOrNotFound(abs, 'scandir')
      if (!stat.isDirectory()) throw named('NotFoundError', `ENOTDIR: not a directory, scandir '${abs}'`, 'ENOTDIR')
      const entries = await fs.readdir(abs)
      const out: ModFsEntry[] = []
      for (const entry of entries) {
        const isLink = entry.isSymbolicLink()
        const kind: ModFsKind = isLink ? 'other' : entry.isFile() ? 'file' : entry.isDirectory() ? 'dir' : 'other'
        let size = 0
        let mtimeMs = 0
        if (kind === 'file') {
          try {
            const own = await fs.stat(joinRuntimePath(abs, entry.name))
            size = own.size
            mtimeMs = own.mtimeMs ?? 0
          } catch {
            /* gone between the listing and the stat */
          }
        }
        out.push({ name: entry.name, kind, size, mtimeMs, isLink })
      }
      return out
    },
    async exists(path) {
      const abs = await resolve(path)
      try {
        await fs.stat(abs)
        return true
      } catch {
        return false
      }
    },
    async stat(path, resolveLinks) {
      const abs = await resolve(path)
      const isLink = isLinkOf(abs)
      let stat
      try {
        stat = await fs.stat(abs)
      } catch {
        // A link that leads nowhere is `other`; anything else is missing.
        if (isLink) return { kind: 'other', size: 0, mtimeMs: 0, isLink: true }
        throw notFound(abs, 'stat')
      }
      const own: ModFsStat = {
        kind: kindOf(stat),
        size: stat.isFile() ? stat.size : 0,
        mtimeMs: stat.mtimeMs ?? 0,
        isLink,
      }
      if (resolveLinks && fs.realpath) {
        try {
          own.realPath = await fs.realpath(abs, { resolveLinks: true })
        } catch {
          /* leads nowhere: absent */
        }
      } else if (resolveLinks) {
        own.realPath = abs
      }
      return own
    },
    async ancestors(request) {
      const names = Array.isArray(request?.names) ? request.names : []
      for (const name of names) {
        if (typeof name !== 'string' || name === '' || name.split(/[\\/]/).includes('..') || !name.endsWith('.md')) {
          throw new TypeError(`$.fs.ancestors: names are relative .md file names with no "..", not "${String(name)}"`)
        }
      }
      const start = request.of !== undefined ? dirnameRuntimePath(await resolve(request.of)) : options.cwd
      const floor = request.below !== undefined ? spellingOf(await resolve(request.below)) : undefined
      // Climb, then read root first. "Only directories strictly inside
      // [`below`] are read …; a file not inside it finds nothing."
      const dirs: string[] = []
      let dir = start
      for (;;) {
        if (floor !== undefined && spellingOf(dir) === floor) break
        dirs.unshift(dir)
        const parent = dirnameRuntimePath(dir)
        if (parent === dir || parent === '') {
          if (floor !== undefined) return []
          break
        }
        dir = parent
      }
      const found: ModFsAncestor[] = []
      for (const where of dirs) {
        for (const name of names) {
          const file = joinRuntimePath(where, name)
          // The climb leaves the working directory, so each file passes the
          // boundary the other methods pass: under an untrusted root, one
          // above it is not read (review fix: the climb read past the root).
          if (options.readRoot) {
            try {
              await resolve(file)
            } catch {
              continue
            }
          }
          try {
            const stat = await fs.stat(file)
            if (!stat.isFile()) continue
          } catch {
            continue // not there
          }
          // "Its text as the engine's memory loader reads it": the loader's
          // own read, so an @import is followed, and a file it would not
          // load (empty once its comments are stripped) is not found.
          const read = await readInstructionFileParts(fs, file, options.homeDir, options.readRoot)
          if (read.length === 0) continue
          const parts = read.map(part => ({ path: part.path, content: part.content }))
          found.push({ dir: where, name, content: parts.map(part => part.content).join('\n\n'), parts })
        }
      }
      return found
    },
  }
}
