/**
 * `$.ui.view` on the page (F-25): each new `seq` of a session's published
 * `view` shows that agent's transcript — a teammate's own session, or a
 * subagent's Tasks detail — or, with no `agentId`, goes back. The first state
 * read after watching starts counts as seen. While a teammate is shown, the
 * lead's state is read, until the person leaves that teammate by hand.
 */
import * as React from 'react'

import type { RuntimeConnection } from '../../runtimeClient/RuntimeConnection'
import { useModsUiView } from './modsUiView'

export type ModAgentViewActions = {
  /** Show a session in the main view. */
  focusSession(sessionId: string): void
  /** Show a subagent's transcript, by its task id, over the active
   *  session's conversation. */
  showSubagent(taskId: string): void
  /** Take the active session's subagent transcript down again, back to what
   *  it showed before. */
  leaveSubagent(): void
}

/** The teammate a lead's mod showed; `arrived` once it became the active
 *  session, so a later move away is the person's own. */
type TeammateShown = { lead: string; teammate: string; arrived: boolean }

export function useModAgentView(
  runtimeConnection: (() => Promise<RuntimeConnection>) | undefined,
  activeSessionId: string | undefined,
  actions: ModAgentViewActions,
): void {
  const [shown, setShown] = React.useState<TeammateShown | undefined>(undefined)
  const lead = shown?.lead
  const watched = lead ?? activeSessionId
  const ui = useModsUiView(runtimeConnection, watched)
  const seen = React.useRef<{ sessionId: string; seq: number } | undefined>(undefined)
  // Sessions whose subagent transcript is shown over their conversation.
  const subagentShown = React.useRef(new Set<string>())
  // A subagent asked for while a teammate is shown: shown once the lead is back.
  const pendingSubagent = React.useRef<{ lead: string; taskId: string } | undefined>(undefined)
  const actionsRef = React.useRef(actions)
  actionsRef.current = actions

  React.useEffect(() => {
    if (!shown || activeSessionId === undefined) return
    if (activeSessionId === shown.teammate) {
      if (!shown.arrived) setShown({ ...shown, arrived: true })
      return
    }
    if (shown.arrived) setShown(undefined)
  }, [activeSessionId, shown])

  const seq = ui.isLoaded ? (ui.view?.seq ?? 0) : undefined
  React.useEffect(() => {
    if (watched === undefined || seq === undefined) return
    const last = seen.current
    seen.current = { sessionId: watched, seq }
    if (last?.sessionId !== watched || last.seq === seq) return
    pendingSubagent.current = undefined
    const view = ui.view
    const act = actionsRef.current
    const leave = (): void => {
      if (!subagentShown.current.delete(watched)) return
      act.leaveSubagent()
    }
    if (view?.agentId !== undefined && view.sessionId !== undefined) {
      if (view.kind === 'teammate') {
        leave()
        setShown({ lead: watched, teammate: view.sessionId, arrived: false })
        act.focusSession(view.sessionId)
        return
      }
      if (lead !== undefined && activeSessionId !== lead) {
        pendingSubagent.current = { lead, taskId: view.sessionId }
        setShown(undefined)
        act.focusSession(lead)
        return
      }
      setShown(undefined)
      subagentShown.current.add(watched)
      act.showSubagent(view.sessionId)
      return
    }
    if (lead !== undefined) {
      setShown(undefined)
      if (activeSessionId !== lead) act.focusSession(lead)
    }
    leave()
    // `ui.view` is read for this `seq` alone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watched, seq])

  React.useEffect(() => {
    const pending = pendingSubagent.current
    if (!pending || activeSessionId !== pending.lead) return
    pendingSubagent.current = undefined
    subagentShown.current.add(pending.lead)
    actionsRef.current.showSubagent(pending.taskId)
  }, [activeSessionId])
}
