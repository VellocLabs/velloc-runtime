// A2UI side pane bus (F-1); no renderer import, so the shell loads it eagerly.

// Contract:
// - The pane body registers its mount element and the session the shell shows
//   with `setSlot` (null on unmount). Only the shown session's pane is drawn,
//   so at most one slot exists.
// - The host of the session the slot names portals its surfaces into that
//   element and marks itself the owner with `setOwner`, so the slot can show
//   its empty state. Any other host (a hidden session, a side chat) does not.
// - The host asks the shell to open or close the pane with `requestPane`; the
//   shell reports a person's close with `notifyClosed`.

/** `byPerson`: the person pressed a card or tab, not a transcript change. */
export type A2uiPaneRequest = { sessionId: string; open: boolean; byPerson?: boolean }

export type A2uiPaneSlot = { element: HTMLElement; sessionId: string }

type Listener = () => void

let slot: A2uiPaneSlot | null = null
let owner: string | null = null
const slotListeners = new Set<Listener>()
const requestListeners = new Set<(request: A2uiPaneRequest) => void>()
const closedListeners = new Set<(sessionId: string) => void>()

function emitSlot(): void {
  for (const listener of slotListeners) listener()
}

export function setSlot(element: HTMLElement | null, sessionId: string | null): void {
  const next = element && sessionId ? { element, sessionId } : null
  if (slot?.element === next?.element && slot?.sessionId === next?.sessionId) return
  slot = next
  emitSlot()
}

export function getSlot(): A2uiPaneSlot | null {
  return slot
}

export function setOwner(sessionId: string | null): void {
  if (owner === sessionId) return
  owner = sessionId
  emitSlot()
}

export function getOwner(): string | null {
  return owner
}

export function subscribeSlot(listener: Listener): () => void {
  slotListeners.add(listener)
  return () => {
    slotListeners.delete(listener)
  }
}

export function requestPane(request: A2uiPaneRequest): void {
  for (const listener of requestListeners) listener(request)
}

export function onPaneRequest(listener: (request: A2uiPaneRequest) => void): () => void {
  requestListeners.add(listener)
  return () => {
    requestListeners.delete(listener)
  }
}

export function notifyClosed(sessionId: string): void {
  for (const listener of closedListeners) listener(sessionId)
}

export function onPaneClosed(listener: (sessionId: string) => void): () => void {
  closedListeners.add(listener)
  return () => {
    closedListeners.delete(listener)
  }
}
