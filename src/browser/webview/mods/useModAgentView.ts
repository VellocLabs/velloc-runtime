/**
 * `$.ui.view` on the page (F-25): each new `seq` of a session's published
 * `view` shows that agent's transcript — a teammate's own session, or a
 * subagent's Tasks detail — or, with no `agentId`, goes back. The first state
 * read counts as seen (no replay on open); while a teammate is shown, the
 * lead's state stays the one read, since only the lead's mods can go back.
 */
import * as React from 'react'

import type { RuntimeConnection } from '../../runtimeClient/RuntimeConnection'
import { useModsUiView } from './modsUiView'

export type ModAgentViewActions = {
  /** Show a session in the main view. */
  focusSession(sessionId: string): void
  /** Show a subagent's transcript, by its task id, over the conversation. */
  showSubagent(taskId: string): void
  /** Take a subagent's transcript down again, back to what was shown. */
  leaveSubagent(): void
}

export function useModAgentView(
  runtimeConnection: (() => Promise<RuntimeConnection>) | undefined,
  activeSessionId: string | undefined,
  actions: ModAgentViewActions,
): void {
  // The lead whose teammate is shown; undefined while none is.
  const [lead, setLead] = React.useState<string | undefined>(undefined)
  const watched = lead ?? activeSessionId
  const ui = useModsUiView(runtimeConnection, watched)
  const seen = React.useRef(new Map<string, number>())
  const subagentShown = React.useRef(false)
  // A subagent asked for while a teammate is shown: shown once the lead is back.
  const pendingSubagent = React.useRef<{ lead: string; taskId: string } | undefined>(undefined)
  const actionsRef = React.useRef(actions)
  actionsRef.current = actions

  const seq = ui.isLoaded ? (ui.view?.seq ?? 0) : undefined
  React.useEffect(() => {
    if (watched === undefined || seq === undefined) return
    const last = seen.current.get(watched)
    seen.current.set(watched, seq)
    if (last === undefined || last === seq) return
    const view = ui.view
    const act = actionsRef.current
    if (view?.agentId !== undefined && view.sessionId !== undefined) {
      if (view.kind === 'teammate') {
        if (subagentShown.current) {
          subagentShown.current = false
          act.leaveSubagent()
        }
        setLead(watched)
        act.focusSession(view.sessionId)
        return
      }
      if (lead !== undefined) {
        pendingSubagent.current = { lead, taskId: view.sessionId }
        setLead(undefined)
        act.focusSession(lead)
        return
      }
      subagentShown.current = true
      act.showSubagent(view.sessionId)
      return
    }
    if (lead !== undefined) {
      setLead(undefined)
      act.focusSession(lead)
    }
    if (subagentShown.current) {
      subagentShown.current = false
      act.leaveSubagent()
    }
    // `ui.view` is read for this `seq` alone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watched, seq])

  React.useEffect(() => {
    const pending = pendingSubagent.current
    if (!pending || activeSessionId !== pending.lead) return
    pendingSubagent.current = undefined
    subagentShown.current = true
    actionsRef.current.showSubagent(pending.taskId)
  }, [activeSessionId])
}
