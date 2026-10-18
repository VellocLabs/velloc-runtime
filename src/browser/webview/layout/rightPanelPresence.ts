/**
 * How the open side region is presented beyond its docked form (F-9): the
 * float an agent-opened pane takes over the spare width at the chat's end,
 * and the width a settled float holds. Pure: the shell reports each event
 * with its origin — the person, the agent, a resolved plan, input, a resize,
 * a session switch, a close — and draws what this state says.
 */
import { RIGHT_PANEL_FLOAT_MIN_WIDTH_PX } from './layoutConstants'
import type { SidePaneKind } from './paneLayout'

/** An agent-opened pane floating over the spare width, in the session it opened in. */
export interface RightPanelFloat {
  width: number
  /** The session-area width it floated at; another width settles it. */
  areaW: number
  view: SidePaneKind
  sessionId: string
}

export interface RightPanelPresence {
  float: RightPanelFloat | null
  /** A settled float's share, held while its pane kind stays in front. */
  hold: { kind: SidePaneKind; share: number } | null
  /** The room a docked region splits with the chat, as last reported. */
  room: number
}

export type RightPanelPresenceEvent =
  /** The person brought `view` forward: a link, a card, a toggle. */
  | { type: 'personOpen'; view: SidePaneKind }
  /**
   * The agent brought `view` forward on its own. `panelOpen`: the region was
   * already shown (docked or maximized). `spare`: the width beside the
   * transcript column, null when unmeasured. `dockedWidth`: the width the
   * pane would dock at. `areaW`: the session-area width now.
   */
  | {
      type: 'agentOpen'
      view: SidePaneKind
      sessionId: string
      panelOpen: boolean
      spare: number | null
      dockedWidth: number
      areaW: number
    }
  /** A resolved plan left `nextView` in front; null when nothing is left. */
  | { type: 'planClosed'; nextView: SidePaneKind | null }
  /** A press, key or wheel by the person. */
  | { type: 'input' }
  | { type: 'resize'; areaW: number; room: number }
  | { type: 'sessionSwitch'; sessionId: string }
  /** The person dragged a separator. */
  | { type: 'drag' }
  /** The region closed (its last pane left). */
  | { type: 'close' }

export function initialRightPanelPresence(): RightPanelPresence {
  return { float: null, hold: null, room: 0 }
}

export function stepRightPanelPresence(
  state: RightPanelPresence,
  event: RightPanelPresenceEvent,
): RightPanelPresence {
  switch (event.type) {
    case 'personOpen':
      return frontView(state, event.view)
    case 'agentOpen': {
      const next = frontView(state, event.view)
      if (event.panelOpen || event.spare === null || event.spare < RIGHT_PANEL_FLOAT_MIN_WIDTH_PX) {
        return next
      }
      return {
        ...next,
        float: {
          width: Math.min(event.spare, event.dockedWidth),
          areaW: event.areaW,
          view: event.view,
          sessionId: event.sessionId,
        },
      }
    }
    case 'planClosed':
      return event.nextView === null ? closed(state) : frontView(state, event.nextView)
    case 'input':
      return state.float ? settle(state, state.float.view) : state
    case 'resize': {
      const reported = state.room === event.room ? state : { ...state, room: event.room }
      return reported.float && reported.float.areaW !== event.areaW
        ? settle(reported, reported.float.view)
        : reported
    }
    case 'sessionSwitch': {
      // The float of the session left behind goes; one the agent just opened
      // in the session switched to stays.
      const float = state.float?.sessionId === event.sessionId ? state.float : null
      if (float === state.float && state.hold === null) return state
      return { ...state, float, hold: null }
    }
    case 'drag':
      return state.hold ? { ...state, hold: null } : state
    case 'close':
      return closed(state)
  }
}

/** `view` came to the front: another pane settles the float; another kind drops the hold. */
function frontView(state: RightPanelPresence, view: SidePaneKind): RightPanelPresence {
  const settled = state.float && state.float.view !== view ? settle(state, view) : state
  return settled.hold && settled.hold.kind !== view ? { ...settled, hold: null } : settled
}

/** Docks the float at the width it floated at, held for the kind of `view`. */
function settle(state: RightPanelPresence, view: SidePaneKind): RightPanelPresence {
  if (!state.float) return state
  const share = state.room > 0 ? state.float.width / state.room : Number.NaN
  return {
    ...state,
    float: null,
    hold: Number.isFinite(share) ? { kind: view, share } : state.hold,
  }
}

function closed(state: RightPanelPresence): RightPanelPresence {
  if (!state.float && !state.hold) return state
  return { ...state, float: null, hold: null }
}
