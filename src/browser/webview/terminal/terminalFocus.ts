/**
 * Which terminal the Terminal pane should bring forward for a session (F-31):
 * a request made outside the pane — a chat card that ran a command — waits
 * here until the pane shows that terminal's tab and takes it. Page memory only.
 */

const requests = new Map<string, string>()
const listeners = new Set<() => void>()

/** Ask the pane to activate `terminalId`'s tab the next time it shows `sessionId`. */
export function requestTerminalFocus(sessionId: string, terminalId: string): void {
  if (requests.get(sessionId) === terminalId) return
  requests.set(sessionId, terminalId)
  for (const listener of Array.from(listeners)) listener()
}

/** The terminal waiting to be activated for `sessionId`, if any. */
export function pendingTerminalFocus(sessionId: string): string | undefined {
  return requests.get(sessionId)
}

/** The pane activated the tab: the request is done. */
export function clearTerminalFocus(sessionId: string, terminalId: string): void {
  if (requests.get(sessionId) !== terminalId) return
  requests.delete(sessionId)
  for (const listener of Array.from(listeners)) listener()
}

export function subscribeTerminalFocus(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function resetTerminalFocusForTests(): void {
  requests.clear()
}
