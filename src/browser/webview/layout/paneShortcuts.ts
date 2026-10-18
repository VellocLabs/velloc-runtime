/**
 * Keyboard shortcuts for the side panes (F-9): Ctrl+Shift+D toggles Diff,
 * Ctrl+\ closes the focused pane, Ctrl+Shift+\ expands or restores it,
 * Ctrl+Shift+T reopens the last closed pane. Matched on physical keys, so a
 * keyboard layout does not move them. Pure.
 */
import type { SidePaneKind } from './paneLayout'

export type PaneShortcut =
  | { action: 'toggle'; kind: SidePaneKind }
  | { action: 'close-focused' }
  | { action: 'expand-focused' }
  | { action: 'reopen-closed' }

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
    case 'KeyT':
      return event.shiftKey ? { action: 'reopen-closed' } : null
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
