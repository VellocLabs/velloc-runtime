/**
 * Keyboard shortcuts for the side panes (F-9). Matched on physical keys, so a
 * keyboard layout does not move them. Pure.
 *
 *   Ctrl+Shift+D   toggle the Diff pane
 *   Ctrl+`         toggle the Terminal pane
 *   Ctrl+\         close the focused pane
 *   Ctrl+Shift+\   expand or restore the focused pane
 *   Ctrl+Shift+T   reopen the last closed pane
 *   Ctrl+Shift+E   show or hide the Files pane's tree (focus inside that pane)
 */
import type { SidePaneKind } from './paneLayout'

export type PaneShortcut =
  | { action: 'toggle'; kind: SidePaneKind }
  | { action: 'close-focused' }
  | { action: 'expand-focused' }
  | { action: 'reopen-closed' }
  | { action: 'toggle-files-tree' }

/** The Files pane's tree toggle, as its tooltip shows it. */
export const FILES_TREE_SHORTCUT_LABEL = 'Ctrl+Shift+E'
/** The same chord for `aria-keyshortcuts`. */
export const FILES_TREE_ARIA_SHORTCUT = 'Control+Shift+E'

export interface ShortcutKeyEvent {
  code: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
}

/** The shortcut an event stands for, or null. The control key is Ctrl, also on macOS. */
export function paneShortcutFor(event: ShortcutKeyEvent): PaneShortcut | null {
  if (!event.ctrlKey || event.metaKey || event.altKey) return null
  switch (event.code) {
    case 'KeyD':
      return event.shiftKey ? { action: 'toggle', kind: 'diff' } : null
    case 'Backquote':
      return event.shiftKey ? null : { action: 'toggle', kind: 'terminal' }
    case 'KeyT':
      return event.shiftKey ? { action: 'reopen-closed' } : null
    case 'KeyE':
      return event.shiftKey ? { action: 'toggle-files-tree' } : null
    case 'Backslash':
      return event.shiftKey ? { action: 'expand-focused' } : { action: 'close-focused' }
    default:
      return null
  }
}

/** The shortcut shown in a pane's tooltip or menu row, if it has one. */
export function paneShortcutLabel(kind: SidePaneKind): string | null {
  switch (kind) {
    case 'diff':
      return 'Ctrl+Shift+D'
    case 'terminal':
      return 'Ctrl+`'
    case 'files':
      return 'Ctrl+Shift+F'
    default:
      return null
  }
}
