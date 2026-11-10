// The pure i18n core — no React, so importing it here does not drag React
// into the SharedWorker's separate Rollup build.
import { primeEnCatalog } from '../webview/i18n/translate'
import { createAgentRuntime } from '../runtime/createAgentRuntime'
import type { AgentRuntimeState } from '../runtime/AgentRuntimeState'
import type { AgentWorkerBridgeTransport } from './AgentWorkerBridgeTransport'
import {
  resolveStorageBackend,
  resolveResumeProjectRoot,
  createBootStageReporter,
} from './agentRuntimeBootstrap'
import type {
  BrowserConversationStorageBackend,
  BrowserConversationStore,
} from '../../sessions/sessionStore'
import { readProjectBranch } from '../../utils/projectBranch'
import type { AgentRuntimeWorkerInitPayload } from './workerProtocol'
import type { ProvisionalBootSources } from './workerSnapshot'
import type { Message } from '../../runtime/RuntimeTypes'
import type {
  AgentWorkerOutboundMessage,
  AgentRuntimeInitResult,
  AgentRuntimeWorkerSnapshot,
} from './workerProtocol'
import { sanitizeMessageForUi } from '../../utils/toolCallDetails'
import type { TraceLoggerEntry } from '../../engine/turn/modelTrace'
import { getSessionTracer } from '../../utils/sessionTrace'
import type { AgentTurnController } from './AgentTurnController'
import { AgentModelController, type AgentModelControllerHost } from './AgentModelController'
import {
  AgentPermissionCoordinator,
  type AgentPermissionCoordinatorHost,
} from './AgentPermissionCoordinator'
import { AgentRuntimeRecovery } from './AgentRuntimeRecovery'
import { AgentTranscriptService } from './AgentTranscriptService'
import type { TranscriptSource } from './AgentTranscriptService'
import type { FileSnapshotRecorder } from '../../sessions/fileSnapshots/snapshotRecorder'
import type { RuntimeFs } from '../../utils/fs/runtimeFs'
import type { AutoCompactWindowSettings } from '../../context/compaction/windowSettings'
import type { PermissionSettingsBySource } from '../../permissions/seedPermissionContext'
import {
  resolveSessionDisplayState,
  type SessionDisplayState,
} from './sessionDisplayState'
import { disposeScopeResources, type RuntimeScope } from './agentRuntimeScope'
import type { AgentRuntimeDiagnostics } from './AgentRuntimeDiagnostics'
import type { AgentRuntimeWorkerHost } from './AgentRuntimeWorker'
import { withTranscriptLines } from './transcriptLineStamp'

/** The code a failed init reports: a plugin template's own (F-25), else `worker_init_failed`. */
function initFailureCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && code.startsWith('plugin_template_') ? code : 'worker_init_failed'
}

/**
 * Backoff before each retry of the init-time git-branch resolve (the first attempt is immediate).
 * Retries only while no shell answered at all, so a non-git folder costs one attempt.
 */
const PROJECT_BRANCH_RETRY_DELAYS_MS = [150, 600, 1_500, 3_000] as const

/** The provisional boot feed a primary session publishes before its runtime installs. */
export type ProvisionalBootState = {
  snapshot: ProvisionalBootSources
  /** The early transcript read, as the engine will be seeded with it. */
  messages: Message[]
  conversationStore?: BrowserConversationStore
}

/**
 * Contract: the worker state the boot flow reads and writes. The worker owns
 * every field; reassigned ones are accessors, so the boot flow always sees
 * the current value.
 */
export interface AgentRuntimeBootHost {
  readonly emit: (message: AgentWorkerOutboundMessage) => void
  readonly bridgeTransport: AgentWorkerBridgeTransport
  readonly diagnostics: AgentRuntimeDiagnostics
  readonly injectedStorageBackend?: BrowserConversationStorageBackend
  readonly host?: AgentRuntimeWorkerHost
  readonly turns: AgentTurnController
  readonly runtime: AgentRuntimeState | null
  readonly executingTurn: boolean
  runtimeScope: RuntimeScope | null
  generation: number
  provisionalBoot: ProvisionalBootState | null
  initPromise: Promise<void> | null
  displayReadyPromise: Promise<void> | null
  boundSessionId: string | null
  projectBranch: string | undefined
  transcriptRewrittenInTurn: boolean
  emitError(code: string, message: string): void
  getSnapshot(): AgentRuntimeWorkerSnapshot
  isBusy(): boolean
  isCurrentScope(scope: RuntimeScope): boolean
  makeModelHost(generation?: number): AgentModelControllerHost
  makePermissionHost(): AgentPermissionCoordinatorHost
  disposeRuntimeScope(reason: string): Promise<void>
  emitWholeTranscript(): Promise<void>
}

/**
 * Contract: a worker's runtime boot — scope switching on (re)init, the
 * runtime build and install, the provisional UI-ready publish, and the
 * project-branch resolve. Owns no state; every read and write goes through
 * its host, the owning `AgentRuntimeWorker`.
 */
export class AgentRuntimeBoot {
  constructor(private readonly worker: AgentRuntimeBootHost) {}

  /**
   * Run (or re-run) the init flow and report its EXPLICIT outcome.
   * `receiveFrame(init)` resolves void for a successful build, a
   * preflight rejection, and a superseded init alike — the Manager's rebind
   * two-phase commit needs to tell them apart, or it commits pointers (and
   * deletes the old-dir stub) for a rebuild that never happened.
   */
  async reinitialize(
    payload: AgentRuntimeWorkerInitPayload,
  ): Promise<AgentRuntimeInitResult> {
    // --- Atomic scope switching + preflight before dispose ---

    // Preflight: forceReinit safety check MUST happen before we dispose
    // anything. After dispose, getSnapshot().messageCount is 0 (runtime
    // is null), so the check would incorrectly pass.
    if (payload.forceReinit && this.worker.runtime) {
      const snapshot = this.worker.getSnapshot()
      if (snapshot.isBusy || snapshot.messageCount > 0) {
        this.worker.emitError(
          'worker_reinit_not_allowed',
          'A runtime can only be rebound while the session is idle and empty.',
        )
        return { status: 'rejected', code: 'worker_reinit_not_allowed' }
      }
    }

    // Create a new runtime scope with an incremented generation.
    const generation = ++this.worker.generation

    const scopePermissions = new AgentPermissionCoordinator(
      this.worker.makePermissionHost(),
    )
    let markDisplayReady!: () => void
    const displayPublished = new Promise<void>(resolve => {
      markDisplayReady = resolve
    })
    const scope: RuntimeScope = {
      generation,
      markDisplayReady: () => markDisplayReady(),
      abortController: new AbortController(),
      runtime: null,
      disposeCallbacks: [],
      // Fresh controllers per scope so detached disposal is isolated.
      // The generation lets the model host's outbound callbacks self-fence
      // once this scope is superseded.
      models: new AgentModelController(this.worker.makeModelHost(generation)),
      permissions: scopePermissions,
      recovery: new AgentRuntimeRecovery({
        clearPendingPlanApprovalMarker: () =>
          scopePermissions.clearPendingPlanApprovalMarker(),
      }),
      transcript: new AgentTranscriptService({
        emit: m => this.worker.emit(m),
        isBusy: () => this.worker.isBusy(),
        includeHunks: () => payload.isSubAgent === true,
      }),
      projectBranch: undefined,
    }

    // Synchronous latest-wins: install the new scope BEFORE any await so
    // a concurrent init can never overwrite us with a stale scope. The
    // previous scope is detached and disposed asynchronously.
    const previousScope = this.worker.runtimeScope
    this.worker.runtimeScope = scope
    // A previous build's provisional boot feed belongs to ITS scope — the
    // new build re-publishes its own (or none, for a rebind to a session
    // whose store is empty).
    this.worker.provisionalBoot = null
    // Bridge requests issued from here on belong to THIS scope — set
    // synchronously with the install so the attribution can
    // never lag behind the scope switch.
    this.worker.bridgeTransport.setActiveGeneration(generation)
    if (previousScope) {
      previousScope.abortController.abort('superseded')
    }

    // Two views of one init run (P-1): `initPromise` is the
    // CONTAINED view — it never rejects (reports worker_init_failed and
    // disposes the half-built scope) so waitForInit callers can't park on a
    // rejection; the raw chain still reaches this caller as an explicit
    // result. A superseded scope stays silent.
    const initRun = (async () => {
      // Dispose the previous scope asynchronously (detached — it can
      // never mutate the worker's runtimeScope because it's no longer current).
      await this.disposeDetachedScope(previousScope, 'reinitialize')
      await this.runInit(payload, scope)
    })()
    // Set initPromise SYNCHRONOUSLY before any await so concurrent
    // non-init messages (setModelSelection, etc.) park on it via
    // waitForInit() instead of seeing a null runtime.
    this.worker.initPromise = initRun.catch(async error => {
      if (!this.worker.isCurrentScope(scope)) return
      this.worker.emitError(
        initFailureCode(error),
        error instanceof Error ? error.message : String(error),
      )
      await this.worker.disposeRuntimeScope('init_failed').catch(() => {})
    })
    this.worker.displayReadyPromise = Promise.race([displayPublished, this.worker.initPromise])
    try {
      await initRun
    } catch (error) {
      // Distinguish by GENERATION, not scope identity: the contained view's
      // own failure-dispose has already nulled `runtimeScope` by the time
      // this catch runs (it was attached first), so `isCurrentScope` would
      // misread our own failure as a supersession. Only a NEWER init
      // advances the generation.
      if (this.worker.generation !== generation) {
        return { status: 'superseded', generation }
      }
      return {
        status: 'failed',
        code: 'worker_init_failed',
        message: error instanceof Error ? error.message : String(error),
      }
    }
    // runInit's internal guards return NORMALLY when a newer init lands
    // mid-flight — surface that as superseded, not ready (a stale reinit's
    // "success" must never win the commit).
    // Ready carries the bind-persist outcome and the EFFECTIVE init slice
    // so the Manager commits stub deletion, pointers,
    // and the template from the same final truth this build used.
    return this.worker.isCurrentScope(scope)
      ? {
          status: 'ready',
          generation,
          bindPersisted: scope.bindPersisted,
          effectiveInit: scope.effectiveInit,
        }
      : { status: 'superseded', generation }
  }

  /**
   * Dispose a scope that has already been detached (replaced by a newer scope).
   * Unlike disposeRuntimeScope, this NEVER touches the worker's runtimeScope — the
   * scope is already stale by definition. Only cleans up the scope's own
   * resources (callbacks, engine). All state mutations are scope-local.
   */
  private async disposeDetachedScope(
    scope: RuntimeScope | null,
    reason: string,
  ): Promise<void> {
    if (!scope) return
    await disposeScopeResources(scope, {
      reason,
      cancelGeneration: generation =>
        this.worker.bridgeTransport.cancelGeneration(generation),
    })
    // No field to null out: the worker's `runtime` derives from `runtimeScope`,
    // which by definition no longer points at this detached scope.
  }

  private async runInit(
    payload: AgentRuntimeWorkerInitPayload,
    scope: RuntimeScope,
  ): Promise<void> {
    // NOTE: forceReinit preflight is handled in the 'worker.init' case
    // BEFORE dispose. By the time we reach here, the check has
    // already passed or the init was rejected.
    this.worker.diagnostics.apply(payload, scope)
    const tracer = getSessionTracer()
    const traceId = payload.traceId
    const initSpan = tracer.span('worker.init', {
      traceId,
      attrs: { sessionId: payload.sessionId },
    })

    // Scope-bound transport view: everything this scope's
    // build owns — the storage backend here and the runtime below — issues
    // bridge requests tagged with THIS scope's generation, no matter when
    // a continuation fires. The shared transport's ambient generation
    // cannot do that: by the time a stale closure runs, the ambient value
    // already points at the successor, so `cancelGeneration(old)` missed
    // the request and its response could feed the disposed scope.
    const scopedBridgeTransport = this.worker.bridgeTransport.bindGeneration(
      scope.generation,
    )
    const conversationStorageBackend = resolveStorageBackend(
      payload,
      scopedBridgeTransport,
      this.worker.injectedStorageBackend,
    )

    // Start the English catalog load now, unawaited: the worker composes the
    // model-facing text of slash output from it, but nothing in runtime
    // construction needs it, and blocking init on a network fetch would delay
    // every session for a string table only the first slash command reads.
    // The dispatcher awaits `whenEnCatalogReady()` at its own entry point.
    primeEnCatalog(payload.enCatalogUrl)

    // Resume restore — read
    // the bound folder from this session's persisted summary, AWAITED, before
    // createAgentRuntime. See resolveResumeProjectRoot.
    const effectivePayload = await resolveResumeProjectRoot(
      payload,
      conversationStorageBackend,
    )

    // Generation guard BEFORE the expensive runtime build: the
    // await above can lose the race to a newer init, and a stale init must
    // not build a full runtime (engine boot, storage, model init) just to
    // dispose it. Bail now; the newer scope owns the worker.
    if (!this.worker.isCurrentScope(scope)) {
      return
    }

    const traceLogger =
      payload.hostMode === 'nexus'
        ? (entry: TraceLoggerEntry) => {
            this.worker.emit({
              type: 'worker.debugLog',
              payload: entry,
            })
          }
        : undefined

    const runtimeSpan = tracer.span('worker.runtime.create', {
      traceId: initSpan.traceId,
      parentSpanId: initSpan.spanId,
    })
    // Boot-welcome footer milestones + keepalive (liveness heartbeat, not a
    // fake stage advance) — see createBootStageReporter. Only the primary
    // interactive session reports; headless spawns and sub-agents stay silent.
    const isPrimarySessionBuild =
      !payload.isHeadless && !effectivePayload.isSubAgent
    const bootStages = createBootStageReporter(
      isPrimarySessionBuild,
      payload.sessionId,
      // Scope guard: a superseded init's still-running
      // createAgentRuntime must not keep driving the boot-progress UI — the
      // successor scope's reporter owns it now.
      (stage, sessionId) => {
        if (!this.worker.isCurrentScope(scope)) return
        this.worker.host?.broadcastBootStage(stage, sessionId)
      },
    )
    // Use a LOCAL variable for the created runtime. Only assign to
    // the worker's runtime AFTER the scope guard passes — a stale init must never
    // write (and then null) the shared field, which would wipe a newer
    // runtime that already installed itself.
    let createdRuntime: AgentRuntimeState
    try {
      createdRuntime = await createAgentRuntime({
        ...effectivePayload,
        // Scope-bound view, not the shared core transport.
        bridgeTransport: scopedBridgeTransport,
        conversationStorageBackend,
        traceLogger,
        requestToolUseConfirm: scope.permissions.request,
        // Aborted by disposeScopeResources (and on supersession): lets work
        // that outlives a tool call (SuperShell in the background) stop with
        // the scope whose transport and permission queue it was using.
        runtimeScopeSignal: scope.abortController.signal,
        onBootStage: bootStages.onBootStage,
        // UI-ready split: only the primary interactive session publishes a
        // provisional boot feed (headless/sub-agent builds have no UI to
        // unblock — same gate as the boot-stage reporter above).
        onUiReady: isPrimarySessionBuild
          ? info => this.publishProvisionalBoot(scope, info, payload)
          : undefined,
        // Mid-turn task-notification drain. Scope-guarded: a
        // superseded build's runtime must not consume the live session's
        // pending results.
        drainTaskNotifications: this.worker.host?.drainMidTurnTaskNotifications
          ? (sessionId, opts) =>
              this.worker.isCurrentScope(scope)
                ? (this.worker.host?.drainMidTurnTaskNotifications?.(sessionId, opts) ?? null)
                : null
          : undefined,
        // Mid-turn team frames (teammate or lead). Scope-guarded like the
        // notification drain: a superseded build must not consume them.
        drainTeamMessages: this.worker.host?.drainMidTurnTeamMessages
          ? sessionId =>
              this.worker.isCurrentScope(scope)
                ? (this.worker.host?.drainMidTurnTeamMessages?.(sessionId) ?? [])
                : []
          : undefined,
        // Child reports at a turn's start (F-36). Scope-guarded: a
        // superseded build must not consume them.
        takeChildReports: this.worker.host?.takeChildReports
          ? (sessionId, opts) =>
              this.worker.isCurrentScope(scope)
                ? (this.worker.host?.takeChildReports?.(sessionId, opts) ?? Promise.resolve(null))
                : Promise.resolve(null)
          : undefined,
        // Mid-turn user input (plain Enter while busy): the inject queue lives
        // in this worker's own turn controller, so no host hop. Scope-guarded
        // like the notification drain.
        drainInjectMessages: () =>
          this.worker.isCurrentScope(scope) ? this.worker.turns.drainInjectEntries() : [],
        // The read-only half of the same queue, for the Sleep tool's wake.
        hasPendingInjectMessages: () =>
          this.worker.isCurrentScope(scope) && this.worker.turns.hasInjectEntries(),
        // A plugin's `$.prompt.submit` (F-25): a turn of its own on this
        // worker's queue. The interactive session only: a headless or
        // sub-agent build has no person to see it. Scope-guarded.
        // `$.prompt.read` / `.fill` / `.suggest` (F-25): the page's
        // prompt box, which the interactive session alone draws.
        drawsComposer: isPrimarySessionBuild,
        // `$.config.set` wrote a plugin's option: every session's plugins
        // reload with it, as after the Settings form's save.
        ...(this.worker.host?.reloadPluginsOnAllSessions
          ? { reloadPluginsOnAllSessions: () => this.worker.host!.reloadPluginsOnAllSessions!() }
          : {}),
        enqueuePluginTurn: isPrimarySessionBuild
          ? turn => {
              if (!this.worker.isCurrentScope(scope)) return
              this.worker.turns.enqueuePluginTurn(
                {
                  type: 'worker.submitMessage',
                  payload: {
                    prompt: turn.text,
                    promptUuid: globalThis.crypto.randomUUID(),
                    displayPrompt: turn.text,
                  },
                },
                turn,
              )
            }
          : undefined,
      })
    } finally {
      bootStages.clear()
    }
    // The provisional publish lands before the runtime takes over; its
    // restore holds the values the display already shows. Without one, each
    // restore below resolves its own.
    const restore = (await scope.display)?.restore

    // Generation guard: if a newer init was started while we were awaiting
    // createAgentRuntime, discard this result and let the newer scope win.
    // The stale runtime is disposed via its LOCAL reference — the worker's
    // runtime is never touched, so a newer scope's runtime stays intact.
    if (!this.worker.isCurrentScope(scope)) {
      try {
        await (createdRuntime.engine as { dispose?: () => Promise<void> })?.dispose?.()
      } catch {
        // best-effort
      }
      return
    }

    // Scope is still current — install the runtime atomically. The worker's
    // `runtime` derives from the scope, so this single write installs it.
    scope.runtime = createdRuntime
    // The runtime is the snapshot source from here on; drop the provisional
    // feed (and its retained transcript copy).
    this.worker.provisionalBoot = null
    scope.permissions.bindRuntime(createdRuntime)
    // A view bound at the provisional publish already delegates to the runtime.
    if (!scope.transcriptView) scope.transcript.bindRuntime(createdRuntime)
    scope.recovery.bindRuntime(createdRuntime)
    // Pin the model controller too — its async flows (Phase-2
    // reconcile, refresh, applySelection) must never commit a stale scope's
    // selection into a successor runtime via the worker-live host getter.
    scope.models.bindRuntime(createdRuntime)
    // The Connectors card reads the pool's servers off the snapshot; a server
    // that settles after the build (a slow connect, a settings change) is
    // published as it happens.
    const mcpPool = createdRuntime.sessionMcpPool
    if (mcpPool) {
      scope.disposeCallbacks.push(
        mcpPool.onServersChanged(() => {
          if (!this.worker.isCurrentScope(scope)) return
          this.worker.emit({ type: 'worker.state', payload: this.worker.getSnapshot() })
        }),
      )
    }
    // F-25: a plugin's `$.session.compact` / `.append` changes the
    // conversation outside the stream this worker mirrors to the page. Mid
    // submission (a mod's command), the whole transcript goes out when the
    // submission ends; otherwise (a timer, `session.start`) at once.
    createdRuntime.engine.setConversationRewrittenListener?.(() => {
      if (!this.worker.isCurrentScope(scope)) return
      if (this.worker.executingTurn) {
        this.worker.transcriptRewrittenInTurn = true
        return
      }
      void this.worker.emitWholeTranscript()
    })
    runtimeSpan.end({
      messageCount: createdRuntime.engine.transcriptRows().length ?? 0,
    })

    // File-snapshot crash recovery: a crash/kill mid-turn leaves that turn's
    // rows unfinalized; the disk was not touched since (the session was not
    // running), so finalizing lazily HERE is still correct. Cheap no-op for
    // sessions with no snapshot DB (a stat probe); fire-and-forget so boot
    // never blocks on it.
    // A history computed before the build saw the unrecovered turns; compute
    // it again so its digest can be stored.
    void createdRuntime.fileSnapshotRecorder?.recoverUnfinalized().then(
      () => {
        if (this.worker.isCurrentScope(scope)) void scope.transcript.recomputeIfComputed()
      },
      () => {
        // best-effort — the next turn end retries the same finalize
      },
    )

    // Cache-usage totals are derived from a full transcript walk in
    // getSnapshot() on every snapshot emission — no load-time seed needed.

    // A re-bind (forceReinit) reuses this worker, so `projectBranch` may still
    // hold the PREVIOUS folder's branch. Now that a fresh runtime (new
    // projectRoot) exists, clear it so the worker.ready snapshot starts clean
    // and refreshProjectBranch re-resolves for the new folder. refreshProjectBranch
    // only ever SETS a truthy branch (never re-clears here), so a transient
    // resolve failure on a later reload can't wipe an already-shown branch.
    this.worker.projectBranch = undefined

    // Apply the boot snapshot of the unified agent config (maxTurns,
    // …) once, now that the engine exists. Live changes
    // arrive later via the `worker.applyRuntimeSettings` message. Model
    // selection is NOT part of this — it flows through the per-session
    // model path below.
    if (payload.runtimeSettings) {
      createdRuntime.engine.applyRuntimeSettings(payload.runtimeSettings)
    }

    // PHASE 1 — fast path. Catalog-free model setup so the engine
    // is callable on the persisted/requested selection. If the
    // caller passed initialModelCatalog (typical for second+
    // session this browser session), use it; otherwise the
    // catalog stays null until Phase 2 completes.
    if (payload.initialModelCatalog) {
      scope.models.setCatalog(payload.initialModelCatalog)
    }
    const phase1Span = tracer.span('worker.model.applyImmediate', {
      traceId: initSpan.traceId,
      parentSpanId: initSpan.spanId,
    })
    const appliedImmediately = await scope.models.applyImmediateSelection(
      payload,
      restore?.selection,
    )
    phase1Span.end({ applied: appliedImmediately })

    // Scope guard: if superseded during model selection, bail out.
    if (!this.worker.isCurrentScope(scope)) return

    // Per-await scope guards: each of these steps parks on
    // storage I/O, and a forceReinit landing mid-await supersedes this scope.
    // Bailing between steps stops a stale scope from racing the successor's
    // identical restore work — and, critically, from reaching the host bind
    // below, which would overwrite the Manager's conversation-store binding
    // with the STALE scope's store.
    await scope.permissions.applyPersistedMode(restore?.persistedMode)
    if (!this.worker.isCurrentScope(scope)) return
    // Load the bypass-warning acknowledgment flag (F-13) so the first switch
    // into bypassPermissions this session knows whether to warn. Best-effort.
    await scope.permissions.loadSkipDangerousMode()
    if (!this.worker.isCurrentScope(scope)) return
    await scope.recovery.copyForkedPlanIfNeeded()
    if (!this.worker.isCurrentScope(scope)) return
    await scope.recovery.restorePendingPlanApproval(restore?.planApproval)
    if (!this.worker.isCurrentScope(scope)) return

    // Terminal state restore + interrupted-turn detection (Continue button).
    await scope.recovery.restoreTerminalState(restore?.terminal)
    if (!this.worker.isCurrentScope(scope)) return

    // Record this build's effective template/folder for the ready result
    // the Manager commits pointers and `lastInitTemplate`
    // from the same final truth the runtime and bind metadata use.
    scope.effectiveInit = {
      templateType: effectivePayload.templateType,
      projectRoot: effectivePayload.projectRoot,
    }
    const boundSessionId = createdRuntime.engine.boundSessionId()
    if (boundSessionId) {
      this.worker.boundSessionId = boundSessionId
      if (this.worker.host) {
        // Ready is a COMMIT BARRIER: the bind is AWAITED (worker.ready must
        // not race the host's critical metadata write) and carries the
        // EFFECTIVE build's template/folder. `false` = the durable write did
        // not land; void/true (legacy hosts, mocks) counts as persisted; a
        // throw is contained as not-persisted (P-1).
        try {
          const persisted = await this.worker.host.bindSessionRuntime(
            boundSessionId,
            createdRuntime.conversationStore,
            {
              ...scope.effectiveInit,
              // Identity, not build state: it rides the payload straight
              // through rather than joining `effectiveInit` (which the init
              // orchestrator re-commits as template/folder pointers).
              ...(effectivePayload.spawnerSessionId
                ? { spawnerSessionId: effectivePayload.spawnerSessionId }
                : {}),
              ...(effectivePayload.teammateName
                ? { teammateName: effectivePayload.teammateName }
                : {}),
            },
          )
          scope.bindPersisted = persisted !== false
        } catch {
          scope.bindPersisted = false
        }
        if (!this.worker.isCurrentScope(scope)) return
      }
    }

    // Scope guard: if superseded during metadata/plan/bind steps, bail
    // before emitting worker.ready — a stale ready would confuse the UI.
    if (!this.worker.isCurrentScope(scope)) return

    // worker.ready.send — see comment above. With the Phase 1/2
    // split this fires *before* the catalog fetch, so the UI
    // unblocks ~2 s sooner on cold boot.
    const sendSpan = tracer.span('worker.ready.send', {
      traceId: initSpan.traceId,
      parentSpanId: initSpan.spanId,
      attrs: { sessionId: payload.sessionId },
    })
    const snapshot = this.worker.getSnapshot()
    this.worker.emit({
      type: 'worker.ready',
      payload: snapshot,
    })
    sendSpan.end({
      messageCount: snapshot.messageCount,
      toolCount: snapshot.toolNames.length,
      modelCount: snapshot.availableModels.length,
      catalogReady: !!scope.models.getCatalog(),
    })

    // Resolve the project folder's git branch off the hot path; emits a state
    // push if it lands so the composer's branch chip fills in without blocking.
    // Retries while the host shell is still coming up (see the ladder).
    void this.resolveProjectBranchAtInit(scope)

    // PHASE 2 — slow path, in background. Only fires if we don't
    // already have a catalog. When it lands, reconcile the model
    // selection (the persisted choice might have been disabled in
    // settings) and emit a state push so the UI's model picker
    // populates without blocking the session render.
    scope.models.startBackgroundCatalogFetch(
      payload,
      {
        traceId: initSpan.traceId,
        parentSpanId: initSpan.spanId,
      },
      () => !this.worker.isCurrentScope(scope),
    )
    initSpan.end()
  }

  /**
   * Resolve the project folder's git branch and push a state update when it changed (no-op for
   * non-code / sandbox sessions). A transport failure keeps the branch; a shell that answered "no
   * branch" clears it. Returns whether the question is settled (`false` = no shell ran).
   */
  async refreshProjectBranch(scope: RuntimeScope): Promise<boolean> {
    const runtime = this.worker.runtime
    if (!runtime) return true
    // Every type that BINDS a real folder gets the branch chip — the same set
    // that drives the folder picker (`requiresProjectFolder`: the bundled
    // forced-folder types and a plugin type that requires a folder).
    if (!runtime.requiresProjectFolder || runtime.usedSandboxProjectRoot) {
      return true
    }
    const callTool = runtime.hostBridge?.browser?.callTool
    const projectRoot = runtime.options.projectRoot
    // `hostBridge` is built once with the runtime, so a missing callTool is
    // permanent for this runtime — nothing to retry.
    if (!callTool || !projectRoot) return true
    const { branch, shellResponded } = await readProjectBranch(
      request => callTool(request),
      projectRoot,
      runtime.engine.boundSessionId(),
    )
    // Generation guard: never accept a branch result from an older runtime
    // generation (e.g. a stale resolve that lands after a forceReinit).
    // Scope is mandatory so no caller can skip this guard.
    if (!this.worker.isCurrentScope(scope)) return true
    // A real branch always wins. `undefined` only wins when a shell actually
    // answered — that is a SETTLED "this folder has no branch" (detached HEAD,
    // or not a repo) and must clear the stale name. When nothing answered, the
    // resolve failed in transport and the last known branch stays put.
    const resolved = branch ?? (shellResponded ? undefined : this.worker.projectBranch)
    if (resolved !== this.worker.projectBranch) {
      this.worker.projectBranch = resolved
      this.worker.emit({ type: 'worker.state', payload: this.worker.getSnapshot() })
    }
    return !!branch || shellResponded
  }

  /**
   * The init-time branch resolve, retried on a bounded backoff while the host
   * shell has not answered at all. Without this a single boot-race failure left
   * the composer's branch chip empty until some unrelated action happened to
   * send `worker.getState` — often for the whole session. See
   * `PROJECT_BRANCH_RETRY_DELAYS_MS`.
   */
  private async resolveProjectBranchAtInit(scope: RuntimeScope): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      if (await this.refreshProjectBranch(scope)) return
      const delay = PROJECT_BRANCH_RETRY_DELAYS_MS[attempt]
      if (delay === undefined) return
      await new Promise(resolve => setTimeout(resolve, delay))
      // A forceReinit during the wait means a newer scope owns the worker.
      if (!this.worker.isCurrentScope(scope)) return
    }
  }

  private publishProvisionalBoot(
    scope: RuntimeScope,
    info: {
      sessionId: string
      cwd: string
      projectRoot: string
      usedSandboxProjectRoot: boolean
      hostMode: string | undefined
      messages: Message[]
      /** The building session's own store — see `withTranscriptLines`. */
      conversationStore?: BrowserConversationStore
      fileSnapshotRecorder?: FileSnapshotRecorder
      installedFs?: RuntimeFs
      autoCompactWindows?: AutoCompactWindowSettings
      permissionSettings?: Promise<PermissionSettingsBySource>
    },
    payload: AgentRuntimeWorkerInitPayload,
  ): void {
    // A superseded build must not publish into the successor's UI.
    if (!this.worker.isCurrentScope(scope)) return
    // The catalog the install would adopt; the selection resolves against it.
    if (payload.initialModelCatalog && !scope.models.getCatalog()) {
      scope.models.setCatalog(payload.initialModelCatalog)
    }
    const store = info.conversationStore
    const display: Promise<SessionDisplayState | null> = store && info.installedFs
      ? resolveSessionDisplayState({
          payload,
          conversationStore: store,
          rows: info.messages,
          cwd: info.cwd,
          sessionId: info.sessionId,
          fs: info.installedFs,
          catalog: scope.models.getCatalog(),
          permissionSettings: info.permissionSettings,
          autoCompactWindows: info.autoCompactWindows,
          models: scope.models,
          permissions: scope.permissions,
        }).catch(() => null)
      : Promise.resolve(null)
    scope.display = display
    // The first provisional snapshot already carries the display state.
    void display.then(state => this.finishProvisionalBoot(scope, info, state))
  }

  private finishProvisionalBoot(
    scope: RuntimeScope,
    info: {
      sessionId: string
      cwd: string
      projectRoot: string
      usedSandboxProjectRoot: boolean
      hostMode: string | undefined
      messages: Message[]
      conversationStore?: BrowserConversationStore
      fileSnapshotRecorder?: FileSnapshotRecorder
    },
    display: SessionDisplayState | null,
  ): void {
    // A runtime that installed first publishes through `worker.ready`.
    if (!this.worker.isCurrentScope(scope) || scope.runtime) return
    if (display) {
      scope.recovery.setTerminalState(
        display.restore.terminal.reason,
        display.restore.terminal.timestamp,
      )
    }
    const earlyRows = info.messages
    const messages = earlyRows.map(sanitizeMessageForUi)
    this.worker.provisionalBoot = {
      snapshot: {
        sessionId: info.sessionId,
        cwd: info.cwd,
        projectRoot: info.projectRoot,
        usedSandboxProjectRoot: info.usedSandboxProjectRoot,
        hostMode: info.hostMode,
        messageCount: messages.length,
        ...(display ? { display: display.view } : {}),
      },
      messages: earlyRows,
      conversationStore: info.conversationStore,
    }
    const earlyStore = info.conversationStore
    if (earlyStore) {
      // Reads the early transcript until the runtime installs, then the
      // runtime's own; one identity, so in-flight reads survive the install.
      const view: TranscriptSource = {
        get conversationStore() {
          return scope.runtime?.conversationStore ?? earlyStore
        },
        get fileSnapshotRecorder() {
          return scope.runtime ? scope.runtime.fileSnapshotRecorder : info.fileSnapshotRecorder
        },
        engine: {
          transcriptRows: () =>
            scope.runtime ? scope.runtime.engine.transcriptRows() : earlyRows,
        },
      }
      scope.transcriptView = view
      scope.transcript.bindRuntime(view)
    }
    scope.markDisplayReady?.()
    this.worker.emit({ type: 'worker.uiReady', payload: this.worker.getSnapshot() })
    // Emit ONCE, with the transcript lines already attached — never a
    // sync unstamped copy followed by an async stamped one. A double emit
    // renders rows without line ranges first, and if the stamped copy
    // lost the race (or shipped unstamped) a search jump could find no
    // range at all. `.catch` falls back to the unstamped list so a
    // stamping failure still delivers messages.
    void withTranscriptLines(messages, info.conversationStore)
      .catch(() => messages)
      .then(stamped => {
        if (!this.worker.isCurrentScope(scope)) return
        this.worker.emit({ type: 'worker.messages', payload: { messages: stamped } })
      })
  }
}
