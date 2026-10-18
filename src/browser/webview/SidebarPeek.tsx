/**
 * The sidebar's peek drawer (F-9): the full sidebar floating over the chat,
 * the layout unmoved. Opened from the hidden form (narrow area) by a pointer
 * resting at the start edge or the topbar toggle; from the rail by a pointer
 * resting on it, the rail's width held underneath. Escape, a press outside,
 * the pointer leaving or a session switch closes it. Docked expanded, this
 * renders its children as they are.
 */
import * as React from 'react'

import { useOverlayDismiss } from './layout/useOverlayDismiss'

/** Pointer distance from the start edge that opens the drawer, after a dwell. */
const PEEK_EDGE_PX = 16
const PEEK_EDGE_DWELL_MS = 100
/** Longer on the rail, so a quick press still reaches the rail's own icons. */
const PEEK_RAIL_DWELL_MS = 300

export function SidebarPeek({
  hidden,
  railWidth,
  open,
  onOpenChange,
  activeSessionId,
  children,
}: {
  hidden: boolean
  /** Set while the docked form is the rail: its width, held while peeking. */
  railWidth?: number
  open: boolean
  onOpenChange: (open: boolean) => void
  activeSessionId: string
  children?: React.ReactNode
}) {
  const dwellRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const onOpenChangeRef = React.useRef(onOpenChange)
  onOpenChangeRef.current = onOpenChange

  const clearDwell = React.useCallback(() => {
    if (dwellRef.current !== null) clearTimeout(dwellRef.current)
    dwellRef.current = null
  }, [])
  React.useEffect(() => clearDwell, [clearDwell])
  const startDwell = React.useCallback((ms: number) => {
    clearDwell()
    dwellRef.current = setTimeout(() => onOpenChangeRef.current(true), ms)
  }, [clearDwell])

  const fromRail = !hidden && railWidth !== undefined
  const peekable = hidden || fromRail
  const active = peekable && open
  const dismiss = useOverlayDismiss(
    active,
    () => onOpenChangeRef.current(false),
    '[data-testid="topbar-sidebar-toggle"]',
  )
  React.useEffect(() => {
    if (!active) clearDwell()
  }, [active, clearDwell])

  // A pointer move outside it closes it too: when it opens under a resting
  // pointer, the browser may send no leave event for it.
  const moveInsideRef = React.useRef<Event | null>(null)
  React.useEffect(() => {
    if (!active) return
    const onMove = (event: PointerEvent) => {
      if (moveInsideRef.current === event) return
      onOpenChangeRef.current(false)
    }
    document.addEventListener('pointermove', onMove)
    return () => document.removeEventListener('pointermove', onMove)
  }, [active])

  // Choosing a session closes it.
  const shownForRef = React.useRef(activeSessionId)
  React.useEffect(() => {
    if (shownForRef.current !== activeSessionId && active) onOpenChangeRef.current(false)
    shownForRef.current = activeSessionId
  }, [activeSessionId, active])

  // One wrapper in every form, so the sidebar inside never remounts: laid out
  // as if absent while docked, kept mounted but undrawn while the hidden peek
  // is shut.
  return (
    <>
      <div
        data-testid={active ? 'sidebar-peek' : fromRail ? 'sidebar-rail-peek' : undefined}
        data-peek-from={active ? (hidden ? 'hidden' : 'rail') : undefined}
        className={
          active
            ? 'absolute inset-y-0 start-0 z-40 flex border-border border-e shadow-xl'
            : hidden
              ? 'hidden'
              : 'contents'
        }
        {...(active ? dismiss : null)}
        onPointerEnter={fromRail && !open ? () => startDwell(PEEK_RAIL_DWELL_MS) : undefined}
        onPointerLeave={active ? () => onOpenChange(false) : fromRail ? clearDwell : undefined}
        onPointerMoveCapture={
          active
            ? (event: React.PointerEvent) => {
                moveInsideRef.current = event.nativeEvent
              }
            : undefined
        }
      >
        {children}
      </div>
      {hidden && !open ? (
        <div
          aria-hidden
          data-testid="sidebar-peek-edge"
          className="absolute inset-y-0 start-0 z-30"
          style={{ width: PEEK_EDGE_PX }}
          onPointerEnter={() => startDwell(PEEK_EDGE_DWELL_MS)}
          onPointerLeave={clearDwell}
        />
      ) : null}
      {active && fromRail ? (
        <div
          aria-hidden
          data-testid="sidebar-rail-spacer"
          className="h-full shrink-0 bg-sidebar"
          style={{ width: railWidth }}
        />
      ) : null}
    </>
  )
}
