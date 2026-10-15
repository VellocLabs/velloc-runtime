import type { AgentRuntimeWorkerSnapshot } from '../browser/worker/workerProtocol'

/**
 * True iff a session's worker snapshot shows a control that HALTS the turn on
 * the user: `approvalQueue`, `pendingPlanApproval`, `pendingPermissions` or
 * `pendingUserInteraction`. Pure. Narrower than `isRuntimeBusy`: busy is not
 * waiting for you.
 */
export function snapshotNeedsAnswer(
  snapshot: AgentRuntimeWorkerSnapshot | null | undefined,
): boolean {
  if (!snapshot) return false
  if ((snapshot.approvalQueue?.length ?? 0) > 0) return true
  if (recordHasEntries(snapshot.pendingPlanApproval)) return true
  if (recordHasEntries(snapshot.pendingPermissions)) return true
  if (recordHasEntries(snapshot.pendingUserInteraction)) return true
  return false
}

/**
 * True only when the TURN HAS ENDED halted on the user (`pendingUserInteraction`
 * or `pendingPlanApproval`); parked input must not be submitted underneath it.
 * Asks inside a running turn are excluded: nothing re-runs the consume when they
 * clear.
 */
export function snapshotHaltedOnUser(
  snapshot: AgentRuntimeWorkerSnapshot | null | undefined,
): boolean {
  if (!snapshot) return false
  return haltRecordsHaltOnUser(
    snapshot.pendingUserInteraction,
    snapshot.pendingPlanApproval,
  )
}

/**
 * `snapshotHaltedOnUser` over the two engine records themselves — for the
 * worker, which holds the engine and asks on every idle send and every pump.
 * Building a snapshot to answer walks the whole transcript (`messageCount`,
 * the tool-detail hydration); the two records are a direct app-state read.
 */
export function haltRecordsHaltOnUser(
  pendingUserInteraction: Record<string, unknown> | undefined | null,
  pendingPlanApproval: Record<string, unknown> | undefined | null,
): boolean {
  if (recordHasEntries(pendingUserInteraction)) return true
  if (recordHasEntries(pendingPlanApproval)) return true
  return false
}

/**
 * True only when halted on an AskUserQuestion-style interaction that blocks the
 * composer. Plan approval and permission asks are excluded: they have their own
 * footer controls.
 */
export function snapshotBlocksComposerInput(
  snapshot: AgentRuntimeWorkerSnapshot | null | undefined,
): boolean {
  if (!snapshot) return false
  if (recordHasEntries(snapshot.pendingUserInteraction)) return true
  return false
}

function recordHasEntries(
  record: Record<string, unknown> | undefined | null,
): boolean {
  return !!record && Object.keys(record).length > 0
}

/**
 * True iff a submitMessage prompt carries a tool-result block — i.e. the user
 * just answered an AskUserQuestion / permission / plan-approval halt and the
 * engine is about to clear the pending flag (see QueryEngine.submitMessage).
 * The worker uses this to pre-clear + emit a fresh snapshot BEFORE the stream
 * opens, so the session-list "needs your response" indicator drops the instant
 * the user answers instead of lingering through the follow-up turn.
 */
export function submitCarriesToolResult(
  prompt: unknown,
): prompt is ReadonlyArray<unknown> {
  if (!Array.isArray(prompt)) return false
  for (const block of prompt) {
    const record = block as { type?: unknown }
    if (record?.type === 'tool-result' || record?.type === 'tool_result') {
      return true
    }
  }
  return false
}

/**
 * The tool-use ids a submitMessage prompt answers, one per tool-result block in
 * order (`tool-result` / `toolCallId`, or `tool_result` / `tool_use_id`). Both
 * clears read ids through this so they never disagree.
 */
export function toolResultIdsInPrompt(prompt: unknown): string[] {
  if (!Array.isArray(prompt)) return []
  const ids: string[] = []
  for (const block of prompt) {
    const record = block as {
      type?: unknown
      toolCallId?: unknown
      tool_use_id?: unknown
    }
    if (record?.type !== 'tool-result' && record?.type !== 'tool_result') {
      continue
    }
    const id =
      typeof record.toolCallId === 'string'
        ? record.toolCallId
        : typeof record.tool_use_id === 'string'
          ? record.tool_use_id
          : undefined
    if (id) ids.push(id)
  }
  return ids
}
