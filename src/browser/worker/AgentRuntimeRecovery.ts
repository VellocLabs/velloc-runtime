/**
 * AgentRuntimeRecovery — session restore on init: forked plan file copy, pending plan approval,
 * terminal reason, and interrupted-turn detection. One per RuntimeScope, bound via `bindRuntime`.
 */
import type { AgentRuntimeState } from '../runtime/AgentRuntimeState'
import { copyPlanFileForFork, getPlanFilePathForSession } from '../../utils/planFiles'
import { PLAN_OFF_TOOL_ID } from '../../toolkit/builtin/planExit'
import type { BrowserSessionMetadata } from '../../sessions/sessionStore'
import type { RuntimeFs } from '../../utils/fs/runtimeFs'
import type { Message, PendingPlanApproval } from '../../runtime/RuntimeTypes'

type TerminalMetadata = Pick<BrowserSessionMetadata, 'lastTerminalReason' | 'lastTerminalTimestamp'>

/** The terminal reason and time a session opens with. */
export type TerminalStateResolution = { reason?: string; timestamp?: number }

/**
 * A pending plan approval as read from disk: the marker and its plan, or a
 * marker whose plan file is gone (`stale`, to be cleared). Null: no marker.
 */
export type PlanApprovalResolution =
  | { kind: 'pending'; toolCallId: string; planText: string; planFilePath: string }
  | { kind: 'stale' }
  | null

/**
 * The resolve half of `restorePendingPlanApproval`: the persisted marker and
 * the plan file it points at. A fork whose own plan file is not copied yet
 * reads its source session's, which is what the copy will write.
 */
export async function resolvePendingPlanApproval(input: {
  metadata: BrowserSessionMetadata | undefined
  cwd: string | undefined
  sessionId: string | undefined
  fs: Pick<RuntimeFs, 'readFile'>
}): Promise<PlanApprovalResolution> {
  const toolCallId = input.metadata?.pendingPlanApprovalToolCallId
  if (typeof toolCallId !== 'string' || toolCallId.length === 0) return null
  const { cwd, sessionId } = input
  if (!cwd || !sessionId) return null
  const planFilePath = getPlanFilePathForSession(cwd, sessionId)
  const read = (path: string) => input.fs.readFile(path, { encoding: 'utf-8' })
  try {
    return { kind: 'pending', toolCallId, planText: await read(planFilePath), planFilePath }
  } catch {
    const forkedFrom = input.metadata?.forkedFromSessionId
    if (typeof forkedFrom === 'string' && forkedFrom.length > 0 && forkedFrom !== sessionId) {
      try {
        const planText = await read(getPlanFilePathForSession(cwd, forkedFrom))
        return { kind: 'pending', toolCallId, planText, planFilePath }
      } catch {
        // fall through: no plan to restore
      }
    }
    return { kind: 'stale' }
  }
}

/** The `pendingPlanApproval` record a resolved approval restores. */
export function pendingPlanApprovalEntry(
  plan: Extract<PlanApprovalResolution, { kind: 'pending' }>,
  restoreMode: string | undefined,
): Record<string, PendingPlanApproval> {
  return {
    [plan.toolCallId]: {
      toolName: PLAN_OFF_TOOL_ID,
      planText: plan.planText,
      planFilePath: plan.planFilePath,
      restoreMode: restoreMode ?? 'default',
    },
  }
}

/**
 * The resolve half of `restoreTerminalState`: the persisted terminal state,
 * then 'aborted_streaming' at `now` for a session killed mid-turn — an
 * assistant tail with unresolved `tool_use`, or any non-meta user tail
 * (including a tool_result) the model never answered.
 */
export function resolveTerminalState(
  metadata: TerminalMetadata | undefined,
  rows: () => readonly Message[],
  now: () => number = Date.now,
): TerminalStateResolution {
  let reason = metadata?.lastTerminalReason
  let timestamp = metadata?.lastTerminalTimestamp
  if (reason === 'aborted_streaming') return { reason, timestamp }
  try {
    const messages = rows()
    if (messages.length > 0) {
      // Signature 2 — the chain stops on a user message, so the model
      // owed a reply and never delivered it: either the prompt itself
      // (kill point A) or a tool_result awaiting the next streaming round
      // (kill point C). Checked FIRST because neither needs an assistant
      // tail, which is precisely what signature 1 below requires — and
      // for C that branch would actively return the wrong answer.
      // `isMeta` turns are internal context, never an owed reply.
      const last = messages[messages.length - 1]
      if (
        last?.type === 'user' &&
        (last as { isMeta?: unknown }).isMeta !== true
      ) {
        return { reason: 'aborted_streaming', timestamp: now() }
      }
      const lastAssistant = [...messages].reverse().find(
        (m) => m.type === 'assistant',
      )
      if (lastAssistant) {
        const content = (lastAssistant as { message?: { content?: unknown[] } }).message?.content
        if (Array.isArray(content)) {
          const hasUnresolvedToolUse = content.some(
            (block) => (block as { type?: string })?.type === 'tool_use',
          )
          if (hasUnresolvedToolUse) {
            // Tool results arrive as 'user' messages containing
            // tool_result blocks. If any user message follows the last
            // assistant, the tool calls were resolved (or the user sent
            // a new prompt) — not an interrupted session.
            const lastIdx = messages.lastIndexOf(lastAssistant)
            const hasSubsequentUser = messages.slice(lastIdx + 1).some(
              (m) => m.type === 'user',
            )
            if (!hasSubsequentUser) {
              reason = 'aborted_streaming'
              timestamp = now()
            }
          }
        }
      }
    }
  } catch {
    // best-effort — interruption detection must not break init
  }
  return { reason, timestamp }
}

export type AgentRecoverySnapshot = {
  lastTerminalReason?: string
  lastTerminalTimestamp?: number
}

/** The worker-provided seam: the one cross-controller need — clearing the
 *  persisted plan-approval marker, which AgentPermissionCoordinator owns. */
export interface AgentRuntimeRecoveryHost {
  clearPendingPlanApprovalMarker(): Promise<void>
}

export class AgentRuntimeRecovery {
  private lastTerminalReason?: string
  private lastTerminalTimestamp?: number
  private runtime: AgentRuntimeState | null = null

  constructor(private readonly host: AgentRuntimeRecoveryHost) {}

  bindRuntime(runtime: AgentRuntimeState): void {
    this.runtime = runtime
  }

  getTerminalReason(): string | undefined {
    return this.lastTerminalReason
  }

  getTerminalTimestamp(): number | undefined {
    return this.lastTerminalTimestamp
  }

  setTerminalState(reason: string | undefined, timestamp: number | undefined): void {
    this.lastTerminalReason = reason
    this.lastTerminalTimestamp = timestamp
  }

  snapshot(): AgentRecoverySnapshot {
    return {
      lastTerminalReason: this.lastTerminalReason,
      lastTerminalTimestamp: this.lastTerminalTimestamp,
    }
  }

  reset(): void {
    this.lastTerminalReason = undefined
    this.lastTerminalTimestamp = undefined
    this.runtime = null
  }

  /**
   * Copy a forked session's plan file from its source on first init (plan files are keyed by
   * sessionId). Best-effort, idempotent, never clobbers; clears the `forkedFromSessionId` marker after.
   */
  async copyForkedPlanIfNeeded(): Promise<void> {
    // Capture locally: `reset()` nulls `this.runtime` on scope
    // disposal, so a re-read after an await could TypeError mid-flight.
    const runtime = this.runtime
    if (!runtime) {
      return
    }
    try {
      const metadata =
        await runtime.conversationStore.getSessionMetadata?.()
      const fromSessionId = metadata?.forkedFromSessionId
      const toSessionId = runtime.engine.boundSessionId()
      if (
        typeof fromSessionId !== 'string' ||
        fromSessionId.length === 0 ||
        !toSessionId
      ) {
        return
      }
      await copyPlanFileForFork(
        runtime.options.cwd,
        fromSessionId,
        toSessionId,
        runtime.installedFs,
      )
      // One-shot — clear the marker so later reloads don't re-run the copy.
      // (Even if the clear is a no-op, copyPlanFileForFork never clobbers an
      // existing destination plan, so re-running stays safe.)
      await runtime.conversationStore.updateSessionMetadata?.({
        forkedFromSessionId: undefined,
      })
    } catch {
      // best-effort — a missing plan / fs hiccup just means no carry-over
    }
  }

  /**
   * Restore a pending ExitPlanMode approval after a restart from the
   * `pendingPlanApprovalToolCallId` metadata marker and the plan file on disk.
   * `resolved` is the marker and plan read earlier
   * (`resolvePendingPlanApproval`); when omitted they are read now.
   */
  async restorePendingPlanApproval(resolved?: PlanApprovalResolution): Promise<void> {
    const runtime = this.runtime
    if (!runtime) return
    const plan =
      resolved !== undefined
        ? resolved
        : await resolvePendingPlanApproval({
            metadata: await runtime.conversationStore.getSessionMetadata?.(),
            cwd: runtime.options.cwd,
            sessionId: runtime.engine.boundSessionId(),
            fs: runtime.installedFs,
          })
    if (!plan) return
    if (plan.kind === 'stale') {
      // No plan file — clear the stale marker.
      void this.host.clearPendingPlanApprovalMarker()
      return
    }
    // The restore mode is the permission mode plan mode was entered from.
    // After a restart, applyPersistedPermissionMode re-applies 'plan', which
    // records the engine's initial mode ('default') as modeBeforePlan.
    const runtimeWithAppState = runtime as unknown as {
      getAppState?: () => {
        permissionRules?: { modeBeforePlan?: string }
      }
    }
    const restoreMode =
      runtimeWithAppState?.getAppState?.()?.permissionRules?.modeBeforePlan
    runtime.setAppState(prev => ({
      ...prev,
      pendingPlanApproval: {
        ...prev.pendingPlanApproval,
        ...pendingPlanApprovalEntry(plan, restoreMode),
      },
    }))
  }

  /**
   * Load the persisted terminal state and mark a session killed mid-turn as
   * 'aborted' so the UI offers Continue (`resolveTerminalState`). `resolved`
   * is a state resolved earlier; when omitted it is resolved now from the
   * runtime's store and rows. Writes nothing to the transcript.
   */
  async restoreTerminalState(resolved?: TerminalStateResolution): Promise<void> {
    const runtime = this.runtime
    if (!runtime) return
    let state = resolved
    if (!state) {
      let metadata: TerminalMetadata | undefined
      try {
        metadata = await runtime.conversationStore.getSessionMetadata?.()
      } catch {
        // best-effort — if metadata load fails, terminal state stays undefined
      }
      state = resolveTerminalState(metadata, () => runtime.engine.transcriptRows())
    }
    this.lastTerminalReason = state.reason
    this.lastTerminalTimestamp = state.timestamp
  }

  /**
   * Turn-end refresh: the engine's query loop persists the terminal reason
   * into session metadata; re-read it so the snapshot emitted with
   * `worker.completed` carries the fresh value. Best-effort — a metadata
   * read failure must not break turn completion.
   */
  async refreshTerminalStateFromMetadata(): Promise<void> {
    const runtime = this.runtime
    if (!runtime) return
    try {
      const metadata =
        await runtime.conversationStore.getSessionMetadata?.()
      if (metadata) {
        this.lastTerminalReason = metadata.lastTerminalReason
        this.lastTerminalTimestamp = metadata.lastTerminalTimestamp
      }
    } catch {
      // best-effort — a metadata read failure must not break turn completion
    }
  }
}
