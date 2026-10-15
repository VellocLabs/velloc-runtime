import type {
  BridgeFsDirentResult,
  BridgeFsStatResult,
  BrowserBridgeAction,
  BrowserBridgeCapability,
  BrowserBridgeRequestPayload,
  BrowserBridgeResult,
  BrowserBridgeRoute,
  BrowserBridgeTransport,
} from '../browser/bridge/browserBridgeProtocol'
import { createBridgeRoute } from '../browser/bridge/browserBridgeProtocol'
import type { RuntimeFsEntry, RuntimeFs, RuntimeFsStat } from './fs/runtimeFs'

export type CreateBrowserFsOperationsOptions = {
  transport: BrowserBridgeTransport
  createRequestId: () => string
  initialCwd?: string
}

const TEXT_DECODER = new TextDecoder()
const TEXT_ENCODER = new TextEncoder()

function createFsStat(result: BridgeFsStatResult): RuntimeFsStat {
  return {
    size: result.size,
    mtimeMs: result.mtimeMs,
    ctimeMs: result.ctimeMs,
    birthtimeMs: result.birthtimeMs,
    isFile: () => result.isFile,
    isDirectory: () => result.isDirectory,
    isSymbolicLink: () => result.isSymbolicLink,
    isFIFO: () => result.isFIFO,
    isSocket: () => result.isSocket,
    isCharacterDevice: () => result.isCharacterDevice,
    isBlockDevice: () => result.isBlockDevice,
  }
}

function createFsDirent(result: BridgeFsDirentResult): RuntimeFsEntry {
  return {
    name: result.name,
    isFile: () => result.isFile,
    isDirectory: () => result.isDirectory,
    isSymbolicLink: () => result.isSymbolicLink,
  }
}

/** The error `send` throws for an `ok:false` envelope. `message` keeps the
 *  flattened `` `${code}: ${message}` `` shape the message-prefix classifiers
 *  (`isFsNotFoundError`, `isFsTransportFailure`, `isMissingFileError`) are
 *  anchored on; `bridgeCode` is the envelope code (`FS_ERROR`,
 *  `transport_disposed`, `bridge_timeout`, `NOT_IMPLEMENTED`, …); `code` is
 *  set ONLY when the host discriminated the failure with a Node-style wire
 *  code (`ENOENT: …`, `EACCES: …`, nexus_fs_host.cc `FsFailureMessage`). */
export type BridgeFsError = Error & { code?: string; bridgeCode: string }

// Leading Node-style errno code in the host's message. Anchored: the code is
// the discriminator, never prose embedded later in the message.
const WIRE_CODE_PATTERN = /^(E[A-Z]+)\b/

function toBridgeFsError(error: { code: string; message: string }): BridgeFsError {
  const err = new Error(`${error.code}: ${error.message}`) as BridgeFsError
  err.bridgeCode = error.code
  // `.code` follows the `NodeJS.ErrnoException` convention so callers that
  // branch on `code === 'ENOENT'` / `code !== 'ENOENT'` (the instruction files'
  // `probeInstructionFile`, the memory adapter's read guard) see the real
  // discriminator. It is deliberately NOT set to the envelope code: a generic
  // `FS_ERROR` / `transport_disposed` there would read as "a positively
  // identified non-ENOENT failure" and, on a host that emits undiscriminated
  // messages, turn every missing file into "unreadable".
  const wireCode = WIRE_CODE_PATTERN.exec(error.message)?.[1]
  if (wireCode) err.code = wireCode
  return err
}

function unsupportedSync(method: string): never {
  throw new Error(
    `Synchronous bridge call "${method}" is not supported by BrowserFsOperations.`,
  )
}

export function createBrowserFsOperations(
  options: CreateBrowserFsOperationsOptions,
): RuntimeFs {
  let cwdCache = options.initialCwd ?? '.'

  async function send<
    C extends BrowserBridgeCapability,
    A extends BrowserBridgeAction<C>,
  >(
    route: BrowserBridgeRoute<C, A>,
    payload: BrowserBridgeRequestPayload<C, A>,
  ): Promise<BrowserBridgeResult<C, A>> {
    const response = await options.transport.request({
      id: options.createRequestId(),
      route,
      payload,
    }) as { ok: true; result: BrowserBridgeResult<C, A> } | {
      ok: false
      error: { code: string; message: string }
    }

    if (!response.ok) {
      throw toBridgeFsError(response.error)
    }

    return response.result
  }

  void send(createBridgeRoute('fs', 'cwd'), {}).then(
    cwd => {
      cwdCache = cwd
    },
    () => {},
  )

  return {
    cwd() {
      return cwdCache
    },
    existsSync() {
      return false
    },
    async stat(path: string) {
      return createFsStat(await send(createBridgeRoute('fs', 'stat'), { path }))
    },
    async readdir(path: string) {
      return (await send(createBridgeRoute('fs', 'readdir'), { path })).map(
        createFsDirent,
      )
    },
    async rm(
      path: string,
      fsOptions?: { recursive?: boolean; force?: boolean },
    ) {
      await send(createBridgeRoute('fs', 'rm'), {
        path,
        recursive: fsOptions?.recursive,
        force: fsOptions?.force,
      })
    },
    async unlink(path: string) {
      await send(createBridgeRoute('fs', 'unlink'), { path })
    },
    async rename(oldPath: string, newPath: string) {
      try {
        await send(createBridgeRoute('fs', 'rename'), { oldPath, newPath })
      } catch (err) {
        // Host refusal strings ("Source does not exist" / "Destination already exists")
        // are a wire contract; NOT_IMPLEMENTED (an older binary without `fs.rename`)
        // becomes NotSupportedError, the signal to fall back to copy+delete.
        const message = err instanceof Error ? err.message : String(err)
        const name = message.includes('Source does not exist')
          ? 'NotFoundError'
          : message.includes('Destination already exists')
            ? 'AlreadyExistsError'
            : message.startsWith('NOT_IMPLEMENTED')
              ? 'NotSupportedError'
              : 'OperationError'
        const mapped = new Error(message)
        mapped.name = name
        throw mapped
      }
    },
    async mkdir(path: string, fsOptions?: { mode?: number }) {
      await send(createBridgeRoute('fs', 'mkdir'), {
        path,
        mode: fsOptions?.mode,
      })
    },
    async readFile(path: string, fsOptions: { encoding: string }) {
      const bytes = await send(createBridgeRoute('fs', 'readFile'), {
        path,
      })
      return TEXT_DECODER.decode(bytes)
    },
    async writeFile(
      path: string,
      data: string | Uint8Array,
      _fsOptions?: { encoding?: string },
    ) {
      const content =
        typeof data === 'string' ? TEXT_ENCODER.encode(data) : data
      await send(createBridgeRoute('fs', 'writeFile'), {
        path,
        content,
      })
    },
    statSync() {
      return unsupportedSync('statSync')
    },
    lstatSync() {
      return unsupportedSync('lstatSync')
    },
    readFileSync() {
      return unsupportedSync('readFileSync')
    },
    readBytesBlocking() {
      return unsupportedSync('readBytesBlocking')
    },
    readSync() {
      return unsupportedSync('readSync')
    },
    appendFileSync() {
      return unsupportedSync('appendFileSync')
    },
    copyFileSync() {
      return unsupportedSync('copyFileSync')
    },
    unlinkSync() {
      return unsupportedSync('unlinkSync')
    },
    renameSync() {
      return unsupportedSync('renameSync')
    },
    linkSync() {
      return unsupportedSync('linkSync')
    },
    symlinkSync() {
      return unsupportedSync('symlinkSync')
    },
    readlinkSync() {
      return unsupportedSync('readlinkSync')
    },
    realpathSync() {
      return unsupportedSync('realpathSync')
    },
    mkdirSync() {
      return unsupportedSync('mkdirSync')
    },
    readdirSync() {
      return unsupportedSync('readdirSync')
    },
    listDirBlocking() {
      return unsupportedSync('listDirBlocking')
    },
    dirIsEmptyBlocking() {
      return unsupportedSync('dirIsEmptyBlocking')
    },
    async readFileBytes(path: string, maxBytes?: number) {
      return await send(createBridgeRoute('fs', 'readFileBytes'), {
        path,
        maxBytes,
      })
    },
    async readRange(path: string, fsOptions: { offset: number; length: number }) {
      const result = await send(createBridgeRoute('fs', 'readRange'), {
        path,
        offset: fsOptions.offset,
        length: fsOptions.length,
      })

      return {
        buffer: result.data,
        bytesRead: result.bytesRead,
      }
    },
    async realpath(path: string, realpathOptions?: { resolveLinks?: boolean }) {
      const result = await send(createBridgeRoute('fs', 'realpath'), {
        path,
        ...(realpathOptions?.resolveLinks ? { resolveLinks: true } : {}),
      })
      return result.path
    },
  }
}
