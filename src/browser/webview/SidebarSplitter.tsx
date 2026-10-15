import { useCallback, useRef, type PointerEvent, type KeyboardEvent } from 'react'
import { cn } from '@/lib/utils'
import { useT } from './i18n'

export type SidebarSplitterProps = {
  /** Size of the resized element along the splitter's cross axis (width for a
   *  vertical handle, height for a horizontal one). */
  width: number
  minWidth: number
  maxWidth: number
  onResize: (width: number) => void
  onResizeStart?: () => void
  onResizeEnd?: () => void
  /**
   * Set when the resized element sits to the RIGHT of (vertical) / BELOW
   * (horizontal) the handle: drags toward it then SHRINK it, so the pointer
   * delta and arrow-key direction are negated.
   */
  invert?: boolean
  /**
   * Handle orientation. `vertical` (default) is a vertical bar that resizes
   * horizontally (sidebar / webview area); `horizontal` is a horizontal bar
   * that resizes vertically (the Right Panel's pinned-view split).
   */
  orientation?: 'vertical' | 'horizontal'
  /** Accessible label; defaults to the sidebar-resize string. */
  ariaLabel?: string
}

const KEYBOARD_STEP_PX = 16
const KEYBOARD_STEP_LARGE_PX = 32

function clamp(value: number, min: number, max: number): number {
  return Math.round(Math.min(Math.max(value, min), max))
}

export function SidebarSplitter({
  width,
  minWidth,
  maxWidth,
  onResize,
  onResizeStart,
  onResizeEnd,
  invert = false,
  orientation = 'vertical',
  ariaLabel,
}: SidebarSplitterProps) {
  const t = useT()
  const horizontal = orientation === 'horizontal'
  const sign = invert ? -1 : 1
  const cursor = horizontal ? 'row-resize' : 'col-resize'
  const handleRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ startPos: number; startWidth: number } | null>(null)
  const previousBodyCursorRef = useRef<string | null>(null)

  const onPointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return
      event.preventDefault()
      handleRef.current?.setPointerCapture(event.pointerId)
      dragRef.current = {
        startPos: horizontal ? event.clientY : event.clientX,
        startWidth: width,
      }
      if (typeof document !== 'undefined') {
        previousBodyCursorRef.current = document.body.style.cursor
        document.body.style.cursor = cursor
      }
      onResizeStart?.()
    },
    [width, onResizeStart, horizontal, cursor],
  )

  const onPointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (!dragRef.current) return
      const pos = horizontal ? event.clientY : event.clientX
      const delta = (pos - dragRef.current.startPos) * sign
      onResize(clamp(dragRef.current.startWidth + delta, minWidth, maxWidth))
    },
    [onResize, minWidth, maxWidth, sign, horizontal],
  )

  const finishDrag = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (!dragRef.current) return
      handleRef.current?.releasePointerCapture(event.pointerId)
      dragRef.current = null
      if (typeof document !== 'undefined' && previousBodyCursorRef.current !== null) {
        document.body.style.cursor = previousBodyCursorRef.current
        previousBodyCursorRef.current = null
      }
      onResizeEnd?.()
    },
    [onResizeEnd],
  )

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const decKey = horizontal ? 'ArrowUp' : 'ArrowLeft'
      const incKey = horizontal ? 'ArrowDown' : 'ArrowRight'
      if (event.key !== decKey && event.key !== incKey) return
      event.preventDefault()
      const step = event.shiftKey ? KEYBOARD_STEP_LARGE_PX : KEYBOARD_STEP_PX
      const direction = (event.key === decKey ? -1 : 1) * sign
      onResize(clamp(width + direction * step, minWidth, maxWidth))
    },
    [onResize, width, minWidth, maxWidth, sign, horizontal],
  )

  return (
    <div
      ref={handleRef}
      role="separator"
      aria-orientation={horizontal ? 'horizontal' : 'vertical'}
      aria-label={ariaLabel ?? t('sidebar.resizeAria')}
      aria-valuenow={width}
      aria-valuemin={minWidth}
      aria-valuemax={maxWidth}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finishDrag}
      onPointerCancel={finishDrag}
      onKeyDown={onKeyDown}
      className={cn(
        'group relative flex shrink-0 select-none touch-none outline-none',
        horizontal
          ? 'h-1 w-full cursor-row-resize justify-stretch'
          : 'h-full w-1 cursor-col-resize items-stretch',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'pointer-events-none absolute bg-sidebar-border transition-colors',
          'group-hover:bg-foreground/40 group-focus-visible:bg-foreground/40',
          horizontal
            ? 'inset-x-0 top-1/2 h-px -translate-y-1/2'
            : 'inset-y-0 left-1/2 w-px -translate-x-1/2',
        )}
      />
    </div>
  )
}
