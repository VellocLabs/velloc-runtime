/**
 * The shell's drawn layout for a session-area width (F-9). Priority, highest
 * first: the chat, the Right Panel, the sidebar, the docked card stack; as the
 * area narrows the lowest gives way first and the chat keeps its minimum.
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
 * drawn only on demand, floating over it.
 */
export type PanelForm = 'none' | 'beside' | 'maximized' | 'overlay'
export type StackPlacement = 'docked' | 'popover'

export interface ShellLayoutInput {
  /** The session area's width (the window below the topbar). */
  areaW: number
  sidebar: { collapsed: boolean; width: number }
  panel: { visible: boolean; maximized: boolean; width: number; minWidth: number }
  /** The docked browser's drawn width with its splitter, 0 when it is not shown. */
  browserW: number
}

export interface ShellLayout {
  sidebar: SidebarForm
  /** The sidebar's drawn width, with its splitter when expanded. */
  sidebarW: number
  panel: PanelForm
  /** The panel's drawn width beside the chat, without its splitter; 0 unless `beside`. */
  panelW: number
  chatW: number
  /** The area itself is narrower than the chat's content: content keeps its floor and is clipped. */
  chatClipped: boolean
  stack: StackPlacement
}

export function resolveShellLayout(input: ShellLayoutInput): ShellLayout {
  const { areaW, sidebar, panel, browserW } = input
  const chatMin = CHAT_CONTENT_MIN_WIDTH_PX
  const panelOpen: PanelForm = !panel.visible ? 'none' : panel.maximized ? 'maximized' : 'beside'
  const besideRoom = Math.max(0, areaW - Math.max(0, browserW))

  // The sidebar stays while the chat keeps its floor beside the panel at its
  // minimum (a maximized panel needs only its minimum).
  const dockedSidebarW = sidebar.collapsed ? SIDEBAR_RAIL_WIDTH_PX : sidebar.width + SPLITTER_WIDTH_PX
  const panelMinNeed = panel.minWidth + SPLITTER_WIDTH_PX
  const othersNeed =
    panelOpen === 'maximized' ? panel.minWidth : panelOpen === 'beside' ? chatMin + panelMinNeed : chatMin
  const form: SidebarForm =
    besideRoom - dockedSidebarW < othersNeed ? 'hidden' : sidebar.collapsed ? 'rail' : 'expanded'
  const sidebarW = form === 'hidden' ? 0 : dockedSidebarW
  const room = besideRoom - sidebarW

  let panelForm: PanelForm = panelOpen
  let panelW = 0
  let chatW = room
  if (panelOpen === 'maximized') {
    panelW = room
    chatW = 0
  } else if (panelOpen === 'beside') {
    const panelRoom = room - SPLITTER_WIDTH_PX
    if (panelRoom - panel.width >= chatMin) panelW = panel.width
    else if (panelRoom - panel.minWidth >= chatMin) panelW = panelRoom - chatMin
    else panelForm = 'overlay'
    chatW = panelForm === 'beside' ? panelRoom - panelW : room
  }

  return {
    sidebar: form,
    sidebarW,
    panel: panelForm,
    panelW,
    chatW,
    chatClipped: chatW > 0 && chatW < chatMin,
    stack: chatW >= STACK_DOCK_MIN_CHAT_PX && panelForm !== 'maximized' ? 'docked' : 'popover',
  }
}
