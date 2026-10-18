/**
 * The shell's drawn layout for a session-area width (F-9). Priority, highest
 * first: the chat, the side region (the panes, the browser among them), the
 * sidebar, the docked card stack; as the area narrows the lowest gives way
 * first and the chat keeps its minimum.
 */

/*
 * Contract: pure; widths are CSS px. Stored preferences (sidebar collapse and
 * width, the panel's visibility and width) come in unchanged and are never
 * altered here — a forced state is a drawing decision only.
 */
import {
  CHAT_CONTENT_MIN_WIDTH_PX,
  SIDEBAR_RAIL_WIDTH_PX,
  SPLITTER_WIDTH_PX,
  STACK_DOCK_MIN_CHAT_PX,
} from './layoutConstants'

export type SidebarForm = 'expanded' | 'rail' | 'hidden'
/**
 * `none`: closed by the person. `beside`: docked next to the chat.
 * `maximized`: covers the chat. `overlay`: open but no room beside the chat —
 * drawn only on demand, over it. `float`: opened by the agent, drawn over the
 * spare width beside the transcript until the person's next input docks it.
 */
export type PanelForm = 'none' | 'beside' | 'maximized' | 'overlay' | 'float'
export type StackPlacement = 'docked' | 'popover'

export interface ShellLayoutInput {
  /** The session area's width (the window below the topbar). */
  areaW: number
  sidebar: { collapsed: boolean; width: number }
  panel: {
    visible: boolean
    maximized: boolean
    /** Share of the room beside the chat (`panelShare`). */
    share: number
    minWidth: number
    maxWidth: number
    /** Set while the panel floats: its drawn width. */
    floatWidth: number | null
    /** The gap between the chat and the panel; the splitter's width by default. */
    gutter?: number
  }
}

export interface ShellLayout {
  sidebar: SidebarForm
  /** The sidebar's drawn width, with its splitter when expanded. */
  sidebarW: number
  /** The widest expanded sidebar (without its splitter) that stays docked. */
  sidebarMaxW: number
  panel: PanelForm
  /** The panel's drawn width beside the chat, without its splitter; 0 unless `beside`. */
  panelW: number
  /** The panel's width off the row: an overlay's wanted width, a float's width; else 0. */
  panelOffRowW: number
  chatW: number
  /** The area itself is narrower than the chat's content: content keeps its floor and is clipped. */
  chatClipped: boolean
  stack: StackPlacement
}

/** The panel's wanted width in `room`, inside `[minWidth, maxWidth]`. */
export function rightPanelWantWidth(
  share: number,
  room: number,
  minWidth: number,
  maxWidth: number,
): number {
  return Math.round(Math.min(Math.max(share * Math.max(0, room), minWidth), maxWidth))
}

export function resolveShellLayout(input: ShellLayoutInput): ShellLayout {
  const { areaW, sidebar, panel } = input
  const chatMin = CHAT_CONTENT_MIN_WIDTH_PX
  const panelOpen: PanelForm = !panel.visible
    ? 'none'
    : panel.maximized
      ? 'maximized'
      : panel.floatWidth !== null
        ? 'float'
        : 'beside'
  const besideRoom = Math.max(0, areaW)

  // The sidebar stays while the chat keeps its floor beside the panel at its
  // minimum (a maximized panel needs only its minimum).
  const dockedSidebarW = sidebar.collapsed ? SIDEBAR_RAIL_WIDTH_PX : sidebar.width + SPLITTER_WIDTH_PX
  const panelGap = panel.gutter ?? SPLITTER_WIDTH_PX
  const panelMinNeed = panel.minWidth + panelGap
  const othersNeed =
    panelOpen === 'maximized' ? panel.minWidth : panelOpen === 'beside' ? chatMin + panelMinNeed : chatMin
  const form: SidebarForm =
    besideRoom - dockedSidebarW < othersNeed ? 'hidden' : sidebar.collapsed ? 'rail' : 'expanded'
  const sidebarW = form === 'hidden' ? 0 : dockedSidebarW
  const room = besideRoom - sidebarW
  const sidebarMaxW = besideRoom - SPLITTER_WIDTH_PX - othersNeed

  let panelForm: PanelForm = panelOpen
  let panelW = 0
  let panelOffRowW = 0
  let chatW = room
  if (panelOpen === 'maximized') {
    panelW = room
    chatW = 0
  } else if (panelOpen === 'float') {
    panelOffRowW = panel.floatWidth ?? 0
  } else if (panelOpen === 'beside') {
    const panelRoom = room - panelGap
    const want = rightPanelWantWidth(panel.share, panelRoom, panel.minWidth, panel.maxWidth)
    if (panelRoom - want >= chatMin) panelW = want
    else if (panelRoom - panel.minWidth >= chatMin) panelW = panelRoom - chatMin
    else {
      panelForm = 'overlay'
      panelOffRowW = want
    }
    chatW = panelForm === 'beside' ? panelRoom - panelW : room
  }

  // A maximized panel covers the chat without moving the stack: it stays
  // where the chat beside the panel has it.
  const stack: StackPlacement =
    panelOpen === 'maximized'
      ? resolveShellLayout({ ...input, panel: { ...panel, maximized: false } }).stack
      : chatW >= STACK_DOCK_MIN_CHAT_PX
        ? 'docked'
        : 'popover'

  return {
    sidebar: form,
    sidebarW,
    sidebarMaxW,
    panel: panelForm,
    panelW,
    panelOffRowW,
    chatW,
    chatClipped: chatW > 0 && chatW < chatMin,
    stack,
  }
}
