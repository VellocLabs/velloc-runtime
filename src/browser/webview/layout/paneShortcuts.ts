/**
 * Keyboard shortcuts for the side panes (F-9). Matched on physical keys, so a
 * keyboard layout does not move them. Pure.
 *
 *   Ctrl+Shift+D   toggle the Diff pane
 *   Ctrl+`         toggle the Terminal pane
 *   Ctrl+Shift+B   toggle the Browser pane
 *   Ctrl+Shift+F   toggle the Files pane (not while focus is in a terminal,
 *                  where it opens the find bar)
 *   Ctrl+;         toggle the Side chats pane
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

/** The `{modifier}` a pane shortcut's catalog key text is filled with: Ctrl on every platform. */
export const PANE_SHORTCUT_MODIFIER = 'Ctrl'
/** The Files pane's tree toggle for `aria-keyshortcuts`. */
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
    case 'KeyB':
      return event.shiftKey ? { action: 'toggle', kind: 'browser' } : null
    case 'KeyF':
      return event.shiftKey ? { action: 'toggle', kind: 'files' } : null
    case 'Backquote':
      return event.shiftKey ? null : { action: 'toggle', kind: 'terminal' }
    case 'Semicolon':
      return event.shiftKey ? null : { action: 'toggle', kind: 'sidechat' }
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

/**
 * Whether `shortcut` is left to the terminal emulator `focused` sits in:
 * Ctrl+Shift+F is its find bar there. Elsewhere in the Terminal pane (its
 * header, an empty state) the shortcut stays a pane shortcut.
 */
export function paneShortcutYieldsToTerminal(shortcut: PaneShortcut, focused: Element | null): boolean {
  return (
    shortcut.action === 'toggle' &&
    shortcut.kind === 'files' &&
    focused !== null &&
    focused.closest('[data-terminal-view="live"]') !== null
  )
}

/** What a session's panes look like when a pane shortcut is pressed. */
export interface PaneShortcutScene {
  /** The open panes, in layout order. */
  panes: readonly SidePaneKind[]
  /** The pane that last had focus, if it is still open. */
  focused?: SidePaneKind
  maximized: SidePaneKind | null
  lastClosed?: SidePaneKind
  /** The panes this session can show; absent: every pane. */
  offered?: readonly SidePaneKind[]
}

/** The change a pane shortcut makes. */
export type PaneShortcutStep =
  | { do: 'toggle'; kind: SidePaneKind }
  | { do: 'close'; kind: SidePaneKind }
  | { do: 'maximize'; kind: SidePaneKind | null }
  | { do: 'open'; kind: SidePaneKind }

/**
 * The change `shortcut` makes in `scene`, or null when it would change
 * nothing (no pane to close or expand, nothing to reopen, a pane the session
 * does not offer). The Files tree toggle is decided by focus, not here.
 */
export function paneShortcutStep(
  shortcut: Exclude<PaneShortcut, { action: 'toggle-files-tree' }>,
  scene: PaneShortcutScene,
): PaneShortcutStep | null {
  const offered = (kind: SidePaneKind) => !scene.offered || scene.offered.includes(kind)
  const target =
    scene.focused && scene.panes.includes(scene.focused)
      ? scene.focused
      : scene.panes[scene.panes.length - 1]
  switch (shortcut.action) {
    case 'toggle':
      return offered(shortcut.kind) ? { do: 'toggle', kind: shortcut.kind } : null
    case 'close-focused':
      return target ? { do: 'close', kind: target } : null
    case 'expand-focused':
      if (scene.maximized !== null) return { do: 'maximize', kind: null }
      return target ? { do: 'maximize', kind: target } : null
    case 'reopen-closed': {
      const kind = scene.lastClosed
      return kind && !scene.panes.includes(kind) && offered(kind) ? { do: 'open', kind } : null
    }
  }
}

/** The shortcut shown in a pane's tooltip or menu row, if it has one. */
export function paneShortcutLabel(kind: SidePaneKind): string | null {
  switch (kind) {
    case 'diff':
      return 'Ctrl+Shift+D'
    case 'terminal':
      return 'Ctrl+`'
    case 'browser':
      return 'Ctrl+Shift+B'
    case 'files':
      return 'Ctrl+Shift+F'
    case 'sidechat':
      return 'Ctrl+;'
    default:
      return null
  }
}
