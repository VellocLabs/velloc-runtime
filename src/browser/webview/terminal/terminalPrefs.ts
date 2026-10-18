/**
 * The viewer's terminal preferences (F-31): cursor style, cursor blink,
 * copy on select and the scrollback kept by the emulator. Per browser
 * profile, in localStorage, best-effort: a missing or unreadable store
 * yields the defaults and a failed write is ignored. These are display
 * preferences only — terminal output is never stored here.
 */

export const TERMINAL_PREFS_STORAGE_KEY = 'nexus.terminal.prefs'

export const TERMINAL_CURSOR_STYLES = ['block', 'bar', 'underline'] as const
export type TerminalCursorStyle = (typeof TERMINAL_CURSOR_STYLES)[number]

/** The scrollback choices the menu offers, in lines. */
export const TERMINAL_SCROLLBACK_CHOICES = [1_000, 5_000, 10_000, 50_000] as const

export interface TerminalPrefs {
  cursorStyle: TerminalCursorStyle
  cursorBlink: boolean
  copyOnSelect: boolean
  scrollbackLines: number
}

export const DEFAULT_TERMINAL_PREFS: TerminalPrefs = {
  cursorStyle: 'bar',
  cursorBlink: true,
  copyOnSelect: false,
  scrollbackLines: 10_000,
}

function isCursorStyle(value: unknown): value is TerminalCursorStyle {
  return typeof value === 'string' && (TERMINAL_CURSOR_STYLES as readonly string[]).includes(value)
}

/** The prefs `value` describes; every unreadable field is the default. */
export function sanitizeTerminalPrefs(value: unknown): TerminalPrefs {
  const record = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  const scrollback = record.scrollbackLines
  return {
    cursorStyle: isCursorStyle(record.cursorStyle) ? record.cursorStyle : DEFAULT_TERMINAL_PREFS.cursorStyle,
    cursorBlink:
      typeof record.cursorBlink === 'boolean' ? record.cursorBlink : DEFAULT_TERMINAL_PREFS.cursorBlink,
    copyOnSelect:
      typeof record.copyOnSelect === 'boolean' ? record.copyOnSelect : DEFAULT_TERMINAL_PREFS.copyOnSelect,
    scrollbackLines:
      typeof scrollback === 'number' && Number.isInteger(scrollback) && scrollback >= 0 && scrollback <= 1_000_000
        ? scrollback
        : DEFAULT_TERMINAL_PREFS.scrollbackLines,
  }
}

let current: TerminalPrefs | null = null
const listeners = new Set<() => void>()

function read(): TerminalPrefs {
  try {
    const raw = globalThis.localStorage?.getItem(TERMINAL_PREFS_STORAGE_KEY)
    return sanitizeTerminalPrefs(raw == null ? null : JSON.parse(raw))
  } catch {
    return { ...DEFAULT_TERMINAL_PREFS }
  }
}

export function loadTerminalPrefs(): TerminalPrefs {
  if (!current) current = read()
  return current
}

/** Apply `patch`, store the result and tell the subscribers; a no-op patch changes nothing. */
export function updateTerminalPrefs(patch: Partial<TerminalPrefs>): TerminalPrefs {
  const prev = loadTerminalPrefs()
  const next = sanitizeTerminalPrefs({ ...prev, ...patch })
  if (
    next.cursorStyle === prev.cursorStyle &&
    next.cursorBlink === prev.cursorBlink &&
    next.copyOnSelect === prev.copyOnSelect &&
    next.scrollbackLines === prev.scrollbackLines
  ) {
    return prev
  }
  current = next
  try {
    globalThis.localStorage?.setItem(TERMINAL_PREFS_STORAGE_KEY, JSON.stringify(next))
  } catch {
    // Storage may be unavailable or full; the preference still applies this session.
  }
  for (const listener of [...listeners]) listener()
  return next
}

export function subscribeTerminalPrefs(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Forget the cached prefs (tests). */
export function resetTerminalPrefsForTests(): void {
  current = null
}
