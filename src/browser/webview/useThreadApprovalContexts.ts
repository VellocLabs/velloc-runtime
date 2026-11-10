import { useMemo } from 'react'
import type { EnterPlanApprovalContextValue } from '@/components/assistant-ui/enter-plan-approval-context'
import type { PermissionAskContextValue } from '@/components/assistant-ui/permission-ask-context'
import type { PlanPanelContextValue } from '@/components/assistant-ui/plan-panel-context'
import { resolvePlanApproval } from '@/permissions/planApproval'
import type { RuleEdit } from '@/permissions/ruleUpdates'
import type { PendingApproval } from '@/runtime/RuntimeTypes'
import type { AssistantUiThreadProps } from './AssistantUiThreadProps'

/** The plan-panel, enter-plan and permission-ask context values for one thread's approval queue. */
export function useThreadApprovalContexts({
  state,
  queuedPlanConfirm,
  queuedEnterPlanConfirm,
  queuedPermissionConfirm,
  submitToolResult,
  setPermissionMode,
  resolveToolUseConfirm,
  clearPlanApproval,
  onOpenPlanPanel,
}: {
  state: AssistantUiThreadProps['state']
  queuedPlanConfirm: PendingApproval | undefined
  queuedEnterPlanConfirm: PendingApproval | undefined
  queuedPermissionConfirm: PendingApproval | undefined
  submitToolResult: AssistantUiThreadProps['submitToolResult']
  setPermissionMode: AssistantUiThreadProps['setPermissionMode']
  resolveToolUseConfirm: AssistantUiThreadProps['resolveToolUseConfirm']
  clearPlanApproval: AssistantUiThreadProps['clearPlanApproval']
  onOpenPlanPanel: AssistantUiThreadProps['onOpenPlanPanel']
}) {
  // Per-session plan-approval state + actions for the footer plan control
  // (replaces the old top banner). The loop HALTS on the first ExitPlanMode, so
  // there is at most one entry — render the first. `resolve` clears the approval
  // first (instant dismiss) then approves / keeps planning.
  const planPanelValue = useMemo<PlanPanelContextValue>(() => {
    if (queuedPlanConfirm) {
      const pending = {
        toolCallId: queuedPlanConfirm.approvalCallId,
        request: {
          toolName: queuedPlanConfirm.toolName,
          planText:
            typeof queuedPlanConfirm.permissionResult.planText === 'string'
              ? queuedPlanConfirm.permissionResult.planText
              : '',
          planFilePath:
            typeof queuedPlanConfirm.permissionResult.planFilePath === 'string'
              ? queuedPlanConfirm.permissionResult.planFilePath
              : '',
          restoreMode: queuedPlanConfirm.permissionResult.restoreMode ?? 'default',
        },
      }
      return {
        pending,
        openPanel: onOpenPlanPanel,
        resolve: (decision, feedback) =>
          resolveToolUseConfirm?.({
            approvalCallId: queuedPlanConfirm.approvalCallId,
            behavior: decision === 'approve' ? 'allow' : 'reject',
            updatedInput:
              decision === 'approve' ? queuedPlanConfirm.input : undefined,
            feedback,
          }),
      }
    }
    const entries = state.snapshot?.pendingPlanApproval
      ? Object.entries(state.snapshot.pendingPlanApproval)
      : []
    const first = entries[0]
    const pending = first
      ? { toolCallId: first[0], request: first[1] }
      : null
    return {
      pending,
      openPanel: onOpenPlanPanel,
      resolve: pending
        ? (decision, feedback) =>
            resolvePlanApproval(
              decision,
              pending.toolCallId,
              pending.request,
              { clearPlanApproval, setPermissionMode, submitToolResult },
              feedback,
            )
        : undefined,
    }
  }, [
    queuedPlanConfirm,
    state.snapshot?.pendingPlanApproval,
    onOpenPlanPanel,
    resolveToolUseConfirm,
    clearPlanApproval,
    setPermissionMode,
    submitToolResult,
  ])

  // Pending model-invoked EnterPlanMode ask for THIS session ("Enter plan
  // mode?"). Approve resolves the
  // suspended tool call with allow (call() then flips the mode); reject sends
  // the model a declined tool result. The dialog has no feedback field.
  const enterPlanApprovalValue = useMemo<EnterPlanApprovalContextValue>(() => {
    if (!queuedEnterPlanConfirm) return { pending: null }
    return {
      pending: { toolCallId: queuedEnterPlanConfirm.approvalCallId },
      resolve: decision =>
        resolveToolUseConfirm?.({
          approvalCallId: queuedEnterPlanConfirm.approvalCallId,
          behavior: decision === 'approve' ? 'allow' : 'reject',
          updatedInput:
            decision === 'approve' ? queuedEnterPlanConfirm.input : undefined,
        }),
    }
  }, [queuedEnterPlanConfirm, resolveToolUseConfirm])

  // Pending permission ASK (Allow/Deny/Always) for THIS session, surfaced in
  // the composer footer (PermissionAskFooterControl) instead of a top banner.
  // Resolve logic mirrors the former PermissionBanner: Deny → error result;
  // Allow-once/always → add the allow rule (always also persists) + a "granted,
  // retry" result; Allow-folder → add the directory via RuleEdit.
  const permissionAskValue = useMemo<PermissionAskContextValue>(() => {
    if (queuedPermissionConfirm) {
      const suggestedRule =
        queuedPermissionConfirm.permissionResult.suggestedRule ??
        queuedPermissionConfirm.toolName
      const request = {
        toolName: queuedPermissionConfirm.toolName,
        summary:
          queuedPermissionConfirm.permissionResult.summary ??
          queuedPermissionConfirm.permissionResult.message,
        suggestedRule,
        reason: queuedPermissionConfirm.permissionResult.reason,
        directory: queuedPermissionConfirm.permissionResult.directory,
      }
      const canAllowFolder =
        request.reason === 'outside-workspace' && Boolean(request.directory)
      return {
        pending: {
          toolCallId: queuedPermissionConfirm.approvalCallId,
          request,
        },
        canAllowFolder,
        resolve: async (decision, feedback) => {
          const ruleEdits: RuleEdit[] = []
          if (decision === 'allow-folder' && request.directory) {
            ruleEdits.push({
              type: 'addDirectories',
              directories: [request.directory],
              destination: 'localSettings',
            })
          } else if (decision === 'allow-always') {
            ruleEdits.push({
              type: 'addRules',
              behavior: 'allow',
              rules: [suggestedRule],
              destination: 'localSettings',
            })
          }
          await resolveToolUseConfirm?.({
            approvalCallId: queuedPermissionConfirm.approvalCallId,
            behavior: decision === 'deny' ? 'reject' : 'allow',
            updatedInput:
              decision === 'deny' ? undefined : queuedPermissionConfirm.input,
            feedback:
              decision === 'deny'
                ? (feedback ?? 'Permission denied by the user. Do not retry this call.')
                : feedback,
            ruleEdits:
              ruleEdits.length > 0 ? ruleEdits : undefined,
          })
        },
      }
    }
    // No `pendingPermissions` branch: real asks resolve via `queuedPermissionConfirm` above;
    // an allow-and-retry would re-match the ask rule and re-prompt.
    return { pending: null }
  }, [queuedPermissionConfirm, resolveToolUseConfirm])

  return { planPanelValue, enterPlanApprovalValue, permissionAskValue }
}
