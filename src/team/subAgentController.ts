/**
 * Leaf indirection (avoids an import cycle) for the background sub-agent control
 * tools: the manager registers via `setSubAgentController`; tools read
 * `getSubAgentController()`, null outside the background runtime.
 */

/** A point-in-time view of a background task, for `TaskOutput`. */
export type SubAgentSnapshot = {
  /** The task id — `subagent-…` for agents, or the shell_id for local_bash. */
  sessionId: string
  /** Lifecycle status. `running` = in flight; the rest are terminal. */
  status: 'running' | 'success' | 'error' | 'stopped'
  /** 3-5 word task label from the original spawn, or shell command. */
  description: string
  /** Task backend type. Each kind keeps its own registry; all share one task-control surface. */
  taskType?: 'local_agent' | 'local_bash' | 'local_supershell' | 'local_plugin'
  /** Resolved `subagent_type`, when the run used a named agent. */
  agentType?: string
  /** Final assistant text when terminal; best-effort partial text when running. */
  output: string
  /** `local_bash` only: the process exit code when terminal (the same field
   *  the raw foreground `Exec` result `{output, exit_code}` carries). Absent for agents /
   *  while running; -1 / null when the host reported no code. */
  exitCode?: number | null
  /** Unix ms when the (current) run started. */
  startedAt: number
  /** Liveness: count of stream/poll updates seen so far. Present while running. */
  updates?: number
  /** Liveness: Unix ms of the last stream/poll update. Present while running. */
  lastActivityAt?: number
}

/** Result of a `TaskStop` request. */
export type SubAgentStopResult = {
  status: 'stopped' | 'not_found' | 'already_finished'
  /** The task label, when the id resolved. */
  description?: string
}

/** One row of `AgentList` — a background sub-agent launched from a session. */
export type SubAgentListEntry = {
  /** The sub-agent's session id — the handle for TaskOutput/TaskStop/AgentResume. */
  sessionId: string
  /** Lifecycle status. `running` = in flight; the rest are terminal. */
  status: 'running' | 'success' | 'error' | 'stopped'
  /** 3-5 word task label from the original spawn. */
  description: string
  /** Resolved `subagent_type`, when the run used a named agent. */
  agentType?: string
  /** Unix ms when the (current) run started. */
  startedAt: number
  /** Unix ms when the run reached a terminal state; absent while running. */
  finishedAt?: number
  /** Liveness: count of stream updates seen so far. Present while running. */
  updates?: number
  /** The id the sub-agent's own loop carries as `agentId` on its events. */
  loopId?: string
}

/** The `agentId` a sub-agent's own loop carries, from its native session id. */
export function subAgentLoopId(nativeSessionId: string): string {
  return nativeSessionId.startsWith('subagent-') ? nativeSessionId.slice('subagent-'.length) : nativeSessionId
}

/** Result of an `AgentResume` request. */
export type SubAgentResumeResult =
  | { ok: true; sessionId: string }
  | {
      ok: false
      /** `not_found` (no record), `still_running` (resume a live run),
       *  `unavailable` (runtime not ready). */
      reason: 'not_found' | 'still_running' | 'unavailable'
    }

export type SubAgentController = {
  /** Non-blocking snapshot of a running or finished sub-agent; null if unknown. */
  getSnapshot(sessionId: string): SubAgentSnapshot | null
  /**
   * Resolve when the sub-agent ends, or with its running snapshot after
   * `timeoutMs`; null for an unknown id. When `signal` aborts, resolves at once
   * and stops the sub-agent.
   */
  waitForCompletion(
    sessionId: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<SubAgentSnapshot | null>
  /** Abort + reap a running sub-agent; records a `stopped` terminal state. */
  stop(sessionId: string): SubAgentStopResult
  /**
   * Re-launch a FINISHED sub-agent into its persisted transcript with a
   * follow-up `prompt`. The resumed run delivers its result back to the
   * original parent like any background sub-agent.
   */
  resume(sessionId: string, prompt: string): SubAgentResumeResult
  /**
   * Enumerate the background sub-agents launched from `spawnerSessionId` —
   * in-flight runs plus retained terminal records — so the model can discover
   * the ids it needs for TaskOutput / TaskStop / AgentResume. Running entries
   * sort first.
   */
  list(spawnerSessionId: string): SubAgentListEntry[]
  /**
   * Mark a finished sub-agent's result as already seen by the model (it just
   * read the terminal result via `TaskOutput`), so the manager SUPPRESSES the
   * otherwise-automatic `<task-notification>` delivery turn for it —
   * avoiding a duplicate answer + wasted re-activation. Optional so test /
   * mock controllers needn't implement it. No-op if nothing is pending.
   */
  acknowledgeResult?(sessionId: string): void
  /**
   * Hold a LIVE sub-agent's result for a waiter: when it finishes while held,
   * its `<task-notification>` is kept back instead of queued. The returned
   * release takes whether the waiter consumed the result; the last release
   * of an unconsumed held result delivers it after all. Undefined when the
   * sub-agent is not live (nothing to hold). Optional for mocks.
   */
  holdResult?(sessionId: string): ((consumed: boolean) => void) | undefined
}

let controller: SubAgentController | null = null

export function setSubAgentController(fn: SubAgentController | null): void {
  controller = fn
}

export function getSubAgentController(): SubAgentController | null {
  return controller
}
