import { createContext, useContext } from 'react'
import type { PendingPlanApproval } from '@/runtime/RuntimeTypes'

/**
 * Carries the plan-approval state + actions from a session's AssistantUiThread
 * down to the footer plan control (rendered deep inside the assistant-ui
 * <Thread>). Mirrors BackgroundTasksContext. The control reads THIS session's
 * pending approval (per-session, like pendingQuestionsStore — a background
 * session's pending plan must not surface in the active session's footer) and
 * resolves it / opens the full plan in the right-side panel.
 */
export type PlanPanelEntry = {
  toolCallId: string
  request: PendingPlanApproval
}

export type PlanPanelContextValue = {
  /** This session's pending plan approval (the first/only entry), or null. */
  pending?: PlanPanelEntry | null
  /** Resolve it: approve, or keep planning with optional feedback. */
  resolve?: (
    decision: 'approve' | 'reject',
    feedback?: string,
  ) => void | Promise<void>
  /**
   * Set only for an approval staged after its turn ended (restored, or the no-dialog halt): Reject calls this
   * instead of Stop's cancel, since no turn runs.
   */
  cancelStaged?: () => void | Promise<void>
  /** Open the full plan in the right-side panel (shell-level drawer). */
  openPanel?: () => void
}

export const PlanPanelContext = createContext<PlanPanelContextValue>({})

export function usePlanPanel(): PlanPanelContextValue {
  return useContext(PlanPanelContext)
}
