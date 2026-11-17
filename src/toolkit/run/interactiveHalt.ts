/**
 * Stage 8: tools the user answers (F-26). A `haltsForUser` tool asks in its own
 * `haltForUser`, or suspends the loop and the answer arrives by another path.
 * Without prompts, PermissionRequest hooks decide once; a tool that
 * `runsWithoutHaltUnderSession` runs unasked in a loop under the session.
 */
import { refusalUpdate, resolveHeadlessPermissionDecision } from './toolPermissionGate'
import type { AdmittedRun, DeferredMessageUpdate, StageStep } from './executeToolCall'

function haltUpdate(run: AdmittedRun): DeferredMessageUpdate {
  return { pendingToolUse: { toolUseId: run.block.toolCallId, toolName: run.tool.name } }
}

/** Stage 8. */
export async function* haltForUserStage(run: AdmittedRun): AsyncGenerator<DeferredMessageUpdate, StageStep> {
  const { tool, callContext } = run
  if (!tool.haltsForUser?.()) return 'continue'
  if (tool.runsWithoutHaltUnderSession && callContext.agentId) return 'continue'

  if (callContext.readAppState().permissionRules.suppressAsks) {
    const decision = await resolveHeadlessPermissionDecision(
      tool,
      run.rawInput,
      run.block.toolCallId,
      callContext,
    )
    if (decision.behavior === 'deny') {
      yield refusalUpdate(run, decision.message)
      return 'stop'
    }
    if (decision.updatedInput) {
      run.gateVerdict = { behavior: 'allow', updatedInput: decision.updatedInput }
    }
    return 'continue'
  }
  if (tool.haltForUser) return yield* tool.haltForUser(run)

  // Recorded on app state so the "needs your answer" indicator survives the
  // thread being unmounted; cleared where the answer is submitted.
  callContext.writeAppState(prev => ({
    ...prev,
    pendingUserInteraction: {
      ...prev.pendingUserInteraction,
      [run.block.toolCallId]: { toolName: tool.name },
    },
  }))
  yield haltUpdate(run)
  return 'stop'
}
