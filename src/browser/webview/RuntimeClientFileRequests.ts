import type {
  BrowserBridgeAction,
  BrowserBridgeCapability,
  BrowserBridgeRequestPayload,
  BrowserBridgeResult,
  BrowserBridgeRoute,
  BrowserBridgeTransport,
} from '../bridge/browserBridgeProtocol'
import { createBridgeRoute } from '../bridge/browserBridgeProtocol'
import type { AgentRuntimeWorkerInitPayload } from '../worker/workerProtocol'
import { randomUuid } from '../../utils/randomUuid'
import type { CompleteAttachment } from '@assistant-ui/react'
import { startFileSearch, type FileSearchRequest, type RuntimeFileAccess } from '../runtimeClient/fileAccess'
import type { FsxListDirResult, FsxListTreeResult, FsxSearchState } from '../runtimeProtocol'
import {
  BROWSER_COMPOSER_ATTACHMENT_EXTENSIONS,
  BROWSER_COMPOSER_ATTACHMENT_EXTENSIONS_NO_IMAGES,
  pathBytesToAttachmentFile,
} from './BrowserComposerAttachmentAdapter'
import type { BrowserRuntimeClientState } from './browserRuntimeClientState'

/** What the file requests read on their client: the state and init payload
 *  (for the session id) and the client's lazy start. */
export interface FileRequestsHost {
  readonly state: BrowserRuntimeClientState
  readonly initPayload: AgentRuntimeWorkerInitPayload
  startOnce(): Promise<void>
}

/**
 * Contract: a session client's file requests — `fsx` over the runtime
 * connection — and the host's attachment picker over its bridge transport.
 * Holds no state; every request is for the client's current session.
 */
export class RuntimeClientFileRequests {
  constructor(
    private readonly files: RuntimeFileAccess | null,
    private readonly hostBridgeTransport: BrowserBridgeTransport,
    private readonly host: FileRequestsHost,
  ) {}

  private async requestHostBridge<
    C extends BrowserBridgeCapability,
    A extends BrowserBridgeAction<C>,
  >(
    route: BrowserBridgeRoute<C, A>,
    payload: BrowserBridgeRequestPayload<C, A>,
  ): Promise<BrowserBridgeResult<C, A>> {
    const response = await this.hostBridgeTransport.request({
      id: randomUuid(),
      route,
      payload,
    }) as { ok: true; result: BrowserBridgeResult<C, A> } | {
      ok: false
      error: { code: string; message: string }
    }

    if (!response.ok) {
      throw new Error(`${response.error.code}: ${response.error.message}`)
    }

    return response.result
  }

  /** The session this client's file requests are made for. */
  private fileSessionId(): string {
    const sessionId = this.host.state.snapshot?.sessionId ?? this.host.initPayload.sessionId
    if (!sessionId) throw new Error('fsx: this client has no session id yet')
    return sessionId
  }

  /** `fsx` over the runtime connection. Absent only in tests that never touch files — and then loudly. */
  private requireFiles(): RuntimeFileAccess {
    if (!this.files) throw new Error('fsx: this BrowserRuntimeClient was built without file access')
    return this.files
  }

  /**
   * Read a file's full contents as UTF-8 text, over `fsx.readText`. Backs the
   * right-panel Files view, which shows the complete, current file for a
   * path the user clicked in the transcript (the inline Read card only has the
   * slice that was read). Rejects on error (missing file, a path outside a
   * scoped connection's roots).
   */
  async readFileText(path: string): Promise<string> {
    await this.host.startOnce()
    return this.requireFiles().readText(this.fileSessionId(), path)
  }

  /**
   * Show a video, audio, image or PDF file in the host's viewer window, over
   * `fsx.openInWindow`. Rejects like `readFileText`, and for any other file.
   */
  async openFileInWindow(path: string): Promise<void> {
    await this.host.startOnce()
    await this.requireFiles().openInWindow(this.fileSessionId(), path)
  }

  /**
   * A directory's entries over `fsx.listDir` (the Files pane's browse state). A relative
   * `path` resolves against the session's cwd. Rejects like `readFileText`.
   */
  async listDir(path: string): Promise<FsxListDirResult> {
    await this.host.startOnce()
    return this.requireFiles().listDir(this.fileSessionId(), path)
  }

  /** The tree below `path` over `fsx.listTree` (go-to-file index); see `RuntimeFileAccess.listTree`. */
  async listTree(path: string, depth?: number): Promise<FsxListTreeResult> {
    await this.host.startOnce()
    return this.requireFiles().listTree(this.fileSessionId(), path, depth)
  }

  /**
   * One Files pane search over `fsx.findFiles` / `fsx.searchText`, its state followed with
   * `onState`; resolves with the function that ends it. Rejects like `listDir`.
   */
  async startFileSearch(
    request: FileSearchRequest,
    onState: (state: FsxSearchState) => void,
  ): Promise<() => void> {
    await this.host.startOnce()
    return startFileSearch(this.requireFiles(), this.fileSessionId(), request, onState)
  }

  /**
   * Existence check for a batch of paths (one `fsx.statBatch`). Never rejects: anything that
   * cannot be stat'ed resolves `isFile: false`.
   */
  async statFilePaths(
    paths: string[],
  ): Promise<Array<{ path: string; isFile: boolean }>> {
    if (paths.length === 0) return []
    await this.host.startOnce()
    try {
      const results = await this.requireFiles().statBatch(this.fileSessionId(), paths)
      return results.map((entry) => ({ path: entry.path, isFile: entry.isFile }))
    } catch {
      return paths.map((path) => ({ path, isFile: false }))
    }
  }

  /**
   * Write UTF-8 text back to a file over `fsx.writeText` (`full` scope) —
   * backs the right-panel Files view's editable mode (explicit save).
   */
  async writeFileText(path: string, text: string): Promise<void> {
    await this.host.startOnce()
    await this.requireFiles().writeText(this.fileSessionId(), path, text)
  }

  /**
   * Open the host's native multi-file picker and return the chosen files as `File`s (read
   * via `fsx.readBlob`). `[]` on cancel; a file that fails to read is skipped. `allowImages`
   * is a UX hint only — `BrowserComposerAttachmentAdapter.add` is the hard gate; an explicit
   * `options.extensions` wins over it.
   */
  async pickComposerAttachmentFiles(
    options?: { allowImages?: boolean; extensions?: readonly string[] },
  ): Promise<File[]> {
    await this.host.startOnce()
    const extensions =
      options?.extensions !== undefined
        ? [...options.extensions]
        : options?.allowImages === false
          ? [...BROWSER_COMPOSER_ATTACHMENT_EXTENSIONS_NO_IMAGES]
          : [...BROWSER_COMPOSER_ATTACHMENT_EXTENSIONS]
    const result = await this.requestHostBridge(
      createBridgeRoute('ui', 'pickAttachmentFiles'),
      { extensions },
    )
    if (result.canceled || result.paths.length === 0) {
      return []
    }
    const files: File[] = []
    const sessionId = this.fileSessionId()
    for (const path of result.paths) {
      try {
        const bytes = await this.requireFiles().readBytes(sessionId, path)
        files.push(pathBytesToAttachmentFile(path, bytes))
      } catch (error) {
        console.warn('Failed to read picked attachment file:', path, error)
      }
    }
    return files
  }

  /**
   * Store a composer attachment as a session upload (`sys.putBlob` +
   * `fsx.commitUpload`); the runtime picks the path under the session's
   * uploads directory and the prompt quotes it.
   */
  async uploadComposerAttachment(
    attachment: CompleteAttachment,
  ): Promise<string | null> {
    const file = attachment.file
    if (!(file instanceof File)) {
      return null
    }
    await this.host.startOnce()
    const content = new Uint8Array(await file.arrayBuffer())
    return this.requireFiles().upload(
      this.fileSessionId(),
      attachment.name || file.name,
      content,
      file.type || undefined,
    )
  }
}
