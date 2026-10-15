import { createContext, useContext } from 'react'
import type { PendingPermissionRequest } from '@/runtime/RuntimeTypes'

/**
 * Carries a session's pending permission ask down to the footer control. Per-session:
 * a background session's pending ask must not surface in the active session's footer.
 */
export type ApprovalPick =
  | 'deny'
  | 'allow-once'
  | 'allow-always'
  | 'allow-folder'

export type PermissionAskEntry = {
  toolCallId: string
  request: PendingPermissionRequest
}

export type PermissionAskContextValue = {
  /** This session's pending permission ask (the first/only entry), or null. */
  pending?: PermissionAskEntry | null
  /**
   * Resolve it. Deny → error result; Allow* → grant + "retry" result. The
   * optional `feedback` is free-text the user types to steer the model (spec
   * 5-10-3 "tab-to-amend"): on deny it becomes the rejection note, on
   * allow it's appended so the model knows what to do differently.
   */
  resolve?: (decision: ApprovalPick, feedback?: string) => void | Promise<void>
  /** Whether the "Allow this folder" affordance applies (outside-workspace
   *  ask + a directory + an applyPermissionUpdate handler). */
  canAllowFolder?: boolean
}

export const PermissionAskContext = createContext<PermissionAskContextValue>({})

export function usePermissionAsk(): PermissionAskContextValue {
  return useContext(PermissionAskContext)
}
