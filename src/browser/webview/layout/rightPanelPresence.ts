/**
 * How the open Right Panel is presented beyond its docked form (F-9): the
 * overlay drawn over the chat when the panel has no room beside it, the float
 * an agent-opened view takes over the spare width at the chat's end, and the
 * width a settled float holds. Pure: the shell reports each event with its
 * origin — the person, the agent, a resolved plan, input, a resize, a session
 * switch, a close — and draws what this state says.
 */
import { RIGHT_PANEL_FLOAT_MIN_WIDTH_PX } from './layoutConstants'
import { rightPanelViewKind, shareFromWidth, type RightPanelViewKind } from './panelShare'
import type { RightPanelViewId } from './rightPanelManager'
import type { PanelForm } from './shellLayout'

/** An agent-opened view floating over the spare width, in the session it opened in. */
export interface RightPanelFloat {
  width: number
  /** The session-area width it floated at; another width settles it. */
  areaW: number
  view: RightPanelViewId
  sessionId: string
}

export interface RightPanelPresence {
  /** The person asked for the overlay; it is drawn only while the panel's form is `overlay`. */
  overlay: boolean
  float: RightPanelFloat | null
  /** A settled float's share, held while its view kind stays in front. */
  hold: { kind: RightPanelViewKind; share: number } | null
  /** The panel's drawn form as last reported. */
  form: PanelForm
  /** The room a docked panel splits with the chat. */
  room: number
}

export type RightPanelPresenceEvent =
  /** The person brought `view` forward: a link, a card, a tab, the toggle. */
  | { type: 'personOpen'; view: RightPanelViewId }
  /**
   * The agent brought `view` forward on its own. `panelOpen`: the panel was
   * already shown (docked or maximized). `spare`: the width beside the
   * transcript column, null when unmeasured. `dockedWidth`: the width the
   * view would dock at. `areaW`: the session-area width now.
   */
  | {
      type: 'agentOpen'
      view: RightPanelViewId
      sessionId: string
      panelOpen: boolean
      spare: number | null
      dockedWidth: number
      areaW: number
    }
  /** A resolved plan left `nextView` in front; null when nothing is left. */
  | { type: 'planClosed'; nextView: RightPanelViewId | null }
  /** A press, key or wheel by the person. */
  | { type: 'input' }
  | { type: 'resize'; areaW: number; form: PanelForm; room: number }
  | { type: 'sessionSwitch'; sessionId: string }
  /** The topbar panel toggle while the panel is overlaid. */
  | { type: 'toggle' }
  /** Escape or a press outside the overlay. */
  | { type: 'dismiss' }
  /** The person dragged the panel's splitter. */
  | { type: 'drag' }
  /** The panel closed. */
  | { type: 'close' }

export function initialRightPanelPresence(): RightPanelPresence {
  return { overlay: false, float: null, hold: null, form: 'none', room: 0 }
}

export function stepRightPanelPresence(
  state: RightPanelPresence,
  event: RightPanelPresenceEvent,
): RightPanelPresence {
  switch (event.type) {
    case 'personOpen': {
      const next = frontView(state, event.view)
      // Before the panel is drawn its form is unknown; the next resize drops
      // the request unless the panel lands overlaid.
      const overlaidOrPending = state.form === 'overlay' || state.form === 'none'
      return overlaidOrPending && !next.overlay ? { ...next, overlay: true } : next
    }
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
      const reported = { ...state, form: event.form, room: event.room }
      const withOverlay =
        reported.overlay && event.form !== 'overlay' ? { ...reported, overlay: false } : reported
      return withOverlay.float && withOverlay.float.areaW !== event.areaW
        ? settle(withOverlay, withOverlay.float.view)
        : withOverlay
    }
    case 'sessionSwitch': {
      // The float of the session left behind goes; one the agent just opened
      // in the session switched to stays.
      const float = state.float?.sessionId === event.sessionId ? state.float : null
      if (!state.overlay && float === state.float && state.hold === null) return state
      return { ...state, overlay: false, float, hold: null }
    }
    case 'toggle':
      return state.form === 'overlay' ? { ...state, overlay: !state.overlay } : state
    case 'dismiss':
      return state.overlay ? { ...state, overlay: false } : state
    case 'drag':
      return state.hold ? { ...state, hold: null } : state
    case 'close':
      return closed(state)
  }
}

/** `view` came to the front: another view settles the float; another kind drops the hold. */
function frontView(state: RightPanelPresence, view: RightPanelViewId): RightPanelPresence {
  const settled = state.float && state.float.view !== view ? settle(state, view) : state
  const kind = rightPanelViewKind(view)
  return settled.hold && settled.hold.kind !== kind ? { ...settled, hold: null } : settled
}

/** Docks the float at the width it floated at, held for the kind of `view`. */
function settle(state: RightPanelPresence, view: RightPanelViewId): RightPanelPresence {
  if (!state.float) return state
  const share = shareFromWidth(state.float.width, state.room)
  return {
    ...state,
    float: null,
    hold: Number.isFinite(share) ? { kind: rightPanelViewKind(view), share } : state.hold,
  }
}

function closed(state: RightPanelPresence): RightPanelPresence {
  if (!state.overlay && !state.float && !state.hold) return state
  return { ...state, overlay: false, float: null, hold: null }
}
