/**
 * RuntimeFileAccess: a client's file reads and writes as `fsx` requests on its
 * one runtime connection (P-3), so the runtime decides what a connection may
 * touch (`runtimeHub/fsxCapability.ts`) and bytes move only as `BlobRef`s.
 * Failures reject with the connection's `RuntimeRequestError` (`forbidden_scope`
 * outside a scoped connection's roots); `host_unavailable` is retried first.
 */
import {
  FSX_CAPABILITY,
  type FsxAction,
  type FsxCommitUploadResult,
  type FsxListDirResult,
  type FsxListTreeResult,
  type FsxReadBlobResult,
  type FsxReadTextResult,
  type FsxStatBatchResult,
  type FsxUserHomeResult,
  type RouteKey,
} from '../runtimeProtocol'
import { requestRetryingHostUnavailable, type HostUnavailableRetry } from './hostBridgeOverConnection'
import type { RuntimeConnection } from './RuntimeConnection'

export interface RuntimeFileAccess {
  /** The host user's home directory (the `~` of `~/.velloc`). */
  userHome(): Promise<string>
  /** A file's contents as UTF-8. A relative `path` resolves against the session's cwd. */
  readText(sessionId: string, path: string): Promise<string>
  readBytes(sessionId: string, path: string): Promise<Uint8Array>
  statBatch(sessionId: string, paths: readonly string[]): Promise<FsxStatBatchResult>
  /** A directory's entries, folders first; `truncated` when the runtime's cap cut the listing. */
  listDir(sessionId: string, path: string): Promise<FsxListDirResult>
  /**
   * The files and folders below `path`, `depth` levels down (the runtime's default when omitted),
   * without VCS, dependency and runtime directories; paths '/'-separated, relative to `path`.
   */
  listTree(sessionId: string, path: string, depth?: number): Promise<FsxListTreeResult>
  writeText(sessionId: string, path: string, text: string): Promise<void>
  /** Store bytes as a session upload; resolves with the host path the runtime chose. */
  upload(sessionId: string, name: string, bytes: Uint8Array, mime?: string): Promise<string>
}

export type RuntimeFileAccessOptions = {
  /** The client's one runtime connection; awaited per call so early callers queue behind the handshake. */
  connection: () => Promise<RuntimeConnection>
  retry?: HostUnavailableRetry
}

export function createRuntimeFileAccess(options: RuntimeFileAccessOptions): RuntimeFileAccess {
  const call = async <R>(action: FsxAction, payload: unknown): Promise<R> => {
    const connection = await options.connection()
    const route: RouteKey = `${FSX_CAPABILITY}.${action}`
    return requestRetryingHostUnavailable<R>(connection, route, payload, options.retry)
  }

  return {
    async userHome() {
      const result = await call<FsxUserHomeResult>('userHome', {})
      return result.path
    },
    async readText(sessionId, path) {
      const result = await call<FsxReadTextResult>('readText', { sessionId, path })
      return result.text
    },
    async readBytes(sessionId, path) {
      const result = await call<FsxReadBlobResult>('readBlob', { sessionId, path })
      const connection = await options.connection()
      return connection.readBlob(result.blob)
    },
    statBatch(sessionId, paths) {
      return call<FsxStatBatchResult>('statBatch', { sessionId, paths })
    },
    listDir(sessionId, path) {
      return call<FsxListDirResult>('listDir', { sessionId, path })
    },
    listTree(sessionId, path, depth) {
      return call<FsxListTreeResult>('listTree', {
        sessionId,
        path,
        ...(depth === undefined ? {} : { depth }),
      })
    },
    async writeText(sessionId, path, text) {
      await call<undefined>('writeText', { sessionId, path, text })
    },
    async upload(sessionId, name, bytes, mime) {
      const connection = await options.connection()
      const blob = await connection.putBlob(bytes, mime ? { mime } : {})
      const result = await call<FsxCommitUploadResult>('commitUpload', { sessionId, blob, name })
      return result.path
    },
  }
}
