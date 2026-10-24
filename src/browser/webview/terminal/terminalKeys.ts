/**
 * The key policy of a focused terminal (F-31): which key events the app
 * keeps, which the view handles itself, and which go to the shell. Pure;
 * matched on physical keys so a keyboard layout does not move them.
 */

export interface TerminalKeyEvent {
  type: string
  code: string
  key: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
}

/**
 * `app`: the event is left to the app's own handlers (pane shortcuts and
 * session switching). `copy`: the view copies the selection. `paste`: the
 * browser's own paste runs, not the program's key. `search`: the view opens
 * its find bar. `shell`: the emulator encodes the key for the program.
 */
export type TerminalKeyDecision = 'app' | 'copy' | 'paste' | 'search' | 'shell'

/** The chords the app keeps while a terminal has focus: Ctrl + one of these codes, Shift or not. */
const APP_CODES: ReadonlySet<string> = new Set([
  'Backquote', // toggle the Terminal pane
  'Tab', // switch session
  'Backslash', // close / expand the focused pane
])
/** The app's Ctrl+Shift chords that stay with the app. */
const APP_SHIFT_CODES: ReadonlySet<string> = new Set(['KeyD', 'KeyT'])

export function terminalKeyDecision(
  event: TerminalKeyEvent,
  state: { hasSelection: boolean },
): TerminalKeyDecision {
  // Only Ctrl chords carry policy; Alt and the OS key pass to the program.
  if (!event.ctrlKey || event.metaKey || event.altKey) return 'shell'
  if (APP_CODES.has(event.code)) return 'app'
  if (event.shiftKey && APP_SHIFT_CODES.has(event.code)) return 'app'
  if (event.shiftKey && event.code === 'KeyF') return 'search'
  // Terminal convention: Ctrl+Shift+C / V always copy and paste.
  if (event.shiftKey && event.code === 'KeyC') return 'copy'
  if (event.shiftKey && event.code === 'KeyV') return 'paste'
  // Ctrl+C copies a selection and otherwise interrupts the program.
  if (!event.shiftKey && event.code === 'KeyC') return state.hasSelection ? 'copy' : 'shell'
  if (!event.shiftKey && event.code === 'KeyV') return 'paste'
  return 'shell'
}
