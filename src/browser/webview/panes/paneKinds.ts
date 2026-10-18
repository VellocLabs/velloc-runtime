import {
  ClipboardListIcon,
  FilesIcon,
  GitCompareArrowsIcon,
  GlobeIcon,
  ListTodoIcon,
  SquareTerminalIcon,
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
}

export const PANE_ICON: Record<SidePaneKind, LucideIcon> = {
  tasks: ListTodoIcon,
  diff: GitCompareArrowsIcon,
  browser: GlobeIcon,
  plan: ClipboardListIcon,
  skill: ToolboxIcon,
  files: FilesIcon,
  terminal: SquareTerminalIcon,
}
