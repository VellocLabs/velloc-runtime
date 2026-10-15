/**
 * taskTypes — the background-task domain model: per-kind run-state and finished-record types, the
 * unions the TaskRegistry uses, the delivery-result union and retention caps. Declarations only.
 */
import type { RuntimeFs } from '../../utils/fs/runtimeFs'
import type {
  BrowserSessionCounters,
  getConversationStore,
} from '../../sessions/sessionStore'
import type { getActiveSidechainStore } from '../../utils/sidechainTranscripts'
import type { NexusTaskTranscriptEntry } from '../bridge/protocol/ui'
import type { HeadlessRunResult } from '../../routines/HeadlessRunner'
import type {
  BackgroundShellRunState,
  FinishedBackgroundShellRecord,
  BackgroundShellDeliveryResult,
} from './BackgroundShellCoordinator'

/**
 * Per-background-sub-agent run state (the worker-hosted `Agent` tool path).
 * Stream events accumulate here so the final summary can be extracted on
 * `worker.completed`, then delivered into the parent session as a later turn.
 * Mirrors `HeadlessRunState` but is callback-driven (nobody awaits a
 * background sub-agent) and carries the parent + nesting depth.
 */
export type SubAgentRunState = {
  /** Discriminant for the unified task registry (`tasks`): one map keyed by
   *  native id, a discriminated union on `type`. */
  type: 'local_agent'
  /** Public task id with its kind prefix (`a…`) — the model/drawer/control handle. The
   *  map is keyed by the NATIVE worker `sessionId`; `taskId` is surfaced. */
  taskId: string
  spawnerSessionId: string
  sessionId: string
  agentId: string
  description: string
  agentType?: string
  /** The directive driving this run — kept so a resumed/finalized run can
   *  re-submit it and so the launch IIFE reads it from one place. */
  prompt: string
  /** StreamRecord events from `worker.stream`; scanned for the final text. */
  messages: unknown[]
  completed: boolean
  /** Nesting depth (parent sub-agent's depth + 1); caps runaway recursion. */
  depth: number
  startedAt: number
  /** Liveness (G5): Unix ms of the last `worker.stream` event seen. */
  lastActivityAt: number
  // Resume params — retained so a stopped or
  // finished sub-agent can be re-launched into its persisted transcript with
  // the same agent identity (system prompt / model / tool scope / worktree).
  systemPrompt?: string
  model?: string
  /** Provider paired with a TIER-resolved `model` (the Agent tool's
   *  `model: 'fast'|'balanced'|'best'` param); resume re-injects the exact
   *  pair. Absent for frontmatter-model and inherited runs. */
  modelProviderId?: string
  /** The model this run ACTUALLY boots on, for the detail view's "Model" line:
   *  the explicit `model` when set, else the parent's live selection it inherits
   *  (`model` stays undefined for inherited runs so resume re-inherits — see
   *  `spawnSubAgentSession`'s modelOverride). Display-only; never drives resume. */
  effectiveModel?: string
  /** The reasoning effort / thinking tier the run boots on, for the detail
   *  view's "Effort" line: a tier-resolved spawn's declared tier, else the
   *  inherited parent tier. Display-only; never drives resume. */
  effort?: string
  allowTools?: string[]
  disallowTools?: string[]
  projectRoot?: string
  /** Routine this run's work originates from, inherited from the spawning
   *  context. Retained (like the resume params above) so `AgentResume` can
   *  re-stamp it — a resumed run of a routine-originated sub-agent is still
   *  routine-originated, and re-reading the parent is not possible once the
   *  spawning turn is gone. */
  routineOriginId?: string
  /** Worktree-cleanup callback (G7); invoked once on finalize/stop. */
  onCleanup?: () => void | Promise<void>
  /** A `worker.error` the emit interceptor observed mid-run; consumed by the
   *  single terminal authority (`runSubAgentTurn`) — first error wins. The
   *  emit path never finalizes. */
  emitErrorSummary?: string
  /**
   * The parent runtime's captured singletons (fs, conversation store, sidechain store), restored at this
   * sub-agent's terminal transition BEFORE the parent's turn resumes; never re-read from the shared slot.
   */
  ownerGlobals?: OwnerRuntimeGlobals
}

/** Process-global runtime singletons a sub-agent boot clobbers; see `ownerGlobals`. */
export type OwnerRuntimeGlobals = {
  fs: RuntimeFs
  conversationStore: ReturnType<typeof getConversationStore>
  sidechainStore: ReturnType<typeof getActiveSidechainStore>
}

/** A finished sub-agent's result, queued for delivery into the parent turn. */
export type SubAgentResult = {
  type: 'local_agent'
  /** Public `a…` task id — the id the model saw at launch (dedup/ack key + the
   *  `<task-id>` in the delivered `<task-notification>`). */
  taskId: string
  agentId: string
  description: string
  agentType?: string
  status: 'success' | 'error'
  summary: string
}

/**
 * One finished background task's result queued for delivery to its parent.
 * Every kind is one member of this discriminated union and is delivered
 * through one path as one `<task-notification>` block (see
 * `formatTaskNotifications`), replacing the former
 * split `SubAgentResult`/`BackgroundShellDeliveryResult` delivery paths.
 */
export type NexusTaskDeliveryResult =
  | SubAgentResult
  | BackgroundShellDeliveryResult
  | SuperShellDeliveryResult

/** A finished background SuperShell invocation's result, queued for delivery.
 *  Formatted like an agent result (`<description>: <summary>`). */
export type SuperShellDeliveryResult = {
  type: 'local_supershell'
  taskId: string
  description: string
  status: 'success' | 'error'
  summary: string
}

/**
 * A terminal record for a finished/stopped sub-agent, retained so `TaskOutput`
 * can read its result after the live run is reaped and `AgentResume` can
 * re-launch it.
 */
export type FinishedSubAgentRecord = {
  type: 'local_agent'
  /** Public task id with its kind prefix (`a…`) — see SubAgentRunState.taskId. */
  taskId: string
  sessionId: string
  agentId: string
  spawnerSessionId: string
  description: string
  agentType?: string
  status: 'success' | 'error' | 'stopped'
  summary: string
  /** Read-only transcript projected from the live `run.messages` at finalize/
   *  stop. `subAgentRuns` is deleted on terminal transition, so without
   *  capturing it here the detail view went BLANK the moment a sub-agent
   *  finished / was stopped (and after a webview reload) — the disk fallback in
   *  `loadSubAgentTranscript` isn't reliably resolvable for a reaped sub-agent
   *  session. Held in-memory so it survives reaping + a reload (SharedWorker
   *  lives across the page reload). */
  transcript?: NexusTaskTranscriptEntry[]
  /** The directive that drove this run — retained for the detail view's "Task"
   *  line (the live run's `prompt`; lost without this since the spawn args are
   *  gone once the run is reaped). */
  prompt?: string
  startedAt: number
  finishedAt: number
  depth: number
  systemPrompt?: string
  model?: string
  /** Provider paired with a TIER-resolved `model` (see SubAgentRunState) —
   *  `AgentResume` re-injects the exact pair. */
  modelProviderId?: string
  /** Display-only resolved model for the detail view (see SubAgentRunState). */
  effectiveModel?: string
  /** Display-only reasoning effort / thinking tier (see SubAgentRunState). */
  effort?: string
  allowTools?: string[]
  disallowTools?: string[]
  projectRoot?: string
  /** Routine origin of the finished run (see SubAgentRunState) — `AgentResume`
   *  re-stamps it so a resumed routine-originated sub-agent stays guarded. */
  routineOriginId?: string
}

/** Hard cap on background sub-agent nesting (a sub-agent spawning a sub-agent,
 *  …). Prevents a runaway tree of worker sessions; the fuller depth/abort
 *  treatment is a later milestone. */
export const MAX_SUBAGENT_DEPTH = 3

/** Cap on retained finished sub-agent records (FIFO eviction). Bounds memory
 *  across a long session; `TaskOutput`/`AgentResume` on an evicted id degrade
 *  gracefully (the result was also delivered as a turn). */
export const MAX_FINISHED_SUBAGENTS = 100

/** Bound on the finished sub-agent tail carried in the sessions-summary
 *  broadcast (G2 human-facing) — recent completions are useful context, but the
 *  full retained set (up to MAX_FINISHED_SUBAGENTS) needn't ride every flush. */
export const MAX_SUBAGENT_SUMMARY_FINISHED = 20

/** Frozen all-zero per-session tool/MCP counters — spread to copy. Shared by
 *  the Manager's session-entry registration and the feed's metadata refresh. */
export const ZERO_COUNTERS: BrowserSessionCounters = Object.freeze({
  tool: 0,
  toolFail: 0,
  mcp: 0,
  mcpFail: 0,
}) as BrowserSessionCounters

// ---------- In-process fork (`local_fork` task) types ----------

/**
 * In-flight in-process fork (`launchFork`), announced by the `sideTaskSink` leaf and keyed by its native
 * sidechain `agentId`. Runs inline in the parent's realm; `abort` aborts its child controller.
 */
export type ForkRunState = {
  type: 'local_fork'
  /** Public task id with its kind prefix (`f…`) — the drawer/control handle. */
  taskId: string
  agentId: string
  spawnerSessionId: string
  /** The spawning side-channel's telemetry tag (`skill_fork`, …). */
  querySource: string
  forkLabel: string
  description: string
  agentType?: string
  /** The model the fork actually runs under (post-override). */
  model?: string
  /** The fork's prompt — the detail view's "Task" line. */
  prompt?: string
  /** The fork's effective system prompt — the detail view's "System prompt". */
  systemPrompt?: string
  /** Persisted fork messages pushed by the sink's progress notifications. */
  messages: unknown[]
  startedAt: number
  lastActivityAt: number
  /** Aborts the fork's child AbortController (drawer Stop). */
  abort: () => void
  /** Set by a drawer Stop so the finish notification records 'stopped'
   *  even when the fork's loop exits gracefully post-abort. */
  stopRequested: boolean
}

/** Terminal record for a finished/stopped in-process fork. */
export type FinishedForkRecord = {
  type: 'local_fork'
  taskId: string
  agentId: string
  spawnerSessionId: string
  querySource: string
  description: string
  agentType?: string
  model?: string
  prompt?: string
  systemPrompt?: string
  status: 'success' | 'error' | 'stopped'
  summary: string
  /** Projected at finish from the live `messages` (see FinishedSubAgentRecord
   *  — the live state is reaped on terminal transition). */
  transcript?: NexusTaskTranscriptEntry[]
  startedAt: number
  finishedAt: number
}

// ---------- Fast-model one-shot (`local_fast` task) types ----------

/**
 * In-flight one-shot fast-model call (`queryFastModel`) — announced by the
 * `sideTaskSink` leaf. Covers session-title generation, memory recall,
 * WebFetch extraction, and prompt hooks. Keyed by the minted `callId` (a fast
 * call has no native id of its own — no session, no shell, no sidechain).
 * There is no transcript and no Stop: the call is a single request.
 */
export type FastCallRunState = {
  type: 'local_fast'
  /** Public task id with its kind prefix (`c…`) — the drawer handle. */
  taskId: string
  callId: string
  spawnerSessionId: string
  querySource: string
  description: string
  model?: string
  prompt?: string
  /** The system prompt sent with the one-shot — the detail view's
   *  "System prompt" (e.g. the fixed session-title namer directive). */
  systemPrompt?: string
  startedAt: number
}

/** Terminal record for a finished fast call. 'stopped' = the caller's abort
 *  signal fired mid-call (user Stop), reported distinctly from a failure. */
export type FinishedFastCallRecord = {
  type: 'local_fast'
  taskId: string
  callId: string
  spawnerSessionId: string
  querySource: string
  description: string
  model?: string
  prompt?: string
  systemPrompt?: string
  status: 'success' | 'error' | 'stopped'
  summary: string
  /** The assistant's response snippet — the detail view's output. */
  responseText?: string
  startedAt: number
  finishedAt: number
}

// ---------- run_js execution (`local_js` task) types ----------

/**
 * In-flight `run_js` execution (a synchronous tool in a per-call DedicatedWorker) surfaced as a task,
 * keyed by its tool CALL id, which is also the public task id. Holds code + params for the detail view.
 */
export type RunJsRunState = {
  type: 'local_js'
  /** Public task id == the tool `callId` (native id). The registry is keyed by
   *  this; `resolveNative` is identity for this kind. */
  taskId: string
  callId: string
  spawnerSessionId: string
  description: string
  /** The JS source the run executes — the detail view's formatted code block.
   *  Held only in memory (never persisted to the transcript). */
  code: string
  /** The local file the code was read from, when `path` was used. */
  path?: string
  /** The run's `inputs` data values — detail-view only, same in-memory rule
   *  as `code`. */
  inputs?: Record<string, unknown>
  /** The execution timeout the run was launched with (seconds). */
  timeoutSec?: number
  /** True when the code was supplied inline vs. read from `path`. */
  inlineCode: boolean
  startedAt: number
}

/** Terminal record for a finished `run_js` execution. 'stopped' = the run's
 *  turn was interrupted (user Stop) mid-execution. */
export type FinishedRunJsRecord = {
  type: 'local_js'
  taskId: string
  callId: string
  spawnerSessionId: string
  description: string
  code: string
  path?: string
  inputs?: Record<string, unknown>
  timeoutSec?: number
  inlineCode: boolean
  status: 'success' | 'error' | 'stopped'
  /** The run's output (script return value + captured console), or the error
   *  text — the detail view's result block. */
  resultText: string
  startedAt: number
  finishedAt: number
}

// ---------- SuperShell invocation (`local_supershell` task) types ----------

/**
 * A running SuperShell invocation (toolkit/builtin/superShell.ts), registered by the
 * `superShellTaskSink` leaf for the invocation's whole life — inline and, once
 * it outlasts its inline wait, in the background. The native id IS the minted
 * public id (`h…`). `progress` and `stop` are in-process callbacks into the
 * tool: the SharedWorker realm hosts both, so no message crosses a boundary.
 */
export type SuperShellRunState = {
  type: 'local_supershell'
  taskId: string
  /** The SuperShell tool call id — the drawer's handle for this run (its row id
   *  and the conversation card's jump target), accepted wherever the drawer
   *  addresses the task. The model only ever sees `taskId`. */
  toolCallId?: string
  spawnerSessionId: string
  description: string
  code: string
  inputs?: Record<string, unknown>
  startedAt: number
  /** Steps finished so far plus the commands still running — TaskOutput's
   *  partial output and the drawer detail while running. */
  progress: () => string
  /** Stop the whole invocation: its script, its running commands, and the
   *  background processes it started. */
  stop: () => void
}

/** Terminal record for a SuperShell invocation. */
export type FinishedSuperShellRecord = {
  type: 'local_supershell'
  taskId: string
  /** See SuperShellRunState.toolCallId. */
  toolCallId?: string
  spawnerSessionId: string
  description: string
  code: string
  inputs?: Record<string, unknown>
  status: 'success' | 'error' | 'stopped'
  /** The tool result text the invocation produced. */
  resultText: string
  startedAt: number
  finishedAt: number
}

// The finished-`local_js` FIFO cap lives with the other SideTaskCoordinator-owned
// caps (MAX_FINISHED_FORKS / MAX_FINISHED_FAST_CALLS) in SideTaskCoordinator.ts,
// not here — only the Manager-owned kinds (sub-agent, routine) cap from this file.

// ---------- Headless routine run (`local_routine` task) types ----------

/** In-flight headless routine run — the Manager's RoutineCoordinator entry. */
export type HeadlessRunState = {
  routineId: string
  sessionId: string
  /** StreamRecord events from `worker.stream`. We scan these for the final assistant text. */
  messages: unknown[]
  /** Resolved exactly once by `finalizeHeadlessRun` — the single terminal
   *  authority driven from the submitAndWait resolution path. */
  resolve: (result: HeadlessRunResult) => void
  /** Set by `worker.completed` (informational; the emit path never finalizes). */
  completed: boolean
  /** A `worker.error` the emit interceptor observed mid-run; consumed by the
   *  single terminal authority (`runHeadlessTurn`) — first error wins. */
  emitErrorSummary?: string
  /** Set when `RoutineSignal` writes via registry; the dispatch step in HeadlessRunner re-reads. */
  startedAt: number
  // -- `local_routine` task surfacing (Background Tasks drawer) --
  /** Public task id with its kind prefix (`r…`) — the drawer/control handle. */
  taskId: string
  /** Display label: the routine's user-supplied `name` (falls back to id). */
  description: string
  /** The routine's model override, when set (else the template default). */
  model?: string
  /** The routine's prompt — the detail view's "Task" line. */
  prompt: string
  /** Unix ms of the last `worker.stream` event (drawer liveness). */
  lastActivityAt: number
  /** Set by a drawer Stop so the terminal record reads 'stopped'. */
  stopRequested?: boolean
}

/** FIFO cap on retained finished `local_routine` records. */
export const MAX_FINISHED_ROUTINE_RUNS = 40

/**
 * Terminal record for a finished headless routine run. The LIVE side needs no
 * task state: `headlessRuns` already tracks in-flight runs (the summary rows
 * read it directly); this record preserves the run for the drawer's finished
 * tail + detail view after `finalizeHeadlessRun` reaps the live state.
 * Routine runs have NO parent session (`spawnerSessionId: ''` on their rows) —
 * the webview shows them in every session's drawer (global work).
 */
export type FinishedRoutineRecord = {
  type: 'local_routine'
  /** Public task id with its kind prefix (`r…`) — the drawer handle. */
  taskId: string
  /** The headless run's own (native) session id. */
  sessionId: string
  routineId: string
  description: string
  model?: string
  prompt?: string
  status: 'success' | 'error' | 'stopped'
  summary: string
  transcript?: NexusTaskTranscriptEntry[]
  startedAt: number
  finishedAt: number
}

// ---------- Unified registry unions ----------

/**
 * Unified background-task state, keyed by NATIVE id (sub-agent `sessionId`, shell `shell_id`, fork
 * `agentId`, fast-call `callId`) and discriminated on `type`. Headless routine runs are not here.
 */
export type NexusTaskState =
  | SubAgentRunState
  | BackgroundShellRunState
  | ForkRunState
  | FastCallRunState
  | RunJsRunState
  | SuperShellRunState
export type NexusFinishedTaskRecord =
  | FinishedSubAgentRecord
  | FinishedBackgroundShellRecord
  | FinishedForkRecord
  | FinishedFastCallRecord
  | FinishedRoutineRecord
  | FinishedRunJsRecord
  | FinishedSuperShellRecord
