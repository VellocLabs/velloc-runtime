import { createContext, useContext } from 'react'

/**
 * Thread-level handle to open the global Background Tasks drawer. Provided by
 * `AssistantUiThread` (bound to the shell's drawer toggle) and consumed by the
 * Agent (sub-agent) tool card in `tool-fallback.tsx`, which surfaces a
 * "jump to background task" affordance on a background launch. Own module so the
 * deep tool-call component and the thread host don't import each other (no
 * cycle), mirroring `message-actions-context.ts`.
 */
export type BackgroundTasksContextValue = {
  /** Open the Background Tasks drawer, optionally focusing a task by id
   *  (`subagent-…` for agents, or `bg_…`/shell id for local_bash). Absent on
   *  hosts without the drawer. */
  openTasksDrawer?: (focusSessionId?: string) => void
  /** Number of THIS session's background tasks still running. Drives the
   *  composer-footer "session still working" indicator: a turn can settle
   *  while background tasks keep running, and each will inject a
   *  `<task-notification>` turn later — so the session isn't really done.
   *  Absent/0 on hosts without the drawer feed. */
  runningTaskCount?: number
}

export const BackgroundTasksContext =
  createContext<BackgroundTasksContextValue>({})

export function useBackgroundTasksContext(): BackgroundTasksContextValue {
  return useContext(BackgroundTasksContext)
}
