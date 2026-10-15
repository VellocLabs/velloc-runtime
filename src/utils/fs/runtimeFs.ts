/**
 * Runtime filesystem abstraction. One realm-global slot holds the process fs;
 * session code should prefer `fsForContext`, which honours a per-runtime
 * override on the tool-use context.
 */

export type RuntimeFsEntry = {
  name: string
  isFile(): boolean
  isDirectory(): boolean
  isSymbolicLink(): boolean
}

export type RuntimeFsStat = {
  size: number
  mtimeMs?: number
  ctimeMs?: number
  birthtimeMs?: number
  isFile(): boolean
  isDirectory(): boolean
  isSymbolicLink(): boolean
  isFIFO(): boolean
  isSocket(): boolean
  isCharacterDevice(): boolean
  isBlockDevice(): boolean
}

/** Where the fs is anchored and whether a path exists. */
type FsLocation = {
  cwd(): string
  existsSync(path: string): boolean
}

/** Promise-returning file and directory operations. */
type FsAsyncOps = {
  readFile(path: string, options: { encoding: string }): Promise<string>
  readFileBytes(path: string, maxBytes?: number): Promise<Uint8Array>
  /** Optional ranged read; callers probe for it. */
  readRange?(
    path: string,
    options: { offset: number; length: number },
  ): Promise<{ buffer: Uint8Array; bytesRead: number }>
  writeFile(
    path: string,
    data: string | Uint8Array,
    options?: { encoding?: string },
  ): Promise<void>
  stat(path: string): Promise<RuntimeFsStat>
  readdir(path: string): Promise<RuntimeFsEntry[]>
  mkdir(path: string, options?: { mode?: number }): Promise<void>
  unlink(path: string): Promise<void>
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>
  /**
   * Optional atomic same-volume move (directory trees included) that never
   * overwrites. Callers probe for it and fall back when it is absent or fails
   * with an error named `NotSupportedError`. Other failure names:
   * `NotFoundError`, `AlreadyExistsError`, `OperationError`.
   */
  rename?(oldPath: string, newPath: string): Promise<void>
  /**
   * Optional canonical absolute path. With `resolveLinks: true` links are
   * followed on Windows too, and a path that does not exist yet resolves
   * through its deepest existing ancestor (for containment checks only).
   * Hosts unaware of the option return the default form. Callers probe and
   * fall back to string normalisation.
   */
  realpath?(path: string, options?: { resolveLinks?: boolean }): Promise<string>
}

/** Blocking reads. */
type FsSyncReads = {
  readFileSync(path: string, options: { encoding: string }): string
  readBytesBlocking(path: string): Uint8Array
  readSync(
    path: string,
    options: { length: number },
  ): { buffer: Uint8Array; bytesRead: number }
  statSync(path: string): RuntimeFsStat
  lstatSync(path: string): RuntimeFsStat
  readdirSync(path: string): RuntimeFsEntry[]
  listDirBlocking(path: string): string[]
  dirIsEmptyBlocking(path: string): boolean
}

/** Blocking writes. */
type FsSyncWrites = {
  appendFileSync(path: string, data: string, options?: { mode?: number }): void
  mkdirSync(path: string, options?: { mode?: number }): void
  copyFileSync(src: string, dest: string): void
  renameSync(oldPath: string, newPath: string): void
  unlinkSync(path: string): void
}

/** What a symbolic link points at; `junction` is a Windows directory link. */
export type SymlinkKind = 'dir' | 'file' | 'junction'

/** Link resolution, then link creation. */
type FsLinks = {
  realpathSync(path: string): string
  readlinkSync(path: string): string
  symlinkSync(target: string, path: string, kind?: SymlinkKind): void
  linkSync(target: string, path: string): void
}

/** The filesystem a runtime reads and writes through. */
export type RuntimeFs = FsLocation & FsAsyncOps & FsSyncReads & FsSyncWrites & FsLinks

function notConfigured(method: string): Error {
  return new Error(
    `Filesystem method "${method}" is unavailable: the runtime fs is not configured. ` +
      'Install a browser-backed adapter at runtime bootstrap.',
  )
}

function failSync(method: string): () => never {
  return () => {
    throw notConfigured(method)
  }
}

function failAsync(method: string): () => Promise<never> {
  return () => Promise.reject(notConfigured(method))
}

function emptyStat(): RuntimeFsStat {
  return {
    size: 0,
    isFile: failSync('stat.isFile'),
    isDirectory: failSync('stat.isDirectory'),
    isSymbolicLink: failSync('stat.isSymbolicLink'),
    isFIFO: failSync('stat.isFIFO'),
    isSocket: failSync('stat.isSocket'),
    isCharacterDevice: failSync('stat.isCharacterDevice'),
    isBlockDevice: failSync('stat.isBlockDevice'),
  }
}

/** The fs in effect until a real adapter is installed. */
export const unconfiguredFs: RuntimeFs = {
  cwd: () => '.',
  existsSync: () => false,
  stat: async () => emptyStat(),
  statSync: () => emptyStat(),
  lstatSync: () => emptyStat(),
  readdir: failAsync('readdir'),
  rm: failAsync('rm'),
  unlink: failAsync('unlink'),
  mkdir: failAsync('mkdir'),
  readFile: failAsync('readFile'),
  writeFile: failAsync('writeFile'),
  readFileSync: failSync('readFileSync'),
  readBytesBlocking: failSync('readBytesBlocking'),
  readSync: failSync('readSync'),
  appendFileSync: failSync('appendFileSync'),
  copyFileSync: failSync('copyFileSync'),
  unlinkSync: failSync('unlinkSync'),
  renameSync: failSync('renameSync'),
  linkSync: failSync('linkSync'),
  symlinkSync: failSync('symlinkSync'),
  readlinkSync: failSync('readlinkSync'),
  realpathSync: failSync('realpathSync'),
  mkdirSync: failSync('mkdirSync'),
  readdirSync: failSync('readdirSync'),
  listDirBlocking: failSync('listDirBlocking'),
  dirIsEmptyBlocking: failSync('dirIsEmptyBlocking'),
  readFileBytes: failAsync('readFileBytes'),
  readRange: failAsync('readRange'),
}

let activeFs: RuntimeFs = unconfiguredFs

/** Replace the realm-global process fs. Last writer wins. */
export function installProcessFs(fs: RuntimeFs): void {
  activeFs = fs
}

/** The realm-global process fs (`unconfiguredFs` until one is installed). */
export function processFs(): RuntimeFs {
  return activeFs
}

/** Put the slot back to `unconfiguredFs`. */
export function resetProcessFs(): void {
  activeFs = unconfiguredFs
}

/** The context's own fs when it carries one, else the process fs. */
export function fsForContext(context: {
  options: { fsOperations?: RuntimeFs | null }
}): RuntimeFs {
  return context.options.fsOperations ?? activeFs
}
