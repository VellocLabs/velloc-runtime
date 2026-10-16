/**
 * The sidebar while the session area is too narrow to dock it (F-9): hidden,
 * with a peek drawer floating over the chat. A pointer resting at the area's
 * start edge, or the topbar toggle, opens it; Escape, a press outside it, the
 * pointer leaving it, or a session switch closes it. When the sidebar is not
 * hidden this renders its children as they are.
 */
import * as React from 'react'

import { useOverlayDismiss } from './layout/useOverlayDismiss'

/** Pointer distance from the start edge that opens the drawer, after a dwell. */
const PEEK_EDGE_PX = 16
const PEEK_DWELL_MS = 100

export function SidebarPeek({
  hidden,
  open,
  onOpenChange,
  activeSessionId,
  children,
}: {
  hidden: boolean
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

  const active = hidden && open
  const dismiss = useOverlayDismiss(
    active,
    () => onOpenChangeRef.current(false),
    '[data-testid="topbar-sidebar-toggle"]',
  )

  // Choosing a session closes it.
  const shownForRef = React.useRef(activeSessionId)
  React.useEffect(() => {
    if (shownForRef.current !== activeSessionId && active) onOpenChangeRef.current(false)
    shownForRef.current = activeSessionId
  }, [activeSessionId, active])

  if (!hidden) return <>{children}</>
  return (
    <>
      {open ? (
        <div
          data-testid="sidebar-peek"
          className="absolute inset-y-0 start-0 z-40 flex border-border border-e shadow-xl"
          {...dismiss}
          onPointerLeave={() => onOpenChange(false)}
        >
          {children}
        </div>
      ) : (
        <div
          aria-hidden
          data-testid="sidebar-peek-edge"
          className="absolute inset-y-0 start-0 z-30"
          style={{ width: PEEK_EDGE_PX }}
          onPointerEnter={() => {
            clearDwell()
            dwellRef.current = setTimeout(() => onOpenChange(true), PEEK_DWELL_MS)
          }}
          onPointerLeave={clearDwell}
        />
      )}
    </>
  )
}
