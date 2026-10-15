/**
 * BackgroundShellHostBridge — the native primitives behind the background-shell registry
 * (`shell.spawn` with `persist`, `shell.persistentList`, `shell.persistentKill`, `fs.stat` +
 * `fs.readRange`) and output-file path resolution. The output file IS the child's log; nothing here writes it.
 */
import type { DirectPortBridgeTransport } from '../bridge/DirectPortBridgeTransport'
import type {
  BridgeFsStatResult,
  BridgeShellPersistentRecord,
  BrowserHostManifest,
} from '../bridge/browserBridgeProtocol'
import { createBridgeRoute } from '../bridge/protocol/core'
import {
  createNativePrimitives,
  isNativePrimitiveUnsupported,
  NativePrimitiveError,
} from '../bridge/nativePrimitives'
import type {
  BackgroundShellBridge,
  PersistentShellListResult,
  PersistentShellSpawnSpec,
  ShellLogTail,
} from './BackgroundShellCoordinator'
import {
  getNexusWorkspaceDirForType,
  projectHomeFor,
  taskLogFile,
} from '../../utils/conversationStoragePaths'
import { DEFAULT_TEMPLATE_TYPE } from './workerProtocol'

/** The manifest entries the worker's registry needs, all of them. */
export const PERSISTENT_SHELL_PRIMITIVES = [
  'shell.spawn.persist',
  'shell.persistentList',
  'shell.persistentKill',
] as const

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** A list failure that will not heal by asking again. */
function isTerminalListError(err: unknown): boolean {
  if (isNativePrimitiveUnsupported(err)) return true
  return err instanceof NativePrimitiveError &&
    (err.code === 'SHELL_UNAVAILABLE' || err.code === 'transport_disposed')
}

/** fs.stat's "no such file" — the guest keys on the ENOENT text (nexus_fs_host.cc). */
function isMissingFileError(error: { code: string; message: string }): boolean {
  return error.code === 'ENOENT' || /ENOENT|no such file/i.test(error.message)
}

/** Leading U+FFFD left by a tail read that began inside a multi-byte char. */
const LEADING_REPLACEMENT = /^�{1,3}/

export interface BackgroundShellHostBridgeHost {
  /** Read lazily — the direct port installs after construction. */
  getTransport(): DirectPortBridgeTransport | null
  /** The host manifest, once a page published it (null before). */
  getManifest(): Pick<BrowserHostManifest, 'capabilities' | 'primitives'> | null
  createRequestId(): string
  getHomeDir(): string | null
  storageRoot(): string | null
  /** The parent session's bound project folder, when live + bound. */
  getSessionProjectRoot(spawnerSessionId: string): string | undefined
  /** The parent session's COMMITTED storage routing (the exact grouped
   *  project dir its transcripts live in) — authoritative when present
   *  re-deriving the dir here guessed the DEFAULT template
   *  type for unbound sessions and mis-filed non-default sessions' output. */
  projectRouteOf(spawnerSessionId: string): string | undefined
  /** The parent session's template type, for the unrouted fallback derive. */
  getSessionTemplateType(spawnerSessionId: string): string | undefined
}

export class BackgroundShellHostBridge implements BackgroundShellBridge {
  constructor(private readonly host: BackgroundShellHostBridgeHost) {}

  hasTransport(): boolean {
    return this.host.getTransport() !== null
  }

  /** The host lists every persistent-shell primitive (a positive listing:
   *  an older host would IGNORE `persist` and run a connection-bound child). */
  knowsHost(): boolean {
    return this.hasTransport() && this.host.getManifest() != null
  }

  supportsPersistentShells(): boolean {
    const primitives = this.host.getManifest()?.primitives
    if (!primitives || !this.hasTransport()) return false
    return PERSISTENT_SHELL_PRIMITIVES.every(p => primitives.includes(p))
  }

  private primitives() {
    const transport = this.host.getTransport()
    if (!transport) return null
    return createNativePrimitives({
      transport,
      createRequestId: () => this.host.createRequestId(),
      manifest: this.host.getManifest() ?? undefined,
    })
  }

  /** Start a persistent child. Throws the primitive's error unchanged
   *  (`NativePrimitiveError` carries the host's code, e.g. BINARY_NOT_FOUND). */
  async spawnPersistent(spec: PersistentShellSpawnSpec): Promise<{ persistentId: string }> {
    const primitives = this.primitives()
    if (!primitives) {
      throw new NativePrimitiveError('SHELL_UNAVAILABLE', 'host bridge is not attached')
    }
    return primitives.shell.spawnPersistent({
      shell: spec.shell,
      command: spec.command,
      cwd: spec.cwd,
      logPath: spec.logPath,
      // The model's command never reads stdin: a child that tries gets EOF
      // instead of hanging.
      closeStdin: true,
    })
  }

  async listPersistent(): Promise<PersistentShellListResult> {
    const primitives = this.primitives()
    if (!primitives) {
      return { ok: false, terminal: false, message: 'host bridge is not attached' }
    }
    try {
      const shells: BridgeShellPersistentRecord[] = await primitives.shell.persistentList()
      if (!Array.isArray(shells)) {
        return {
          ok: false,
          terminal: true,
          message: 'shell.persistentList returned an invalid response',
        }
      }
      return { ok: true, shells }
    } catch (err) {
      return { ok: false, terminal: isTerminalListError(err), message: errorMessage(err) }
    }
  }

  async killPersistent(id: string): Promise<{ found: boolean; wasRunning: boolean } | null> {
    const primitives = this.primitives()
    if (!primitives) return null
    try {
      return await primitives.shell.persistentKill(id)
    } catch {
      return null
    }
  }

  /**
   * The last `maxBytes` of a log, decoded as UTF-8. `sinceSize` is the size
   * the caller last read: an unchanged file answers `{ok, size}` without a
   * `text` (nothing new). A log the child has not created yet reads as empty.
   */
  async readLogTail(
    path: string,
    maxBytes: number,
    sinceSize?: number,
  ): Promise<ShellLogTail> {
    const transport = this.host.getTransport()
    if (!transport) return { ok: false, message: 'host bridge is not attached' }
    try {
      const statResponse = await transport.request({
        id: this.host.createRequestId(),
        route: createBridgeRoute('fs', 'stat'),
        payload: { path },
      })
      if (!statResponse.ok) {
        // Not created yet: the child has written nothing so far.
        if (isMissingFileError(statResponse.error)) {
          return sinceSize === 0
            ? { ok: true, size: 0 }
            : { ok: true, size: 0, text: '', truncated: false }
        }
        return { ok: false, message: `${statResponse.error.code}: ${statResponse.error.message}` }
      }
      const size = (statResponse.result as BridgeFsStatResult | null)?.size
      if (typeof size !== 'number' || size < 0) {
        return { ok: false, message: 'fs.stat returned an invalid response' }
      }
      if (size === sinceSize) return { ok: true, size }
      if (size === 0) return { ok: true, size, text: '', truncated: false }
      const offset = Math.max(0, size - maxBytes)
      const readResponse = await transport.request({
        id: this.host.createRequestId(),
        route: createBridgeRoute('fs', 'readRange'),
        payload: { path, offset, length: size - offset },
      })
      if (!readResponse.ok) {
        return { ok: false, message: `${readResponse.error.code}: ${readResponse.error.message}` }
      }
      const { data, bytesRead } = readResponse.result as { data: Uint8Array; bytesRead?: number }
      const bytes = data instanceof Uint8Array
        ? data.subarray(0, typeof bytesRead === 'number' ? bytesRead : data.length)
        : new Uint8Array(0)
      let text = new TextDecoder('utf-8').decode(bytes)
      if (offset > 0) text = text.replace(LEADING_REPLACEMENT, '')
      return { ok: true, size, text, truncated: offset > 0 }
    } catch (err) {
      return { ok: false, message: errorMessage(err) }
    }
  }

  getOutputPath(
    spawnerSessionId: string,
    taskId: string,
    providedPath?: string,
  ): string | null {
    if (providedPath && providedPath.length > 0) return providedPath
    // COMMITTED storage routing first: the router maps the
    // parent to the exact grouped project dir its transcripts live in —
    // including the per-type default workspace for unbound sessions. The
    // derive below is only the fallback for a not-yet-routed parent, and
    // it must use the parent's ACTUAL template type: with the unified
    // default, an unbound `chat`/`code` session's shell output landed in
    // the `agent` workspace's project dir — outside the parent's storage,
    // missed by parent delete, wrong path on resume.
    const routedDir = this.host.projectRouteOf(spawnerSessionId)
    if (routedDir) {
      return taskLogFile(routedDir, spawnerSessionId, taskId)
    }
    const homeDir = this.host.getHomeDir()
    if (homeDir) {
      const projectRoot =
        this.host.getSessionProjectRoot(spawnerSessionId) ??
        getNexusWorkspaceDirForType(
          homeDir,
          this.host.getSessionTemplateType(spawnerSessionId) ??
            DEFAULT_TEMPLATE_TYPE,
        )
      return taskLogFile(
        projectHomeFor(homeDir, projectRoot),
        spawnerSessionId,
        taskId,
      )
    }
    const storagePath = this.host.storageRoot()
    if (storagePath) {
      return taskLogFile(storagePath, spawnerSessionId, taskId)
    }
    return null
  }
}
