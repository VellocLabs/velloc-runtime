/**
 * Page-lifetime feedback drafts for pending plan approvals, keyed by the plan's
 * tool call id, so a draft typed in the Plan pane outlives the pane body's
 * remount on a session switch (F-9). A draft is dropped when its plan resolves
 * from either feedback field, or when the shown session's plan goes away.
 * Bounded by {@link rememberBounded}; an evicted draft reads back empty.
 */
import { rememberBounded } from './boundedUiMemory'

export const PLAN_FEEDBACK_DRAFTS_MAX = 64

const drafts = new Map<string, string>()

export function readPlanFeedbackDraft(toolCallId: string): string {
  return drafts.get(toolCallId) ?? ''
}

/** An empty draft is dropped rather than stored. */
export function writePlanFeedbackDraft(toolCallId: string, text: string): void {
  if (text === '') drafts.delete(toolCallId)
  else rememberBounded(drafts, toolCallId, text, PLAN_FEEDBACK_DRAFTS_MAX)
}

export function dropPlanFeedbackDraft(toolCallId: string): void {
  drafts.delete(toolCallId)
}
