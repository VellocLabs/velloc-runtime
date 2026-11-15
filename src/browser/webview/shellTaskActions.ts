import { type RefObject, type Dispatch, type SetStateAction } from 'react'
import type { SessionCardPrefs } from './layout/sessionCards'
import { setSessionCardsShown } from './layout/sessionCards'
import { setMaximized, type SessionPaneRecord, type SidePaneKind } from './layout/paneLayout'
import { type RightPanelSkillTarget } from '@/components/assistant-ui/right-panel-content-context'
import { filterSubAgentRowsBySession, subAgentsEqual } from './backgroundSubAgents'
import { loopTimerStopRequest } from './loopTimers'
import type { NexusTaskSummaryRow } from '../bridge/protocol/ui'
import { type SkillPanelListRow } from './sessionSkills'

export function createShellSubAgentRowsForSession(
  subAgentRows: readonly NexusTaskSummaryRow[],
  subAgentRowsSeenRef: RefObject<Map<string, NexusTaskSummaryRow[]>>,
) {
  return (() => {
    const bySession = new Map<string, NexusTaskSummaryRow[]>()
    return (sessionId: string): NexusTaskSummaryRow[] => {
      let rows = bySession.get(sessionId)
      if (!rows) {
        rows = filterSubAgentRowsBySession(subAgentRows, sessionId)
        const seen = subAgentRowsSeenRef.current.get(sessionId)
        if (seen && subAgentsEqual(seen, rows)) rows = seen
        else subAgentRowsSeenRef.current.set(sessionId, rows)
        bySession.set(sessionId, rows)
      }
      return rows
    }
  })()
}
export function createShellHandleStopBackgroundTask(
  subAgentRowsRef: RefObject<readonly NexusTaskSummaryRow[]>,
  submitPromptToSession: (sessionId: string, prompt: string) => Promise<void>,
  handleStopSubAgent: (subAgentSessionId: string) => void,
) {
  return (taskId: string) => {
    const timerStop = loopTimerStopRequest(subAgentRowsRef.current, taskId)
    if (timerStop) {
      void submitPromptToSession(timerStop.sessionId, timerStop.prompt)
      return
    }
    handleStopSubAgent(taskId)
  }
}
export function createShellHandleSelectSkill(
  openSkillInPanel: (target: RightPanelSkillTarget) => void,
) {
  return (skill: SkillPanelListRow) => {
    // A failed invocation has no body — open it as an error target.
    if (skill.status === 'failed') {
      openSkillInPanel({
        name: skill.name,
        detailId: null,
        inlineBody: null,
        eventId: skill.id,
        status: 'failed',
        error: skill.error,
      })
      return
    }
    const diskPath =
      skill.path && skill.source !== 'bundled' ? skill.path : null
    openSkillInPanel({
      name: skill.name,
      path: diskPath ?? undefined,
      detailId: diskPath ? null : skill.detailId ?? null,
      inlineBody: null,
      eventId: skill.id,
      status: skill.status,
    })
  }
}
export function createShellHandleOpenBackgroundTasks(
  setBackgroundTaskFocusSessionId: Dispatch<SetStateAction<string | null>>,
  openSidePane: (kind: SidePaneKind) => void,
) {
  return (focusSessionId?: string) => {
    setBackgroundTaskFocusSessionId(focusSessionId ?? null)
    openSidePane('tasks')
  }
}
export function createShellHandleOpenBackgroundTasksList(
  setBackgroundTaskFocusSessionId: Dispatch<SetStateAction<string | null>>,
  setBackgroundTaskListRequest: Dispatch<SetStateAction<number>>,
  openSidePane: (kind: SidePaneKind) => void,
) {
  return () => {
    setBackgroundTaskFocusSessionId(null)
    setBackgroundTaskListRequest(n => n + 1)
    openSidePane('tasks')
  }
}
export function createShellHandleTaskFocusConsumed(
  setBackgroundTaskFocusSessionId: Dispatch<SetStateAction<string | null>>,
) {
  return () => {
    setBackgroundTaskFocusSessionId(null)
  }
}
export function createShellHandleToggleSessionCards(
  paneMaximized: SidePaneKind | null,
  updatePaneRecord: (fn: (prev: SessionPaneRecord) => SessionPaneRecord, sessionId?: string) => void,
  sessionCardsFit: boolean,
  writeSessionCardPrefs: (next: SessionCardPrefs) => void,
  sessionCardPrefs: SessionCardPrefs,
  setSessionCardsPopoverOpen: Dispatch<SetStateAction<boolean>>,
) {
  return () => {
    // A maximized panel covers the cards: the toggle restores the chat and
    // shows them.
    if (paneMaximized !== null) {
      updatePaneRecord(r => setMaximized(r, null))
      if (sessionCardsFit) writeSessionCardPrefs(setSessionCardsShown(sessionCardPrefs, true))
      else setSessionCardsPopoverOpen(true)
      return
    }
    if (sessionCardsFit) {
      writeSessionCardPrefs(setSessionCardsShown(sessionCardPrefs, !sessionCardPrefs.shown))
    } else {
      setSessionCardsPopoverOpen(open => !open)
    }
  }
}
export function createShellCloseSessionCardsPopover(
  setSessionCardsPopoverOpen: Dispatch<SetStateAction<boolean>>,
) {
  return () => setSessionCardsPopoverOpen(false)
}
