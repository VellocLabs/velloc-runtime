/**
 * SessionStorageCoordinator — session-transcript storage lifecycle: backend bring-up (grouped
 * home-anchored layout, or the flat cwd fallback; deduped, idempotent), the memoized host home probe,
 * and per-session storage routing incl. sub-agent and teammate nesting.
 */
import type { BrowserBridgeTransport } from '../bridge/protocol/core'
import { createBridgeRoute } from '../bridge/protocol/core'
import type { DirectPortBridgeTransport } from '../bridge/DirectPortBridgeTransport'
import { BridgeFsConversationStorageBackend } from '../storage/BridgeFsSessionStorage'
import { GroupedConversationStorage } from '../storage/GroupedConversationStorage'
import type {
  SummarySourceRequest,
  SummarySourceResult,
} from '../storage/GroupedConversationStorage'
import { SqliteSessionMetaStore } from '../storage/SqliteSessionMetaStore'
import { scanSessionTreeComplete } from '../storage/sessionTreeScan'
import type { SessionTreeRow, SessionTreeScanResult } from '../storage/sessionTreeScan'
import type { BridgeFsTreeEntry } from '../bridge/protocol/fs'
import { sliceReadBatch } from '../bridge/protocol/fs'
import type { BrowserConversationStorageBackend } from '../../sessions/sessionStore'
import {
  userDataRoot,
  getNexusWorkspaceDir,
  getNexusWorkspaceDirForType,
  projectHomeFor,
  projectsHome,
  getSessionMetaDbPath,
} from '../../utils/conversationStoragePaths'
import type { SessionMetaFile } from '../../sessions/sessionStore'
import { resolveHomeDirViaBridgeBounded } from '../../utils/resolveHomeDirViaBridge'
import { joinRuntimePath } from '../../utils/runtimePaths'
import {
  SUBAGENTS_DIR_NAME,
  TEAMMATES_DIR_NAME,
} from '../../utils/sidechainStoragePaths'
import type { AgentRuntimeWorkerInitPayload } from './workerProtocol'
import { DEFAULT_TEMPLATE_TYPE } from './workerProtocol'
import { isSubAgentSessionId, isTeammateSessionId } from './taskProjection'

/**
 * Boot-blocking budget for the host home-dir probe. See
 * `resolveHostHomeDirOnce` — on a real host the bridge answers in
 * milliseconds; a host-less deployment pays this once, then the memo
 * short-circuits every later entry.
 */
const HOST_HOME_DIR_TIMEOUT_MS = 5_000
const STORAGE_READY_TIMEOUT_MS = HOST_HOME_DIR_TIMEOUT_MS + 1_000

/** The narrow view of the Manager the coordinator needs. */
export type SessionStorageCoordinatorHost = {
  /** Read lazily — the direct bridge port is installed via
   *  `bridge.setPort` after construction, and storage bring-up is a
   *  no-op until it exists. */
  getDirectBridgeTransport(): DirectPortBridgeTransport | null
  /**
   * Fired once, after the backend is constructed (either layout). The
   * Manager kicks its post-storage boot subsystems from here (sidebar
   * summary preload, routines/team runtime boot, provider-config and
   * binary-registry publish) — all fire-and-forget on the Manager side;
   * nothing in the storage bring-up awaits them.
   */
  onStorageReady(): void
}

/**
 * A storage-routing preparation whose ROUTER side effect is deferred.
 * Produced by `prepareWorkerStorageTarget`; the caller
 * commits (or abandons) the routing based on the init's explicit result.
 */
export type PreparedWorkerStorage = {
  /** The payload to hand the worker build — in the grouped layout a CLONE
   *  with `sessionStoragePath` stamped, so an abandoned prepare leaves the
   *  caller's original message untouched. */
  payload: AgentRuntimeWorkerInitPayload
  /** The backend to hand the worker (`null` in the grouped layout — the
   *  worker creates its own per-project backend from the stamped path). */
  backend: BrowserConversationStorageBackend | null
  /** The grouped project dir this prepare targets; undefined in the legacy
   *  flat layout (where there is no routing to commit). */
  targetProjectDir?: string
  /** Point the manager's storage router at the target dir. Routing is part
   *  of the init's commit, not of preparation — call only once the init
   *  this prepare fed reported `ready` (and is still the newest). */
  commitRouting(): void
}

export class SessionStorageCoordinator {
  // The session-transcript backend. In the home-anchored, project-grouped
  // layout (`~/.velloc/projects/<projectFolderKey(projectRoot)>/<sessionId>/`) this is
  // a `GroupedConversationStorage` router; on a host with no resolvable home dir
  // it falls back to the legacy flat `BridgeFsConversationStorageBackend`. Both
  // implement every backend method non-optionally, so the union keeps existing
  // `storage.*` enumerate/delete/rename call sites routing transparently.
  private storage:
    | BridgeFsConversationStorageBackend
    | GroupedConversationStorage
    | null = null
  /** Non-null only in the grouped layout — the router used to hand each worker a
   *  CONCRETE per-project backend (so its `getBasePath` sidechain anchor is the
   *  session's own project dir, not the projects root). */
  private groupedStorage: GroupedConversationStorage | null = null
  /** Host home dir (`~`) resolved once via the bridge; null ⇒ legacy cwd layout. */
  private homeDir: string | null = null
  /**
   * Worker-lifetime memo of the host home-dir probe. The probe resolves fast on
   * a real host but HANGS when the host doesn't answer `fs.userHome` (the web
   * deployment), where it costs the full boot-blocking timeout. Caching the
   * result means a re-entry never re-pays that wait, and the timeout warning is
   * emitted at most once. (The manager is a worker singleton —
   * `agentRuntime.sharedworker.ts` — so this is effectively per-worker.)
   */
  private hostHomeDirProbe?: Promise<string | null>
  /** De-dupes concurrent first-`ensureStorage` calls (it awaits the home dir). */
  private ensureStoragePromise: Promise<void> | null = null
  private readonly storageReadyWaiters = new Set<{
    resolve(): void
    reject(error: unknown): void
  }>()
  private storageReadyTimeout: ReturnType<typeof setTimeout> | null = null
  private storagePath: string | null = null
  /** Last requested path, retained when init arrives before the direct port. */
  private requestedStoragePath: string | null = null
  private storageGeneration = 0
  private storageFallbackCommitted = false
  private establishedStorageMode: 'grouped' | 'flat' | null = null

  constructor(private readonly host: SessionStorageCoordinatorHost) {}

  // Method accessors (not same-name getters) so the private backing
  // fields keep their plain names — tests seed fake backends through
  // structural casts on those names, mirroring production writes.
  getStorage():
    | BridgeFsConversationStorageBackend
    | GroupedConversationStorage
    | null {
    return this.storage
  }

  getGroupedStorage(): GroupedConversationStorage | null {
    return this.groupedStorage
  }

  getHomeDir(): string | null {
    return this.homeDir
  }

  /**
   * The user's home as sessions see it: the grouped layout's home, else the
   * same memoized host probe storage bring-up awaits. Null with no direct
   * transport yet, in the flat layout, or when the host does not answer.
   */
  async resolveHomeDir(): Promise<string | null> {
    if (this.homeDir) return this.homeDir
    if (this.establishedStorageMode === 'flat') return null
    const transport = this.host.getDirectBridgeTransport()
    if (!transport) return null
    return this.resolveHostHomeDirOnce(transport)
  }

  storageRoot(): string | null {
    return this.storagePath
  }

  /**
   * Bring up the session-transcript storage. Async because the home-anchored
   * layout needs the host home dir (a bridge round-trip). Callers remain parked
   * across direct-transport attachment/replacement until the latest generation
   * has installed usable storage.
   */
  ensureStorage(path: string | null): Promise<void> {
    if (path) {
      this.requestedStoragePath = path
    }
    const requestedPath = path ?? this.requestedStoragePath
    if (this.storageFallbackCommitted) return Promise.resolve()
    if (this.storage) return Promise.resolve()
    if (!requestedPath) return Promise.resolve()
    const readiness = new Promise<void>((resolve, reject) => {
      this.storageReadyWaiters.add({ resolve, reject })
    })
    this.armStorageReadyTimeout()
    this.startStorageInitialization()
    return readiness
  }

  /** Rebuild transport-bound storage after a direct-port attach/replacement. */
  handleDirectTransportAttached(): Promise<void> {
    const path = this.requestedStoragePath ?? this.storagePath
    if (!path) {
      return Promise.resolve()
    }
    // A committed initial fallback is recoverable: the mode latched to
    // 'flat' at commit, so a late healthy attach rebuilds the SAME layout
    // the no-storage window's workers wrote to and un-gates the
    // post-storage boot chain. Permanence-of-nothing orphaned those
    // transcripts and left enumeration/routines/publishers dead for the
    // realm's lifetime.
    this.storageFallbackCommitted = false
    this.invalidateTransportBoundStorage()
    return this.ensureStorage(path)
  }

  /** Drop adapters that capture a direct transport which has been disposed. */
  handleDirectTransportDetached(): void {
    this.invalidateTransportBoundStorage()
  }

  private invalidateTransportBoundStorage(): void {
    this.storageGeneration += 1
    this.storage = null
    this.groupedStorage = null
    this.ensureStoragePromise = null
    this.hostHomeDirProbe = undefined
    this.armStorageReadyTimeout(true)
  }

  private startStorageInitialization(): void {
    if (this.storageFallbackCommitted) {
      this.resolveStorageReadyWaiters()
      return
    }
    if (this.storage) {
      this.resolveStorageReadyWaiters()
      return
    }
    if (
      this.ensureStoragePromise ||
      !this.requestedStoragePath ||
      !this.host.getDirectBridgeTransport()
    ) {
      return
    }
    const generation = this.storageGeneration
    const attempt = this.initStorage(this.requestedStoragePath, generation)
    this.ensureStoragePromise = attempt
    void attempt.then(
      () => {
        if (this.ensureStoragePromise === attempt) {
          this.ensureStoragePromise = null
        }
        if (this.storage) {
          this.resolveStorageReadyWaiters()
        }
      },
      error => {
        if (generation !== this.storageGeneration) {
          return
        }
        if (this.ensureStoragePromise === attempt) {
          this.ensureStoragePromise = null
        }
        this.rejectStorageReadyWaiters(error)
      },
    )
  }

  private resolveStorageReadyWaiters(): void {
    this.clearStorageReadyTimeout()
    const waiters = [...this.storageReadyWaiters]
    this.storageReadyWaiters.clear()
    for (const waiter of waiters) {
      waiter.resolve()
    }
  }

  private rejectStorageReadyWaiters(error: unknown): void {
    this.clearStorageReadyTimeout()
    const waiters = [...this.storageReadyWaiters]
    this.storageReadyWaiters.clear()
    for (const waiter of waiters) {
      waiter.reject(error)
    }
  }

  private armStorageReadyTimeout(force = false): void {
    if (this.storageReadyTimeout !== null && !force) {
      return
    }
    this.clearStorageReadyTimeout()
    if (this.storageReadyWaiters.size === 0) {
      return
    }
    const generation = this.storageGeneration
    this.storageReadyTimeout = setTimeout(() => {
      if (generation === this.storageGeneration) {
        this.handleStorageReadyTimeout()
      }
    }, STORAGE_READY_TIMEOUT_MS)
  }

  private clearStorageReadyTimeout(): void {
    if (this.storageReadyTimeout !== null) {
      clearTimeout(this.storageReadyTimeout)
      this.storageReadyTimeout = null
    }
  }

  private handleStorageReadyTimeout(): void {
    // Initial-boot fallback commits FLAT, not "nothing": mode selection
    // stays sticky (a late attach must not migrate the window's workers
    // into grouped storage) while remaining recoverable — a later attach
    // rebuilds flat via handleDirectTransportAttached. Boot proceeds now;
    // later inits short-circuit on `storageFallbackCommitted`.
    if (this.establishedStorageMode === null) {
      this.establishedStorageMode = 'flat'
      this.storageFallbackCommitted = true
      this.storageGeneration += 1
      this.ensureStoragePromise = null
      this.resolveStorageReadyWaiters()
      return
    }
    // Once a concrete layout is established, never let a replacement timeout
    // boot new workers through a different path. Fail current waiters so their
    // callers can retry after a later direct attach.
    this.storageGeneration += 1
    this.ensureStoragePromise = null
    this.rejectStorageReadyWaiters(
      new Error('Timed out rebuilding established session storage.'),
    )
  }

  private async initStorage(path: string, generation: number): Promise<void> {
    const transport = this.host.getDirectBridgeTransport()
    if (!transport) return

    // Home dir from the host (the worker env is empty in production): grouped layout on success, flat
    // cwd layout otherwise. Bounded by a timeout so `worker.init` always completes; skipped in flat mode.
    const homeDir =
      this.establishedStorageMode === 'flat'
        ? null
        : await this.resolveHostHomeDirOnce(transport)
    if (generation !== this.storageGeneration) {
      return
    }
    if (this.establishedStorageMode === 'grouped' && !homeDir) {
      throw new Error(
        'Unable to rebuild grouped session storage without a host home directory.',
      )
    }
    this.homeDir =
      this.establishedStorageMode === 'flat' ? null : homeDir
    const useGroupedStorage =
      this.establishedStorageMode === 'grouped' ||
      (this.establishedStorageMode === null && homeDir !== null)
    if (useGroupedStorage && homeDir) {
      const home = homeDir
      // Routines + team subsystems share the single `~/.velloc` root (they are
      // NOT per-project) — keep `storagePath` pointed there.
      this.storagePath = userDataRoot(home)
      const projectsRoot = projectsHome(home)
      // ONE sqlite DB for every project's session meta, at the projects root.
      // The router owns it; the per-project child backends get NO store (they
      // own transcript + tool-details only).
      const metaStore = new SqliteSessionMetaStore({
        transport,
        dbPath: getSessionMetaDbPath(projectsRoot),
      })
      this.groupedStorage = new GroupedConversationStorage({
        projectsRoot,
        defaultProjectDir: projectHomeFor(home, getNexusWorkspaceDir(home)),
        createBackend: basePath =>
          new BridgeFsConversationStorageBackend({ transport, basePath }),
        scanSessionTree: () => this.scanSessionTree(projectsRoot),
        readSummarySources: items => this.readSummarySources(items),
        joinPath: (base, child) => joinRuntimePath(base, child),
        metaStore,
        resolveProjectDirForMeta: meta =>
          this.resolveProjectDirForMeta(home, meta),
      })
      this.storage = this.groupedStorage
      this.establishedStorageMode = 'grouped'
    } else {
      this.storagePath = path
      // Flat fallback: the single DB lives at the flat base; the backend owns
      // meta (delegating to the store) as the top-level storage.
      this.storage = new BridgeFsConversationStorageBackend({
        transport,
        basePath: path,
        metaStore: new SqliteSessionMetaStore({
          transport,
          dbPath: getSessionMetaDbPath(path),
        }),
      })
      this.establishedStorageMode = 'flat'
    }

    // Storage is up — let the Manager kick its post-storage boot
    // subsystems (summary preload, routines/team, provider + binary
    // registry publish). All fire-and-forget on the Manager side;
    // nothing on the boot-critical path awaits them.
    this.host.onStorageReady()
  }

  /**
   * Resolve the host home dir ONCE per worker, racing a boot-blocking timeout.
   * On a real host this returns in milliseconds; when the host never answers
   * `fs.userHome` (the web deployment) it resolves to null after the timeout and
   * warns exactly once. Memoized so re-entry never re-pays the wait. Reduced
   * from the previous 8s to 5s — a post-handshake local IPC answers far faster,
   * so this only trims the dead-wait on host-less deployments.
   */
  private resolveHostHomeDirOnce(
    transport: BrowserBridgeTransport,
  ): Promise<string | null> {
    if (this.hostHomeDirProbe) return this.hostHomeDirProbe
    this.hostHomeDirProbe = resolveHomeDirViaBridgeBounded(
      transport,
      HOST_HOME_DIR_TIMEOUT_MS,
    ).then(({ home, timedOut }) => {
      if (timedOut) {
        // eslint-disable-next-line no-console
        console.warn(
          '[nexus] resolveHomeDirViaBridge timed out after ' +
            `${HOST_HOME_DIR_TIMEOUT_MS / 1000}s — the host did not answer; ` +
            'falling back to the legacy cwd layout so boot can complete ' +
            '(worker.ready is emitted regardless).',
        )
      }
      return home
    })
    return this.hostHomeDirProbe
  }

  /**
   * The whole session index from a depth-3 scan (a level-at-a-time scan past the host's entry cap). A
   * missing projects root resolves EMPTY; anything else throws.
   */
  private async scanSessionTree(projectsRoot: string): Promise<SessionTreeRow[] | SessionTreeScanResult> {
    const transport = this.host.getDirectBridgeTransport()
    if (!transport) return []
    const readdirTree = async (path: string, maxDepth: number) => {
      const response = await transport.request({
        id: globalThis.crypto?.randomUUID?.() ?? `tree-${Date.now()}`,
        route: createBridgeRoute('fs', 'readdirTree'),
        payload: { path, maxDepth },
      })
      if (!response.ok) {
        throw new Error(`${response.error.code}: ${response.error.message}`)
      }
      const result = response.result as {
        entries?: BridgeFsTreeEntry[]
        truncated?: boolean
      }
      return { entries: result.entries ?? [], truncated: result.truncated === true }
    }
    let scan: SessionTreeScanResult
    try {
      scan = await scanSessionTreeComplete(projectsRoot, readdirTree, joinRuntimePath)
    } catch (error) {
      // The host reports a missing root as an ordinary error; a profile with
      // no `projects/` dir yet simply has no sessions.
      const exists = await this.pathExists(projectsRoot)
      if (!exists) return []
      throw error
    }
    if (scan.truncated) {
      console.warn(
        '[SessionStorageCoordinator] session tree scan hit its entry cap even ' +
          'one directory at a time; some sessions will be missing from the ' +
          'sidebar until reload',
      )
    }
    return scan
  }

  private async pathExists(path: string): Promise<boolean> {
    const transport = this.host.getDirectBridgeTransport()
    if (!transport) return false
    try {
      const response = await transport.request({
        id: globalThis.crypto?.randomUUID?.() ?? `exists-${Date.now()}`,
        route: createBridgeRoute('fs', 'exists'),
        payload: { path },
      })
      return response.ok ? Boolean(response.result) : false
    } catch {
      return false
    }
  }

  /**
   * Fetch many summary sources in one `fs.readBatch`. Per-item failure comes
   * back as `ok:false` rather than a rejection, so one deleted transcript
   * cannot cost the rest of the sidebar its summaries.
   */
  private async readSummarySources(
    items: readonly SummarySourceRequest[],
  ): Promise<SummarySourceResult[]> {
    const transport = this.host.getDirectBridgeTransport()
    if (!transport) {
      return items.map(item => ({ path: item.path, ok: false, bytes: null }))
    }
    const response = await transport.request({
      id: globalThis.crypto?.randomUUID?.() ?? `batch-${Date.now()}`,
      route: createBridgeRoute('fs', 'readBatch'),
      payload: { items: items.map(item => ({ ...item })) },
    })
    if (!response.ok) {
      throw new Error(`${response.error.code}: ${response.error.message}`)
    }
    // `sliceReadBatch` throws if the index does not line up with the request
    // — a short index would attribute one session's bytes to another, which
    // is worse than losing the batch.
    return sliceReadBatch(items, response.result as never).map(entry => ({
      path: entry.path,
      ok: entry.ok,
      bytes: entry.bytes,
      // The migration tells a missing file from a failed read by this.
      ...(entry.error !== undefined ? { error: entry.error } : {}),
    }))
  }

  /**
   * The `<projectDir>/<parent>/subagents/` dir a parent's background
   * sub-agents live under — null until the parent's routing is committed
   * (grouped layout only; the flat layout has no per-parent nesting to
   * restore from). Mirrors `prepareWorkerStorageTarget`'s nesting rule.
   */
  getSubAgentsDirForParent(spawnerSessionId: string): string | null {
    const projectDir = this.groupedStorage?.projectRouteOf(spawnerSessionId)
    if (!projectDir) return null
    return joinRuntimePath(
      joinRuntimePath(projectDir, spawnerSessionId),
      SUBAGENTS_DIR_NAME,
    )
  }

  /**
   * Best-effort write of a sub-agent's `task.json` restart-restore seed
   * (subAgentTaskFile.ts). Atomic where the host supports it — the file is the
   * only copy of the record's task-level fields.
   */
  async writeSubAgentTaskFile(
    spawnerSessionId: string,
    subagentSessionId: string,
    fileName: string,
    json: string,
  ): Promise<void> {
    // The WHOLE body is best-effort: the caller `void`s this promise from the
    // SharedWorker, so a throw anywhere here (including a storage double
    // without `projectRouteOf`) must never become an unhandled
    // rejection — a failed write only degrades a future restart-restore.
    try {
      const dir = this.getSubAgentsDirForParent(spawnerSessionId)
      const transport = this.host.getDirectBridgeTransport()
      if (!dir || !transport) return
      const path = joinRuntimePath(
        joinRuntimePath(dir, subagentSessionId),
        fileName,
      )
      await transport.request({
        id: globalThis.crypto?.randomUUID?.() ?? `write-${fileName}`,
        route: createBridgeRoute('fs', 'writeFile'),
        payload: { path, content: new TextEncoder().encode(json), atomic: true },
      })
    } catch {
      // Best-effort (see above).
    }
  }

  /** The `subagent-…` session dir names under a parent's `subagents/` dir
   *  (sync-fork `agent-*.jsonl` FILES are excluded by the directory filter). */
  async listSubAgentSessionDirs(spawnerSessionId: string): Promise<string[]> {
    const dir = this.getSubAgentsDirForParent(spawnerSessionId)
    if (!dir) return []
    const names = await this.listChildDirNames(dir)
    return names.filter(name => name.startsWith('subagent-'))
  }

  /** Read one file under `<subagents dir>/<subagentSessionId>/` as UTF-8 text;
   *  null when missing/unreadable. */
  async readSubAgentFile(
    spawnerSessionId: string,
    subagentSessionId: string,
    fileName: string,
  ): Promise<string | null> {
    const dir = this.getSubAgentsDirForParent(spawnerSessionId)
    const transport = this.host.getDirectBridgeTransport()
    if (!dir || !transport) return null
    const path = joinRuntimePath(
      joinRuntimePath(dir, subagentSessionId),
      fileName,
    )
    try {
      const response = await transport.request({
        id: globalThis.crypto?.randomUUID?.() ?? `read-${path}`,
        route: createBridgeRoute('fs', 'readFile'),
        payload: { path },
      })
      if (!response.ok) return null
      // fs.readFile's result IS the raw bytes (`$result` binary — see
      // DirectPortBridgeTransport's route policy).
      const data = response.result as Uint8Array | undefined
      return data ? new TextDecoder().decode(data) : null
    } catch {
      return null
    }
  }

  /**
   * Re-point the router at a restored sub-agent's dir — the same write
   * `prepareWorkerStorageTarget.commitRouting` makes at spawn. Without it a
   * post-restart `storage.load('subagent-…')` (the drawer's transcript
   * fallback) resolves against the default project dir and misses.
   */
  registerSubAgentRouting(
    spawnerSessionId: string,
    subagentSessionId: string,
  ): void {
    const dir = this.getSubAgentsDirForParent(spawnerSessionId)
    if (dir) this.groupedStorage?.setSessionProjectDir(subagentSessionId, dir)
  }

  /** Immediate child directory names under `dir`. Retained for the flat
   *  (no-home-dir) layout, which has no projects tree to scan. */
  private async listChildDirNames(dir: string): Promise<string[]> {
    const transport = this.host.getDirectBridgeTransport()
    if (!transport) return []
    try {
      const response = await transport.request({
        id: globalThis.crypto?.randomUUID?.() ?? `readdir-${Date.now()}`,
        route: createBridgeRoute('fs', 'readdir'),
        payload: { path: dir },
      })
      if (!response.ok) return []
      const entries = response.result as Array<{
        name: string
        isDirectory?: boolean
      }>
      return entries.filter(e => e.isDirectory).map(e => e.name)
    } catch {
      return []
    }
  }

  /**
   * The project dir a session's meta routes to — the SAME computation
   * `prepareWorkerStorageTarget` uses for a non-sub-agent session
   * (`projectHomeFor(home, projectRoot ?? per-type workspace)`), so the router's
   * `listSessions` restores routing identically to a live bind. Sub-agent rows
   * are filtered before this is called, so their deeper `subagents/` nesting is
   * not this method's concern.
   */
  private resolveProjectDirForMeta(
    home: string,
    meta: SessionMetaFile,
  ): string {
    return projectHomeFor(
      home,
      meta.metadata?.projectRoot ??
        getNexusWorkspaceDirForType(
          home,
          meta.metadata?.templateType ?? DEFAULT_TEMPLATE_TYPE,
        ),
    )
  }

  /**
   * Prepare a worker's session storage. Grouped layout: register the project dir, stamp
   * `sessionStoragePath` into the payload and return null (the worker builds its own backend, so a
   * re-bind relocates). Flat layout: the shared backend. Commits routing at once; a RELOCATING init
   * must use `prepareWorkerStorageTarget`.
   */
  prepareWorkerStorage(
    sessionId: string,
    payload: AgentRuntimeWorkerInitPayload,
    spawnerSessionId?: string,
  ): BrowserConversationStorageBackend | null {
    const prepared = this.prepareWorkerStorageTarget(
      sessionId,
      payload,
      spawnerSessionId,
    )
    prepared.commitRouting()
    if (prepared.targetProjectDir !== undefined) {
      payload.sessionStoragePath = prepared.targetProjectDir
      // Propagate `sessionMetaDbPath` too: the worker's own backend needs it for its meta store.
      payload.sessionMetaDbPath = prepared.payload.sessionMetaDbPath
    }
    return prepared.backend
  }

  /**
   * Side-effect-deferred `prepareWorkerStorage`: stamps a CLONE of the payload and leaves the router
   * alone; the caller calls `commitRouting` only once the init reported `ready`.
   */
  prepareWorkerStorageTarget(
    sessionId: string,
    payload: AgentRuntimeWorkerInitPayload,
    spawnerSessionId?: string,
  ): PreparedWorkerStorage {
    if (this.groupedStorage && this.homeDir) {
      // Unbound sessions route by the per-type default project root (co-located with its memory dir);
      // a bound `projectRoot` wins. A session without a persisted address prefers the router's stored
      // `project_dir`. Nesting below requires a KNOWN parent.
      const nestDir =
        spawnerSessionId && isSubAgentSessionId(sessionId)
          ? SUBAGENTS_DIR_NAME
          : spawnerSessionId && isTeammateSessionId(sessionId)
            ? TEAMMATES_DIR_NAME
            : null
      const routedDir =
        !payload.projectRoot && !nestDir
          ? this.groupedStorage.projectRouteOf(sessionId)
          : undefined
      const projectDir =
        routedDir ??
        projectHomeFor(
          this.homeDir,
          payload.projectRoot ??
            getNexusWorkspaceDirForType(
              this.homeDir,
              payload.templateType ?? DEFAULT_TEMPLATE_TYPE,
            ),
        )
      // A background sub-agent nests under `<spawnerSessionId>/subagents/`, a teammate under
      // `<spawnerSessionId>/teammates/`, so deleting the parent's dir sweeps them. A teammate's base is
      // the PARENT's routed dir; a sub-agent keeps `projectDir`.
      const base = !nestDir
        ? projectDir
        : joinRuntimePath(
            nestDir === TEAMMATES_DIR_NAME
              ? this.groupedStorage.projectRouteOf(spawnerSessionId!) ||
                  projectDir
              : projectDir,
            spawnerSessionId!,
            nestDir,
          )
      const grouped = this.groupedStorage
      return {
        // The worker builds its OWN per-project backend from
        // `sessionStoragePath` (backend:null), so it needs the single DB's path
        // too — it lives at the PROJECTS ROOT, not this session's base (a
        // sub-agent base nests deeper, so it can't be derived from the base).
        payload: {
          ...payload,
          sessionStoragePath: base,
          sessionMetaDbPath: getSessionMetaDbPath(projectsHome(this.homeDir)),
        },
        backend: null,
        targetProjectDir: base,
        commitRouting: () => {
          grouped.setSessionProjectDir(sessionId, base)
        },
      }
    }
    // Flat layout: the worker reuses the shared flat backend (which already owns
    // the store), so no DB path needs stamping.
    return {
      payload,
      backend: this.storage,
      commitRouting: () => {},
    }
  }
}
