import {
  ClipboardListIcon,
  FileDiffIcon,
  FolderIcon,
  LayoutPanelLeftIcon,
  ListTodoIcon,
  MessagesSquareIcon,
  PuzzleIcon,
  SquareMousePointerIcon,
  TerminalIcon,
  ToolboxIcon,
  type LucideIcon,
} from 'lucide-react'

import type { MessageKey } from '../i18n/messages/en'
import type { SidePaneKind } from '../layout/paneLayout'

/** The pane names, for the topbar, the More menu and the frame handles (F-9). */
export const PANE_LABEL_KEY: Record<SidePaneKind, MessageKey> = {
  tasks: 'topbar.pane.tasks',
  diff: 'topbar.pane.diff',
  browser: 'topbar.pane.browser',
  plan: 'topbar.pane.plan',
  skill: 'topbar.pane.skill',
  files: 'topbar.pane.files',
  terminal: 'topbar.pane.terminal',
  mods: 'topbar.pane.mods',
  sidechat: 'topbar.pane.sidechat',
  a2ui: 'topbar.pane.a2ui',
}

/** Panes that, maximized, fill the area edge to edge with no header or frame (F-9). */
export const IMMERSIVE_PANES: ReadonlySet<SidePaneKind> = new Set<SidePaneKind>(['a2ui'])

export const PANE_ICON: Record<SidePaneKind, LucideIcon> = {
  tasks: ListTodoIcon,
  diff: FileDiffIcon,
  browser: SquareMousePointerIcon,
  plan: ClipboardListIcon,
  skill: ToolboxIcon,
  files: FolderIcon,
  terminal: TerminalIcon,
  mods: PuzzleIcon,
  sidechat: MessagesSquareIcon,
  a2ui: LayoutPanelLeftIcon,
}
