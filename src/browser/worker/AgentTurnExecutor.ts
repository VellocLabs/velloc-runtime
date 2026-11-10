import {
  submitCarriesToolResult,
  toolResultIdsInPrompt,
} from '../../utils/sessionNeedsAnswer'
import { isHaltSafeSlashCommandPrompt } from '../../utils/slashCommandPrompt'
import type { AgentRuntimeState } from '../runtime/AgentRuntimeState'
import {
  MSG_TYPE_SYSTEM,
  SYSTEM_SUBTYPE_COMPACT_BOUNDARY,
} from '../../runtime/VercelModelConstants'
import { streamEventMovesGitHead } from '../../utils/branchSwitchDetect'
import type {
  AgentWorkerInboundMessage,
  AgentWorkerOutboundMessage,
  AgentRuntimeWorkerSnapshot,
} from './workerProtocol'
import {
  sanitizeMessageForUi,
  sanitizeSdkMessageForUi,
} from '../../utils/toolCallDetails'
import type { AgentTurnController } from './AgentTurnController'
import type { AgentModelController } from './AgentModelController'
import type { AgentPermissionCoordinator } from './AgentPermissionCoordinator'
import type { AgentRuntimeRecovery } from './AgentRuntimeRecovery'
import type { AgentTranscriptService } from './AgentTranscriptService'
import { parseApiErrorRetryEvent } from './agentRuntimeMessageParsing'
import type { RuntimeScope } from './agentRuntimeScope'
import { notifyTurnEnded } from './agentRuntimeStopNotifications'
import {
  beginRoutineFireTurn,
  endRoutineFireTurn,
} from '../../routines/routineTurnScope'
import { withTranscriptLines } from './transcriptLineStamp'

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
 * Contract: the worker state a submission reads and writes. The worker owns
 * every field; reassigned ones are accessors, so a submission always sees
 * the current value.
 */
export interface AgentTurnExecutorHost {
  readonly emit: (message: AgentWorkerOutboundMessage) => void
  readonly turns: AgentTurnController
  readonly runtime: AgentRuntimeState | null
  readonly runtimeScope: RuntimeScope | null
  readonly boundSessionId: string | null
  readonly scopeModels: AgentModelController
  readonly scopePermissions: AgentPermissionCoordinator
  readonly scopeRecovery: AgentRuntimeRecovery
  readonly scopeTranscript: AgentTranscriptService
  executingTurn: boolean
  transcriptRewrittenInTurn: boolean
  emitError(code: string, message: string): void
  getSnapshot(): AgentRuntimeWorkerSnapshot
  haltedOnUser(): boolean
  refreshProjectBranch(scope: RuntimeScope): Promise<boolean>
  waitForInit(): Promise<void>
}

/**
 * Contract: runs one dequeued submission through the engine and mirrors its
 * stream, phase and transcript to the page. Owns no state; every read and
 * write goes through its host, the owning `AgentRuntimeWorker`.
 */
export class AgentTurnExecutor {
  constructor(private readonly worker: AgentTurnExecutorHost) {}

  async executeSubmit(
    message: Extract<AgentWorkerInboundMessage, { type: 'worker.submitMessage' }>,
    source: import('./AgentTurnController').QueuedTurn['source'] = 'user',
    plugin?: import('../../mods/promptNouns').PluginPromptTurn,
  ): Promise<import('./AgentTurnController').AgentTurnResult> {
    await this.worker.waitForInit()
    if (!this.worker.runtime) {
      this.worker.emitError('worker_not_initialized', 'Worker has not been initialized.')
      // Pre-engine exit: normalize the dequeue-time busy phase (
      // the engine try's finally below never runs for this return).
      this.normalizeTurnEndPhase()
      return {
        status: 'failed',
        code: 'worker_not_initialized',
        message: 'Worker has not been initialized.',
      }
    }
    // The turn controller marks the phase busy AT DEQUEUE, so
    // "phase is running" is true for our own turn and can't serve as the
    // overlap guard. Overlap is structurally prevented by the submit
    // queue (one onTurnReady at a time via `submitting`); this flag is the
    // defensive backstop against a hypothetical direct executeSubmit call.
    if (this.worker.executingTurn) {
      this.worker.emitError('worker_busy', 'Worker is already processing a request.')
      return {
        status: 'failed',
        code: 'worker_busy',
        message: 'Worker is already processing a request.',
      }
    }
    const turnScope = this.worker.runtimeScope
    this.worker.executingTurn = true
    // Arm the recursion guard for the whole turn when this submit is a cron
    // routine firing into an existing session. Paired with the
    // `endRoutineFireTurn` in the SAME finally that clears `executingTurn`,
    // so no throw or abort path can leave the marker set — a stuck marker
    // would permanently disable CronCreate for this session. Removing
    // either half is a real defect: see routineTurnScope.ts.
    const routineFireSessionId =
      this.worker.boundSessionId ?? this.worker.runtime?.engine.boundSessionId() ?? null
    if (message.payload.routineFireId) {
      if (!routineFireSessionId) {
        // The marker is keyed by session id and the tools look it up the
        // same way, so with no id there is no way to arm the guard — the
        // fired prompt would run with BOTH arms of routineRecursionDenial
        // missing and could register more routines. Refuse the turn rather
        // than run it ungated: a routine fire is never urgent, and the
        // scheduler simply retries at the next slot.
        this.worker.emit({
          type: 'worker.debugLog',
          payload: {
            level: 'warn',
            message: `routine fire ${message.payload.routineFireId} rejected: session id unresolved, cannot arm the recursion guard`,
          },
        })
        this.worker.executingTurn = false
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
      const modelInitPromise = this.worker.scopeModels.getInitPromise()
      if (!this.worker.scopeModels.getHasEngineSelection() && modelInitPromise) {
        await Promise.race([
          modelInitPromise.catch(() => {}),
          new Promise<void>((resolve) =>
            setTimeout(resolve, MODEL_INIT_SUBMIT_GRACE_MS),
          ),
        ])
      }

      if (this.worker.turns.isStopping()) {
        return { status: 'aborted', reason: 'user_interrupted' }
      }
      this.worker.turns.setPhase({ kind: 'running', sub: { type: 'streaming' } })
      if (message.payload.toolCallDetail) {
        await this.worker.runtime.conversationStore.saveToolCallDetail(
          message.payload.toolCallDetail,
        )
      }
      // A tool-result submit answers a halt: clear the pending flag and push a snapshot BEFORE the
      // stream opens (app-state writes emit nothing). Idempotent with the engine-side clear.
      if (submitCarriesToolResult(message.payload.prompt)) {
        const engine = this.worker.runtime.engine
        for (const id of toolResultIdsInPrompt(message.payload.prompt)) {
          engine.clearPendingPermission(id)
          engine.clearPendingPlanApproval(id)
          engine.clearPendingUserInteraction(id)
        }
        this.worker.emit({ type: 'worker.state', payload: this.worker.getSnapshot() })
      } else if (
        !isHaltSafeSlashCommandPrompt(message.payload.prompt) &&
        this.worker.haltedOnUser()
      ) {
        // A model turn that is not the answer starts over a halt: both halt records go. A halt-safe
        // built-in (`/status`, `/cost`) touches no open call.
        this.worker.runtime.engine.clearPendingUserInteraction()
        this.worker.runtime.engine.clearPendingPlanApproval()
        this.worker.emit({ type: 'worker.state', payload: this.worker.getSnapshot() })
      }
      let sawTranscriptRewrite = false
      // Set when the agent asks to run a shell command that can move the
      // project folder's HEAD (`git checkout` and friends). Only LATCHED here:
      // the stream carries the tool-use REQUEST, so the command has not run
      // yet and re-resolving now would read the pre-switch branch. The resolve
      // happens once the stream drains, below.
      let sawGitHeadMove = false
      let lastStreamedPermissionMode =
        this.worker.runtime.engine.getCurrentPermissionMode?.()
      conversationEpochAtStart = this.worker.runtime.engine.getConversationEpoch?.()
      for await (const event of this.worker.runtime.engine.submitTurn(
        message.payload.prompt,
        {
          uuid: message.payload.promptUuid,
          isMeta: message.payload.isMeta,
          // From the queue source, not the payload: a client cannot forge a
          // mailbox turn. The transcript renders the team-message card only
          // for a marked turn (see UserMessage.origin).
          ...(source === 'mailbox' ? { origin: 'mailbox' as const } : {}),
          ...(source === 'auto_continuation' ? { origin: 'auto_continuation' as const } : {}),
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
          this.worker.turns.beginRetry(retryInfo)
        } else {
          // Any non-retry stream event while the phase is `retry` means the
          // provider recovered and the new attempt is producing output —
          // flip back to streaming. No-op outside retry, so this
          // costs one phase check per event.
          this.worker.turns.resumeFromRetry()
        }
        await this.worker.scopeTranscript.persistStreamDetails(event)
        this.worker.emit({
          type: 'worker.stream',
          payload: {
            event: sanitizeSdkMessageForUi(event),
          },
        })
        const streamedPermissionMode =
          this.worker.runtime.engine.getCurrentPermissionMode?.()
        if (streamedPermissionMode !== lastStreamedPermissionMode) {
          lastStreamedPermissionMode = streamedPermissionMode
          this.worker.emit({ type: 'worker.state', payload: this.worker.getSnapshot() })
        }
      }

      // A user Stop already told the host; any other ending releases the
      // turn's agent-tab holds here.
      if (!this.worker.turns.isStopping() && turnScope?.abortController.signal.aborted !== true) {
        notifyTurnEnded(this.worker.runtime)
      }
      this.worker.turns.finishStopping()
      // Clear retry phase on turn completion.
      this.worker.turns.endRetry()
      // The agent moved HEAD during this turn and every tool call has now
      // returned, so the folder is settled — re-resolve the branch chip.
      // Fire-and-forget off the turn's critical path; `refreshProjectBranch`
      // pushes `worker.state` itself, and only when the branch actually
      // changed. Without this the chip kept the pre-checkout branch until some
      // unrelated user action sent `worker.getState`.
      if (sawGitHeadMove && this.worker.runtimeScope) {
        void this.worker.refreshProjectBranch(this.worker.runtimeScope)
      }
      await this.worker.scopePermissions.persistModeIfChanged()
      await this.worker.scopeRecovery.refreshTerminalStateFromMetadata()
      // The stream has fully drained here, so a still-running
      // phase is stale bookkeeping (markStreamEnd skips the idle transition
      // while tools are in flight — an unbalanced markToolStart leaves it
      // stuck). Normalize BEFORE the emit so `worker.completed` never
      // reports a busy snapshot. Safe: the pump is blocked by `submitting`,
      // so no successor turn owns the phase yet.
      this.normalizeTurnEndPhase()
      this.worker.emit({
        type: 'worker.completed',
        payload: {
          ...this.worker.getSnapshot(),
          reason: 'submitMessage_complete',
        },
      })

      // `/clear` replaced the conversation. The stream only carried the new
      // rows, which the page appends under the old ones — send the whole
      // (now short) transcript so the cleared rows leave the page too.
      if (
        this.worker.runtime &&
        this.worker.runtime.engine.getConversationEpoch?.() !== conversationEpochAtStart
      ) {
        sawTranscriptRewrite = true
      }

      if ((sawTranscriptRewrite || this.worker.transcriptRewrittenInTurn) && this.worker.runtime) {
        this.worker.transcriptRewrittenInTurn = false
        await this.emitWholeTranscript()
      }
      conversationEpochAtStart = null
      return { status: 'completed' }
    } catch (error) {
      const isAbort =
        this.worker.turns.isStopping() ||
        turnScope?.abortController.signal.aborted === true
      if (isAbort) {
        this.worker.turns.endRetry()
        return { status: 'aborted', reason: 'user_interrupted' }
      }
      notifyTurnEnded(this.worker.runtime ?? null)
      const errorMessage = error instanceof Error ? error.message : 'Unknown worker error'
      this.worker.emitError('worker_submit_failed', errorMessage)
      return { status: 'failed', code: 'worker_submit_failed', message: errorMessage }
    } finally {
      this.worker.executingTurn = false
      // A failed or aborted submission still owes the page the rows a
      // plugin's call put in during it (see the listener in the init path) —
      // and, when it got as far as `/clear`, the conversation that replaced
      // the one the page still shows.
      const epochMoved =
        conversationEpochAtStart !== null &&
        this.worker.runtime !== undefined &&
        this.worker.runtime !== null &&
        this.worker.runtime.engine.getConversationEpoch?.() !== conversationEpochAtStart
      if (this.worker.transcriptRewrittenInTurn || epochMoved) {
        this.worker.transcriptRewrittenInTurn = false
        void this.emitWholeTranscript()
      }
      // Unconditional: cheap Map.delete, and clearing a marker that was
      // never set is a no-op. Doing it unconditionally means a future edit
      // to the `begin` condition can't desynchronize the pair.
      if (routineFireSessionId) endRoutineFireTurn(routineFireSessionId)
      // Safety net: if markStreamEnd never fired (abnormal throw path),
      // force the phase back to idle so the session doesn't stay stuck busy.
      this.worker.turns.finishStopping()
      // Every terminal path clears the retry countdown: the
      // completion and abort paths call endRetry explicitly, and a
      // non-abort FAILURE while the phase is `retry` would otherwise leave
      // the interval ticking until its deadline self-clear.
      this.worker.turns.endRetry()
      this.normalizeTurnEndPhase()
      // File snapshots: the turn is over on EVERY terminal path (completed,
      // aborted, failed), so stamp after-states for the files it touched.
      // Fire-and-forget — the recorder serializes internally and a
      // still-open turn is recovered on next session open, so a failure
      // here degrades to the crash-recovery path, never a stuck turn.
      const recorder = this.worker.runtime?.fileSnapshotRecorder
      if (recorder) {
        void recorder
          .finalizeOpenTurns()
          .then(() => {
            // The after-states just landed — refresh the snapshot-backed
            // Diff-panel history so the finished turn's diff appears without
            // waiting for the next worker.getMessages round-trip.
            void this.worker.scopeTranscript.emitTurnDiffHistory()
          })
          .catch(err => {
          this.worker.emit({
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
        void this.worker.scopeTranscript.emitTurnDiffHistory()
      }
    }
  }

  /** The whole transcript to the page, replacing its copy. Same stamping as
   *  `worker.getMessages` — the rewritten transcript replaces every row, so
   *  unstamped rows here would strip the line ranges the UI had. */
  async emitWholeTranscript(): Promise<void> {
    const runtime = this.worker.runtime
    if (!runtime) return
    this.worker.emit({
      type: 'worker.messages',
      payload: {
        messages: await withTranscriptLines(
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
  normalizeTurnEndPhase(): void {
    if (!this.worker.turns.isBusy()) return
    this.worker.turns.setPhase({ kind: 'idle' })
    this.worker.emit({ type: 'worker.state', payload: this.worker.getSnapshot() })
  }
}
