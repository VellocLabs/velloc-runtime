/**
 * Stage 8: tools the user answers (F-26). A `haltsForUser` tool suspends the loop;
 * the answer arrives by another path. Without prompts, PermissionRequest hooks
 * decide once; ExitPlanMode in a sub-agent is auto-approved.
 */
import { planDocPath } from '../../utils/planFiles'
import { buildRejectedPlanMessage, getRestoreMode, resolvePlanText } from '../../permissions/planApproval'
import { PLAN_ON_TOOL_ID } from '../builtin/planEnter'
import { PLAN_OFF_TOOL_ID } from '../builtin/planExit'
import {
  confirmRejectionMessage,
  refusalUpdate,
  requestQueuedToolUseConfirm,
  resolveHeadlessPermissionDecision,
} from './toolPermissionGate'
import type { AdmittedRun, DeferredMessageUpdate, StageStep } from './executeToolCall'

function haltUpdate(run: AdmittedRun): DeferredMessageUpdate {
  return { pendingToolUse: { toolUseId: run.block.toolCallId, toolName: run.tool.name } }
}

async function* exitPlanMode(run: AdmittedRun): AsyncGenerator<DeferredMessageUpdate, StageStep> {
  const { tool, block, callContext, rawInput } = run
  const restoreMode = getRestoreMode(callContext)
  const planFilePath = planDocPath(callContext)
  const planText = await resolvePlanText(callContext, rawInput)
  const approvedInput = { ...rawInput, plan: planText }
  callContext.writeAppState(prev => ({
    ...prev,
    permissionRules: {
      ...prev.permissionRules,
      mode: 'plan',
      modeBeforePlan: prev.permissionRules.modeBeforePlan ?? restoreMode,
    },
  }))
  const resolution = await requestQueuedToolUseConfirm({
    tool,
    input: approvedInput,
    message: 'Exit plan mode?',
    metadata: { planText, planFilePath, restoreMode },
    callRef: block.toolCallId,
    modelReply: run.modelReply,
    callContext,
  })
  if (!resolution) {
    callContext.writeAppState(prev => ({
      ...prev,
      pendingPlanApproval: {
        ...prev.pendingPlanApproval,
        [block.toolCallId]: { toolName: tool.name, planText, planFilePath, restoreMode },
      },
    }))
    yield haltUpdate(run)
    return 'stop'
  }
  if (resolution.behavior !== 'allow') {
    yield refusalUpdate(
      run,
      resolution.behavior === 'abort'
        ? confirmRejectionMessage(resolution.behavior, resolution.feedback, 'Interrupted by user')
        : buildRejectedPlanMessage(resolution.feedback),
    )
    return 'stop'
  }
  run.gateVerdict = { behavior: 'allow', updatedInput: resolution.updatedInput ?? approvedInput }
  return 'continue'
}

async function* enterPlanMode(run: AdmittedRun): AsyncGenerator<DeferredMessageUpdate, StageStep> {
  const resolution = await requestQueuedToolUseConfirm({
    tool: run.tool,
    input: run.rawInput,
    message: 'Enter plan mode?',
    callRef: run.block.toolCallId,
    modelReply: run.modelReply,
    callContext: run.callContext,
  })
  // No dialog installed: the tool runs.
  if (!resolution) return 'continue'
  if (resolution.behavior !== 'allow') {
    yield refusalUpdate(
      run,
      confirmRejectionMessage(resolution.behavior, resolution.feedback, 'User declined to enter plan mode'),
    )
    return 'stop'
  }
  run.gateVerdict = { behavior: 'allow', updatedInput: resolution.updatedInput ?? run.rawInput }
  return 'continue'
}

/** Stage 8. */
export async function* haltForUserStage(run: AdmittedRun): AsyncGenerator<DeferredMessageUpdate, StageStep> {
  const { tool, callContext } = run
  if (!tool.haltsForUser?.()) return 'continue'
  if (tool.name === PLAN_OFF_TOOL_ID && callContext.agentId) return 'continue'

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
  if (tool.name === PLAN_OFF_TOOL_ID) return yield* exitPlanMode(run)
  if (tool.name === PLAN_ON_TOOL_ID) return yield* enterPlanMode(run)

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
