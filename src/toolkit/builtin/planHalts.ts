/**
 * The halts of the two plan-mode tools (F-26): each asks the user through the
 * confirm queue. Without an installed dialog ExitPlanMode suspends the loop and
 * records the pending approval; EnterPlanMode runs.
 */
import { planDocPath } from '../../utils/planFiles'
import { buildRejectedPlanMessage, getRestoreMode, resolvePlanText } from '../../permissions/planApproval'
import {
  confirmRejectionMessage,
  refusalUpdate,
  requestQueuedToolUseConfirm,
} from '../run/toolPermissionGate'
import type { AdmittedRun, DeferredMessageUpdate, StageStep } from '../run/executeToolCall'

export async function* exitPlanModeHalt(run: AdmittedRun): AsyncGenerator<DeferredMessageUpdate, StageStep> {
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
    yield { pendingToolUse: { toolUseId: block.toolCallId, toolName: tool.name } }
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

export async function* enterPlanModeHalt(run: AdmittedRun): AsyncGenerator<DeferredMessageUpdate, StageStep> {
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
