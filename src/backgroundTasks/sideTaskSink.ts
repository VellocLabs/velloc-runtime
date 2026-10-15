/**
 * Module-level sink for side-channel model conversations (in-process forks and
 * fast-model calls), so the session manager can list them as background tasks.
 * Instrumented at the two choke points; avoids an import cycle. No-op by
 * default.
 */

import type { Message } from '../runtime/RuntimeTypes'
import type { TurnOrigin } from '../runtime/interfaces/QueryRuntimeDeps'

/** Fired by `launchFork` just before its query loop starts. */
export type ForkTaskStart = {
  /** The fork's sidechain agent id — the task's NATIVE id (registry map key,
   *  correlation key for progress/finish, sidechain-transcript file name). */
  agentId: string
  /** The session that spawned the fork — scopes the row to that session's
   *  drawer, exactly like a sub-agent's / shell's `spawnerSessionId`. */
  spawnerSessionId?: string
  /** Telemetry tag of the spawning side-channel (`skill_fork`,
   *  `extract_memories`, `periodic_tidy`, `hook_agent`, `agent_tool`). */
  querySource: TurnOrigin
  /** The fork's label (skill/command name, or 'subagent'/'fork' defaults). */
  forkLabel: string
  /** Named-agent type when the fork resolves one (e.g. 'general-purpose'). */
  agentType?: string
  /** Caller-provided human description, when set (Agent tool `description`). */
  description?: string
  /** The model the fork ACTUALLY runs under (post-override). */
  model?: string
  /** The prompt text handed to the fork — detail-view only, may be long. */
  prompt?: string
  /** The fork's effective system prompt, serialized for display (the custom
   *  override when set, else the inherited parent prompt). Detail-view only. */
  systemPrompt?: string
  startedAt: number
  /** Aborts the fork's child AbortController — powers the drawer's Stop. */
  abort: () => void
}

/** Fired by `launchFork` when its query loop ends (or throws). */
export type ForkTaskFinish = {
  agentId: string
  status: 'success' | 'error' | 'stopped'
  finishedAt: number
  errorMessage?: string
  /** The model the fork ACTUALLY ended on. Differs from the started `model`
   *  only when a runtime failure fell the fork back to the parent tail — the
   *  finish then corrects the drawer row off the stale head model. */
  model?: string
}

/** Fired by `queryFastModel` just before it issues the one-shot request. */
export type FastCallStart = {
  /** Correlation key minted per call (fast calls have no native id of their
   *  own — no session, no shell, no sidechain). */
  callId: string
  /** The session whose turn triggered the call. */
  spawnerSessionId?: string
  /** Telemetry tag (`rename_generate_name`, `memory_recall`,
   *  `web_fetch_apply`, `fast_model_call`). */
  querySource: TurnOrigin
  providerId?: string
  /** The resolved model the request goes out with (fast model or fallback). */
  model?: string
  /** The user prompt of the one-shot — detail-view only, may be long. */
  prompt?: string
  /** The system prompt sent with the one-shot, serialized for display (e.g.
   *  the fixed session-title namer prompt). Detail-view only, may be long. */
  systemPrompt?: string
  startedAt: number
}

/** Fired by `queryFastModel` when the one-shot resolves (or throws).
 *  A throw caused by the caller's abort signal reports 'stopped' (a user
 *  Stop mid-turn is not a failure), mirroring the fork status mapping. */
export type FastCallFinish = {
  callId: string
  status: 'success' | 'error' | 'stopped'
  finishedAt: number
  /** The assistant's response text (truncated) — the detail view's output. */
  responseText?: string
  errorMessage?: string
  /** The model that ACTUALLY produced the result. Set only when a fallback
   *  retry changed it from the started `model` (a failed pin/tier degrading to
   *  the parent) — the finish then corrects the drawer row. */
  model?: string
}

/** Fired by the `run_js` tool just before it dispatches the script. */
export type RunJsTaskStart = {
  /** The tool CALL id — the run's native id AND public task id (so the
   *  conversation card can jump to the drawer with the id it already holds). */
  callId: string
  /** The session whose turn issued the run. */
  spawnerSessionId?: string
  /** The model's `description` arg — the drawer row label + detail header. */
  description?: string
  /** The JS source the run executes — detail-view only, held in memory (never
   *  persisted to the transcript). May be large. */
  code: string
  /** The local file the code was read from, when `path` was used. */
  path?: string
  /** The run's `inputs` data values — detail-view only (rendered next to the
   *  JS source so the content a generic script writes stays reviewable),
   *  never persisted to the transcript. May be large. */
  inputs?: Record<string, unknown>
  /** The execution timeout the run was launched with (seconds). */
  timeoutSec?: number
  /** True when the code was supplied inline (`code`) vs. read from `path`. */
  inlineCode: boolean
  startedAt: number
}

/** Fired by the `run_js` tool when the script settles (or throws). A throw
 *  caused by the caller's abort reports 'stopped' (a user Stop mid-turn is not
 *  a failure), mirroring the fork/fast status mapping. */
export type RunJsTaskFinish = {
  callId: string
  status: 'success' | 'error' | 'stopped'
  finishedAt: number
  /** The run's output (script return + console) or the error text — the detail
   *  view's result block. */
  resultText?: string
}

export type SideTaskSink = {
  forkStarted: (start: ForkTaskStart) => void
  /** Per persisted (non-stream) fork message — drives liveness (updates /
   *  lastActivityAt) and the live detail transcript. */
  forkProgress: (agentId: string, message: Message) => void
  forkFinished: (finish: ForkTaskFinish) => void
  fastCallStarted: (start: FastCallStart) => void
  fastCallFinished: (finish: FastCallFinish) => void
  runJsStarted: (start: RunJsTaskStart) => void
  runJsFinished: (finish: RunJsTaskFinish) => void
}

let sink: SideTaskSink | null = null

/** Register the sink. The manager calls this in its init; pass `null` to clear. */
export function setSideTaskSink(next: SideTaskSink | null): void {
  sink = next
}

export function notifyForkStarted(start: ForkTaskStart): void {
  sink?.forkStarted(start)
}

export function notifyForkProgress(agentId: string, message: Message): void {
  sink?.forkProgress(agentId, message)
}

export function notifyForkFinished(finish: ForkTaskFinish): void {
  sink?.forkFinished(finish)
}

export function notifyFastCallStarted(start: FastCallStart): void {
  sink?.fastCallStarted(start)
}

export function notifyFastCallFinished(finish: FastCallFinish): void {
  sink?.fastCallFinished(finish)
}

export function notifyRunJsStarted(start: RunJsTaskStart): void {
  sink?.runJsStarted(start)
}

export function notifyRunJsFinished(finish: RunJsTaskFinish): void {
  sink?.runJsFinished(finish)
}
