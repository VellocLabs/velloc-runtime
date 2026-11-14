/**
 * The open signal a side pane's header flashes on (F-9). Keyed by pane kind:
 * only the shown session's panes are on screen, and the shell signals only
 * for them.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'

import type { SidePaneKind } from '../layout/paneLayout'

const counts = new Map<SidePaneKind, number>()
/** The count a request was made at while no pane of the kind was mounted. */
const waiting = new Map<SidePaneKind, number>()
const mounted = new Map<SidePaneKind, number>()
const listeners = new Set<() => void>()

/** Flash `kind`'s header once more. */
export function requestPaneFlash(kind: SidePaneKind): void {
  const count = (counts.get(kind) ?? 0) + 1
  counts.set(kind, count)
  if ((mounted.get(kind) ?? 0) === 0) waiting.set(kind, count)
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * The flash to play for `kind`: a number that changes on each request, or
 * null when there is none. A pane mounting plays the request its own open
 * made just before it existed, once; a mount with no such request (a session
 * switch, say) plays none.
 */
export function usePaneFlash(kind: SidePaneKind): number | null {
  const count = useSyncExternalStore(subscribe, () => counts.get(kind) ?? 0, () => 0)
  const atMount = useRef(count)
  const [onMount, setOnMount] = useState<number | null>(null)
  useEffect(() => {
    mounted.set(kind, (mounted.get(kind) ?? 0) + 1)
    const asked = waiting.get(kind)
    if (asked !== undefined) {
      waiting.delete(kind)
      if (asked === atMount.current) setOnMount(asked)
    }
    return () => {
      mounted.set(kind, (mounted.get(kind) ?? 1) - 1)
    }
  }, [kind])
  return count === atMount.current ? onMount : count
}
