import type { BrowserLlmSelection } from '../bridge/browserBridgeProtocol'
// The pure i18n core — no React, so importing it here does not drag React
// into the SharedWorker's separate Rollup build.
import {
  haltRecordsHaltOnUser,
  submitCarriesToolResult,
  toolResultIdsInPrompt,
} from '../../utils/sessionNeedsAnswer'
import { isHaltSafeSlashCommandPrompt } from '../../utils/slashCommandPrompt'
import { primeEnCatalog } from '../webview/i18n/translate'
import { createAgentRuntime } from '../runtime/createAgentRuntime'
import type { HookNotification } from '../../lifecycleHooks/sessionLifecycleHooks'
import type { AgentRuntimeState } from '../runtime/AgentRuntimeState'
import { isSelectionEnabled, toEntrySelection } from './modelSelection'
import {
  extractFinalAssistantMessage,
  extractFinalAssistantText,
} from './taskProjection'
import { AgentWorkerBridgeTransport } from './AgentWorkerBridgeTransport'
import {
  MSG_TYPE_SYSTEM,
  SYSTEM_SUBTYPE_COMPACT_BOUNDARY,
} from '../../runtime/VercelModelConstants'
import {
  resolveStorageBackend,
  resolveResumeProjectRoot,
  createBootStageReporter,
} from './agentRuntimeBootstrap'
import type {
  BrowserConversationStorageBackend,
  BrowserConversationStore,
} from '../../sessions/sessionStore'
import type { OwnerRuntimeGlobals } from './taskTypes'
import { readProjectBranch } from '../../utils/projectBranch'
import { streamEventMovesGitHead } from '../../utils/branchSwitchDetect'
import { isForcedFolderTemplateType } from '../../utils/conversationStoragePaths'
import type { AgentRuntimeWorkerInitPayload } from './workerProtocol'
import { buildWorkerSnapshot } from './workerSnapshot'
import { isAutoCompactWindow } from '../../settings/modelSettings'
import { onModSlotsChanged } from '../../mods/modSlotRegistry'
import type { ProvisionalBootSources } from './workerSnapshot'
import type { Message } from '../../runtime/RuntimeTypes'
import type {
  AgentWorkerInboundMessage,
  AgentWorkerOutboundMessage,
  AgentRuntimeInitResult,
  AgentRuntimeWorkerSnapshot,
} from './workerProtocol'
import {
  sanitizeMessageForUi,
  sanitizeSdkMessageForUi,
} from '../../utils/toolCallDetails'
import type { TraceLoggerEntry } from '../../engine/turn/modelTrace'
import { getSessionTracer } from '../../utils/sessionTrace'
import type {
  AgentSessionPhase,
  AgentToolKind,
} from './AgentTurnState'
import {
  AgentTurnController,
  type AgentToolEndTransition,
} from './AgentTurnController'
import { AgentModelController, type AgentModelControllerHost } from './AgentModelController'
import {
  AgentPermissionCoordinator,
  type AgentPermissionCoordinatorHost,
} from './AgentPermissionCoordinator'
import { AgentRuntimeRecovery } from './AgentRuntimeRecovery'
import { AgentTranscriptService } from './AgentTranscriptService'
import {
  extractRuntimeSettingsNamespaces,
  parseApiErrorRetryEvent,
} from './agentRuntimeMessageParsing'
import {
  disposeScopeResources,
  type RuntimeScope,
} from './agentRuntimeScope'
import { AgentRuntimeDiagnostics } from './AgentRuntimeDiagnostics'
import {
  fireSessionDeletedStop as notifySessionDeleted,
  scheduleActorStopForInterrupt as notifyUserInterrupt,
} from './agentRuntimeStopNotifications'
import {
  beginRoutineFireTurn,
  endRoutineFireTurn,
} from '../../routines/routineTurnScope'
import { resolveBundledSkillBody } from '../../skillLibrary/builtinSkillBody'
import { isTeammateSessionId } from '../../utils/sidechainStoragePaths'

/** How long a session sits idle before it lets go of its tool payloads. */
export const IDLE_PAYLOAD_RELEASE_MS = 5 * 60_000

/**
 * Max time the FIRST submit of a fresh session will wait for the Phase-2 model
 * catalog fetch before falling through and submitting on the engine's default
 * ('inherit') model. The catalog normally lands in ~2-3s; this cap exists so a
 * catalog fetch that never resolves (see submitMessage's modelGate comment)
 * can't wedge the first turn indefinitely. Comfortably above the cold-boot
 * catalog time and well under the harness's per-attempt submit window.
 */
const MODEL_INIT_SUBMIT_GRACE_MS = 3_000

/**
 * Backoff before each retry of the init-time git-branch resolve (the first attempt is immediate).
 * Retries only while no shell answered at all, so a non-git folder costs one attempt.
 */
const PROJECT_BRANCH_RETRY_DELAYS_MS = [150, 600, 1_500, 3_000] as const

/**
 * Narrow host interface the Worker uses to report back to its owner
 * (SharedWorkerSessionManager) without importing it directly. This breaks
 * the Worker -> Manager reverse dependency. The Manager implements
 * this structurally; tests can supply a stub.
 */
export interface AgentRuntimeWorkerHost {
  /** Report a boot-progress stage for the boot-welcome overlay. */
  broadcastBootStage(stage: string, sessionId: string): void
  /** Bind a freshly-created runtime's conversation store to its session.
   *  `initMeta` carries the INIT PAYLOAD's template/folder so
   *  the Manager persists what this build is actually binding — during a
   *  force-reinit the SessionEntry still holds the OLD values until the
   *  two-phase commit lands, so deriving from the entry wrote the old
   *  projectRoot into the NEW store. */
  bindSessionRuntime(
    sessionId: string,
    store: BrowserConversationStore,
    initMeta?: {
      templateType?: string
      projectRoot?: string
      /** Teammate identity from the init payload — written once, never
       *  cleared (see BrowserSessionMetadata.spawnerSessionId). */
      spawnerSessionId?: string
      teammateName?: string
    },
  ): void | boolean | Promise<void | boolean>
  /** Report the applied model selection so the topbar feed emits a delta. */
  setModel(
    sessionId: string,
    selection: BrowserLlmSelection | null,
  ): void
  /** Mid-turn task-notification drain: take this session's pending background
   *  task results that may be injected between tool rounds (shells always;
   *  sub-agents only when `includeLater`). Returns the formatted
   *  `<task-notification>` batch (+ its oldest enqueue time) or null.
   *  Optional — hosts without a delivery queue leave it unset and results
   *  arrive only as the idle turn. */
  drainMidTurnTaskNotifications?(
    sessionId: string,
    opts: { includeLater: boolean },
  ): { prompt: string; enqueuedAt: number } | null
  /** Mid-turn team-mailbox drain: every frame queued for this session,
   *  removed (and marked read) as it is returned. Optional. */
  drainMidTurnTeamMessages?(
    sessionId: string,
  ): Array<{ prompt: string; enqueuedAt: number }>
  /** Every session reloads its plugins — after a plugin's stored
   *  `userConfig` value changed (`$.config.set`). Optional: without it only
   *  this session's engine reloads. */
  reloadPluginsOnAllSessions?(): void
}

export type AgentRuntimeWorkerOptions = {
  emit: (message: AgentWorkerOutboundMessage) => void
  /**
   * Narrow host callback interface. Replaces the old
   * `getActiveSessionManager()` reverse import so the Worker no longer
   * depends on SharedWorkerSessionManager.
   */
  host?: AgentRuntimeWorkerHost
  /**
   * Optional shared storage backend injected by SharedWorkerSessionManager so
   * all per-session workers talk to the same fs adapter (one cache, one set
   * of directory-ensure flags, one summary-invalidation path).
   */
  conversationStorageBackend?: BrowserConversationStorageBackend
}

export class AgentRuntimeWorker {
  private readonly emit: (message: AgentWorkerOutboundMessage) => void
  private readonly bridgeTransport: AgentWorkerBridgeTransport
  private readonly diagnostics: AgentRuntimeDiagnostics
  private readonly injectedStorageBackend?: BrowserConversationStorageBackend
  private readonly host?: AgentRuntimeWorkerHost
  // Defensive overlap guard for executeSubmit — the phase-based
  // check moved to dequeue time, so overlap detection needs its own flag.
  private executingTurn = false
  /** The engine's conversation changed outside the stream during the
   *  submission in flight (a plugin's `$.session.compact` / `.append`). */
  private transcriptRewrittenInTurn = false
  // --- Runtime generation / scope (PR 3: reinit safety) ---
  private generation = 0
  private runtimeScope: RuntimeScope | null = null
  /**
   * Provisional boot state, set by `onUiReady` until the runtime installs or the scope dies. While set,
   * every snapshot carries `uiReady: true` + the provisional fields; `messages` lets a port attaching
   * mid-build replay `worker.uiReady` + `worker.messages`.
   */
  private provisionalBoot: {
    snapshot: ProvisionalBootSources
    messages: Message[]
  } | null = null
  /** SINGLE runtime source: the runtime always belongs to the
   *  current scope. Deriving it kills the old dual `this.runtime` field —
   *  the two could disagree across dispose/install races, and every "null
   *  out the field if it still points at this scope's runtime" dance in the
   *  dispose paths existed only to re-synchronize them. */
  private get runtime(): AgentRuntimeState | null {
    return this.runtimeScope?.runtime ?? null
  }
  /**
   * In-flight `worker.init` body, resolved after Phase 1. Non-init handlers await it before touching
   * `this.runtime`; it stays set (resolved) after init.
   */
  private initPromise: Promise<void> | null = null
  private boundSessionId: string | null = null
  /** The last composer save of the auto-compact window failed; published on
   *  the snapshot until the next save. */
  private autoCompactSaveError: string | undefined
  /**
   * Current git branch of a bound `code` session's project folder, surfaced on
   * the snapshot next to `projectRoot` (folder + branch).
   * Now per-scope so a detached disposal cannot clear the new scope's branch.
   */
  private get projectBranch(): string | undefined {
    return this.runtimeScope?.projectBranch
  }
  private set projectBranch(v: string | undefined) {
    if (this.runtimeScope) this.runtimeScope.projectBranch = v
  }
  // --- Turn controller (PR 4A: extracted from inline fields) ---
  private readonly turns: AgentTurnController
  /** See `scheduleIdlePayloadRelease`. */
  private idleReleaseTimer: ReturnType<typeof setTimeout> | null = null
  // Controllers are per-scope (created in worker.init). Fallback
  // instances support pre-init snapshots and protocol requests.
  private get scopeModels(): AgentModelController {
    return this.runtimeScope?.models ?? this.fallbackModels
  }
  private get scopePermissions(): AgentPermissionCoordinator {
    return this.runtimeScope?.permissions ?? this.fallbackPermissions
  }
  private get scopeRecovery(): AgentRuntimeRecovery {
    return this.runtimeScope?.recovery ?? this.fallbackRecovery
  }
  private get scopeTranscript(): AgentTranscriptService {
    return this.runtimeScope?.transcript ?? this.fallbackTranscript
  }
  // Fallback instances for pre-init access (snapshot before init, etc.).
  /**
   * The seam AgentModelController acts through. With `generation`, the outbound host callbacks
   * self-fence, so a superseded scope's late continuation reports nothing.
   */
  private makeModelHost(generation?: number): AgentModelControllerHost {
    const stale = (): boolean =>
      generation !== undefined && !this.isCurrentGeneration(generation)
    return {
      getRuntime: () => this.runtime,
      emitState: () => {
        if (stale()) return
        this.emit({ type: 'worker.state', payload: this.getSnapshot() })
      },
      emitDebugLog: (level, message) =>
        this.emit({ type: 'worker.debugLog', payload: { level, message } }),
      reportModelChanged: selection => {
        if (stale()) return
        if (this.boundSessionId) {
          this.host?.setModel(this.boundSessionId, selection)
        }
      },
    }
  }

  private readonly fallbackModels = new AgentModelController(this.makeModelHost())
  /** The narrow seam AgentPermissionCoordinator acts through (runtime access
   *  is via its own scope-bound `bindRuntime`, not this host). */
  private makePermissionHost(): AgentPermissionCoordinatorHost {
    return {
      emitState: () =>
        this.emit({ type: 'worker.state', payload: this.getSnapshot() }),
      emitError: (code, message) => this.emitError(code, message),
    }
  }

  private readonly fallbackPermissions = new AgentPermissionCoordinator(
    this.makePermissionHost(),
  )
  private readonly fallbackRecovery = new AgentRuntimeRecovery({
    clearPendingPlanApprovalMarker: () =>
      this.scopePermissions.clearPendingPlanApprovalMarker(),
  })
  private readonly fallbackTranscript = new AgentTranscriptService({
    emit: m => this.emit(m),
    isBusy: () => this.isBusy(),
  })

  /** Stops hearing the mod slot registry (F-25): the picker's command list
   *  and the mods' state ride the snapshot, which a change republishes. */
  private readonly unsubscribeModSlots: () => void

  constructor(options: AgentRuntimeWorkerOptions) {
    this.emit = options.emit
    this.unsubscribeModSlots = onModSlotsChanged(sessionId => {
      const runtime = this.runtime
      if (!runtime || runtime.engine.boundSessionId() !== sessionId) return
      this.emit({ type: 'worker.state', payload: this.getSnapshot() })
    })
    this.bridgeTransport = new AgentWorkerBridgeTransport(this.emit)
    this.diagnostics = new AgentRuntimeDiagnostics(message =>
      this.emit({
        type: 'worker.debugLog',
        payload: { level: 'info', message },
      }),
    )
    this.injectedStorageBackend = options.conversationStorageBackend
    this.host = options.host
    this.turns = new AgentTurnController({
      onStateChanged: () => {
        this.emit({ type: 'worker.state', payload: this.getSnapshot() })
      },
      onTurnReady: turn => {
        // executeSubmit returns an explicit AgentTurnResult. The
        // completion deferred is resolved with that result directly — no
        // more inferring success/failure from promise resolution/rejection.
        this.cancelIdlePayloadRelease()
        void this.executeSubmit(turn.message, turn.source, turn.plugin)
          .catch((error): import('./AgentTurnController').AgentTurnResult => ({
            // Hardening: a throw that escapes executeSubmit's own
            // try (e.g. waitForInit rejecting) must still settle the turn —
            // otherwise the completion never resolves and `submitting` never
            // clears, wedging the queue forever.
            status: 'failed',
            code: 'worker_submit_failed',
            message: error instanceof Error ? error.message : String(error),
          }))
          .then(result => {
            if (turn.completion) {
              turn.completion.resolve(result)
            }
            // Settle ⇒ not busy (mirrors executeSubmit's finally, which the
            // escape-throw path above bypasses). Safe here: the pump is still
            // blocked by `submitting`, so no successor turn owns the phase yet.
            this.normalizeTurnEndPhase()
            this.turns.markExecutionFinished()
            this.scheduleIdlePayloadRelease()
            // A non-completed turn still publishes the settled state, or clients keep `isBusy: true`.
            // After the pump on purpose: a just-dispatched queued turn is reported busy.
            if (result.status !== 'completed') {
              this.emit({ type: 'worker.state', payload: this.getSnapshot() })
            }
          })
      },
      runImmediateCommand: message => {
        const { prompt } = message.payload
        const engine = this.runtime?.engine
        if (typeof prompt !== 'string' || !engine?.isImmediateCommand(prompt)) return false
        // Beside the running turn, never as one: no phase, no queue slot.
        void engine.runImmediateCommand(prompt)
        return true
      },
      onPendingMessageChanged: (text, reason, extra) => {
        this.emit({
          type: 'worker.pendingMessageUpdated',
          payload: {
            text,
            reason,
            ...(extra?.promptUuids ? { promptUuids: extra.promptUuids } : {}),
            ...(extra?.entries ? { entries: extra.entries } : {}),
            ...(extra?.consumed ? { consumed: extra.consumed } : {}),
          },
        })
      },
      onPendingMessageCleared: () => {
        this.emit({ type: 'worker.pendingMessageCleared', payload: {} })
      },
      onInjectMessagesChanged: entries => {
        this.emit({ type: 'worker.injectMessagesUpdated', payload: { entries } })
      },
      onInjectMessagesLanded: info => {
        this.emit({ type: 'worker.injectMessagesLanded', payload: info })
      },
      onInjectMessagesCleared: entries => {
        this.emit({ type: 'worker.injectMessagesCleared', payload: { entries } })
      },
      isAwaitingUser: () => this.haltedOnUser(),
    })
  }

  /**
   * Halted on the user: the turn ended on an unanswered AskUserQuestion or a
   * staged plan approval. Read straight off the engine's two records — the
   * controller asks on every idle send and every pump, and a snapshot walks
   * the transcript to answer. The provisional (pre-init) snapshot carries no
   * halt records, so no engine means no halt.
   */
  private haltedOnUser(): boolean {
    const engine = this.runtime?.engine
    if (!engine) return false
    return haltRecordsHaltOnUser(
      engine.getPendingUserInteraction?.(),
      engine.getPendingPlanApproval?.(),
    )
  }

  /** Whether the given scope is still the active runtime scope. */
  private isCurrentScope(scope: RuntimeScope): boolean {
    return this.runtimeScope === scope
  }

  /** Whether the given generation is still the active generation. */
  isCurrentGeneration(generation: number): boolean {
    return this.generation === generation
  }

  /**
   * Dispose the current runtime scope: abort in-flight async work, clear
   * timers/subscriptions, and release the runtime. Called before a reinit
   * and on worker disposal. Idempotent — safe to call multiple times.
   * All state mutations are scope-local.
   */
  private async disposeRuntimeScope(reason: string): Promise<void> {
    const scope = this.runtimeScope
    if (!scope) return

    this.runtimeScope = null
    // A dead scope's provisional feed must not keep advertising `uiReady`
    // (an init-failure dispose leaves no runtime for it to hand off to).
    this.provisionalBoot = null
    await disposeScopeResources(scope, {
      reason,
      cancelGeneration: generation =>
        this.bridgeTransport.cancelGeneration(generation),
    })
    // No field to null out: `this.runtime` derives from `runtimeScope`,
    // which was already detached above.
  }

  /**
   * Dispose a scope that has already been detached (replaced by a newer scope).
   * Unlike disposeRuntimeScope, this NEVER touches this.runtimeScope — the
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
        this.bridgeTransport.cancelGeneration(generation),
    })
    // No field to null out: `this.runtime` derives from `runtimeScope`,
    // which by definition no longer points at this detached scope.
  }

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
    if (payload.forceReinit && this.runtime) {
      const snapshot = this.getSnapshot()
      if (snapshot.isBusy || snapshot.messageCount > 0) {
        this.emitError(
          'worker_reinit_not_allowed',
          'A runtime can only be rebound while the session is idle and empty.',
        )
        return { status: 'rejected', code: 'worker_reinit_not_allowed' }
      }
    }

    // Create a new runtime scope with an incremented generation.
    const generation = ++this.generation

    const scopePermissions = new AgentPermissionCoordinator(
      this.makePermissionHost(),
    )
    const scope: RuntimeScope = {
      generation,
      abortController: new AbortController(),
      runtime: null,
      disposeCallbacks: [],
      // Fresh controllers per scope so detached disposal is isolated.
      // The generation lets the model host's outbound callbacks self-fence
      // once this scope is superseded.
      models: new AgentModelController(this.makeModelHost(generation)),
      permissions: scopePermissions,
      recovery: new AgentRuntimeRecovery({
        clearPendingPlanApprovalMarker: () =>
          scopePermissions.clearPendingPlanApprovalMarker(),
      }),
      transcript: new AgentTranscriptService({
        emit: m => this.emit(m),
        isBusy: () => this.isBusy(),
      }),
      projectBranch: undefined,
    }

    // Synchronous latest-wins: install the new scope BEFORE any await so
    // a concurrent init can never overwrite us with a stale scope. The
    // previous scope is detached and disposed asynchronously.
    const previousScope = this.runtimeScope
    this.runtimeScope = scope
    // A previous build's provisional boot feed belongs to ITS scope — the
    // new build re-publishes its own (or none, for a rebind to a session
    // whose store is empty).
    this.provisionalBoot = null
    // Bridge requests issued from here on belong to THIS scope — set
    // synchronously with the install so the attribution can
    // never lag behind the scope switch.
    this.bridgeTransport.setActiveGeneration(generation)
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
      // never mutate this.runtimeScope because it's no longer current).
      await this.disposeDetachedScope(previousScope, 'reinitialize')
      await this.runInit(payload, scope)
    })()
    // Set initPromise SYNCHRONOUSLY before any await so concurrent
    // non-init messages (setModelSelection, etc.) park on it via
    // waitForInit() instead of seeing a null runtime.
    this.initPromise = initRun.catch(async error => {
      if (!this.isCurrentScope(scope)) return
      this.emitError(
        'worker_init_failed',
        error instanceof Error ? error.message : String(error),
      )
      await this.disposeRuntimeScope('init_failed').catch(() => {})
    })
    try {
      await initRun
    } catch (error) {
      // Distinguish by GENERATION, not scope identity: the contained view's
      // own failure-dispose has already nulled `runtimeScope` by the time
      // this catch runs (it was attached first), so `isCurrentScope` would
      // misread our own failure as a supersession. Only a NEWER init
      // advances the generation.
      if (this.generation !== generation) {
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
    return this.isCurrentScope(scope)
      ? {
          status: 'ready',
          generation,
          bindPersisted: scope.bindPersisted,
          effectiveInit: scope.effectiveInit,
        }
      : { status: 'superseded', generation }
  }

  async receiveFrame(message: AgentWorkerInboundMessage): Promise<void> {
    switch (message.type) {
      case 'worker.init': {
        const result = await this.reinitialize(message.payload)
        if (result.status === 'failed') {
          // Preserve the dispatch contract: fire-and-forget callers
          // observe init failure as a rejection (which they catch/trace).
          throw new Error(result.message)
        }
        return
      }

      case 'worker.bridgeEvent':
        this.bridgeTransport.handleEvent(message.payload)
        return

      case 'worker.submitMessage':
        this.handleSubmitMessage(message)
        return

      case 'worker.clearPendingMessage':
        this.turns.clearPendingUserMessage()
        return

      case 'worker.removeInjectMessage': {
        const removed = this.turns.removeInjectEntry(message.payload.uuid)
        this.emit({
          type: 'worker.injectMessageRemoved',
          payload: {
            uuid: message.payload.uuid,
            requestId: message.payload.requestId,
            ok: removed !== null,
            ...(removed ? { text: removed.text } : {}),
          },
        })
        return
      }

      case 'worker.interrupt':
        // Wait for init in case Stop is clicked during the createBrowserRuntime
        // window. Without this, a fast Stop hits an empty `this.runtime` and
        // silently no-ops (isBusy is false), then a moments-later
        // submitMessage races against a half-initialized engine.
        await this.waitForInit()
        // Re-entrant interrupts are a no-op. The first one already aborted
        // the controller; hitting the route again would just re-fire the
        // actor-stop request and do nothing else.
        if (!this.turns.beginStopping()) {
          this.emit({
            type: 'worker.state',
            payload: this.getSnapshot(),
          })
          return
        }
        // Drop the saved "next message": auto-running it after Stop would
        // resurrect the conversation the user just halted.
        this.turns.clearForInterrupt()
        this.scopePermissions.resolveAllAsAbort()
        // Fire-and-forget: cancel the hosted browser actor task for this
        // session so `browser_*` Mojo traffic unwinds alongside the
        // abort. Without this, the actor keeps running until the Stop
        // hook at natural turn-end (which doesn't fire on abort — see
        // engine/turnLoop.ts abort-path early return).
        this.scheduleActorStopForInterrupt()
        this.runtime?.engine.cancelTurn()
        this.emit({
          type: 'worker.state',
          payload: this.getSnapshot(),
        })
        return

      case 'worker.setModelSelection':
        await this.runWithRuntime(
          async () => {
            // Security: a teammate stays on the provider its lead spawned it on (its trust and read
            // boundary were decided for that provider). Backstop to the page; checked after init binds.
            if (this.boundSessionId && isTeammateSessionId(this.boundSessionId)) {
              return false
            }
            const catalog = this.scopeModels.getCatalog()
            // A raw model id (the host's profile-wide push, an older page)
            // lands on its model-entry row.
            const selection = toEntrySelection(catalog, message.payload.selection)
            if (
              catalog &&
              !isSelectionEnabled(catalog, selection)
            ) {
              this.emitError(
                'worker_invalid_model_selection',
                'Selected provider or model is disabled or unavailable.',
              )
              return false
            }
            await this.scopeModels.applySelection(selection)
          },
          { emitStateAfter: true },
        )
        return

      case 'worker.setPermissionMode':
        await this.runWithRuntime(
          () => this.scopePermissions.applyMode(message.payload.mode),
          { emitStateAfter: true },
        )
        return

      case 'worker.resolveToolUseConfirm':
        await this.runWithRuntime(() =>
          this.scopePermissions.resolveConfirm(message.payload),
        )
        return

      case 'worker.addPermissionRule': {
        const { rule, toolCallId, persist } = message.payload
        await this.runWithRuntime(
          () =>
            this.scopePermissions.addAllowRule(rule, toolCallId, persist),
          { emitStateAfter: true },
        )
        return
      }

      case 'worker.applyPermissionUpdate': {
        const { update, toolCallId } = message.payload
        await this.runWithRuntime(
          () => this.scopePermissions.applyUpdate(update, toolCallId),
          { emitStateAfter: true },
        )
        return
      }

      case 'worker.setAutoCompactWindow': {
        const { value } = message.payload
        await this.runWithRuntime(
          async runtime => {
            const modelId = runtime.engine.getCurrentModel()
            if (!modelId || modelId === 'inherit') return false
            if (value !== 'auto' && !isAutoCompactWindow(value)) return false
            try {
              await runtime.autoCompactWindows.saveForModel(
                modelId,
                runtime.engine.getCurrentProviderId(),
                value,
              )
              this.autoCompactSaveError = undefined
            } catch (error) {
              this.autoCompactSaveError =
                error instanceof Error ? error.message : String(error)
            }
          },
          { emitStateAfter: true },
        )
        return
      }

      case 'worker.setSkipDangerousMode': {
        await this.runWithRuntime(
          () =>
            this.scopePermissions.persistSkipDangerousMode(
              message.payload.value,
            ),
          { emitStateAfter: true },
        )
        return
      }

      case 'worker.clearPlanApproval': {
        await this.runWithRuntime(
          runtime => {
            // Clear the pending plan approval AUTHORITATIVELY and immediately
            // emit a fresh snapshot, so the plan-approval control dismisses
            // before the follow-up implementation turn completes.
            runtime.engine.clearPendingPlanApproval(
              message.payload?.toolCallId,
            )
            // The page sends this AHEAD of the approve / reject tool result
            // (resolvePlanApproval). With the record gone the halt gate would
            // open, and a turn held under the halt would start before the
            // answer; keep it closed until that answer dispatches.
            this.turns.holdForAnswer()
          },
          { emitStateAfter: true },
        )
        return
      }

      case 'worker.applyRuntimeSettings':
        await this.runWithRuntime(
          runtime => {
            const config = message.payload.config
            // Generic: forward the whole config dict to the engine, which
            // applies the keys it recognizes (maxTurns, …).
            runtime.engine.applyRuntimeSettings(config)
            const { memorySettings, sessionModelSettings } =
              extractRuntimeSettingsNamespaces(config)
            if (memorySettings) {
              runtime.engine.applyMemorySettings(memorySettings)
            }
            if (sessionModelSettings) {
              runtime.engine.applySessionModelSettings(sessionModelSettings)
            }
          },
          { emitStateAfter: true },
        )
        return

      case 'worker.reloadPlugins':
        await this.runWithRuntime(
          async runtime => {
            await runtime.engine.refreshPluginSet(message.payload?.enabledPlugins)
          },
          { emitStateAfter: true, onMissing: 'ignore' },
        )
        return

      case 'worker.reloadMods':
        await this.runWithRuntime(
          async runtime => {
            await runtime.engine.reloadMods()
          },
          { emitStateAfter: true, onMissing: 'ignore' },
        )
        return

      case 'worker.refreshModelCatalog':
        await this.runWithRuntime(
          () => this.scopeModels.refreshCatalog(),
          { emitStateAfter: true },
        )
        return

      case 'worker.getState':
        this.emit({
          type: 'worker.state',
          payload: this.getSnapshot(),
        })
        // Re-resolve the git branch off the hot path so a `git checkout` or
        // an init-time resolve that lost a race (host git/Bash not ready yet)
        // is picked up whenever the UI re-requests state. Idempotent: it only
        // pushes another `worker.state` if the branch actually changed.
        // Pass the current scope so a stale resolve can't write to a
        // newer scope's projectBranch. Scope is MANDATORY —
        // no scope yet means nothing to resolve against.
        if (this.runtimeScope) {
          void this.refreshProjectBranch(this.runtimeScope)
        }
        return

      case 'worker.getMessages':
        // Wait for init before reading the engine, or a `worker.getMessages` in the same tick as
        // `worker.ready` replies with an empty array.
        await this.waitForInit()
        this.emit({
          type: 'worker.messages',
          payload: {
            messages: await this.withTranscriptLines(
              this.runtime
                ? this.runtime.engine.transcriptRows().map(sanitizeMessageForUi)
                : [],
              this.runtime?.conversationStore,
            ),
          },
        })
        // Bring the change history up to date AFTER the (boot-critical)
        // transcript emit — never blocks it; an opened session is served
        // from its stored digest when that still holds.
        void this.scopeTranscript.refreshTurnDiffHistory()
        return

      case 'worker.getMessagesSince': {
        await this.waitForInit()
        const allMessages = this.runtime
          ? this.runtime.engine.transcriptRows()
          : []
        const sinceOrdinal = message.payload.sinceOrdinal
        // Stamped like the full read above: a delta row without its
        // transcript line is one a search jump cannot land on.
        const deltaMessages = await this.withTranscriptLines(
          allMessages.slice(sinceOrdinal).map(sanitizeMessageForUi),
          this.runtime?.conversationStore,
        )
        this.emit({
          type: 'worker.messages',
          payload: {
            messages: deltaMessages,
            sinceOrdinal,
          },
        })
        void this.scopeTranscript.refreshTurnDiffHistory()
        return
      }

      case 'worker.getToolCallDetail': {
        // UI-ready split: the transcript is visible (and expandable) during
        // the provisional window, so this can arrive before the runtime is
        // built. Park like getMessages — replying from the unbound transcript
        // service would return an empty detail for a tool call the user can
        // see on screen.
        await this.waitForInit()
        const detail = await this.scopeTranscript.getToolCallDetail(message.payload.toolCallId)
        this.emit({
          type: 'worker.toolCallDetail',
          payload: {
            toolCallId: message.payload.toolCallId,
            detail,
          },
        })
        return
      }

      case 'worker.getTurnDiffDetail': {
        // Same provisional-window park as getToolCallDetail above — the
        // history cache is only populated once the runtime is bound.
        await this.waitForInit()
        // Serve a turn's hunks from the history cache (computed by
        // emitTurnDiffHistory). The UI fetches this lazily on expand.
        // Sentinel turnIndex 0 (real turns are 1-based): the WHOLE-SESSION
        // snapshot diff of a fileSnapshots session — the WorkspaceDiff
        // card's file jump reads it; null for sessions without a recorder.
        const turnIndex = message.payload.turnIndex
        // The history is computed on first need, not on open.
        if (turnIndex !== 0) await this.scopeTranscript.ensureTurnDiffHistory()
        const files =
          turnIndex === 0
            ? await this.scopeTranscript.getSessionSnapshotDiff()
            : (this.scopeTranscript
                .getHistoryFull()
                .find(t => t.turnIndex === turnIndex)?.files ?? null)
        this.emit({
          type: 'worker.turnDiffDetail',
          payload: { turnIndex, files },
        })
        return
      }

      case 'worker.getTurnDiffHistory': {
        // A view that lists the history asks for it; computed on this first
        // need when the open was served from the stored digest.
        await this.waitForInit()
        if (!(await this.scopeTranscript.ensureTurnDiffHistory())) {
          this.scopeTranscript.emitComputedIfCurrent()
        }
        return
      }

      case 'worker.getSkillBody': {
        // Bundled-skill body for the Skills tab (synthetic `bundled:<name>`
        // path — no SKILL.md to read). Park on init like getToolCallDetail:
        // the bundled registry is populated during the runtime build
        // (`installStockSkills` via loadLocalPromptCommands), so answering
        // earlier would report every skill `not_found`.
        await this.waitForInit()
        const name = message.payload.name
        this.emit({
          type: 'worker.skillBody',
          payload: {
            name,
            // No bound session (init failed) → the invoked-store lookup for
            // '' simply misses; static bodies still resolve.
            result: resolveBundledSkillBody(
              name,
              this.boundSessionId ?? '',
              this.runtime?.options.templateType,
            ),
          },
        })
        return
      }

      case 'worker.bridgeResponse':
        this.bridgeTransport.settleReply(message.payload)
        return

      case 'worker.cancelAutoTitle':
        // A manual rename (sidebar `session.rename`) supersedes the pending
        // AI title — abort the in-flight fast-model call so it doesn't land
        // and race the user's choice. No-op when nothing is in flight.
        this.runtime?.engine.cancelAutoTitleGeneration()
        return

      case 'worker.updateSessionMetadata': {
        await this.runWithRuntime(
          async runtime => {
            const merged =
              await runtime.conversationStore.updateSessionMetadata(
                message.payload.metadata,
              )
            this.emit({
              type: 'worker.metadataUpdated',
              payload: {
                metadata: merged,
                updatedAt: Date.now(),
              },
            })
          },
          { onMissing: 'ignore' },
        )
        return
      }
    }
  }

  /**
   * Await an in-flight `worker.init` if one is running, swallowing any
   * rejection so the caller falls through to its existing
   * `if (!this.runtime)` guard rather than throwing out of the message
   * dispatch. Idempotent: once init has resolved this is a single
   * already-resolved-promise microtask.
   */
  private async waitForInit(): Promise<void> {
    if (!this.initPromise) return
    try {
      await this.initPromise
    } catch {
      // init failed — let the caller see `this.runtime === null` and
      // emit the existing `worker_not_initialized` error.
    }
  }

  /**
   * Shared guard for protocol operations that require a live runtime.
   * Returning false from the operation suppresses the optional state emit
   * (used when the operation reports its own validation error).
   */
  private async runWithRuntime(
    operation: (
      runtime: AgentRuntimeState,
    ) => void | false | Promise<void | false>,
    options: {
      emitStateAfter?: boolean
      onMissing?: 'error' | 'ignore'
    } = {},
  ): Promise<void> {
    await this.waitForInit()
    const runtime = this.runtime
    if (!runtime) {
      if (options.onMissing !== 'ignore') {
        this.emitError(
          'worker_not_initialized',
          'Worker has not been initialized.',
        )
      }
      return
    }
    const result = await operation(runtime)
    if (options.emitStateAfter && result !== false) {
      this.emit({ type: 'worker.state', payload: this.getSnapshot() })
    }
  }

  /**
   * Apply the page-computed debug gates from an init payload, on first boot and when the worker is
   * REUSED across a page reload. One flag drives all worker-realm collection (payload capture, tracer
   * span ring, the log ring's `'tracer'` source): debug off means zero work and memory.
   */
  applyDiagnosticGates(payload: AgentRuntimeWorkerInitPayload): void {
    this.diagnostics.apply(payload, this.runtimeScope)
  }

  private async runInit(
    payload: AgentRuntimeWorkerInitPayload,
    scope: RuntimeScope,
  ): Promise<void> {
    // NOTE: forceReinit preflight is handled in the 'worker.init' case
    // BEFORE dispose. By the time we reach here, the check has
    // already passed or the init was rejected.
    this.diagnostics.apply(payload, scope)
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
    const scopedBridgeTransport = this.bridgeTransport.bindGeneration(
      scope.generation,
    )
    const conversationStorageBackend = resolveStorageBackend(
      payload,
      scopedBridgeTransport,
      this.injectedStorageBackend,
    )

    // Start the English catalog load now, unawaited: the worker composes the
    // model-facing text of slash output from it, but nothing in runtime
    // construction needs it, and blocking init on a network fetch would delay
    // every session for a string table only the first slash command reads.
    // The dispatcher awaits `whenEnCatalogReady()` at its own entry point.
    primeEnCatalog(payload.enCatalogUrl)

    // Resume restore (the "always shows workspace after restart" fix) — read
    // the bound folder from this session's persisted summary, AWAITED, before
    // createAgentRuntime. See resolveResumeProjectRoot.
    const effectivePayload = await resolveResumeProjectRoot(
      payload,
      conversationStorageBackend,
    )

    // Generation guard BEFORE the expensive runtime build: the
    // await above can lose the race to a newer init, and the first guard used
    // to sit AFTER createAgentRuntime — a stale init built a full runtime
    // (engine boot, storage, model init) just to dispose it. Bail now; the
    // newer scope owns the worker.
    if (!this.isCurrentScope(scope)) {
      return
    }

    const traceLogger =
      payload.hostMode === 'nexus'
        ? (entry: TraceLoggerEntry) => {
            this.emit({
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
        if (!this.isCurrentScope(scope)) return
        this.host?.broadcastBootStage(stage, sessionId)
      },
    )
    // Use a LOCAL variable for the created runtime. Only assign to
    // this.runtime AFTER the scope guard passes — a stale init must never
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
          ? info => this.publishProvisionalBoot(scope, info)
          : undefined,
        // Mid-turn task-notification drain. Scope-guarded: a
        // superseded build's runtime must not consume the live session's
        // pending results.
        drainTaskNotifications: this.host?.drainMidTurnTaskNotifications
          ? (sessionId, opts) =>
              this.isCurrentScope(scope)
                ? (this.host?.drainMidTurnTaskNotifications?.(sessionId, opts) ?? null)
                : null
          : undefined,
        // Mid-turn team frames (teammate or lead). Scope-guarded like the
        // notification drain: a superseded build must not consume them.
        drainTeamMessages: this.host?.drainMidTurnTeamMessages
          ? sessionId =>
              this.isCurrentScope(scope)
                ? (this.host?.drainMidTurnTeamMessages?.(sessionId) ?? [])
                : []
          : undefined,
        // Mid-turn user input (plain Enter while busy): the inject queue lives
        // in this worker's own turn controller, so no host hop. Scope-guarded
        // like the notification drain.
        drainInjectMessages: () =>
          this.isCurrentScope(scope) ? this.turns.drainInjectEntries() : [],
        // The read-only half of the same queue, for the Sleep tool's wake.
        hasPendingInjectMessages: () =>
          this.isCurrentScope(scope) && this.turns.hasInjectEntries(),
        // A plugin's `$.prompt.submit` (F-25): a turn of its own on this
        // worker's queue. The interactive session only: a headless or
        // sub-agent build has no person to see it. Scope-guarded.
        // `$.prompt.read` / `.fill` / `.suggest` (F-25): the page's
        // prompt box, which the interactive session alone draws.
        drawsComposer: isPrimarySessionBuild,
        // `$.config.set` wrote a plugin's option: every session's plugins
        // reload with it, as after the Settings form's save.
        ...(this.host?.reloadPluginsOnAllSessions
          ? { reloadPluginsOnAllSessions: () => this.host!.reloadPluginsOnAllSessions!() }
          : {}),
        enqueuePluginTurn: isPrimarySessionBuild
          ? turn => {
              if (!this.isCurrentScope(scope)) return
              this.turns.enqueuePluginTurn(
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

    // Generation guard: if a newer init was started while we were awaiting
    // createAgentRuntime, discard this result and let the newer scope win.
    // The stale runtime is disposed via its LOCAL reference — this.runtime
    // is never touched, so a newer scope's runtime stays intact.
    if (!this.isCurrentScope(scope)) {
      try {
        await (createdRuntime.engine as { dispose?: () => Promise<void> })?.dispose?.()
      } catch {
        // best-effort
      }
      return
    }

    // Scope is still current — install the runtime atomically. `this.runtime`
    // derives from the scope, so this single write installs it.
    scope.runtime = createdRuntime
    // The runtime is the snapshot source from here on; drop the provisional
    // feed (and its retained transcript copy).
    this.provisionalBoot = null
    scope.permissions.bindRuntime(createdRuntime)
    scope.transcript.bindRuntime(createdRuntime)
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
          if (!this.isCurrentScope(scope)) return
          this.emit({ type: 'worker.state', payload: this.getSnapshot() })
        }),
      )
    }
    // F-25: a plugin's `$.session.compact` / `.append` changes the
    // conversation outside the stream this worker mirrors to the page. Mid
    // submission (a mod's command), the whole transcript goes out when the
    // submission ends; otherwise (a timer, `session.start`) at once.
    createdRuntime.engine.setConversationRewrittenListener?.(() => {
      if (!this.isCurrentScope(scope)) return
      if (this.executingTurn) {
        this.transcriptRewrittenInTurn = true
        return
      }
      void this.emitWholeTranscript()
    })
    runtimeSpan.end({
      messageCount: createdRuntime.engine.transcriptRows().length ?? 0,
    })

    // File-snapshot crash recovery: a crash/kill mid-turn leaves that turn's
    // rows unfinalized; the disk was not touched since (the session was not
    // running), so finalizing lazily HERE is still correct. Cheap no-op for
    // sessions with no snapshot DB (a stat probe); fire-and-forget so boot
    // never blocks on it.
    void createdRuntime.fileSnapshotRecorder?.recoverUnfinalized().catch(() => {
      // best-effort — the next turn end retries the same finalize
    })

    // Cache-usage totals are derived from a full transcript walk in
    // getSnapshot() on every snapshot emission — no load-time seed needed.

    // A re-bind (forceReinit) reuses this worker, so `projectBranch` may still
    // hold the PREVIOUS folder's branch. Now that a fresh runtime (new
    // projectRoot) exists, clear it so the worker.ready snapshot starts clean
    // and refreshProjectBranch re-resolves for the new folder. refreshProjectBranch
    // only ever SETS a truthy branch (never re-clears here), so a transient
    // resolve failure on a later reload can't wipe an already-shown branch.
    this.projectBranch = undefined

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
    const appliedImmediately = await scope.models.applyImmediateSelection(payload)
    phase1Span.end({ applied: appliedImmediately })

    // Scope guard: if superseded during model selection, bail out.
    if (!this.isCurrentScope(scope)) return

    // Per-await scope guards: each of these steps parks on
    // storage I/O, and a forceReinit landing mid-await supersedes this scope.
    // Bailing between steps stops a stale scope from racing the successor's
    // identical restore work — and, critically, from reaching the host bind
    // below, which would overwrite the Manager's conversation-store binding
    // with the STALE scope's store.
    await scope.permissions.applyPersistedMode()
    if (!this.isCurrentScope(scope)) return
    // Load the bypass-warning acknowledgment flag (F-13) so the first switch
    // into bypassPermissions this session knows whether to warn. Best-effort.
    await scope.permissions.loadSkipDangerousMode()
    if (!this.isCurrentScope(scope)) return
    await scope.recovery.copyForkedPlanIfNeeded()
    if (!this.isCurrentScope(scope)) return
    await scope.recovery.restorePendingPlanApproval()
    if (!this.isCurrentScope(scope)) return

    // Terminal state restore + interrupted-turn detection (Continue button).
    await scope.recovery.restoreTerminalState()
    if (!this.isCurrentScope(scope)) return

    // Record this build's effective template/folder for the ready result
    // the Manager commits pointers and `lastInitTemplate`
    // from the same final truth the runtime and bind metadata use.
    scope.effectiveInit = {
      templateType: effectivePayload.templateType,
      projectRoot: effectivePayload.projectRoot,
    }
    const boundSessionId = createdRuntime.engine.boundSessionId()
    if (boundSessionId) {
      this.boundSessionId = boundSessionId
      if (this.host) {
        // Ready is a COMMIT BARRIER: the bind is AWAITED (worker.ready must
        // not race the host's critical metadata write) and carries the
        // EFFECTIVE build's template/folder. `false` = the durable write did
        // not land; void/true (legacy hosts, mocks) counts as persisted; a
        // throw is contained as not-persisted (P-1).
        try {
          const persisted = await this.host.bindSessionRuntime(
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
        if (!this.isCurrentScope(scope)) return
      }
    }

    // Scope guard: if superseded during metadata/plan/bind steps, bail
    // before emitting worker.ready — a stale ready would confuse the UI.
    if (!this.isCurrentScope(scope)) return

    // worker.ready.send — see comment above. With the Phase 1/2
    // split this fires *before* the catalog fetch, so the UI
    // unblocks ~2 s sooner on cold boot.
    const sendSpan = tracer.span('worker.ready.send', {
      traceId: initSpan.traceId,
      parentSpanId: initSpan.spanId,
      attrs: { sessionId: payload.sessionId },
    })
    const snapshot = this.getSnapshot()
    this.emit({
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
      () => !this.isCurrentScope(scope),
    )
    initSpan.end()
  }

  /**
   * Resolve the project folder's git branch and push a state update when it changed (no-op for
   * non-code / sandbox sessions). A transport failure keeps the branch; a shell that answered "no
   * branch" clears it. Returns whether the question is settled (`false` = no shell ran).
   */
  private async refreshProjectBranch(scope: RuntimeScope): Promise<boolean> {
    const runtime = this.runtime
    if (!runtime) return true
    // Every type that BINDS a real folder gets the branch chip — the same set
    // `isForcedFolderTemplateType` drives the folder picker with (code,
    // safe_code, review). Keying on the literal `'code'` here left the other
    // folder-bound types picking a repository and never showing its branch.
    if (
      !isForcedFolderTemplateType(runtime.options.templateType) ||
      runtime.usedSandboxProjectRoot
    ) {
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
    // Scope is mandatory — the optional param let a caller
    // omit it and silently skip this guard.
    if (!this.isCurrentScope(scope)) return true
    // A real branch always wins. `undefined` only wins when a shell actually
    // answered — that is a SETTLED "this folder has no branch" (detached HEAD,
    // or not a repo) and must clear the stale name. When nothing answered, the
    // resolve failed in transport and the last known branch stays put.
    const resolved = branch ?? (shellResponded ? undefined : this.projectBranch)
    if (resolved !== this.projectBranch) {
      this.projectBranch = resolved
      this.emit({ type: 'worker.state', payload: this.getSnapshot() })
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
      if (!this.isCurrentScope(scope)) return
    }
  }

  /**
   * Puts the physical transcript line back on each message, looked up by uuid in THIS session's
   * conversation store (never the process-global slot, which may belong to another session).
   */
  private async withTranscriptLines(
    messages: readonly Message[],
    store: unknown,
  ): Promise<Message[]> {
    const lines =
      store && typeof store === 'object' && 'getTranscriptLinesByUuid' in store
        ? await (
            store as {
              getTranscriptLinesByUuid(): Promise<Record<string, number>>
            }
          ).getTranscriptLinesByUuid()
        : {}
    return messages.map(message => {
      const uuid = (message as { uuid?: string }).uuid
      const line = uuid === undefined ? undefined : lines[uuid]
      return line === undefined
        ? message
        : ({ ...message, transcriptLine: line } as Message)
    })
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
      conversationStore?: unknown
    },
  ): void {
    // A superseded build must not publish into the successor's UI.
    if (!this.isCurrentScope(scope)) return
    const messages = info.messages.map(sanitizeMessageForUi)
    this.provisionalBoot = {
      snapshot: {
        sessionId: info.sessionId,
        cwd: info.cwd,
        projectRoot: info.projectRoot,
        usedSandboxProjectRoot: info.usedSandboxProjectRoot,
        hostMode: info.hostMode,
        messageCount: messages.length,
      },
      messages,
    }
    this.emit({ type: 'worker.uiReady', payload: this.getSnapshot() })
    // Emit ONCE, with the transcript lines already attached — never a
    // sync unstamped copy followed by an async stamped one. A double emit
    // renders rows without line ranges first, and if the stamped copy
    // lost the race (or shipped unstamped) a search jump could find no
    // range at all. `.catch` falls back to the unstamped list so a
    // stamping failure still delivers messages.
    void this.withTranscriptLines(messages, info.conversationStore)
      .catch(() => messages)
      .then(stamped => {
        if (!this.isCurrentScope(scope)) return
        this.emit({ type: 'worker.messages', payload: { messages: stamped } })
      })
  }

  /**
   * The provisional boot feed for a port that attached mid-build (the
   * Manager's reuse path), so it can be replayed the `worker.uiReady` +
   * `worker.messages` pair broadcast before it subscribed. Null once the
   * runtime is installed (the real `worker.ready` flow covers reattach).
   */
  getProvisionalBootFeed(): {
    snapshot: AgentRuntimeWorkerSnapshot
    messages: Message[]
  } | null {
    if (this.runtime || !this.provisionalBoot) return null
    return {
      snapshot: this.getSnapshot(),
      messages: this.provisionalBoot.messages,
    }
  }

  getSnapshot(): AgentRuntimeWorkerSnapshot {
    return buildWorkerSnapshot({
      runtime: this.runtime,
      provisional: this.provisionalBoot?.snapshot ?? null,
      projectBranch: this.projectBranch,
      modelCatalog: this.scopeModels.getCatalog(),
      skipDangerousModePermissionPrompt:
        this.scopePermissions.getSkipDangerousMode(),
      lastTerminalReason: this.scopeRecovery.getTerminalReason(),
      lastTerminalTimestamp: this.scopeRecovery.getTerminalTimestamp(),
      isBusy: this.isBusy(),
      isStopping: this.isStopping(),
      pendingBridgeRequestIds: this.bridgeTransport.getPendingRequestIds(),
      injectMessages: this.turns.getInjectMessageViews(),
      nextMessages: this.turns.getNextMessageTexts(),
      autoCompactSaveError: this.autoCompactSaveError,
    })
  }

  /**
   * The process-global singletons THIS worker's runtime installed (fs, conversation store, sidechain
   * store), snapshotted by the Manager on `worker.ready`. Undefined before build and after dispose.
   */
  getRuntimeGlobals(): OwnerRuntimeGlobals | undefined {
    const runtime = this.runtime
    if (!runtime) return undefined
    return {
      fs: runtime.installedFs,
      conversationStore: runtime.conversationStore,
      sidechainStore: runtime.installedSidechainStore,
    }
  }

  private scheduleActorStopForInterrupt(): void {
    notifyUserInterrupt(this.runtime)
  }

  async fireSessionDeletedStop(): Promise<void> {
    return notifySessionDeleted(this.runtime)
  }

  /** The session's `Notification` hooks (F-7), for a notification the
   *  manager is publishing about it. Nothing before the runtime exists. */
  async fireNotificationHooks(notification: HookNotification): Promise<void> {
    await this.runtime?.engine.runNotificationHooks(notification)
  }

  // --- Phase overlay + public queries (delegated to AgentTurnController) ---

  /** The last assistant text in this session's transcript, or '' when there
   *  is none. The teammate turn-end report reads it: a locked-down child
   *  has no SendMessage, so this is its only upward channel. */
  getFinalAssistantText(): string {
    const runtime = this.runtime
    if (!runtime) return ''
    return extractFinalAssistantText(runtime.engine.transcriptRows())
  }

  /** The uuid of the message `getFinalAssistantText` reads — see
   *  `AgentRuntimeWorkerHandle.getFinalAssistantMessageUuid`. */
  getFinalAssistantMessageUuid(): string | undefined {
    const runtime = this.runtime
    if (!runtime) return undefined
    return extractFinalAssistantMessage(runtime.engine.transcriptRows())?.uuid
  }

  /** Whether the session is executing a turn (streaming, tools, or retry). */
  isBusy(): boolean {
    return this.turns.isBusy()
  }

  /** Whether an interrupt has been requested for the current turn. */
  isStopping(): boolean {
    return this.turns.isStopping()
  }

  /** Full phase for Manager's broadcast/snapshot needs. */
  getPhase(): AgentSessionPhase {
    return this.turns.getPhase()
  }

  markStreamStart(): void {
    this.turns.markStreamStart()
  }

  markStreamEnd(): void {
    this.turns.markStreamEnd()
  }

  markStreamEndWithBoundary(): boolean {
    return this.turns.markStreamEndWithBoundary()
  }

  markToolStart(
    name: string,
    kind: AgentToolKind,
    actionType?: string,
  ): void {
    this.turns.markToolStart(name, kind, actionType)
  }

  markToolEnd(): AgentToolEndTransition['ended'] {
    return this.turns.markToolEnd()
  }

  markToolEndWithBoundary(): AgentToolEndTransition {
    return this.turns.markToolEndWithBoundary()
  }

  // --- Submit queue + pending message (delegated to AgentTurnController) ---

  private handleSubmitMessage(
    message: Extract<AgentWorkerInboundMessage, { type: 'worker.submitMessage' }>,
  ): void {
    this.turns.submitUserMessage(message)
  }

  enqueueSubmit(
    message: AgentWorkerInboundMessage,
    priority: number,
  ): void {
    this.turns.enqueueExternalTurn(
      message as Extract<AgentWorkerInboundMessage, { type: 'worker.submitMessage' }>,
      priority === 1 ? 'mailbox' : 'task_delivery',
    )
  }

  pumpSubmits(): void {
    this.turns.pumpSubmits()
  }

  consumePendingAsNextSubmit(): void {
    this.turns.consumePendingAsNextSubmit()
  }

  private async executeSubmit(
    message: Extract<AgentWorkerInboundMessage, { type: 'worker.submitMessage' }>,
    source: import('./AgentTurnController').QueuedTurn['source'] = 'user',
    plugin?: import('../../mods/promptNouns').PluginPromptTurn,
  ): Promise<import('./AgentTurnController').AgentTurnResult> {
    await this.waitForInit()
    if (!this.runtime) {
      this.emitError('worker_not_initialized', 'Worker has not been initialized.')
      // Pre-engine exit: normalize the dequeue-time busy phase (
      // the engine try's finally below never runs for this return).
      this.normalizeTurnEndPhase()
      return {
        status: 'failed',
        code: 'worker_not_initialized',
        message: 'Worker has not been initialized.',
      }
    }
    // The turn controller marks the phase busy AT DEQUEUE now, so
    // "phase is running" is true for our own turn and can't serve as the
    // overlap guard anymore. Overlap is structurally prevented by the submit
    // queue (one onTurnReady at a time via `submitting`); this flag is the
    // defensive backstop against a hypothetical direct executeSubmit call.
    if (this.executingTurn) {
      this.emitError('worker_busy', 'Worker is already processing a request.')
      return {
        status: 'failed',
        code: 'worker_busy',
        message: 'Worker is already processing a request.',
      }
    }
    const turnScope = this.runtimeScope
    this.executingTurn = true
    // Arm the recursion guard for the whole turn when this submit is a cron
    // routine firing into an existing session. Paired with the
    // `endRoutineFireTurn` in the SAME finally that clears `executingTurn`,
    // so no throw or abort path can leave the marker set — a stuck marker
    // would permanently disable CronCreate for this session. Removing
    // either half is a real defect: see routineTurnScope.ts.
    const routineFireSessionId =
      this.boundSessionId ?? this.runtime?.engine.boundSessionId() ?? null
    if (message.payload.routineFireId) {
      if (!routineFireSessionId) {
        // The marker is keyed by session id and the tools look it up the
        // same way, so with no id there is no way to arm the guard — the
        // fired prompt would run with BOTH arms of routineRecursionDenial
        // missing and could register more routines. Refuse the turn rather
        // than run it ungated: a routine fire is never urgent, and the
        // scheduler simply retries at the next slot.
        this.emit({
          type: 'worker.debugLog',
          payload: {
            level: 'warn',
            message: `routine fire ${message.payload.routineFireId} rejected: session id unresolved, cannot arm the recursion guard`,
          },
        })
        this.executingTurn = false
        this.normalizeTurnEndPhase()
        return {
          status: 'failed',
          code: 'worker_not_initialized',
          message:
            'Routine fire rejected: the worker has no bound session id, so the routine recursion guard cannot be armed.',
        }
      }
      beginRoutineFireTurn(routineFireSessionId, message.payload.routineFireId)
    }

    /** The conversation epoch the turn started on; `null` once the page has
     *  been sent the transcript as it stands (or before it was read). */
    let conversationEpochAtStart: number | undefined | null = null
    try {
      // Phase-2 catch-up: bounded grace window for catalog fetch so the first
      // turn goes out on the catalog-resolved model. Bounded because the fetch
      // can hang under some host/transport conditions. Inside the try:
      // everything after `executingTurn = true` must reach the finally
      // that clears it — a rejection escaping here would wedge every later
      // turn on the worker_busy guard. The `.catch` keeps the turn itself
      // alive too: a failed background reconcile means "proceed on the
      // Phase-1/fallback selection", not "fail the turn".
      const modelInitPromise = this.scopeModels.getInitPromise()
      if (!this.scopeModels.getHasEngineSelection() && modelInitPromise) {
        await Promise.race([
          modelInitPromise.catch(() => {}),
          new Promise<void>((resolve) =>
            setTimeout(resolve, MODEL_INIT_SUBMIT_GRACE_MS),
          ),
        ])
      }

      if (this.turns.isStopping()) {
        return { status: 'aborted', reason: 'user_interrupted' }
      }
      this.turns.setPhase({ kind: 'running', sub: { type: 'streaming' } })
      if (message.payload.toolCallDetail) {
        await this.runtime.conversationStore.saveToolCallDetail(
          message.payload.toolCallDetail,
        )
      }
      // A tool-result submit answers a halt: clear the pending flag and push a snapshot BEFORE the
      // stream opens (app-state writes emit nothing). Idempotent with the engine-side clear.
      if (submitCarriesToolResult(message.payload.prompt)) {
        const engine = this.runtime.engine
        for (const id of toolResultIdsInPrompt(message.payload.prompt)) {
          engine.clearPendingPermission(id)
          engine.clearPendingPlanApproval(id)
          engine.clearPendingUserInteraction(id)
        }
        this.emit({ type: 'worker.state', payload: this.getSnapshot() })
      } else if (
        !isHaltSafeSlashCommandPrompt(message.payload.prompt) &&
        this.haltedOnUser()
      ) {
        // A model turn that is not the answer starts over a halt: both halt records go. A halt-safe
        // built-in (`/status`, `/cost`) touches no open call.
        this.runtime.engine.clearPendingUserInteraction()
        this.runtime.engine.clearPendingPlanApproval()
        this.emit({ type: 'worker.state', payload: this.getSnapshot() })
      }
      let sawTranscriptRewrite = false
      // Set when the agent asks to run a shell command that can move the
      // project folder's HEAD (`git checkout` and friends). Only LATCHED here:
      // the stream carries the tool-use REQUEST, so the command has not run
      // yet and re-resolving now would read the pre-switch branch. The resolve
      // happens once the stream drains, below.
      let sawGitHeadMove = false
      let lastStreamedPermissionMode =
        this.runtime.engine.getCurrentPermissionMode?.()
      conversationEpochAtStart = this.runtime.engine.getConversationEpoch?.()
      for await (const event of this.runtime.engine.submitTurn(
        message.payload.prompt,
        {
          uuid: message.payload.promptUuid,
          isMeta: message.payload.isMeta,
          // From the queue source, not the payload: a client cannot forge a
          // mailbox turn. The transcript renders the team-message card only
          // for a marked turn (see UserMessage.origin).
          ...(source === 'mailbox' ? { origin: 'mailbox' as const } : {}),
          // `session.receive` (F-25): which delivery this turn is, from the
          // queue source alone.
          ...(source === 'mailbox'
            ? { delivery: 'peer' as const }
            : source === 'task_delivery'
              ? { delivery: 'task-notification' as const }
              : {}),
          // A plugin's prompt (F-25), from the queue alone.
          ...(source === 'plugin' && plugin ? { plugin } : {}),
        },
      )) {
        if (
          (event as { type?: unknown }).type === MSG_TYPE_SYSTEM &&
          (event as { subtype?: unknown }).subtype ===
            SYSTEM_SUBTYPE_COMPACT_BOUNDARY
        ) {
          sawTranscriptRewrite = true
        }
        if (!sawGitHeadMove && streamEventMovesGitHead(event)) {
          sawGitHeadMove = true
        }
        const retryInfo = parseApiErrorRetryEvent(event)
        if (retryInfo) {
          this.turns.beginRetry(retryInfo)
        } else {
          // Any non-retry stream event while the phase is `retry` means the
          // provider recovered and the new attempt is producing output —
          // flip back to streaming. No-op outside retry, so this
          // costs one phase check per event.
          this.turns.resumeFromRetry()
        }
        await this.scopeTranscript.persistStreamDetails(event)
        this.emit({
          type: 'worker.stream',
          payload: {
            event: sanitizeSdkMessageForUi(event),
          },
        })
        const streamedPermissionMode =
          this.runtime.engine.getCurrentPermissionMode?.()
        if (streamedPermissionMode !== lastStreamedPermissionMode) {
          lastStreamedPermissionMode = streamedPermissionMode
          this.emit({ type: 'worker.state', payload: this.getSnapshot() })
        }
      }

      this.turns.finishStopping()
      // Clear retry phase on turn completion.
      this.turns.endRetry()
      // The agent moved HEAD during this turn and every tool call has now
      // returned, so the folder is settled — re-resolve the branch chip.
      // Fire-and-forget off the turn's critical path; `refreshProjectBranch`
      // pushes `worker.state` itself, and only when the branch actually
      // changed. Without this the chip kept the pre-checkout branch until some
      // unrelated user action sent `worker.getState`.
      if (sawGitHeadMove && this.runtimeScope) {
        void this.refreshProjectBranch(this.runtimeScope)
      }
      await this.scopePermissions.persistModeIfChanged()
      await this.scopeRecovery.refreshTerminalStateFromMetadata()
      // The stream has fully drained here, so a still-running
      // phase is stale bookkeeping (markStreamEnd skips the idle transition
      // while tools are in flight — an unbalanced markToolStart leaves it
      // stuck). Normalize BEFORE the emit so `worker.completed` never
      // reports a busy snapshot. Safe: the pump is blocked by `submitting`,
      // so no successor turn owns the phase yet.
      this.normalizeTurnEndPhase()
      this.emit({
        type: 'worker.completed',
        payload: {
          ...this.getSnapshot(),
          reason: 'submitMessage_complete',
        },
      })

      // `/clear` replaced the conversation. The stream only carried the new
      // rows, which the page appends under the old ones — send the whole
      // (now short) transcript so the cleared rows leave the page too.
      if (
        this.runtime &&
        this.runtime.engine.getConversationEpoch?.() !== conversationEpochAtStart
      ) {
        sawTranscriptRewrite = true
      }

      if ((sawTranscriptRewrite || this.transcriptRewrittenInTurn) && this.runtime) {
        this.transcriptRewrittenInTurn = false
        await this.emitWholeTranscript()
      }
      conversationEpochAtStart = null
      return { status: 'completed' }
    } catch (error) {
      const isAbort =
        this.turns.isStopping() ||
        turnScope?.abortController.signal.aborted === true
      if (isAbort) {
        this.turns.endRetry()
        return { status: 'aborted', reason: 'user_interrupted' }
      }
      const errorMessage = error instanceof Error ? error.message : 'Unknown worker error'
      this.emitError('worker_submit_failed', errorMessage)
      return { status: 'failed', code: 'worker_submit_failed', message: errorMessage }
    } finally {
      this.executingTurn = false
      // A failed or aborted submission still owes the page the rows a
      // plugin's call put in during it (see the listener in the init path) —
      // and, when it got as far as `/clear`, the conversation that replaced
      // the one the page still shows.
      const epochMoved =
        conversationEpochAtStart !== null &&
        this.runtime !== undefined &&
        this.runtime !== null &&
        this.runtime.engine.getConversationEpoch?.() !== conversationEpochAtStart
      if (this.transcriptRewrittenInTurn || epochMoved) {
        this.transcriptRewrittenInTurn = false
        void this.emitWholeTranscript()
      }
      // Unconditional: cheap Map.delete, and clearing a marker that was
      // never set is a no-op. Doing it unconditionally means a future edit
      // to the `begin` condition can't desynchronize the pair.
      if (routineFireSessionId) endRoutineFireTurn(routineFireSessionId)
      // Safety net: if markStreamEnd never fired (abnormal throw path),
      // force the phase back to idle so the session doesn't stay stuck busy.
      this.turns.finishStopping()
      // Every terminal path clears the retry countdown: the
      // completion and abort paths already call endRetry explicitly, but a
      // non-abort FAILURE while the phase was `retry` left the interval
      // ticking until its deadline self-clear.
      this.turns.endRetry()
      this.normalizeTurnEndPhase()
      // File snapshots: the turn is over on EVERY terminal path (completed,
      // aborted, failed), so stamp after-states for the files it touched.
      // Fire-and-forget — the recorder serializes internally and a
      // still-open turn is recovered on next session open, so a failure
      // here degrades to the crash-recovery path, never a stuck turn.
      const recorder = this.runtime?.fileSnapshotRecorder
      if (recorder) {
        void recorder
          .finalizeOpenTurns()
          .then(() => {
            // The after-states just landed — refresh the snapshot-backed
            // Diff-panel history so the finished turn's diff appears without
            // waiting for the next worker.getMessages round-trip.
            void this.scopeTranscript.emitTurnDiffHistory()
          })
          .catch(err => {
          this.emit({
            type: 'worker.debugLog',
            payload: {
              level: 'warn',
              message: `file-snapshot finalize failed: ${
                err instanceof Error ? err.message : String(err)
              }`,
            },
          })
        })
      } else {
        // The turn's edits are all persisted: the history computed now is the
        // one the session's change digest records.
        void this.scopeTranscript.emitTurnDiffHistory()
      }
    }
  }

  /** The whole transcript to the page, replacing its copy. Same stamping as
   *  `worker.getMessages` — the rewritten transcript replaces every row, so
   *  unstamped rows here would strip the line ranges the UI had. */
  private async emitWholeTranscript(): Promise<void> {
    const runtime = this.runtime
    if (!runtime) return
    this.emit({
      type: 'worker.messages',
      payload: {
        messages: await this.withTranscriptLines(
          runtime.engine.transcriptRows().map(sanitizeMessageForUi),
          runtime.conversationStore,
        ),
      },
    })
  }

  /**
   * Turn-end phase backstop for paths that never reach the engine's stream teardown; EMITS the
   * transition when it changed something. No-op when already idle.
   */
  private normalizeTurnEndPhase(): void {
    if (!this.turns.isBusy()) return
    this.turns.setPhase({ kind: 'idle' })
    this.emit({ type: 'worker.state', payload: this.getSnapshot() })
  }

  /**
   * A session left idle lets go of its tool payloads (the store's hydrated
   * messages and detail cache, the engine's copy) after
   * `IDLE_PAYLOAD_RELEASE_MS`. Every open session lives in this one
   * SharedWorker, and each held its whole tool output for as long as it
   * stayed open. The next turn reads it back from disk in a few batched calls
   * (tens of ms). Armed when a turn settles, cancelled when one starts.
   */
  private scheduleIdlePayloadRelease(): void {
    this.cancelIdlePayloadRelease()
    // Bound to the scope whose turn armed it: a runtime rebuilt in the
    // meantime has not been idle that long, and has just read its payloads.
    const scope = this.runtimeScope
    this.idleReleaseTimer = setTimeout(() => {
      this.idleReleaseTimer = null
      if (this.runtimeScope !== scope) return
      this.releaseIdlePayloads()
    }, IDLE_PAYLOAD_RELEASE_MS)
  }

  private cancelIdlePayloadRelease(): void {
    if (this.idleReleaseTimer !== null) {
      clearTimeout(this.idleReleaseTimer)
      this.idleReleaseTimer = null
    }
  }

  /** Synchronous, so no turn can start halfway through it. */
  private releaseIdlePayloads(): void {
    const runtime = this.runtime
    if (!runtime || this.turns.isBusy()) return
    const store = runtime.conversationStore as Partial<{
      releaseToolPayloads(): boolean
      isRecordedMessage(uuid: string): boolean
    }>
    if (typeof store.releaseToolPayloads !== 'function' || typeof store.isRecordedMessage !== 'function') {
      return
    }
    if (!store.releaseToolPayloads()) return
    // The engine's copy only once the store has every message in it: a fork's
    // seed lives in the engine alone until its first turn records it.
    const engine = runtime.engine as Partial<{
      getMessages(): readonly Message[]
      releaseToolPayloads(): void
    }>
    const messages = engine.getMessages?.() ?? []
    const allRecorded = messages.every(message => {
      const uuid = (message as { uuid?: unknown }).uuid
      return typeof uuid === 'string' && store.isRecordedMessage!(uuid)
    })
    if (allRecorded) engine.releaseToolPayloads?.()
  }

  /**
   * Dispose the worker: tear down the current runtime scope, cancel pending
   * bridge requests, and clear all state. Called by the SessionCoordinator
   * when a session is deleted. Idempotent.
   */
  async dispose(): Promise<void> {
    this.unsubscribeModSlots()
    // Settle every queued/active submitAndWait as aborted BEFORE tearing the
    // scope down — a dangling completion would hang the
    // headless / sub-agent / teammate drive that awaits it (the teammate
    // idle loop permanently). Later submits resolve aborted immediately.
    this.turns.dispose()
    this.cancelIdlePayloadRelease()
    await this.disposeRuntimeScope('worker_disposed')
    this.bridgeTransport.dispose()
  }

  /**
   * Submit a message and wait for the turn to complete. Used by headless
   * routines, sub-agents, and teammates that need to await actual turn
   * completion (not just enqueue). Returns a result indicating whether the
   * turn completed, was aborted, or failed.
   */
  submitAndWait(
    message: Extract<AgentWorkerInboundMessage, { type: 'worker.submitMessage' }>,
    source: 'user' | 'mailbox' | 'task_delivery' = 'user',
  ): Promise<import('./AgentTurnController').AgentTurnResult> {
    return this.turns.submitAndWait(message, source)
  }

  private emitError(code: string, message: string): void {
    this.emit({
      type: 'worker.error',
      payload: {
        code,
        message,
      },
    })
  }
}
