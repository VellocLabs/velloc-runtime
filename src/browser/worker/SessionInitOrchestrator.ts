import type { BrowserConversationStorageBackend } from '../../sessions/sessionStore'
import type { AgentRuntimeWorkerHandle } from './AgentRuntimeWorkerHandle'
import type {
  AgentRuntimeWorkerInitPayload,
  AgentRuntimeInitResult,
} from './workerProtocol'
import type { SessionWorkerInboundMessage } from './sharedWorkerProtocol'
import type { PreparedWorkerStorage } from './SessionStorageCoordinator'
import { isTeammateSessionId } from '../../utils/sidechainStoragePaths'

type WorkerInitMessage = Extract<
  SessionWorkerInboundMessage,
  { type: 'worker.init' }
>

export type SessionInitEntry = {
  worker: AgentRuntimeWorkerHandle
  ports: Set<MessagePort>
  templateType?: string
  projectRoot?: string
  /** Teammate identity from the init payload — set once at registration. */
  spawnerSessionId?: string
  teammateName?: string
  initFailed?: boolean
  rebindOperationId?: number
}

export interface SessionInitOrchestratorHost {
  getEntry(sessionId: string): SessionInitEntry | undefined
  ensureStorage(storagePath: string | null): Promise<void>
  reconcilePersistedSessionBinding(
    sessionId: string,
    payload: AgentRuntimeWorkerInitPayload,
  ): Promise<void>
  prepareWorkerStorageTarget(
    sessionId: string,
    payload: AgentRuntimeWorkerInitPayload,
  ): PreparedWorkerStorage
  prepareWorkerStorage(
    sessionId: string,
    payload: AgentRuntimeWorkerInitPayload,
  ): BrowserConversationStorageBackend | null
  createWorker(
    sessionId: string,
    backend: BrowserConversationStorageBackend | null,
  ): { worker: AgentRuntimeWorkerHandle; instanceId: string }
  registerEntry(
    sessionId: string,
    worker: AgentRuntimeWorkerHandle,
    instanceId: string,
    ports: Set<MessagePort>,
  ): SessionInitEntry
  /** True when the session's persisted meta carries the shutdown marker —
   *  a torn-down teammate retained as a read-only transcript. `worker.init` must
   *  never register a runtime for it. */
  isSessionMarkedShutdown(sessionId: string): Promise<boolean>
  /** Persist the read-only shutdown marker (the same write
   *  `TeamCoordinator.teardown` makes). True once it is on disk. */
  markSessionShutdown(
    sessionId: string,
    shutdownAt: number,
    opts?: { lost?: boolean },
  ): Promise<boolean>
  /** True when the TeamCoordinator ended this teammate itself in this realm
   *  (`TeamCoordinator.wasTornDown`) — a deliberate end whose marker may
   *  simply not have landed, as opposed to a runtime lost to a restart. */
  wasTeammateTornDown(sessionId: string): boolean
  projectRouteOf(sessionId: string): string | undefined
  deleteSessionInDir(projectDir: string, sessionId: string): Promise<void>
  setLastInitTemplate(payload: AgentRuntimeWorkerInitPayload): void
  /** Publish a full status snapshot for a session that just (re)initialized. */
  announceSessionStatus(sessionId: string): void
  notifySessionUpserted(sessionId: string): void
  trace(
    event: string,
    traceId: string | undefined,
    attrs: Record<string, unknown>,
  ): void
}

/**
 * Owns serialized worker initialization and its four state transitions:
 * force-reinitialize, failed-entry retry, healthy reuse, and fresh creation.
 */
export class SessionInitOrchestrator {
  private readonly sessionInitChains = new Map<string, Promise<void>>()

  constructor(private readonly host: SessionInitOrchestratorHost) {}

  handle(port: MessagePort, message: WorkerInitMessage): void {
    const { sessionId } = message
    void this.runSerialized(sessionId, () =>
      this.runInit(port, sessionId, message),
    ).catch(error => {
      const messageText =
        error instanceof Error ? error.message : String(error)
      try {
        port.postMessage({
          type: 'worker.error',
          sessionId,
          payload: {
            code: 'worker_manager_init_failed',
            message: messageText,
          },
        })
      } catch {
        // Port may already be gone; the trace record still lands.
      }
      this.host.trace('worker.manager.init.failed', message.payload.traceId, {
        sessionId,
        message: messageText,
      })
    })
  }

  private runSerialized(
    sessionId: string,
    run: () => Promise<void>,
  ): Promise<void> {
    const prior = this.sessionInitChains.get(sessionId) ?? Promise.resolve()
    // Chain regardless of prior outcome so a failed init never wedges retries.
    const next = prior.then(run, run)
    const tail = next.then(
      () => {},
      () => {},
    )
    this.sessionInitChains.set(sessionId, tail)
    void tail.then(() => {
      if (this.sessionInitChains.get(sessionId) === tail) {
        this.sessionInitChains.delete(sessionId)
      }
    })
    return next
  }

  private async runInit(
    port: MessagePort,
    sessionId: string,
    message: WorkerInitMessage,
  ): Promise<void> {
    const { payload } = message
    const traceId = payload.traceId
    this.host.trace('worker.manager.init.recv', traceId, { sessionId })
    await this.host.ensureStorage(payload.sessionStoragePath ?? null)

    const commitInitTemplate = (effectiveInit?: {
      templateType?: string
      projectRoot?: string
    }): void => {
      if (payload.isHeadless) {
        return
      }
      this.host.setLastInitTemplate({
        ...payload,
        ...(effectiveInit?.templateType !== undefined
          ? { templateType: effectiveInit.templateType }
          : {}),
        ...(effectiveInit ? { projectRoot: effectiveInit.projectRoot } : {}),
        sessionId: undefined,
        sessionStoragePath: undefined,
        traceId: undefined,
        isHeadless: undefined,
        routineId: undefined,
        // A template is the seed for EVERY later spawn, so a routine origin
        // must never survive into it: one leaked origin would make every
        // subsequent session read as routine-originated and disable
        // CronCreate / ScheduleCron / RemoteTrigger.register globally.
        // (Headless payloads already return above; this is the backstop.)
        routineOriginId: undefined,
        forceReinit: undefined,
        // Scoped to the `sessionId` scrubbed five lines up, so it must not
        // travel either: every spawn from this template overrides `sessionId`
        // with a freshly MINTED one, and marking that "may be a stale pointer"
        // would suppress its metadata writes — a routine / sub-agent /
        // teammate that records no message would then leave no session at all.
        restoredSessionId: undefined,
        // Background spawns must not steal the interactive call-model trace.
        logCallModel: undefined,
      })
    }

    if (
      payload.forceReinit &&
      this.startForceReinit(
        port,
        sessionId,
        payload,
        traceId,
        commitInitTemplate,
      )
    ) {
      return
    }

    // A session whose persisted meta is marked shutdown was torn down by its
    // lead and retained as a read-only transcript. Never register a runtime for
    // it — regardless of what the (possibly pre-session.list) UI asked. This is
    // the authoritative chokepoint: the boot-active shutdown tab would
    // otherwise send worker.init before the marker reaches the list-derived set.
    if (await this.host.isSessionMarkedShutdown(sessionId)) {
      this.refuseShutdown(port, sessionId)
      return
    }

    const existing = this.host.getEntry(sessionId)
    // A worker.init for a teammate id with no live entry means its runtime is gone (teammates are not
    // resumed): persist it as ended instead of booting a fresh runtime.
    if (!existing && isTeammateSessionId(sessionId)) {
      // The coordinator's own record decides the REASON. A teammate it tore
      // down whose marker write failed is not lost — it was ended on purpose
      // — and writing `lost` here told its lead the teammate was lost to a
      // restart (and had `reconcileLost` release its tasks a second time).
      // This retries that teardown's marker instead.
      const lost = !this.host.wasTeammateTornDown(sessionId)
      let marked = false
      try {
        // `lost`, not a lead's deliberate `Shutdown`: this path can run
        // BEFORE the lead binds (the user clicks the teammate's tab first),
        // and `reconcileLost` skips an already-shutdown child — so the marker
        // has to carry the reason or the lead never learns it.
        marked = await this.host.markSessionShutdown(
          sessionId,
          Date.now(),
          lost ? { lost: true } : undefined,
        )
      } catch {
        // Refuse regardless: an unmarked orphan must still never boot.
      }
      this.host.trace('worker.manager.init.orphanedTeammate', traceId, {
        sessionId,
        marked,
        lost,
      })
      if (marked) this.host.notifySessionUpserted(sessionId)
      this.refuseShutdown(port, sessionId)
      return
    }
    if (existing) {
      existing.ports.add(port)
      if (existing.initFailed) {
        await this.retryFailedEntry(
          sessionId,
          payload,
          traceId,
          existing,
          commitInitTemplate,
        )
      } else {
        this.reuseEntry(port, sessionId, payload, traceId, existing)
      }
      return
    }

    await this.createEntry(
      port,
      sessionId,
      payload,
      traceId,
      commitInitTemplate,
    )
  }

  /** Answer a worker.init with `session_shutdown`: the client falls back to the
   *  read-only transcript view (`BrowserRuntimeClient.start`). */
  private refuseShutdown(port: MessagePort, sessionId: string): void {
    try {
      port.postMessage({
        type: 'worker.error',
        sessionId,
        payload: {
          code: 'session_shutdown',
          message: `Session '${sessionId}' is shut down (read-only).`,
        },
      })
    } catch {
      // Port may already be gone.
    }
  }

  /**
   * Begin the force-reinit two-phase commit. The worker build intentionally
   * runs outside the serialization chain; operation ids preserve latest-wins.
   */
  private startForceReinit(
    port: MessagePort,
    sessionId: string,
    payload: AgentRuntimeWorkerInitPayload,
    traceId: string | undefined,
    commitInitTemplate: (
      effectiveInit?: { templateType?: string; projectRoot?: string },
    ) => void,
  ): boolean {
    const live = this.host.getEntry(sessionId)
    if (!live) {
      return false
    }
    live.ports.add(port)
    const snapshot = live.worker.getSnapshot()
    if (live.worker.isBusy() || snapshot.messageCount > 0) {
      this.host.trace('worker.manager.init.forceReinit.rejected', traceId, {
        sessionId,
      })
      try {
        port.postMessage({
          type: 'worker.error',
          sessionId,
          payload: {
            code: 'worker_reinit_not_allowed',
            message:
              'A runtime can only be rebound while the session is idle and empty.',
          },
        })
      } catch {
        // Port may already be gone.
      }
      this.host.announceSessionStatus(sessionId)
      return true
    }

    const oldProjectDir = this.host.projectRouteOf(sessionId)
    const prepared = this.host.prepareWorkerStorageTarget(sessionId, payload)
    this.host.trace('worker.manager.init.forceReinit', traceId, { sessionId })
    const operationId = (live.rebindOperationId =
      (live.rebindOperationId ?? 0) + 1)
    void this.finishForceReinit({
      sessionId,
      payload,
      traceId,
      live,
      operationId,
      oldProjectDir,
      prepared,
      commitInitTemplate,
    })
    this.host.announceSessionStatus(sessionId)
    return true
  }

  private async finishForceReinit(options: {
    sessionId: string
    payload: AgentRuntimeWorkerInitPayload
    traceId: string | undefined
    live: SessionInitEntry
    operationId: number
    oldProjectDir: string | undefined
    prepared: PreparedWorkerStorage
    commitInitTemplate(
      effectiveInit?: { templateType?: string; projectRoot?: string },
    ): void
  }): Promise<void> {
    const {
      sessionId,
      payload,
      traceId,
      live,
      operationId,
      oldProjectDir,
      prepared,
      commitInitTemplate,
    } = options
    const markFailedIfNewest = (): void => {
      if (
        this.host.getEntry(sessionId) === live &&
        live.rebindOperationId === operationId
      ) {
        live.initFailed = true
      }
    }

    let result: AgentRuntimeInitResult
    try {
      result = await live.worker.reinitialize(prepared.payload)
    } catch (error) {
      this.host.trace('worker.manager.init.forceReinit.failed', traceId, {
        sessionId,
        message: error instanceof Error ? error.message : String(error),
      })
      markFailedIfNewest()
      return
    }
    if (result.status !== 'ready') {
      this.host.trace('worker.manager.init.forceReinit.notReady', traceId, {
        sessionId,
        status: result.status,
      })
      if (result.status === 'failed') {
        markFailedIfNewest()
      }
      return
    }
    if (
      this.host.getEntry(sessionId) !== live ||
      live.rebindOperationId !== operationId
    ) {
      return
    }

    live.initFailed = false
    prepared.commitRouting()
    const effective = result.effectiveInit
    const effectiveTemplateType =
      effective?.templateType ?? payload.templateType
    if (effectiveTemplateType) {
      live.templateType = effectiveTemplateType
    }
    live.projectRoot = effective ? effective.projectRoot : payload.projectRoot
    commitInitTemplate(effective)

    const newProjectDir = prepared.targetProjectDir
    if (
      result.bindPersisted !== false &&
      oldProjectDir &&
      newProjectDir &&
      oldProjectDir !== newProjectDir
    ) {
      void this.host.deleteSessionInDir(oldProjectDir, sessionId).catch(() => {
        // Best-effort: newest-wins enumeration covers a surviving orphan.
      })
    }
  }

  private async retryFailedEntry(
    sessionId: string,
    payload: AgentRuntimeWorkerInitPayload,
    traceId: string | undefined,
    existing: SessionInitEntry,
    commitInitTemplate: (
      effectiveInit?: { templateType?: string; projectRoot?: string },
    ) => void,
  ): Promise<void> {
    this.host.trace('worker.manager.init.retry', traceId, { sessionId })
    await this.host.reconcilePersistedSessionBinding(sessionId, payload)
    const prepared = this.host.prepareWorkerStorageTarget(sessionId, payload)
    const operationId = (existing.rebindOperationId =
      (existing.rebindOperationId ?? 0) + 1)
    try {
      const result = await existing.worker.reinitialize(prepared.payload)
      if (
        result.status === 'ready' &&
        this.host.getEntry(sessionId) === existing &&
        existing.rebindOperationId === operationId
      ) {
        existing.initFailed = false
        prepared.commitRouting()
        const templateType =
          result.effectiveInit?.templateType ?? payload.templateType
        if (templateType) {
          existing.templateType = templateType
        }
        if (result.effectiveInit) {
          existing.projectRoot = result.effectiveInit.projectRoot
        } else if (payload.projectRoot) {
          existing.projectRoot = payload.projectRoot
        }
        commitInitTemplate(result.effectiveInit)
      } else if (result.status === 'failed') {
        this.host.trace('worker.manager.init.failed', traceId, {
          sessionId,
          message: result.message,
        })
      }
    } catch (error) {
      this.host.trace('worker.manager.init.failed', traceId, {
        sessionId,
        message: error instanceof Error ? error.message : String(error),
      })
    }
    this.host.announceSessionStatus(sessionId)
  }

  private reuseEntry(
    port: MessagePort,
    sessionId: string,
    payload: AgentRuntimeWorkerInitPayload,
    traceId: string | undefined,
    existing: SessionInitEntry,
  ): void {
    existing.worker.applyDiagnosticGates?.(payload)
    const snapshot = existing.worker.getSnapshot()
    if (snapshot.initialized) {
      port.postMessage({
        type: 'worker.ready',
        sessionId,
        payload: snapshot,
      })
    } else {
      // UI-ready split: the build is still in flight, but the transcript may
      // already be readable. Replay the `worker.uiReady` + `worker.messages`
      // pair this port missed (they were broadcast before it subscribed) so
      // a mid-build attach renders the conversation instead of a skeleton
      // parked until `worker.ready`.
      const feed = existing.worker.getProvisionalBootFeed?.()
      if (feed) {
        port.postMessage({
          type: 'worker.uiReady',
          sessionId,
          payload: feed.snapshot,
        })
        port.postMessage({
          type: 'worker.messages',
          sessionId,
          payload: { messages: feed.messages },
        })
      }
    }
    this.host.trace('worker.manager.init.reused', traceId, {
      sessionId,
      initialized: snapshot.initialized,
    })
    this.host.announceSessionStatus(sessionId)
  }

  private async createEntry(
    port: MessagePort,
    sessionId: string,
    payload: AgentRuntimeWorkerInitPayload,
    traceId: string | undefined,
    commitInitTemplate: (
      effectiveInit?: { templateType?: string; projectRoot?: string },
    ) => void,
  ): Promise<void> {
    await this.host.reconcilePersistedSessionBinding(sessionId, payload)
    const backend = this.host.prepareWorkerStorage(sessionId, payload)
    const { worker, instanceId } = this.host.createWorker(sessionId, backend)
    const entry = this.host.registerEntry(
      sessionId,
      worker,
      instanceId,
      new Set([port]),
    )
    if (payload.templateType) {
      entry.templateType = payload.templateType
    }
    if (payload.projectRoot) {
      entry.projectRoot = payload.projectRoot
    }
    if (payload.spawnerSessionId) {
      entry.spawnerSessionId = payload.spawnerSessionId
    }
    if (payload.teammateName) {
      entry.teammateName = payload.teammateName
    }

    void worker
      .reinitialize(payload)
      .then(result => {
        const current = this.host.getEntry(sessionId)
        if (current?.worker !== worker) {
          return
        }
        if (result.status === 'ready') {
          current.initFailed = false
          commitInitTemplate(result.effectiveInit)
        } else if (result.status === 'failed') {
          this.host.trace('worker.manager.init.failed', traceId, {
            sessionId,
            message: result.message,
          })
          current.initFailed = true
        }
      })
      .catch(error => {
        this.host.trace('worker.manager.init.failed', traceId, {
          sessionId,
          message: error instanceof Error ? error.message : String(error),
        })
        const current = this.host.getEntry(sessionId)
        if (current?.worker === worker) {
          current.initFailed = true
        }
      })
    this.host.notifySessionUpserted(sessionId)
  }
}
