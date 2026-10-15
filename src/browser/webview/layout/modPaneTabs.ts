/**
 * Mods' docked panes as Right Panel tabs (F-25): folds the runtime's open `panes`
 * into one session's tab strip as `mod:<plugin>:<id>` tabs. An open the PERSON
 * asked for, or one a mod opened with `focus` (a new `openSeq`), activates the tab
 * and shows the panel; a mod's other opens only add their tab. Nothing counts as
 * newly opened the first time a session is folded. Not docked, the panes draw
 * inline and their tabs leave the strip.
 */
import {
  closeView,
  ensureRightPanelTab,
  isModViewId,
  modViewId,
  openView,
  type ModViewId,
  type RightPanelState,
} from './rightPanelManager'

export type ModPaneTabSource = { plugin: string; id: string; asked?: boolean; focus?: boolean; openSeq?: number }

export function syncModPaneTabs(
  state: RightPanelState,
  params: {
    panes: readonly ModPaneTabSource[]
    /** Each pane view folded last time for this session, with the `openSeq`
     *  it had; undefined when the session has not been folded yet (nothing
     *  counts as newly opened). */
    seen: ReadonlyMap<ModViewId, number> | undefined
    docked: boolean
  },
): { state: RightPanelState; seen: Map<ModViewId, number> } {
  const current = params.panes.map(pane => ({ view: modViewId(pane.plugin, pane.id), pane }))
  const open = new Map(current.map(({ view, pane }) => [view, pane.openSeq ?? 0]))
  let next = state
  for (const view of state.tabs) {
    if (isModViewId(view) && (!params.docked || !open.has(view))) {
      next = closeView(next, view)
    }
  }
  if (params.docked) {
    for (const { view, pane } of current) {
      const isBroughtForward =
        params.seen !== undefined &&
        (pane.asked === true || pane.focus === true) &&
        (pane.openSeq ?? 0) > (params.seen.get(view) ?? 0)
      if (isBroughtForward) next = openView(next, view)
      else if (!next.tabs.includes(view)) next = ensureRightPanelTab(next, view)
    }
  }
  return { state: next, seen: open }
}
