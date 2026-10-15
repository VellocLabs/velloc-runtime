// Plan-approval helpers: ExitPlanMode on the main thread waits for the user's
// approval; one source for the plan text, post-exit mode and tool_result prose.

import type { ToolCallContext } from '../toolkit/toolCallContext'
import type {
  PendingPlanApproval,
  ApprovalMode,
} from '../runtime/RuntimeTypes'
import { fsForContext } from '../utils/fs/runtimeFs'
import {
  ensurePlanDirectoryExists,
  planDocPath,
  planFileExists,
} from '../utils/planFiles'

function isENOENTError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false
  }
  const err = error as { code?: unknown; message?: unknown }
  if (err.code === 'ENOENT') {
    return true
  }
  return typeof err.message === 'string' && /\bENOENT\b/.test(err.message)
}

/**
 * Resolve the plan text to present for approval. If the model passed `plan`
 * inline, persist it to the plan file (so the approved plan survives reload)
 * and return it; otherwise read the previously-written plan file. Returns an
 * empty string when no plan exists. Mirrors ExitPlanModeTool.call()'s
 * write-or-read branch so the suspended path produces the same plan the tool
 * would have.
 */
export async function resolvePlanText(
  context: ToolCallContext,
  input: { plan?: unknown },
): Promise<string> {
  const planFilePath = planDocPath(context)
  const fs = fsForContext(context)
  if (typeof input.plan === 'string' && input.plan.length > 0) {
    await ensurePlanDirectoryExists(context)
    await fs.writeFile(planFilePath, input.plan, { encoding: 'utf-8' })
    return input.plan
  }
  if (await planFileExists(context)) {
    try {
      return await fs.readFile(planFilePath, { encoding: 'utf-8' })
    } catch (error) {
      if (isENOENTError(error)) {
        return ''
      }
      throw error
    }
  }
  return ''
}

/** The mode to switch to when the plan is approved: the pre-plan mode, or default. */
export function getRestoreMode(context: ToolCallContext): ApprovalMode {
  return context.readAppState().permissionRules.modeBeforePlan ?? 'default'
}

/**
 * Model-facing tool_result when the user approves the plan. Mirrors
 * ExitPlanModeTool's approved branch so the model sees identical text whether
 * the exit ran via the tool (agent path) or the approval banner (main thread).
 */
export function buildApprovedPlanMessage(
  planText: string,
  planFilePath: string,
): string {
  if (!planText || planText.length === 0) {
    return 'User has approved exiting plan mode. You can now proceed.'
  }
  return (
    'User has approved your plan.\n\n' +
    `Your plan has been saved to: ${planFilePath}\n\n` +
    '## Approved Plan:\n' +
    planText
  )
}

/** Client actions the plan-approval UI uses to resolve a decision. */
export type PlanApprovalActions = {
  clearPlanApproval?: (toolCallId?: string) => void | Promise<unknown>
  setPermissionMode?: (mode: string) => void | Promise<unknown>
  submitToolResult?: (submission: {
    toolCallId: string
    toolName: string
    result: unknown
    isError?: boolean
  }) => void | Promise<unknown>
}

/**
 * Resolve a pending plan approval. Clears the approval FIRST so a stale one is
 * not re-published; the worker's halt gate stays closed until the tool result
 * dispatches. Approve → post-plan mode + the plan as the ExitPlanMode result;
 * keep planning → a rejection result, mode stays `plan`.
 */
export async function resolvePlanApproval(
  decision: 'approve' | 'reject',
  toolCallId: string,
  request: Pick<
    PendingPlanApproval,
    'toolName' | 'planText' | 'planFilePath' | 'restoreMode'
  >,
  actions: PlanApprovalActions,
  feedback?: string,
): Promise<void> {
  await Promise.resolve(actions.clearPlanApproval?.(toolCallId))
  if (decision === 'approve') {
    await Promise.resolve(actions.setPermissionMode?.(request.restoreMode))
    await Promise.resolve(
      actions.submitToolResult?.({
        toolCallId,
        toolName: request.toolName,
        result: buildApprovedPlanMessage(request.planText, request.planFilePath),
      }),
    )
  } else {
    await Promise.resolve(
      actions.submitToolResult?.({
        toolCallId,
        toolName: request.toolName,
        result: buildRejectedPlanMessage(feedback),
      }),
    )
  }
}

/**
 * Model-facing tool_result when the user rejects the plan ("keep planning").
 * Plan mode stays active; the model revises and calls ExitPlanMode again.
 */
export function buildRejectedPlanMessage(feedback?: string): string {
  const trimmed = feedback?.trim()
  const base =
    'User has rejected the plan and wants to keep planning. You are still in ' +
    'plan mode — do not make changes yet.'
  if (trimmed) {
    return (
      `${base}\n\nFeedback from the user:\n${trimmed}\n\n` +
      'Revise your plan accordingly, then call ExitPlanMode again when ready.'
    )
  }
  return `${base}\n\nRefine your plan, then call ExitPlanMode again when ready.`
}
