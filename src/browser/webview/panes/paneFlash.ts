/**
 * The open signal a side pane's header flashes on (F-9). Keyed by pane kind:
 * only the shown session's panes are on screen, and the shell signals only
 * for them.
 */
import { useRef, useSyncExternalStore } from 'react'

import type { SidePaneKind } from '../layout/paneLayout'

const counts = new Map<SidePaneKind, number>()
const listeners = new Set<() => void>()

/** Flash `kind`'s header once more. */
export function requestPaneFlash(kind: SidePaneKind): void {
  counts.set(kind, (counts.get(kind) ?? 0) + 1)
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * The flash to play for `kind`: a number that changes on each request made
 * after this component mounted, or null when there is none yet (a pane
 * mounting, say on a session switch, does not flash).
 */
export function usePaneFlash(kind: SidePaneKind): number | null {
  const count = useSyncExternalStore(subscribe, () => counts.get(kind) ?? 0, () => 0)
  const atMount = useRef(count)
  return count === atMount.current ? null : count
}
