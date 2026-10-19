/**
 * RuntimeFileAccess: a client's file reads and writes as `fsx` requests on its
 * one runtime connection (P-3), so the runtime decides what a connection may
 * touch (`runtimeHub/fsxCapability.ts`) and bytes move only as `BlobRef`s.
 * Failures reject with the connection's `RuntimeRequestError` (`forbidden_scope`
 * outside a scoped connection's roots); `host_unavailable` is retried first.
 */
import {
  FSX_CAPABILITY,
  fsxSearchTopic,
  type FsxAction,
  type FsxCommitUploadResult,
  type FsxListDirResult,
  type FsxListTreeResult,
  type FsxReadBlobResult,
  type FsxReadTextResult,
  type FsxSearchStartResult,
  type FsxSearchState,
  type FsxSearchTextPayload,
  type FsxStatBatchResult,
  type FsxUserHomeResult,
  type RouteKey,
  type TopicId,
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
  /**
   * Start ranking the files below the folder `path` by name for `query`; resolves with the search id
   * whose results `watchSearch` follows. `refresh` lists the folder again instead of reusing the list.
   */
  findFiles(
    sessionId: string,
    path: string,
    query: string,
    options?: { limit?: number; refresh?: boolean },
  ): Promise<string>
  /** Start searching the contents of the files below the folder `path`; see `findFiles`. */
  searchText(
    sessionId: string,
    path: string,
    query: string,
    options?: Pick<FsxSearchTextPayload, 'caseSensitive' | 'wholeWord' | 'regex' | 'limit'>,
  ): Promise<string>
  /** Follow a search's state, the latest whole, until the returned function is called. */
  watchSearch(searchId: string, listener: (state: FsxSearchState) => void): Promise<() => void>
  /** End a search this connection started; unknown ids are ignored. */
  cancelSearch(searchId: string): Promise<void>
  writeText(sessionId: string, path: string, text: string): Promise<void>
  /** Store bytes as a session upload; resolves with the host path the runtime chose. */
  upload(sessionId: string, name: string, bytes: Uint8Array, mime?: string): Promise<string>
}

/** One Files pane search: a file-name query (`findFiles`) or a contents query (`searchText`). */
export type FileSearchRequest =
  | { kind: 'files'; path: string; query: string; limit?: number; refresh?: boolean }
  | ({ kind: 'text'; path: string; query: string } & Pick<
      FsxSearchTextPayload,
      'caseSensitive' | 'wholeWord' | 'regex' | 'limit'
    >)

/**
 * Start `request` and follow its state with `onState`; resolves with the function that stops
 * following and ends the search. Rejects like `findFiles` when the search cannot start.
 */
export async function startFileSearch(
  files: RuntimeFileAccess,
  sessionId: string,
  request: FileSearchRequest,
  onState: (state: FsxSearchState) => void,
): Promise<() => void> {
  const searchId =
    request.kind === 'files'
      ? await files.findFiles(sessionId, request.path, request.query, {
          ...(request.limit !== undefined ? { limit: request.limit } : {}),
          ...(request.refresh ? { refresh: true } : {}),
        })
      : await files.searchText(sessionId, request.path, request.query, {
          caseSensitive: request.caseSensitive === true,
          wholeWord: request.wholeWord === true,
          regex: request.regex === true,
          ...(request.limit !== undefined ? { limit: request.limit } : {}),
        })
  const unwatch = await files.watchSearch(searchId, onState)
  let stopped = false
  return () => {
    if (stopped) return
    stopped = true
    unwatch()
    void files.cancelSearch(searchId).catch(() => {})
  }
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
    async findFiles(sessionId, path, query, options = {}) {
      const result = await call<FsxSearchStartResult>('findFiles', { sessionId, path, query, ...options })
      return result.searchId
    },
    async searchText(sessionId, path, query, options = {}) {
      const result = await call<FsxSearchStartResult>('searchText', { sessionId, path, query, ...options })
      return result.searchId
    },
    async watchSearch(searchId, listener) {
      const connection = await options.connection()
      return connection.subscribe<FsxSearchState>(fsxSearchTopic(searchId) as TopicId, event => {
        if (event.payload) listener(event.payload)
      })
    },
    async cancelSearch(searchId) {
      await call<undefined>('cancelSearch', { searchId })
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
