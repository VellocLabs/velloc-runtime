/**
 * Contract: `workspace`, a FileSystemDirectoryHandle-shaped facade over the fs
 * bridge (F-21). Standard surface only, platform-shaped errors (DOMException
 * names, TypeError for invalid names); unsupported calls fail like the real API
 * on disk: `createSyncAccessHandle()` → InvalidStateError, `move()` →
 * NotSupportedError. Names are one or more '/'-joined components ('\' accepted
 * and normalized), none '.' or '..', so a handle only reaches down from its root.
 * Writes buffer and commit as one `writeFile` on `close()`.
 * Security: containment and permission belong to the broker (SuperEditTool),
 * through the hosted Read/Write pipeline. A `getDirectory(absPath)` root is gated
 * on the absolute path, so outside-workspace directories prompt; the workspace
 * boundary is the permission pipeline, not the handle.
 */

import type { RunJsFsOp } from './runJsProtocol'

/** Broker round-trip for one primitive. Rejects with a `.name`-carrying error
 *  the caller surfaces as-is. */
export type WorkspaceFsCall = (
  op: RunJsFsOp,
  payload: Record<string, unknown>,
) => Promise<unknown>

type StatResult = { kind: 'file' | 'directory'; size: number; mtimeMs?: number }
type ReaddirResult = Array<{ name: string; kind: 'file' | 'directory' }>
type ReadFileResult = { bytes: Uint8Array; mtimeMs?: number }

/** DOMException when the platform provides it (Worker + node ≥17), else an
 *  Error carrying the same `.name` — models key on the name either way. */
export function domError(name: string, message: string): Error {
  try {
    if (typeof DOMException === 'function') {
      return new DOMException(message, name) as unknown as Error
    }
  } catch {
    /* fall through */
  }
  const err = new Error(message)
  err.name = name
  return err
}

/** Validate a child name for getFileHandle/getDirectoryHandle/removeEntry.
 *  Accepts one OR MORE '/'-joined components (superset of the spec's single
 *  component), each non-empty and not '.'/'..'. '\' is a separator ALIAS
 *  (normalized to '/') — the model pastes Windows paths verbatim, and a
 *  Windows filename can never contain '\'. Invalid → TypeError (per spec).
 *  Returns the normalized ('/'-joined) relative name. */
function validateName(name: unknown): string {
  if (typeof name !== 'string' || name.length === 0) {
    throw new TypeError(`Name is not allowed: ${String(name)}`)
  }
  const normalized = name.replace(/\\/g, '/')
  const parts = normalized.split('/')
  for (const part of parts) {
    if (part.length === 0 || part === '.' || part === '..') {
      throw new TypeError(`Name is not allowed: ${String(name)}`)
    }
  }
  return normalized
}

function joinRel(parent: string, name: string): string {
  return parent === '' ? name : `${parent}/${name}`
}

const encoder = new TextEncoder()

async function toBytes(
  data: string | ArrayBuffer | ArrayBufferView | Blob,
): Promise<Uint8Array> {
  if (typeof data === 'string') return encoder.encode(data)
  if (data instanceof Uint8Array) return data
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  }
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    return new Uint8Array(await data.arrayBuffer())
  }
  throw new TypeError('Unsupported write data type')
}

/** FileSystemWritableFileStream-shaped writer: buffers locally, commits ONE
 *  `writeFile` on close(). Supports the spec's write forms (raw data, and
 *  {type:'write'|'seek'|'truncate'} command objects), seek/truncate, abort,
 *  and a minimal getWriter() for `WritableStream`-style callers. */
class WorkspaceWritableStream {
  private buffer: Uint8Array
  private cursor = 0
  private closed = false
  private aborted = false
  /** True private (see WorkspaceDirectoryHandle) — the script must not be able
   *  to reach the raw broker call through the stream object either. */
  readonly #callFs: WorkspaceFsCall

  constructor(
    private readonly relPath: string,
    callFs: WorkspaceFsCall,
    existing: Uint8Array | null,
  ) {
    this.#callFs = callFs
    this.buffer = existing ? existing.slice() : new Uint8Array(0)
  }

  private ensureOpen(): void {
    if (this.closed || this.aborted) {
      throw domError('InvalidStateError', 'The stream is closed.')
    }
  }

  private writeAt(bytes: Uint8Array, at: number): void {
    const end = at + bytes.byteLength
    if (end > this.buffer.byteLength) {
      const grown = new Uint8Array(end)
      grown.set(this.buffer)
      this.buffer = grown
    }
    this.buffer.set(bytes, at)
    this.cursor = end
  }

  async write(
    data:
      | string
      | ArrayBuffer
      | ArrayBufferView
      | Blob
      | {
          type: 'write' | 'seek' | 'truncate'
          data?: string | ArrayBuffer | ArrayBufferView | Blob
          position?: number
          size?: number
        },
  ): Promise<void> {
    this.ensureOpen()
    const isBlob = typeof Blob !== 'undefined' && data instanceof Blob
    if (
      data &&
      typeof data === 'object' &&
      !isBlob &&
      'type' in data &&
      (data.type === 'write' || data.type === 'seek' || data.type === 'truncate')
    ) {
      // Explicit re-narrow: Blob also carries a string `type`, so TS cannot
      // discriminate the union on `type` alone (the isBlob guard above did the
      // runtime half).
      const cmd = data as {
        type: 'write' | 'seek' | 'truncate'
        data?: string | ArrayBuffer | ArrayBufferView | Blob
        position?: number
        size?: number
      }
      if (cmd.type === 'seek') {
        return this.seek(cmd.position ?? 0)
      }
      if (cmd.type === 'truncate') {
        return this.truncate(cmd.size ?? 0)
      }
      if (cmd.data === undefined) {
        throw domError('SyntaxError', 'write requires a data argument')
      }
      const at = cmd.position ?? this.cursor
      this.writeAt(await toBytes(cmd.data), at)
      return
    }
    this.writeAt(await toBytes(data as string | ArrayBuffer | ArrayBufferView | Blob), this.cursor)
  }

  async seek(position: number): Promise<void> {
    this.ensureOpen()
    this.cursor = Math.max(0, position)
  }

  async truncate(size: number): Promise<void> {
    this.ensureOpen()
    const next = new Uint8Array(size)
    next.set(this.buffer.subarray(0, Math.min(size, this.buffer.byteLength)))
    this.buffer = next
    if (this.cursor > size) this.cursor = size
  }

  async close(): Promise<void> {
    this.ensureOpen()
    this.closed = true
    await this.#callFs('writeFile', { path: this.relPath, bytes: this.buffer })
  }

  async abort(): Promise<void> {
    this.aborted = true
  }

  /** Minimal WritableStreamDefaultWriter shim for getWriter()-style callers. */
  getWriter(): {
    write: (data: Parameters<WorkspaceWritableStream['write']>[0]) => Promise<void>
    close: () => Promise<void>
    abort: () => Promise<void>
    releaseLock: () => void
  } {
    return {
      write: data => this.write(data),
      close: () => this.close(),
      abort: () => this.abort(),
      releaseLock: () => {},
    }
  }
}

class WorkspaceFileHandle {
  readonly kind = 'file' as const
  /** True private (see WorkspaceDirectoryHandle). */
  readonly #callFs: WorkspaceFsCall

  constructor(
    readonly name: string,
    /** Workspace-relative path ('' is the root, so never seen here). */
    private readonly relPath: string,
    callFs: WorkspaceFsCall,
  ) {
    this.#callFs = callFs
  }

  async getFile(): Promise<File> {
    const { bytes, mtimeMs } = (await this.#callFs('readFile', {
      path: this.relPath,
    })) as ReadFileResult
    return new File([bytes as BlobPart], this.name, {
      lastModified: mtimeMs ?? Date.now(),
    })
  }

  async createWritable(options?: {
    keepExistingData?: boolean
  }): Promise<WorkspaceWritableStream> {
    let existing: Uint8Array | null = null
    if (options?.keepExistingData) {
      try {
        const { bytes } = (await this.#callFs('readFile', {
          path: this.relPath,
        })) as ReadFileResult
        existing = bytes
      } catch {
        existing = null
      }
    }
    return new WorkspaceWritableStream(this.relPath, this.#callFs, existing)
  }

  /** OPFS-only in real Chromium — fail exactly the way the real API fails on
   *  a real-disk directory. */
  async createSyncAccessHandle(): Promise<never> {
    throw domError(
      'InvalidStateError',
      'createSyncAccessHandle is only supported for origin-private files.',
    )
  }

  async move(): Promise<never> {
    throw domError('NotSupportedError', 'move is not supported here.')
  }

  async isSameEntry(other: { kind?: string; name?: string }): Promise<boolean> {
    return (
      (other as WorkspaceFileHandle | undefined)?.kind === 'file' &&
      (other as WorkspaceFileHandle).relPathOf?.() === this.relPath
    )
  }

  /** Internal identity for isSameEntry (not part of the standard surface). */
  relPathOf(): string {
    return this.relPath
  }

  async queryPermission(): Promise<'granted'> {
    return 'granted'
  }

  async requestPermission(): Promise<'granted'> {
    return 'granted'
  }
}

class WorkspaceDirectoryHandle {
  readonly kind = 'directory' as const
  /**
   * A true (`#`) private: the script holds these handles, and a TS `private`
   * would expose the raw primitive with `validateName` skipped. The broker still
   * gates every op; this closes a facade bypass, not the boundary.
   */
  readonly #callFs: WorkspaceFsCall

  constructor(
    readonly name: string,
    /** Workspace-relative path; '' for the root handle. */
    private readonly relPath: string,
    callFs: WorkspaceFsCall,
  ) {
    this.#callFs = callFs
  }

  private async statChild(rel: string): Promise<StatResult | null> {
    try {
      return (await this.#callFs('stat', { path: rel })) as StatResult
    } catch (err) {
      if ((err as Error)?.name === 'NotFoundError') return null
      throw err
    }
  }

  async getFileHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<WorkspaceFileHandle> {
    const child = validateName(name)
    const rel = joinRel(this.relPath, child)
    const stat = await this.statChild(rel)
    if (stat?.kind === 'directory') {
      throw domError('TypeMismatchError', `${child} is a directory.`)
    }
    if (!stat) {
      if (!options?.create) {
        throw domError('NotFoundError', `${child} does not exist.`)
      }
      await this.#callFs('writeFile', { path: rel, bytes: new Uint8Array(0) })
    }
    return new WorkspaceFileHandle(child, rel, this.#callFs)
  }

  async getDirectoryHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<WorkspaceDirectoryHandle> {
    const child = validateName(name)
    const rel = joinRel(this.relPath, child)
    const stat = await this.statChild(rel)
    if (stat?.kind === 'file') {
      throw domError('TypeMismatchError', `${child} is a file.`)
    }
    if (!stat) {
      if (!options?.create) {
        throw domError('NotFoundError', `${child} does not exist.`)
      }
      await this.#callFs('mkdir', { path: rel })
    }
    return new WorkspaceDirectoryHandle(child, rel, this.#callFs)
  }

  async removeEntry(
    name: string,
    options?: { recursive?: boolean },
  ): Promise<void> {
    const child = validateName(name)
    const rel = joinRel(this.relPath, child)
    const stat = await this.statChild(rel)
    if (!stat) {
      throw domError('NotFoundError', `${child} does not exist.`)
    }
    if (stat.kind === 'directory' && !options?.recursive) {
      const entries = (await this.#callFs('readdir', {
        path: rel,
      })) as ReaddirResult
      if (entries.length > 0) {
        throw domError(
          'InvalidModificationError',
          `${child} is not empty (pass { recursive: true }).`,
        )
      }
    }
    await this.#callFs('remove', { path: rel })
  }

  async *entries(): AsyncGenerator<
    [string, WorkspaceFileHandle | WorkspaceDirectoryHandle]
  > {
    const listing = (await this.#callFs('readdir', {
      path: this.relPath,
    })) as ReaddirResult
    for (const entry of listing) {
      const rel = joinRel(this.relPath, entry.name)
      yield [
        entry.name,
        entry.kind === 'directory'
          ? new WorkspaceDirectoryHandle(entry.name, rel, this.#callFs)
          : new WorkspaceFileHandle(entry.name, rel, this.#callFs),
      ]
    }
  }

  async *keys(): AsyncGenerator<string> {
    for await (const [name] of this.entries()) yield name
  }

  async *values(): AsyncGenerator<WorkspaceFileHandle | WorkspaceDirectoryHandle> {
    for await (const [, handle] of this.entries()) yield handle
  }

  [Symbol.asyncIterator](): AsyncGenerator<
    [string, WorkspaceFileHandle | WorkspaceDirectoryHandle]
  > {
    return this.entries()
  }

  async resolve(
    possibleDescendant: WorkspaceFileHandle | WorkspaceDirectoryHandle,
  ): Promise<string[] | null> {
    const target =
      possibleDescendant instanceof WorkspaceFileHandle
        ? possibleDescendant.relPathOf()
        : possibleDescendant instanceof WorkspaceDirectoryHandle
          ? possibleDescendant.relPathOf()
          : null
    if (target === null) return null
    if (target === this.relPath) return []
    const prefix = this.relPath === '' ? '' : `${this.relPath}/`
    if (!target.startsWith(prefix)) return null
    return target.slice(prefix.length).split('/')
  }

  async isSameEntry(other: { kind?: string }): Promise<boolean> {
    return (
      (other as WorkspaceDirectoryHandle | undefined)?.kind === 'directory' &&
      (other as WorkspaceDirectoryHandle).relPathOf?.() === this.relPath
    )
  }

  /** Internal identity for isSameEntry/resolve (not standard surface). */
  relPathOf(): string {
    return this.relPath
  }

  async queryPermission(): Promise<'granted'> {
    return 'granted'
  }

  async requestPermission(): Promise<'granted'> {
    return 'granted'
  }
}

export type { WorkspaceDirectoryHandle, WorkspaceFileHandle }

function basename(absPath: string): string {
  const norm = absPath.replace(/\\/g, '/').replace(/\/+$/, '')
  const slash = norm.lastIndexOf('/')
  return slash >= 0 ? norm.slice(slash + 1) || norm : norm
}

/** Wrap `callFs` so every op carries `root` — the broker anchors + gates the
 *  op against this absolute directory instead of the session workspace. */
function anchoredCall(callFs: WorkspaceFsCall, root: string): WorkspaceFsCall {
  return (op, payload) => callFs(op, { ...payload, root })
}

/** Build the root `workspace` handle the script receives (session workspace;
 *  ops leave `root` unset so the broker uses the session cwd). */
export function createWorkspaceFacade(
  rootName: string,
  callFs: WorkspaceFsCall,
): WorkspaceDirectoryHandle {
  return new WorkspaceDirectoryHandle(rootName, '', callFs)
}

/**
 * `getDirectory(absPath)`: a handle anchored at an absolute directory, a separate
 * function so `workspace` stays standard. Ops are gated on the absolute path.
 * Rejects NotFoundError / TypeMismatchError when missing or not a directory.
 */
export function createGetDirectory(
  callFs: WorkspaceFsCall,
): (absPath: string) => Promise<WorkspaceDirectoryHandle> {
  return async (absPath: string) => {
    if (typeof absPath !== 'string' || absPath.length === 0) {
      throw new TypeError('getDirectory requires an absolute path string.')
    }
    const rooted = anchoredCall(callFs, absPath)
    // '' path = the root itself; stat validates existence + kind up front.
    const stat = (await rooted('stat', { path: '' })) as {
      kind: 'file' | 'directory'
    }
    if (stat.kind !== 'directory') {
      throw domError('TypeMismatchError', `${absPath} is not a directory.`)
    }
    return new WorkspaceDirectoryHandle(basename(absPath), '', rooted)
  }
}
