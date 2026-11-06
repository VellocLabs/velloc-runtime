// A2UI side pane bus (F-1); no renderer import, so the shell loads it eagerly.

// Contract:
// - The pane body registers its mount element with `setSlot` (null on unmount).
//   Only the active session's pane is drawn, so at most one slot exists.
// - The foreground session's host portals its surfaces into that element and
//   marks itself the owner with `setOwner`, so the slot can show its empty state.
// - The host asks the shell to open or close the pane with `requestPane`; the
//   shell reports a person's close with `notifyClosed`.

export type A2uiPaneRequest = { sessionId: string; open: boolean }

type Listener = () => void

let slot: HTMLElement | null = null
let owner: string | null = null
const slotListeners = new Set<Listener>()
const requestListeners = new Set<(request: A2uiPaneRequest) => void>()
const closedListeners = new Set<(sessionId: string) => void>()

function emitSlot(): void {
  for (const listener of slotListeners) listener()
}

export function setSlot(element: HTMLElement | null): void {
  if (slot === element) return
  slot = element
  emitSlot()
}

export function getSlot(): HTMLElement | null {
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
