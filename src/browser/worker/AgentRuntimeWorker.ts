import type { BrowserLlmSelection } from '../bridge/browserBridgeProtocol'
import { haltRecordsHaltOnUser } from '../../utils/sessionNeedsAnswer'
import type { HookNotification } from '../../lifecycleHooks/sessionLifecycleHooks'
import type { AgentRuntimeState } from '../runtime/AgentRuntimeState'
import { isSelectionEnabled, toEntrySelection } from './modelSelection'
import {
  extractFinalAssistantMessage,
  extractFinalAssistantText,
} from './taskProjection'
import { AgentWorkerBridgeTransport } from './AgentWorkerBridgeTransport'
import type {
  BrowserConversationStorageBackend,
  BrowserConversationStore,
} from '../../sessions/sessionStore'
import type { OwnerRuntimeGlobals } from './taskTypes'
import type { AgentRuntimeWorkerInitPayload } from './workerProtocol'
import { buildWorkerSnapshot } from './workerSnapshot'
import { isAutoCompactWindow } from '../../settings/modelSettings'
import { onModSlotsChanged } from '../../mods/modSlotRegistry'
import type { Message } from '../../runtime/RuntimeTypes'
import type {
  AgentWorkerInboundMessage,
  AgentWorkerOutboundMessage,
  AgentRuntimeInitResult,
  AgentRuntimeWorkerSnapshot,
} from './workerProtocol'
import { sanitizeMessageForUi } from '../../utils/toolCallDetails'
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
import { extractRuntimeSettingsNamespaces } from './agentRuntimeMessageParsing'
import {
  disposeScopeResources,
  type RuntimeScope,
} from './agentRuntimeScope'
import { AgentRuntimeDiagnostics } from './AgentRuntimeDiagnostics'
import {
  fireSessionDeletedStop as notifySessionDeleted,
  scheduleActorStopForInterrupt as notifyUserInterrupt,
} from './agentRuntimeStopNotifications'
import { resolveBundledSkillBody } from '../../skillLibrary/builtinSkillBody'
import { topbarCommandPrompt } from '../../mods/ui/topbarCommand'
import { isTeammateSessionId } from '../../utils/sidechainStoragePaths'
import {
  AgentRuntimeBoot,
  type AgentRuntimeBootHost,
  type ProvisionalBootState,
} from './AgentRuntimeBoot'
import { AgentTurnExecutor, type AgentTurnExecutorHost } from './AgentTurnExecutor'
import { withTranscriptLines } from './transcriptLineStamp'

/** How long a session sits idle before it lets go of its tool payloads. */
export const IDLE_PAYLOAD_RELEASE_MS = 5 * 60_000

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
  /** Turn start: the session's queued child reports as one block, taken
   *  once (F-36). Optional. */
  takeChildReports?(
    sessionId: string,
    opts: { autoContinuation: boolean },
  ): Promise<string | null>
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
  private provisionalBoot: ProvisionalBootState | null = null
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
  /**
   * Settles once the current scope can serve transcript reads: at its
   * provisional publish, or when its init settles (F-32). Never rejects.
   */
  private displayReadyPromise: Promise<void> | null = null
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

  /** Scope switching, the runtime build and the provisional publish. */
  private readonly boot = new AgentRuntimeBoot(this.makeBootHost())
  /** One dequeued submission through the engine. */
  private readonly submissions = new AgentTurnExecutor(this.makeExecutorHost())

  /** The seam AgentRuntimeBoot acts through; reassigned fields are accessors. */
  private makeBootHost(): AgentRuntimeBootHost {
    const worker = this
    return {
      emit: message => worker.emit(message),
      get bridgeTransport() { return worker.bridgeTransport },
      get diagnostics() { return worker.diagnostics },
      get injectedStorageBackend() { return worker.injectedStorageBackend },
      get host() { return worker.host },
      get turns() { return worker.turns },
      get runtime() { return worker.runtime },
      get executingTurn() { return worker.executingTurn },
      get runtimeScope() { return worker.runtimeScope },
      set runtimeScope(v) { worker.runtimeScope = v },
      get generation() { return worker.generation },
      set generation(v) { worker.generation = v },
      get provisionalBoot() { return worker.provisionalBoot },
      set provisionalBoot(v) { worker.provisionalBoot = v },
      get initPromise() { return worker.initPromise },
      set initPromise(v) { worker.initPromise = v },
      get displayReadyPromise() { return worker.displayReadyPromise },
      set displayReadyPromise(v) { worker.displayReadyPromise = v },
      get boundSessionId() { return worker.boundSessionId },
      set boundSessionId(v) { worker.boundSessionId = v },
      get projectBranch() { return worker.projectBranch },
      set projectBranch(v) { worker.projectBranch = v },
      get transcriptRewrittenInTurn() { return worker.transcriptRewrittenInTurn },
      set transcriptRewrittenInTurn(v) { worker.transcriptRewrittenInTurn = v },
      emitError: (code, message) => worker.emitError(code, message),
      getSnapshot: () => worker.getSnapshot(),
      isBusy: () => worker.isBusy(),
      isCurrentScope: scope => worker.isCurrentScope(scope),
      makeModelHost: generation => worker.makeModelHost(generation),
      makePermissionHost: () => worker.makePermissionHost(),
      disposeRuntimeScope: reason => worker.disposeRuntimeScope(reason),
      emitWholeTranscript: () => worker.emitWholeTranscript(),
    }
  }

  /** The seam AgentTurnExecutor acts through; reassigned fields are accessors. */
  private makeExecutorHost(): AgentTurnExecutorHost {
    const worker = this
    return {
      emit: message => worker.emit(message),
      get turns() { return worker.turns },
      get runtime() { return worker.runtime },
      get runtimeScope() { return worker.runtimeScope },
      get boundSessionId() { return worker.boundSessionId },
      get scopeModels() { return worker.scopeModels },
      get scopePermissions() { return worker.scopePermissions },
      get scopeRecovery() { return worker.scopeRecovery },
      get scopeTranscript() { return worker.scopeTranscript },
      get executingTurn() { return worker.executingTurn },
      set executingTurn(v) { worker.executingTurn = v },
      get transcriptRewrittenInTurn() { return worker.transcriptRewrittenInTurn },
      set transcriptRewrittenInTurn(v) { worker.transcriptRewrittenInTurn = v },
      emitError: (code, message) => worker.emitError(code, message),
      getSnapshot: () => worker.getSnapshot(),
      haltedOnUser: () => worker.haltedOnUser(),
      refreshProjectBranch: scope => worker.refreshProjectBranch(scope),
      waitForInit: () => worker.waitForInit(),
    }
  }

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

  /** Run (or re-run) the init flow; see `AgentRuntimeBoot.reinitialize`. */
  reinitialize(
    payload: AgentRuntimeWorkerInitPayload,
  ): Promise<AgentRuntimeInitResult> {
    return this.boot.reinitialize(payload)
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
        // Served from the early transcript read while the build is pending (F-32).
        await this.waitForDisplay()
        this.emit({
          type: 'worker.messages',
          payload: {
            messages: await withTranscriptLines(
              this.displayTranscriptRows().map(sanitizeMessageForUi),
              this.displayConversationStore(),
            ),
          },
        })
        // Bring the change history up to date AFTER the (boot-critical)
        // transcript emit — never blocks it; an opened session is served
        // from its stored digest when that still holds.
        void this.scopeTranscript.refreshTurnDiffHistory()
        return

      case 'worker.getMessagesSince': {
        await this.waitForDisplay()
        const allMessages = this.displayTranscriptRows()
        const sinceOrdinal = message.payload.sinceOrdinal
        // Stamped like the full read above: a delta row without its
        // transcript line is one a search jump cannot land on.
        const deltaMessages = await withTranscriptLines(
          allMessages.slice(sinceOrdinal).map(sanitizeMessageForUi),
          this.displayConversationStore(),
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
        // The transcript service is bound to the early transcript at the
        // provisional publish, so a visible tool call resolves before the build.
        await this.waitForDisplay()
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
        // Same display-tier read as getToolCallDetail above.
        await this.waitForDisplay()
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
        // need when the open was served from the stored digest. A display
        // read: served from the early transcript before the build (F-32).
        await this.waitForDisplay()
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
    // A newer init can replace the awaited one mid-flight (a project-folder
    // bind during boot); the superseded one settles with the newer scope still
    // building, so wait until the latest init is the one that settled.
    let awaited: Promise<void> | null = null
    while (this.initPromise && this.initPromise !== awaited) {
      awaited = this.initPromise
      try {
        await awaited
      } catch {
        // init failed — let the caller see `this.runtime === null` and
        // emit the existing `worker_not_initialized` error.
      }
    }
  }

  /**
   * Await the point where transcript reads can be served: the provisional
   * publish or the end of init. Never rejects; with neither, readers fall
   * back to an empty transcript.
   */
  private async waitForDisplay(): Promise<void> {
    if (this.runtime || this.provisionalBoot || !this.displayReadyPromise) return
    await this.displayReadyPromise
  }

  /** Transcript rows for the page: the engine's once built, else the early read. */
  private displayTranscriptRows(): readonly Message[] {
    if (this.runtime) return this.runtime.engine.transcriptRows()
    return this.provisionalBoot?.messages ?? []
  }

  private displayConversationStore(): BrowserConversationStore | undefined {
    return this.runtime?.conversationStore ?? this.provisionalBoot?.conversationStore
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

  /** See `AgentRuntimeBoot.refreshProjectBranch`. */
  private refreshProjectBranch(scope: RuntimeScope): Promise<boolean> {
    return this.boot.refreshProjectBranch(scope)
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
      messages: this.provisionalBoot.messages.map(sanitizeMessageForUi),
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

  /** Whether the message `getFinalAssistantText` reads is a model error. */
  finalAssistantIsError(): boolean {
    const rows = this.runtime?.engine.transcriptRows() ?? []
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const row = rows[i] as { type?: string; isApiErrorMessage?: boolean } | undefined
      if (row?.type === 'assistant') return row.isApiErrorMessage === true
    }
    return false
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
    const request = message.payload.pluginCommand
    if (!request) {
      this.turns.submitUserMessage(message)
      return
    }
    void this.waitForInit().then(() => {
      const runtime = this.runtime
      const prompt = runtime
        ? topbarCommandPrompt(request, {
            modCommands: runtime.engine.listModCommands?.() ?? [],
            promptCommands: runtime.options.commands ?? [],
          })
        : undefined
      if (prompt === undefined) {
        this.emitError('topbar_command_unknown', `The plugin ${request.plugin} offers no command ${request.command}.`)
        return
      }
      const { pluginCommand: _request, ...payload } = message.payload
      this.turns.submitUserMessage({ ...message, payload: { ...payload, prompt, displayPrompt: prompt, delivery: 'next' } })
    })
  }

  enqueueSubmit(
    message: AgentWorkerInboundMessage,
    priority: number,
    origin?: 'auto_continuation',
  ): void {
    this.turns.enqueueExternalTurn(
      message as Extract<AgentWorkerInboundMessage, { type: 'worker.submitMessage' }>,
      origin === 'auto_continuation' ? origin : priority === 1 ? 'mailbox' : 'task_delivery',
    )
  }

  pumpSubmits(): void {
    this.turns.pumpSubmits()
  }

  consumePendingAsNextSubmit(): void {
    this.turns.consumePendingAsNextSubmit()
  }

  /** See `AgentTurnExecutor.executeSubmit`. */
  private executeSubmit(
    message: Extract<AgentWorkerInboundMessage, { type: 'worker.submitMessage' }>,
    source: import('./AgentTurnController').QueuedTurn['source'] = 'user',
    plugin?: import('../../mods/promptNouns').PluginPromptTurn,
  ): Promise<import('./AgentTurnController').AgentTurnResult> {
    return this.submissions.executeSubmit(message, source, plugin)
  }

  /** See `AgentTurnExecutor.emitWholeTranscript`. */
  private emitWholeTranscript(): Promise<void> {
    return this.submissions.emitWholeTranscript()
  }

  /** See `AgentTurnExecutor.normalizeTurnEndPhase`. */
  private normalizeTurnEndPhase(): void {
    this.submissions.normalizeTurnEndPhase()
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
