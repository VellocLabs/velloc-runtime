import { createContext, useContext } from 'react'

/**
 * Carries a pending model-invoked EnterPlanMode approval ("Enter plan mode?")
 * from a session's AssistantUiThread down to the footer control. The model's
 * EnterPlanMode waits on a Yes/No permission request; nexus surfaces that
 * decision as a composer-footer control
 * (mirrors PlanPanelContext — per-session, a background session's ask must not
 * surface in the active footer).
 */
export type EnterPlanApprovalEntry = {
  toolCallId: string
}

export type EnterPlanApprovalContextValue = {
  /** This session's pending enter-plan-mode ask, or null. */
  pending?: EnterPlanApprovalEntry | null
  /** Resolve it: approve enters plan mode, reject keeps the current mode. */
  resolve?: (decision: 'approve' | 'reject') => void | Promise<void>
}

export const EnterPlanApprovalContext =
  createContext<EnterPlanApprovalContextValue>({})

export function useEnterPlanApproval(): EnterPlanApprovalContextValue {
  return useContext(EnterPlanApprovalContext)
}
