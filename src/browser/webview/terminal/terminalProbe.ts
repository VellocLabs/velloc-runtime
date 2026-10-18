/**
 * Diagnostics for the Terminal pane (F-31): each mounted emulator by
 * terminal id, reachable from the page as `window.__vellocTerminals`, for
 * the test suite and for a person reproducing a rendering bug. Same trust as
 * the page itself: anything that can run script in the guest can already
 * type into a focused terminal.
 */

export interface TerminalProbeEntry {
  /** The lines of the active buffer (scrollback included), trailing blanks trimmed. */
  lines(): string[]
  cols(): number
  rows(): number
  /** Feed `data` as if typed: it goes through the emulator's input path to the shell. */
  input(data: string): void
}

export type TerminalProbe = Map<string, TerminalProbeEntry>

declare global {
  interface Window {
    __vellocTerminals?: TerminalProbe
  }
}

function probe(): TerminalProbe | null {
  if (typeof window === 'undefined') return null
  window.__vellocTerminals ??= new Map()
  return window.__vellocTerminals
}

/** Register `entry` for `id`; returns the release. */
export function registerTerminalProbe(id: string, entry: TerminalProbeEntry): () => void {
  const map = probe()
  map?.set(id, entry)
  return () => {
    if (map?.get(id) === entry) map.delete(id)
  }
}
