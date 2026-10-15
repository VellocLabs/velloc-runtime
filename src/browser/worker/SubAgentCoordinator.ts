/**
 * Contract: SubAgentCoordinator — background sub-agent spawn / resume, single-turn drive, finalize /
 * stop / teardown with owner-globals restore, record retention, TaskOutput waiters and emit
 * interception (the emit path never finalizes). Invariants:
 * - waiters resolve exactly once
 * - owner globals are restored BEFORE the parent turn resumes
 * - finalize is idempotent
 */
import type { TaskRegistry } from './TaskRegistry'
import type { AgentRuntimeWorkerHandle } from './AgentRuntimeWorkerHandle'
import type {
  AgentRuntimeWorkerInitPayload,
  AgentWorkerInboundMessage,
  AgentWorkerOutboundMessage,
} from './workerProtocol'
import type { SessionWorkerInboundMessage } from './sharedWorkerProtocol'
import type { BrowserLlmSelection } from '../bridge/protocol/nexus_llm'
import type { BrowserConversationStorageBackend } from '../../sessions/sessionStore'
import { setConversationStore } from '../../sessions/sessionStore'
import { installProcessFs } from '../../utils/fs/runtimeFs'
import {
  createSidechainAgentId,
  setActiveSidechainStore,
} from '../../utils/sidechainTranscripts'
import { mintTaskHandle } from '../../backgroundTasks/taskId'
import {
  taskFileFromFinishedRecord,
  taskFileFromRunState,
} from './subAgentTaskFile'
import type { SubAgentSpawnParams } from '../../team/subAgentSpawner'
import type {
  SubAgentStopResult,
  SubAgentResumeResult,
} from '../../team/subAgentController'
import {
  MAX_SUBAGENT_DEPTH,
  MAX_FINISHED_SUBAGENTS,
  type SubAgentRunState,
  type FinishedSubAgentRecord,
  type OwnerRuntimeGlobals,
  type NexusTaskDeliveryResult,
} from './taskTypes'
import {
  extractFinalAssistantText,
  projectSubAgentTranscript,
} from './taskProjection'

// --- Types ---

export type SubAgentSnapshot = {
  sessionId: string
  status: 'running' | 'success' | 'error' | 'stopped'
  description: string
  taskType?: 'local_agent' | 'local_bash' | 'local_supershell'
  output: string
  exitCode?: number | null
  startedAt: number
  updates?: number
  lastActivityAt?: number
  agentType?: string
}

export type SubAgentListEntry = {
  sessionId: string
  status: 'running' | 'success' | 'error' | 'stopped'
  description: string
  agentType?: string
  startedAt: number
  updates?: number
}

type WaiterResolver = (snap: SubAgentSnapshot | null) => void

/**
 * The PARENT session's own project binding, read from its committed init
 * (not from `lastInitTemplate`, which is whichever UI session booted LAST).
 * `cwd` is set only when the parent's working dir has diverged from its
 * project root — i.e. the parent is itself worktree-isolated — so a nested
 * spawn stays in that worktree.
 */
export type ParentSessionBinding = {
  projectRoot?: string
  templateType?: string
  cwd?: string
}

// --- Host interface ---

export interface SubAgentHost {
  getSnapshot(sessionId: string): SubAgentSnapshot | null
  stop(sessionId: string): void
  // --- Lifecycle capabilities ---
  /** The reusable UI init payload; null before any UI session booted. */
  getInitTemplate(): AgentRuntimeWorkerInitPayload | null
  /** The parent session's LIVE model selection (not the boot template's). */
  getParentModelSelection(spawnerSessionId: string): BrowserLlmSelection | null
  /**
   * The parent's own projectRoot / templateType / worktree cwd, or null when
   * the parent has no live entry. The init template is a per-realm
   * "most recent UI boot" snapshot, so a sub-agent that inherited its
   * projectRoot/templateType from it ran in whichever project the user
   * opened LAST — not the parent's. The parent's binding overrides those
   * fields on spawn and resume.
   */
  getParentSessionBinding(spawnerSessionId: string): ParentSessionBinding | null
  /** The parent's captured per-runtime globals (falling back to the parent
   *  worker's live report — never the shared process slot). */
  getOwnerGlobals(spawnerSessionId: string): OwnerRuntimeGlobals | undefined
  /** Route + stamp the run's per-session storage backend. */
  prepareWorkerStorage(
    sessionId: string,
    payload: AgentRuntimeWorkerInitPayload,
    spawnerSessionId?: string,
  ): BrowserConversationStorageBackend | null
  /** Allocate a worker via the SessionWorkerFactory recipe. */
  createWorker(
    sessionId: string,
    backend: BrowserConversationStorageBackend | null,
  ): { worker: AgentRuntimeWorkerHandle; instanceId: string }
  /** Register the background-run session entry (no ports). `binding` is the
   *  run's own projectRoot / templateType, so a sub-agent that spawns a
   *  sub-agent of its own is a parent `getParentSessionBinding` can answer for. */
  registerSessionEntry(
    sessionId: string,
    worker: AgentRuntimeWorkerHandle,
    instanceId: string,
    binding?: { projectRoot?: string; templateType?: string },
  ): void
  getSessionWorker(sessionId: string): AgentRuntimeWorkerHandle | undefined
  /** Synchronous entry removal + delivery drop + async dispose. */
  reapSessionEntry(sessionId: string): void
  /** Unified disposal (fire C++ stop, clear ports, await dispose, delete). */
  disposeManagedSession(
    sessionId: string,
    opts: { fireStop: boolean },
  ): Promise<void>
  /** Queue a finished result for delivery into the parent turn. */
  deliverTaskResult(
    spawnerSessionId: string,
    result: NexusTaskDeliveryResult,
  ): void
  /** Route a live run's `worker.bridgeRequest` to the host bridge. */
  routeBridgeRequest(sessionId: string, payload: unknown): void
  scheduleSummary(): void
  /** Best-effort write of the sub-agent's on-disk `task.json` (see
   *  subAgentTaskFile.ts) — the restart-restore seed. Never awaited. */
  persistSubAgentTaskFile(
    spawnerSessionId: string,
    sessionId: string,
    json: string,
  ): void
}

// --- Coordinator ---

export class SubAgentCoordinator {
  private readonly waiters = new Map<string, WaiterResolver[]>()
  // Per-sub-agent abort controllers. Aborting one fires a
  // `worker.interrupt` at the sub-agent's worker; used by `TaskStop` and the
  // parent-close cascade to stop orphaned in-flight sub-agents. Removed on
  // completion.
  private readonly aborts = new Map<string, AbortController>()
  private readonly pendingTeardowns = new Map<string, Promise<void>>()

  constructor(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly registry: TaskRegistry<any, any>,
    private readonly host: SubAgentHost,
  ) {}

  // --- Registry narrowing (local mirrors of the Manager accessors) ---

  private agentTask(id: string): SubAgentRunState | undefined {
    return this.registry.getLiveByType(id, 'local_agent')
  }

  private finishedAgent(id: string): FinishedSubAgentRecord | undefined {
    return this.registry.getFinishedByType(id, 'local_agent')
  }

  // --- Waiter management ---

  /**
   * Park a resolver for a sub-agent's terminal snapshot. Called by
   * waitForCompletion; resolved by recordFinishedSubAgent or cascade.
   */
  addWaiter(sessionId: string, resolver: WaiterResolver): void {
    const list = this.waiters.get(sessionId) ?? []
    list.push(resolver)
    this.waiters.set(sessionId, list)
  }

  /**
   * Remove a specific resolver (e.g. on timeout). Preserves co-waiters.
   */
  removeWaiter(sessionId: string, resolver: WaiterResolver): void {
    const remaining = (this.waiters.get(sessionId) ?? []).filter(r => r !== resolver)
    if (remaining.length > 0) this.waiters.set(sessionId, remaining)
    else this.waiters.delete(sessionId)
  }

  /**
   * Resolve + reap all parked waiters for a session. Called by
   * recordFinishedSubAgent (terminal record) and cascade (parent close).
   */
  resolveWaiters(sessionId: string): void {
    const waiters = this.waiters.get(sessionId)
    if (!waiters) return
    this.waiters.delete(sessionId)
    const snap = this.host.getSnapshot(sessionId)
    for (const resolve of waiters) resolve(snap)
  }

  hasWaiters(sessionId: string): boolean {
    return this.waiters.has(sessionId)
  }

  // --- Queries ---

  /**
   * Enumerate background sub-agents launched from `spawnerSessionId`:
   * in-flight runs first (oldest-running first), then terminal records
   * (most-recently-finished first).
   */
  list(spawnerSessionId: string): SubAgentListEntry[] {
    const running: SubAgentListEntry[] = []
    for (const run of this.registry.liveByType('local_agent')) {
      if (run.spawnerSessionId !== spawnerSessionId) continue
      running.push({
        sessionId: run.taskId ?? run.sessionId,
        status: 'running',
        description: run.description,
        agentType: run.agentType,
        startedAt: run.startedAt,
        updates: run.messages?.length ?? 0,
      })
    }
    const finished: SubAgentListEntry[] = []
    for (const rec of this.registry.finishedByType('local_agent')) {
      if (rec.spawnerSessionId !== spawnerSessionId) continue
      finished.push({
        sessionId: rec.taskId ?? rec.sessionId,
        status: rec.status,
        description: rec.description,
        agentType: rec.agentType,
        startedAt: rec.startedAt,
      })
    }
    // Running first (oldest-running first), then finished (most-recent first).
    running.sort((a, b) => a.startedAt - b.startedAt)
    finished.sort((a, b) => b.startedAt - a.startedAt)
    return [...running, ...finished]
  }

  // --- Wait ---

  /**
   * Block until a sub-agent reaches a terminal state, or resolve with its
   * current snapshot after `timeoutMs`. Resolves null for an unknown id.
   * `signal` (the calling turn's abort) unblocks immediately AND stops the
   * sub-agent on Stop.
   */
  waitForCompletion(
    sessionId: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<SubAgentSnapshot | null> {
    const initial = this.host.getSnapshot(sessionId)
    if (!initial) return Promise.resolve(null)
    if (initial.status !== 'running') return Promise.resolve(initial)
    if (signal?.aborted) {
      this.host.stop(sessionId)
      return Promise.resolve(this.host.getSnapshot(sessionId))
    }
    return new Promise((resolve) => {
      let settled = false
      const finish = (snap: SubAgentSnapshot | null): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        this.removeWaiter(sessionId, finish)
        resolve(snap)
      }
      const onAbort = (): void => {
        this.host.stop(sessionId)
        finish(this.host.getSnapshot(sessionId))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.addWaiter(sessionId, finish)
      const timer = setTimeout(() => finish(this.host.getSnapshot(sessionId)), timeoutMs)
    })
  }

  // --- Spawn / resume lifecycle ---

  /**
   * Spawn a background, worker-hosted sub-agent; returns its taskId synchronously (the parent does not
   * block) and its final text is delivered as a later parent turn. Null with no init template or at the
   * depth cap.
   */
  spawn(params: SubAgentSpawnParams): string | null {
    const template = this.host.getInitTemplate()
    if (!template) return null
    const {
      spawnerSessionId,
      prompt,
      description,
      agentType,
      systemPrompt,
      model,
      modelProviderId,
      modelThinkingTier,
      allowTools,
      disallowTools,
      projectRoot,
      cwd,
      onCleanup,
      forkSeedMessages,
      forkExactTools,
      routineOriginId,
    } = params

    // Recursion cap. A top-level UI parent is absent from the live map
    // (depth 0); a sub-agent spawning a sub-agent is depth+1 (its own run
    // state is still live when its tool fires). Reject runaway nesting.
    const parentDepth = this.agentTask(spawnerSessionId)?.depth ?? 0
    if (parentDepth >= MAX_SUBAGENT_DEPTH) return null

    const agentId = createSidechainAgentId(agentType ?? description ?? 'subagent')
    const sessionId = `subagent-${agentId}`
    // Public kind-prefixed task id (`a…`) — the model/drawer/control handle returned
    // to the SpawnAgentTool. The worker/storage/routing all keep the native `sessionId`
    // (`subagent-…`); the registry indexes `taskId → sessionId`.
    const taskId = mintTaskHandle('local_agent')

    // A sub-agent without `model` runs on the PARENT's live selection (the template only holds the boot
    // model); an explicit `model` wins.
    const parentSelection = this.host.getParentModelSelection(spawnerSessionId)
    // A TIER-resolved spawn (`modelProviderId` set — the Agent tool's
    // `model: 'fast'|'balanced'|'best'` param) carries the full pair so the
    // worker takes the exact requestedSelection path, plus the parent's live
    // selection as `modelFallbackSelection`: if the requested pair is not
    // enabled in the live catalog, resolution falls back to the PARENT's
    // model — a tier request must never land on a third, unrelated model
    // (the bare-id path below keeps its historical defaultSelection
    // fallback).
    const modelOverride: Partial<AgentRuntimeWorkerInitPayload> = model
      ? modelProviderId
        ? {
            userSpecifiedProviderId: modelProviderId,
            userSpecifiedModel: model,
            // A USER pin's declared effort (specific policy / dictionary
            // pin). Plain tier spawns omit it and boot the model's catalog
            // default tier.
            ...(modelThinkingTier
              ? { userSpecifiedThinkingTier: modelThinkingTier }
              : {}),
            ...(parentSelection ? { modelFallbackSelection: parentSelection } : {}),
          }
        : { userSpecifiedModel: model }
      : parentSelection
        ? {
            userSpecifiedProviderId: parentSelection.providerId,
            userSpecifiedModel: parentSelection.modelId,
            ...(parentSelection.thinkingTier
              ? { userSpecifiedThinkingTier: parentSelection.thinkingTier }
              : {}),
          }
        : {}
    // The model this run effectively boots on (for the detail view's "Model"
    // line): the explicit `model` when set, else the inherited parent selection.
    // This is the spawn-time GUESS — `setModel` refreshes it with the
    // selection the worker actually applied (catalog fallback truth).
    const effectiveModel = model ?? parentSelection?.modelId
    // The effort this run boots on (for the detail view's "Effort" line): a
    // tier-resolved spawn's declared tier wins; an inherited run shows the
    // parent's live tier. Absent when the run uses the model's catalog default.
    const effort = modelThinkingTier ?? parentSelection?.thinkingTier
    // Project binding comes from the PARENT, not the template. The template
    // is the most recent UI `worker.init` of ANY session, so with two projects
    // open a sub-agent spawned from A ran in B's project on B's template. An
    // explicit worktree `projectRoot` (canonical repo root) still wins; no
    // live parent (test seeds, a spawn racing its parent's teardown) keeps
    // the template's fields as before.
    const parent = this.host.getParentSessionBinding(spawnerSessionId)
    const boundProjectRoot = projectRoot ?? parent?.projectRoot
    const boundCwd = cwd ?? parent?.cwd

    const initPayload: AgentRuntimeWorkerInitPayload = {
      ...template,
      sessionId,
      // Fresh isolated context: a named subagent_type's own system prompt
      // REPLACES the default. The model comes from `modelOverride` above — an
      // explicit `model` wins, else the parent's LIVE selection (not the stale
      // boot model frozen in the template).
      ...(systemPrompt ? { customSystemPrompt: systemPrompt } : {}),
      ...modelOverride,
      // Per-agent tool scope — applied worker-side in
      // createBrowserRuntime after dynamic tools are built. `isSubAgent` gates
      // the plan-tool strip there (a general-purpose subagent sets no
      // allow/deny, so the scope lists alone can't flag it as a subagent).
      isSubAgent: true,
      // Its tool calls pass the mods of the slot it runs under.
      modParentSessionId: spawnerSessionId,
      ...(allowTools ? { subAgentAllowTools: allowTools } : {}),
      ...(disallowTools ? { subAgentDisallowTools: disallowTools } : {}),
      // Background FORK: seed the parent's conversation as the worker's initial
      // messages and keep the parent's exact tool pool, so the fork continues
      // the parent's context with a cache-compatible prefix (it boots from the
      // same template, so prompt + tools reconstruct the parent's).
      ...(forkSeedMessages ? { forkSeedMessages } : {}),
      ...(forkExactTools ? { forkExactTools: true } : {}),
      // Worktree isolation: storage/memory stay on the repo root (`projectRoot`), only the cwd moves
      // (`cwdOverride`). With a live parent these OVERRIDE the template's values, `undefined` included.
      ...(parent
        ? { projectRoot: boundProjectRoot, templateType: parent.templateType }
        : boundProjectRoot
          ? { projectRoot: boundProjectRoot }
          : {}),
      ...(boundCwd ? { cwdOverride: boundCwd } : {}),
      // Own trace lineage; not a routine/teammate run.
      traceId: undefined,
      isHeadless: undefined,
      routineId: undefined,
      // ...but routine PROVENANCE is inherited, unlike the two fields above.
      // The sub-agent is not a routine session (no RoutineSignal, no headless
      // boot branch) yet its work is still the routine's, so the recursion
      // guard must see it: without this a routine could register more
      // routines simply by asking the Agent tool to.
      routineOriginId,
      isTeammate: undefined,
      teamName: undefined,
      teammateName: undefined,
    }

    const state: SubAgentRunState = {
      type: 'local_agent',
      taskId,
      spawnerSessionId,
      sessionId,
      agentId,
      description,
      agentType,
      prompt,
      messages: [],
      completed: false,
      depth: parentDepth + 1,
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      systemPrompt,
      model,
      modelProviderId,
      effectiveModel,
      effort,
      allowTools,
      disallowTools,
      // The bound root (worktree repo root, else the parent's), so a resume
      // re-anchors on the same project even once the parent is gone.
      projectRoot: boundProjectRoot,
      routineOriginId,
      onCleanup,
    }
    this.launchWorker(sessionId, initPayload, state)
    return taskId
  }

  /**
   * Re-launch a FINISHED background sub-agent into its persisted transcript
   * with a follow-up `prompt` (`AgentResume`, G4). The resumed run keeps the original agent identity
   * (system prompt / model / tool scope / worktree) and depth, and delivers its
   * new result back to the original parent like any background sub-agent.
   */
  resume(publicId: string, prompt: string): SubAgentResumeResult {
    // `publicId` is the `a…` taskId; the worker/storage key is the native sessionId.
    const sessionId = this.registry.resolveNative(publicId)
    if (this.pendingTeardowns.has(sessionId)) {
      return { ok: false, reason: 'still_running' }
    }
    if (this.agentTask(sessionId)) {
      return { ok: false, reason: 'still_running' }
    }
    const rec = this.finishedAgent(sessionId)
    if (!rec) return { ok: false, reason: 'not_found' }
    const template = this.host.getInitTemplate()
    if (!template) return { ok: false, reason: 'unavailable' }
    // Same rule as `spawn`: the run's recorded root wins, else the parent's
    // own binding — never the template's, which may be another session's.
    const parent = this.host.getParentSessionBinding(rec.spawnerSessionId)
    const boundProjectRoot = rec.projectRoot ?? parent?.projectRoot

    const initPayload: AgentRuntimeWorkerInitPayload = {
      ...template,
      sessionId,
      ...(rec.systemPrompt ? { customSystemPrompt: rec.systemPrompt } : {}),
      ...(rec.model ? { userSpecifiedModel: rec.model } : {}),
      // Tier-resolved runs stored the provider pair — re-inject it so the
      // resume boots the exact same selection (no modelFallbackSelection on
      // resume: generic catalog resolution applies).
      ...(rec.modelProviderId ? { userSpecifiedProviderId: rec.modelProviderId } : {}),
      // Subagent resume — same plan-tool-strip gate as the fresh spawn above.
      isSubAgent: true,
      modParentSessionId: rec.spawnerSessionId,
      ...(rec.allowTools ? { subAgentAllowTools: rec.allowTools } : {}),
      ...(rec.disallowTools ? { subAgentDisallowTools: rec.disallowTools } : {}),
      ...(parent
        ? { projectRoot: boundProjectRoot, templateType: parent.templateType }
        : boundProjectRoot
          ? { projectRoot: boundProjectRoot }
          : {}),
      ...(parent?.cwd ? { cwdOverride: parent.cwd } : {}),
      traceId: undefined,
      isHeadless: undefined,
      routineId: undefined,
      // A resume continues the SAME logical run, so it keeps that run's
      // routine provenance (recorded at spawn) — the spawning turn is long
      // gone and cannot be re-read.
      routineOriginId: rec.routineOriginId,
      isTeammate: undefined,
      teamName: undefined,
      teammateName: undefined,
    }
    const state: SubAgentRunState = {
      type: 'local_agent',
      taskId: rec.taskId,
      spawnerSessionId: rec.spawnerSessionId,
      sessionId,
      agentId: rec.agentId,
      description: rec.description,
      agentType: rec.agentType,
      prompt,
      messages: [],
      completed: false,
      // Resuming continues the same logical run — it does NOT deepen nesting.
      depth: rec.depth,
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      systemPrompt: rec.systemPrompt,
      model: rec.model,
      // The finished record written when this run settles copies these off
      // the live state; dropping them here lost the provider pair and the
      // detail view's "Model" line on every resumed run.
      modelProviderId: rec.modelProviderId,
      effectiveModel: rec.effectiveModel,
      effort: rec.effort,
      allowTools: rec.allowTools,
      disallowTools: rec.disallowTools,
      projectRoot: boundProjectRoot,
      // Keep the provenance on the live state too, so a SECOND resume (which
      // reads the record written when this one finishes) still carries it.
      routineOriginId: rec.routineOriginId,
    }
    // No longer terminal — it's live again. (A fresh terminal record is written
    // when this resumed run finalizes.)
    this.registry.deleteFinished(sessionId)
    this.launchWorker(sessionId, initPayload, state)
    return { ok: true, sessionId: rec.taskId }
  }

  /**
   * Allocate the worker for a sub-agent run and drive its single turn (spawn and `AgentResume`; a
   * resume reuses the sessionId and rehydrates). Completion goes through `finalizeSubAgentRun`.
   */
  private launchWorker(
    sessionId: string,
    initPayload: AgentRuntimeWorkerInitPayload,
    state: SubAgentRunState,
  ): void {
    // Snapshot the PARENT's own captured globals (never the shared slot) for restore at the sub-agent's
    // terminal transition.
    state.ownerGlobals = this.host.getOwnerGlobals(state.spawnerSessionId)
    this.registry.registerLive(sessionId, state)
    // Index the public `a…` taskId → native sessionId (shared by spawn + resume;
    // a resume reuses the same taskId, so this is idempotent).
    this.registry.indexTaskId(state.taskId, sessionId)
    // Surface the new (or resumed) running sub-agent on the human-facing
    // Background Tasks drawer right away (UI-F1); coalesced by scheduleSummary.
    this.host.scheduleSummary()

    // Pass the parent so a sub-agent session nests under
    // `<spawnerSessionId>/subagents/` (covers both fresh spawn and AgentResume —
    // both reach here via `state.spawnerSessionId`).
    const backend = this.host.prepareWorkerStorage(
      sessionId,
      initPayload,
      state.spawnerSessionId,
    )
    // Restart-restore seed: record the run on disk as `running` now (routing
    // for its dir was just committed above), so a run the app's death kills
    // still restores — as `stopped`/interrupted — on the next start.
    this.host.persistSubAgentTaskFile(
      state.spawnerSessionId,
      sessionId,
      JSON.stringify(taskFileFromRunState(state)),
    )
    const { worker, instanceId } = this.host.createWorker(sessionId, backend)
    this.host.registerSessionEntry(sessionId, worker, instanceId, {
      ...(initPayload.projectRoot ? { projectRoot: initPayload.projectRoot } : {}),
      ...(initPayload.templateType
        ? { templateType: initPayload.templateType }
        : {}),
    })

    // Per-sub-agent abort: aborting interrupts the worker. Used
    // by `TaskStop` (G1) and the parent-close cascade to stop an in-flight run.
    const abort = new AbortController()
    this.aborts.set(sessionId, abort)
    abort.signal.addEventListener(
      'abort',
      () => {
        const w = this.host.getSessionWorker(sessionId)
        if (w) {
          void w.receiveFrame({
            type: 'worker.interrupt',
            sessionId,
            payload: {},
          } as SessionWorkerInboundMessage)
        }
      },
      { once: true },
    )

    // Single terminal authority: drive init + one turn using submitAndWait, compute ONE
    // terminal result, and finalize exactly once. The emit interceptor no
    // longer finalizes — it only accumulates stream events, marks
    // `completed`, and records a `worker.error` summary for this path to
    // consume — so the emit path can never reap the session while
    // executeSubmit is still unwinding.
    void (async () => {
      const terminal = await this.runSubAgentTurn(
        worker,
        sessionId,
        initPayload,
        state,
      )
      this.finalizeSubAgentRun(sessionId, terminal.status, terminal.summary)
    })()
  }

  /**
   * Drive a sub-agent run's init + single turn and compute its terminal
   * result. NEVER finalizes — the caller owns the single
   * `finalizeSubAgentRun` call site. A `worker.error` recorded by the emit
   * interceptor outranks a clean-looking settle.
   */
  private async runSubAgentTurn(
    worker: AgentRuntimeWorkerHandle,
    sessionId: string,
    initPayload: AgentRuntimeWorkerInitPayload,
    state: SubAgentRunState,
  ): Promise<{ status: 'success' | 'error' | 'stopped'; summary: string }> {
    try {
      await worker.receiveFrame({
        type: 'worker.init',
        sessionId,
        payload: initPayload,
      } as SessionWorkerInboundMessage)
    } catch (err) {
      return {
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
        return { status: 'error', summary: result.message }
      }
      if (result.status === 'aborted') {
        return {
          status: 'stopped',
          summary: extractFinalAssistantText(state.messages),
        }
      }
    } catch (err) {
      return {
        status: 'error',
        summary: err instanceof Error ? err.message : String(err),
      }
    }

    // Turn settled as completed. A worker.error the emit interceptor
    // recorded mid-run outranks the clean settle — the run surfaced an
    // error the parent must see (the removed emit-path finalize used to
    // report it immediately; it is now reported once, here).
    if (state.emitErrorSummary !== undefined) {
      return { status: 'error', summary: state.emitErrorSummary }
    }
    return {
      status: 'success',
      summary: extractFinalAssistantText(state.messages),
    }
  }

  // --- Terminal transitions ---

  /**
   * Finalize a background sub-agent: reap its session entry, record a terminal
   * `FinishedSubAgentRecord` (so `TaskOutput`/`AgentResume` can reach it after
   * reaping + resolve any blocking `TaskOutput` waiters), and — unless this is a
   * `stopped` run — queue its result for delivery into the parent. Idempotent:
   * the run state is removed on first call so a duplicate `worker.completed` is
   * a no-op.
   */
  private finalizeSubAgentRun(
    sessionId: string,
    status: 'success' | 'error' | 'stopped',
    summary: string,
    opts: { deliver?: boolean } = {},
  ): void {
    const state = this.agentTask(sessionId)
    if (!state) return
    this.registry.deleteLive(sessionId)
    this.aborts.delete(sessionId)
    // Restore the owner runtime's process globals BEFORE `recordFinishedSubAgent`
    // resolves any blocking `TaskOutput` waiter — the waiter's resolution lets
    // the parent's turn resume, and it must resume against its OWN (live) fs /
    // storage, not this just-reaped sub-agent's.
    this.restoreOwnerGlobals(state)
    // Synchronously remove the session entry so a resume can immediately
    // re-register. Worker dispose is async; the instance guard drops
    // any late events from the old worker.
    this.host.reapSessionEntry(sessionId)
    this.recordFinishedSubAgent({
      type: 'local_agent',
      taskId: state.taskId,
      sessionId,
      agentId: state.agentId,
      spawnerSessionId: state.spawnerSessionId,
      description: state.description,
      agentType: state.agentType,
      status,
      summary,
      // Capture the full projected transcript before the run is reaped so the
      // detail view stays readable when finished (not just while running).
      transcript: projectSubAgentTranscript(state.messages),
      prompt: state.prompt,
      startedAt: state.startedAt,
      finishedAt: Date.now(),
      depth: state.depth,
      systemPrompt: state.systemPrompt,
      model: state.model,
      modelProviderId: state.modelProviderId,
      effectiveModel: state.effectiveModel,
      effort: state.effort,
      allowTools: state.allowTools,
      disallowTools: state.disallowTools,
      projectRoot: state.projectRoot,
      routineOriginId: state.routineOriginId,
    })
    // Worktree cleanup (G7): remove the sub-agent's worktree if it has no
    // changes (the closure, built by SpawnAgentTool with a git-capable context,
    // decides). Best-effort, fire-and-forget.
    void state.onCleanup?.()
    // A stopped run is not delivered to the parent (the model invoked TaskStop,
    // so it already knows); success/error deliver as before.
    const deliver = opts.deliver ?? status !== 'stopped'
    if (deliver) {
      this.host.deliverTaskResult(state.spawnerSessionId, {
        type: 'local_agent',
        // Carry the PUBLIC `a…` taskId so the delivery turn (and the dedup + the
        // `acknowledgeSubAgentResult` filter) key on what the model sees, letting
        // it correlate to TaskOutput / AgentResume.
        taskId: state.taskId,
        agentId: state.agentId,
        description: state.description,
        agentType: state.agentType,
        status: status === 'error' ? 'error' : 'success',
        summary,
      })
    }
  }

  /**
   * Abort + reap a running background sub-agent (`TaskStop`, G1) — the
   * sub-agent branch of the Manager's kind-agnostic `stopSubAgent`. Records a
   * `stopped` terminal state (readable via `TaskOutput`) and does NOT deliver
   * a result to the parent. No-op-safe on a non-live id.
   */
  stopRun(nativeId: string): SubAgentStopResult {
    const run = this.agentTask(nativeId)
    if (!run) return { status: 'not_found' }
    const description = run.description
    const partial = extractFinalAssistantText(run.messages)
    const record: FinishedSubAgentRecord = {
      type: 'local_agent',
      taskId: run.taskId,
      sessionId: nativeId,
      agentId: run.agentId,
      spawnerSessionId: run.spawnerSessionId,
      description: run.description,
      agentType: run.agentType,
      status: 'stopped',
      summary: partial
        ? `Stopped by request. Partial output:\n${partial}`
        : 'Stopped by request (no output produced yet).',
      // Keep the partial transcript readable after the run is reaped.
      transcript: projectSubAgentTranscript(run.messages),
      prompt: run.prompt,
      startedAt: run.startedAt,
      finishedAt: Date.now(),
      depth: run.depth,
      systemPrompt: run.systemPrompt,
      model: run.model,
      modelProviderId: run.modelProviderId,
      effectiveModel: run.effectiveModel,
      effort: run.effort,
      allowTools: run.allowTools,
      disallowTools: run.disallowTools,
      projectRoot: run.projectRoot,
      routineOriginId: run.routineOriginId,
    }
    // Restore the owner runtime's process globals BEFORE the parent's turn
    // continues (TaskStop returns synchronously, so the parent's very next
    // step reads fs/storage). Without this, the reaped sub-agent's fs stays
    // installed as the global and the parent's next read hangs on a dropped
    // bridge response — the same deadlock TaskOutput(block) hit.
    this.restoreOwnerGlobals(run)
    // Prevent an immediate resume from reusing this session id until native
    // teardown and worktree cleanup have both settled.
    const teardown = this.teardown(nativeId)
      .catch(() => {})
      .then(() => Promise.resolve(run.onCleanup?.()).catch(() => {}))
    this.pendingTeardowns.set(nativeId, teardown)
    void teardown.finally(() => {
      if (this.pendingTeardowns.get(nativeId) === teardown) {
        this.pendingTeardowns.delete(nativeId)
      }
    })
    this.recordFinishedSubAgent(record)
    return { status: 'stopped', description }
  }

  /**
   * Forcefully tear down an in-flight background sub-agent —
   * abort (interrupt the worker), fire the C++ `session_deleted` cascade (tab
   * cleanup), and reap all bookkeeping. Unlike `finalizeSubAgentRun`, it does
   * NOT deliver a result (used when the parent is going away). Idempotent: the
   * run-state delete makes a later `finalizeSubAgentRun`/emit a no-op.
   */
  async teardown(sessionId: string): Promise<void> {
    // Read the run state BEFORE the registry delete drops it — the
    // owner-globals snapshot rides on it.
    const state = this.agentTask(sessionId)
    this.aborts.get(sessionId)?.abort()
    this.aborts.delete(sessionId)
    this.registry.deleteLive(sessionId)
    // Finalize and stopRun both restore the owner runtime's
    // process globals — but this path (the parent-close cascade) did NOT,
    // so the realm's global fs/store could stay pointed at the disposed
    // child's transport. Any OTHER live session reading the globals (shell
    // output persistence, settings writes) would then hang on a dropped
    // bridge response. Idempotent on the stopRun route, which restored the
    // same owner snapshot before calling us.
    if (state) {
      this.restoreOwnerGlobals(state)
    }
    // The running sub-agent just vanished from the bar (parent-close cascade) —
    // push the change (UI-F1). Fires even on the early `!worker` return below.
    this.host.scheduleSummary()
    const worker = this.host.getSessionWorker(sessionId)
    if (!worker) return
    void worker.receiveFrame({
      type: 'worker.interrupt',
      sessionId,
      payload: {},
    } as SessionWorkerInboundMessage)
    // Unified disposal (fire C++ stop, clear ports, await dispose, delete).
    await this.host.disposeManagedSession(sessionId, { fireStop: true })
  }

  /**
   * Restore the process-global runtime singletons to the parent's snapshot (`state.ownerGlobals`),
   * before the parent resumes (`finalizeSubAgentRun`, `stopRun`). No-op if nothing was captured.
   */
  private restoreOwnerGlobals(state: SubAgentRunState): void {
    const owner = state.ownerGlobals
    if (!owner) return
    installProcessFs(owner.fs)
    if (owner.conversationStore) setConversationStore(owner.conversationStore)
    setActiveSidechainStore(owner.sidechainStore)
  }

  /**
   * Seed a registry record restored from disk (app restart lost the in-memory
   * registry; the manager re-reads `task.json` / `meta.json` — see
   * `SharedWorkerSessionManager.restoreFinishedSubAgentsFromDisk`). Skipped if
   * the session is already known (live or finished). Deliberately does NOT go
   * through `recordFinishedSubAgent`: a restore must not resolve waiters or
   * re-persist the file it was just read from.
   */
  seedRestoredRecord(record: FinishedSubAgentRecord): boolean {
    if (
      this.agentTask(record.sessionId) ||
      this.finishedAgent(record.sessionId)
    ) {
      return false
    }
    this.registry.recordFinished(record.sessionId, record)
    this.registry.indexTaskId(record.taskId, record.sessionId)
    this.registry.evictFinishedOverCap('local_agent', MAX_FINISHED_SUBAGENTS)
    return true
  }

  /**
   * Store a terminal sub-agent record (FIFO-capped) and resolve any blocking
   * `TaskOutput` waiters parked on this sub-agent. Insertion order is
   * chronological, so the oldest key is the eviction target.
   */
  private recordFinishedSubAgent(record: FinishedSubAgentRecord): void {
    this.registry.recordFinished(record.sessionId, record)
    this.registry.evictFinishedOverCap('local_agent', MAX_FINISHED_SUBAGENTS)
    // Restart-restore seed: flip the on-disk `task.json` from `running` to the
    // terminal record (status/summary/finishedAt). Best-effort.
    this.host.persistSubAgentTaskFile(
      record.spawnerSessionId,
      record.sessionId,
      JSON.stringify(taskFileFromFinishedRecord(record)),
    )
    // A terminal transition (running → success/error/stopped) changes the
    // bar's rows; push it (UI-F1). Single point for both finalize and stop.
    this.host.scheduleSummary()
    this.resolveWaiters(record.sessionId)
  }

  // --- Live-run emit interception ---

  /**
   * Background sub-agent interception (worker-hosted Agent tool). Mirrors the
   * headless interceptor: accumulate stream events for final-text extraction,
   * RECORD terminal signals (the single finalizer in the
   * submitAndWait path consumes them), still route bridge requests so
   * the sub-agent's model / fs.* requests reach the host. No ports → no broadcast.
   * Returns false when the session is not a live sub-agent run.
   */
  interceptEmit(
    sessionId: string,
    message: AgentWorkerOutboundMessage,
  ): boolean {
    const subAgentState = this.agentTask(sessionId)
    if (!subAgentState) return false
    if (message.type === 'worker.stream') {
      const event = (message.payload as { event?: unknown })?.event
      if (event !== undefined) {
        subAgentState.messages.push(event)
        // Liveness (G5): record activity so TaskOutput/AgentList can show the
        // run is making progress (and how long since the last update).
        subAgentState.lastActivityAt = Date.now()
        // Push the bumped update count to the human-facing
        // Background Tasks drawer (UI-F1) — coalesced by scheduleSummary, so
        // a burst of stream events flushes at most once per SUMMARY_COALESCE_MS.
        this.host.scheduleSummary()
      }
    } else if (message.type === 'worker.completed') {
      // Mark only — the submitAndWait resolution path
      // (`runSubAgentTurn`) settles for this same turn and finalizes exactly
      // once, so the emit path can never reap the session mid-unwind.
      subAgentState.completed = true
    } else if (message.type === 'worker.error') {
      // Record for the single finalizer to consume. First error wins — a
      // cascade of follow-on errors must not overwrite the root cause.
      subAgentState.completed = true
      if (subAgentState.emitErrorSummary === undefined) {
        const payload = message.payload as { code?: string; message?: string }
        subAgentState.emitErrorSummary = `Sub-agent failed: ${payload?.code ?? 'unknown'} — ${payload?.message ?? ''}`
      }
    }
    if (message.type === 'worker.bridgeRequest') {
      this.host.routeBridgeRequest(sessionId, message.payload)
    }
    return true
  }

  // --- Lifecycle ---

  dispose(): void {
    this.waiters.clear()
    this.aborts.clear()
  }

  /** Test/internal visibility: whether a per-run abort is registered. */
  hasAbort(sessionId: string): boolean {
    return this.aborts.has(sessionId)
  }
}
