/**
 * Contract: RoutineCoordinator — the headless routine-run lifecycle: the `headlessRuns` map, spawn +
 * single-turn drive, stop and emit interception; an app's agent run (F-40) is one more headless
 * run on the same path. Invariants:
 * - `headlessRuns` stays independent of the TaskRegistry's live tasks (only terminal records join it)
 * - headless sessions never appear in the normal session list
 * - ONE terminal authority: the submitAndWait resolution path
 */
import type { TaskRegistry } from './TaskRegistry'
import type { AgentRuntimeWorkerHandle } from './AgentRuntimeWorkerHandle'
import type {
  AgentRuntimeWorkerInitPayload,
  AgentWorkerInboundMessage,
  AgentWorkerOutboundMessage,
} from './workerProtocol'
import type { SessionWorkerInboundMessage } from './sharedWorkerProtocol'
import type { BrowserConversationStorageBackend } from '../../sessions/sessionStore'
import type {
  HeadlessRunResult,
  SpawnHeadlessSession,
} from '../../routines/HeadlessRunner'
import { APP_RUN_SESSION_PREFIX, type AppAgentRunOutcome, type AppAgentRunner } from '../../mods/app/appAgentRun'
import { getProductName } from '../../branding/productName'
import { mintTaskHandle } from '../../backgroundTasks/taskId'
import {
  MAX_FINISHED_ROUTINE_RUNS,
  type HeadlessRunState,
  type FinishedRoutineRecord,
} from './taskTypes'
import {
  extractFinalAssistantText,
  projectSubAgentTranscript,
} from './taskProjection'

/** Headless-run empty-output summary. Lives HERE, not in the shared
 *  extractor — sub-agent/fork callers have their own
 *  wording and their `||` fallbacks were dead while the extractor baked
 *  this in for everyone. */
const HEADLESS_NO_TEXT =
  '(Headless run produced no assistant text. The run may have timed out or aborted before responding.)'

// --- Host interface ---

export interface RoutineHost {
  /** The reusable UI init payload; null before any UI session booted. */
  getInitTemplate(): AgentRuntimeWorkerInitPayload | null
  /** Route + stamp the run's per-session storage backend. */
  prepareWorkerStorage(
    sessionId: string,
    payload: AgentRuntimeWorkerInitPayload,
  ): BrowserConversationStorageBackend | null
  /** Allocate a worker via the SessionWorkerFactory recipe. */
  createWorker(
    sessionId: string,
    backend: BrowserConversationStorageBackend | null,
  ): { worker: AgentRuntimeWorkerHandle; instanceId: string }
  /** Register the headless session entry (no ports). `binding` is the
   *  project / template the run BOOTS on, so a sub-agent or teammate it
   *  spawns inherits it (`getParentSessionBinding`). */
  registerSessionEntry(
    sessionId: string,
    worker: AgentRuntimeWorkerHandle,
    instanceId: string,
    binding?: { projectRoot?: string; templateType?: string },
  ): void
  getSessionWorker(sessionId: string): AgentRuntimeWorkerHandle | undefined
  /** Synchronous entry removal + delivery drop + async dispose. */
  reapSessionEntry(sessionId: string): void
  /** Route a live run's `worker.bridgeRequest` to the host bridge. */
  routeBridgeRequest(sessionId: string, payload: unknown): void
  scheduleSummary(): void
}

// --- Coordinator ---

export class RoutineCoordinator {
  private readonly headlessRuns = new Map<string, HeadlessRunState>()

  constructor(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly registry: TaskRegistry<any, any>,
    private readonly host: RoutineHost,
  ) {}

  // --- Registry (the original coordinator surface) ---

  register(sessionId: string, state: HeadlessRunState): void {
    this.headlessRuns.set(sessionId, state)
  }

  get(sessionId: string): HeadlessRunState | undefined {
    return this.headlessRuns.get(sessionId)
  }

  has(sessionId: string): boolean {
    return this.headlessRuns.has(sessionId)
  }

  delete(sessionId: string): void {
    this.headlessRuns.delete(sessionId)
  }

  *all(): IterableIterator<HeadlessRunState> {
    yield* this.headlessRuns.values()
  }

  get size(): number {
    return this.headlessRuns.size
  }

  dispose(): void {
    this.headlessRuns.clear()
  }

  // --- Spawn lifecycle ---

  /**
   * Spawn a fresh headless session for a routine fire: init payload from the UI template with
   * `isHeadless: true` + `routineId`, a fresh portless worker, `worker.init` then `worker.submitMessage`.
   * Stream events route via `interceptEmit`; the submitAndWait path computes the terminal result.
   */
  readonly spawnHeadlessSession: SpawnHeadlessSession = (params) => {
    const { sessionId, routine, abortSignal } = params

    return new Promise<HeadlessRunResult>((resolve) => {
      // A pre-aborted signal means the runner already timed out or
      // shut down before this spawn ran. The abort→interrupt wiring below
      // could never land for it (the worker doesn't exist yet), so without
      // this guard the run would execute FULL-LENGTH and only read 'aborted'
      // at settle. Skip allocation entirely — nothing ran, nothing records.
      if (abortSignal.aborted) {
        resolve({ sessionId, status: 'aborted', summary: '' })
        return
      }

      const template = this.host.getInitTemplate()
      if (!template) {
        resolve({
          sessionId,
          status: 'error',
          summary:
            'No init template captured yet — at least one UI session must have booted before routines can fire. ' +
            `Open a ${getProductName()} tab once, then routines will fire from the next tick.`,
        })
        return
      }

      const initPayload: AgentRuntimeWorkerInitPayload = {
        ...template,
        sessionId,
        isHeadless: true,
        routineId: routine.id,
        // Root of the routine-originated tree. Unlike the two fields above,
        // this one is inherited by anything this session spawns, so the
        // recursion guard still fires a level down (sub-agent / teammate).
        routineOriginId: routine.id,
        ...(routine.model ? { userSpecifiedModel: routine.model } : {}),
        // Give this headless session its own trace lineage rather than
        // inheriting the UI tab's traceId.
        traceId: undefined,
      }
      this.launchHeadless(sessionId, initPayload, abortSignal, resolve, {
        routineId: routine.id,
        description: routine.name || routine.id,
        model: routine.model,
        prompt: routine.prompt,
      })
    })
  }

  /**
   * Security: an app's agent run (F-40) — headless, so every permission ask is refused; bound to
   * the app's template and folder whatever the template's last session was bound to; read-bounded
   * to that folder (no shell, no memory, nothing read outside it); routine-originated, so it
   * registers no cron or trigger; on the default model, not the last session's pick.
   */
  readonly spawnAppRun: AppAgentRunner = async (job) => {
    if (job.abortSignal.aborted) return { status: 'aborted' }
    const template = this.host.getInitTemplate()
    if (!template) {
      return {
        status: 'error',
        message: `no session has started in a ${getProductName()} window yet, so there is nothing to run on`,
      }
    }
    const sessionId = `${APP_RUN_SESSION_PREFIX}${crypto.randomUUID()}`
    const initPayload: AgentRuntimeWorkerInitPayload = {
      ...template,
      sessionId,
      cwd: job.folder,
      projectRoot: job.folder,
      cwdOverride: undefined,
      templateType: job.templateType,
      isHeadless: true,
      routineId: undefined,
      routineOriginId: `app:${job.appId}`,
      appAgentRun: job.appId,
      untrustedReadRoot: job.folder,
      userSpecifiedProviderId: undefined,
      userSpecifiedModel: undefined,
      userSpecifiedThinkingTier: undefined,
      traceId: undefined,
    }
    const result = await new Promise<HeadlessRunResult>(resolve => {
      this.launchHeadless(sessionId, initPayload, job.abortSignal, resolve, {
        routineId: `app:${job.appId}`,
        description: job.title ?? job.appId,
        prompt: job.prompt,
      })
    })
    return appRunOutcome(result)
  }

  /** Register a headless run, allocate its portless worker, and drive its single turn. */
  private launchHeadless(
    sessionId: string,
    initPayload: AgentRuntimeWorkerInitPayload,
    abortSignal: AbortSignal,
    resolve: (result: HeadlessRunResult) => void,
    run: { routineId: string; description: string; model?: string; prompt: string },
  ): void {
    const now = Date.now()
    const state: HeadlessRunState = {
      routineId: run.routineId,
      sessionId,
      messages: [],
      resolve,
      completed: false,
      startedAt: now,
      // `local_routine` task surfacing (Background Tasks drawer).
      taskId: mintTaskHandle('local_routine'),
      description: run.description,
      model: run.model,
      prompt: run.prompt,
      lastActivityAt: now,
    }
    this.register(sessionId, state)
    // Index the public `r…` id → native headless sessionId (drawer Stop /
    // detail requests send the public id) and show the row immediately.
    this.registry.indexTaskId(state.taskId, sessionId)
    this.host.scheduleSummary()

    // Wire the runner-supplied abort to a `worker.interrupt`. Fire
    // once; chaining further aborts would no-op anyway because the
    // worker becomes !isBusy after the first interrupt.
    const onAbort = () => {
      const w = this.host.getSessionWorker(sessionId)
      if (w) {
        void w.receiveFrame({
          type: 'worker.interrupt',
          sessionId,
          payload: {},
        } as SessionWorkerInboundMessage)
      }
    }
    // No pre-fire check needed: each caller already returned for a
    // pre-aborted signal, and everything between its guard and worker
    // registration below is synchronous — an abort event can only dispatch
    // from a task boundary, by which point the worker exists for onAbort to find.
    abortSignal.addEventListener('abort', onAbort, { once: true })

    // Allocate the worker. Same path the UI takes, minus the
    // `ports` set (no UI port is attached). Routing for emitted
    // events happens via the worker-emit router, which checks
    // `headlessRuns` first.
    const headlessBackend = this.host.prepareWorkerStorage(
      sessionId,
      initPayload,
    )
    const { worker, instanceId } = this.host.createWorker(
      sessionId,
      headlessBackend,
    )
    // With no binding on the entry, a sub-agent this run spawns read a
    // non-null `{}` parent binding and booted unbound, on the default
    // template, while the run itself works in the template's project.
    this.host.registerSessionEntry(sessionId, worker, instanceId, {
      ...(initPayload.projectRoot
        ? { projectRoot: initPayload.projectRoot }
        : {}),
      ...(initPayload.templateType
        ? { templateType: initPayload.templateType }
        : {}),
    })

    // Single terminal authority: drive the init +
    // submit chain using submitAndWait for explicit turn-completion
    // semantics, compute ONE terminal result, and finalize exactly once.
    // The emit interceptor never finalizes — it only accumulates
    // stream events, marks `completed`, and records a `worker.error`
    // summary for this path to consume — which removes the dual-finalizer
    // race where the emit path could dispose the session while
    // executeSubmit was still in its finally block.
    void (async () => {
      this.finalizeHeadlessRun(
        sessionId,
        await this.runHeadlessTurn(
          worker,
          sessionId,
          initPayload,
          state,
          abortSignal,
        ),
      )
    })()
  }

  /**
   * Drive a headless run's init + single turn and compute its terminal
   * result. NEVER finalizes — the caller owns the single
   * `finalizeHeadlessRun` call site (one terminal authority;
   * the emit interceptor only records). A `worker.error` observed by the
   * interceptor outranks a clean-looking settle.
   */
  private async runHeadlessTurn(
    worker: AgentRuntimeWorkerHandle,
    sessionId: string,
    initPayload: AgentRuntimeWorkerInitPayload,
    state: HeadlessRunState,
    abortSignal: AbortSignal,
  ): Promise<HeadlessRunResult> {
    try {
      await worker.receiveFrame({
        type: 'worker.init',
        sessionId,
        payload: initPayload,
      } as SessionWorkerInboundMessage)
    } catch (err) {
      return {
        sessionId,
        status: 'error',
        summary: err instanceof Error ? err.message : String(err),
      }
    }

    try {
      const result = worker.submitAndWait
        ? await worker.submitAndWait(
            { type: 'worker.submitMessage', payload: { prompt: state.prompt } } as Extract<AgentWorkerInboundMessage, { type: 'worker.submitMessage' }>,
            'user',
          )
        : { status: 'completed' as const }

      if (result.status === 'failed') {
        return { sessionId, status: 'error', summary: result.message }
      }
      if (result.status === 'aborted') {
        return {
          sessionId,
          status: 'aborted',
          summary:
            extractFinalAssistantText(state.messages) || HEADLESS_NO_TEXT,
        }
      }
    } catch (err) {
      return {
        sessionId,
        status: 'error',
        summary: err instanceof Error ? err.message : String(err),
      }
    }

    // Turn settled as completed. A worker.error the emit interceptor
    // recorded mid-run outranks the clean settle — the run surfaced an
    // error the caller must see (the removed emit-path finalize used to
    // report it immediately; it is now reported once, here).
    if (state.emitErrorSummary !== undefined) {
      return { sessionId, status: 'error', summary: state.emitErrorSummary }
    }
    return {
      sessionId,
      status: abortSignal.aborted ? 'aborted' : 'success',
      summary: extractFinalAssistantText(state.messages) || HEADLESS_NO_TEXT,
    }
  }

  /**
   * Resolve the awaiting promise and clean up the session entry. Safe
   * to call multiple times — the state is removed on first call so
   * subsequent calls are no-ops.
   */
  finalizeHeadlessRun(sessionId: string, result: HeadlessRunResult): void {
    const state = this.get(sessionId)
    if (!state) return
    this.delete(sessionId)
    // Synchronous entry removal + async dispose (reapSessionEntry).
    this.host.reapSessionEntry(sessionId)
    // Retain a `local_routine` terminal record so the drawer's finished tail
    // + detail view stay populated after the live state is reaped. A drawer
    // Stop (or the runner's abort/timeout) reads as 'stopped'.
    const record: FinishedRoutineRecord = {
      type: 'local_routine',
      taskId: state.taskId,
      sessionId,
      routineId: state.routineId,
      description: state.description,
      model: state.model,
      prompt: state.prompt,
      status:
        state.stopRequested || result.status === 'aborted'
          ? 'stopped'
          : result.status === 'success'
            ? 'success'
            : 'error',
      summary: result.summary ?? '',
      transcript: projectSubAgentTranscript(state.messages),
      startedAt: state.startedAt,
      finishedAt: Date.now(),
    }
    this.registry.recordFinished(sessionId, record)
    this.registry.evictFinishedOverCap('local_routine', MAX_FINISHED_ROUTINE_RUNS)
    this.host.scheduleSummary()
    state.resolve(result)
  }

  /**
   * Drawer Stop for a live headless run: mark it stop-requested (so the
   * terminal record reads 'stopped') and interrupt its worker; the single
   * terminal authority finalizes when the interrupted turn settles.
   */
  stopHeadlessRun(sessionId: string): 'stopped' | 'not_found' {
    const state = this.get(sessionId)
    if (!state) return 'not_found'
    state.stopRequested = true
    const worker = this.host.getSessionWorker(sessionId)
    if (worker) {
      void worker.receiveFrame({
        type: 'worker.interrupt',
        sessionId,
        payload: {},
      } as SessionWorkerInboundMessage)
    }
    this.host.scheduleSummary()
    return 'stopped'
  }

  // --- Live-run emit interception ---

  /**
   * Headless-run interception: stream events accumulate into the run state; terminal branches only
   * RECORD (never dispose). Returns false when the session is not an in-flight headless run.
   */
  interceptEmit(
    sessionId: string,
    message: AgentWorkerOutboundMessage,
  ): boolean {
    const headlessState = this.get(sessionId)
    if (!headlessState) return false
    if (message.type === 'worker.stream') {
      const event = (message.payload as { event?: unknown })?.event
      if (event !== undefined) {
        headlessState.messages.push(event)
        // Drawer liveness for the `local_routine` row (coalesced flush).
        headlessState.lastActivityAt = Date.now()
        this.host.scheduleSummary()
      }
    } else if (message.type === 'worker.completed') {
      // Mark only — the submitAndWait path settles for this same turn and
      // finalizes exactly once.
      headlessState.completed = true
    } else if (message.type === 'worker.error') {
      // Record for the single finalizer to consume. First error wins — a
      // cascade of follow-on errors must not overwrite the root cause.
      if (headlessState.emitErrorSummary === undefined) {
        const payload = message.payload as { code?: string; message?: string }
        headlessState.emitErrorSummary = `Headless run failed: ${payload?.code ?? 'unknown'} — ${payload?.message ?? ''}`
      }
    }
    if (message.type === 'worker.bridgeRequest') {
      this.host.routeBridgeRequest(sessionId, message.payload)
    }
    return true
  }
}

/** An app run's end as the app sees it: its final text, empty when it wrote none. */
function appRunOutcome(result: HeadlessRunResult): AppAgentRunOutcome {
  if (result.status === 'success') return { status: 'success', text: result.summary === HEADLESS_NO_TEXT ? '' : result.summary }
  if (result.status === 'aborted') return { status: 'aborted' }
  return { status: 'error', message: result.summary || 'the run failed' }
}
