import type { Dispatch, SetStateAction } from 'react'

// The Sessions page's handlers (F-17), built outside the shell's render so no
// handler keeps a render scope alive.

export function createShellHandleOpenSessionsPage(
  setSessionsPageOpen: Dispatch<SetStateAction<boolean>>,
) {
  return () => {
    setSessionsPageOpen(true)
  }
}

export function createShellHandleCloseSessionsPage(
  setSessionsPageOpen: Dispatch<SetStateAction<boolean>>,
) {
  return () => {
    setSessionsPageOpen(false)
  }
}

/**
 * Opens a session picked from the page or the sidebar. Closes the page itself:
 * picking the active session leaves the active id unchanged.
 */
export function createShellHandleOpenListedSession(
  setSessionsPageOpen: Dispatch<SetStateAction<boolean>>,
  focusSession: (sessionId: string) => void,
) {
  return (sessionId: string) => {
    setSessionsPageOpen(false)
    focusSession(sessionId)
  }
}

/** Starts a session and closes the page, also when the start reuses the active empty session. */
export function createShellHandleNewSessionFromList(
  setSessionsPageOpen: Dispatch<SetStateAction<boolean>>,
  openNewSession: () => void,
) {
  return () => {
    setSessionsPageOpen(false)
    openNewSession()
  }
}
