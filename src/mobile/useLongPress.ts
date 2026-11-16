/**
 * Long press for touch rows (F-24): `onLongPress` fires after the finger stays down `delayMs`
 * without moving more than `moveTolerancePx`. Moving (a scroll), lifting or cancelling first
 * drops it. The click that ends a long press is swallowed, so the row does not also open. The
 * browser's own long-press menu is suppressed on the element.
 */
import { useCallback, useEffect, useRef } from 'react'
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react'

export const LONG_PRESS_DELAY_MS = 500
export const LONG_PRESS_MOVE_TOLERANCE_PX = 10

export type LongPressHandlers = {
  onPointerDown: (event: ReactPointerEvent) => void
  onPointerMove: (event: ReactPointerEvent) => void
  onPointerUp: () => void
  onPointerCancel: () => void
  onPointerLeave: () => void
  onContextMenu: (event: ReactMouseEvent) => void
  onClickCapture: (event: ReactMouseEvent) => void
}

export function useLongPress(
  onLongPress: () => void,
  delayMs = LONG_PRESS_DELAY_MS,
  moveTolerancePx = LONG_PRESS_MOVE_TOLERANCE_PX,
): LongPressHandlers {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const start = useRef<{ x: number; y: number } | null>(null)
  const fired = useRef(false)
  const callback = useRef(onLongPress)
  callback.current = onLongPress

  const clear = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = null
    start.current = null
  }, [])

  useEffect(() => clear, [clear])

  const onPointerDown = useCallback(
    (event: ReactPointerEvent) => {
      if (event.button !== 0) return
      clear()
      fired.current = false
      start.current = { x: event.clientX, y: event.clientY }
      timer.current = setTimeout(() => {
        timer.current = null
        start.current = null
        fired.current = true
        callback.current()
      }, delayMs)
    },
    [clear, delayMs],
  )

  const onPointerMove = useCallback(
    (event: ReactPointerEvent) => {
      const from = start.current
      if (!from) return
      if (Math.hypot(event.clientX - from.x, event.clientY - from.y) > moveTolerancePx) clear()
    },
    [clear, moveTolerancePx],
  )

  const onClickCapture = useCallback((event: ReactMouseEvent) => {
    if (!fired.current) return
    fired.current = false
    event.preventDefault()
    event.stopPropagation()
  }, [])

  const onContextMenu = useCallback((event: ReactMouseEvent) => event.preventDefault(), [])

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp: clear,
    onPointerCancel: clear,
    onPointerLeave: clear,
    onContextMenu,
    onClickCapture,
  }
}
