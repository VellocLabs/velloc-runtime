import {
  useCallback,
  useEffect,
  useRef,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactElement,
} from 'react'

import { cn } from '@/lib/utils'

import { useT } from '../i18n'
import { PANE_RESIZE_STEP_PX, PANE_SEPARATOR_HIT_PX } from '../layout/layoutConstants'
import type { PaneSeparatorGeometry } from '../layout/paneGeometry'

/**
 * The resize handle in the gutter between two panes (F-9): a focusable
 * `separator` whose value is the first flank's share of the pair. A pointer
 * drag or an arrow-key run reports its delta while it lasts and once more
 * when it ends, so the area can move the panes live and commit once.
 */
export type PaneSeparatorProps = {
  separator: PaneSeparatorGeometry
  /** A drag or key run began. */
  onResizeStart: (separator: PaneSeparatorGeometry) => void
  /**
   * The separator is `delta` px toward its second flank from where the run
   * began; returns the delta the panes could follow.
   */
  onResize: (separator: PaneSeparatorGeometry, delta: number) => number
  /** The pointer lifted or the key was released: the run's final delta. */
  onResizeEnd: (separator: PaneSeparatorGeometry, delta: number) => void
  /** The element, so the area can move it with the panes while dragging. */
  elementRef?: (el: HTMLDivElement | null) => void
}

/** Where the handle is drawn: the gutter, widened across to its hit area. */
export function separatorStyle(separator: PaneSeparatorGeometry): CSSProperties {
  const { rect } = separator
  if (separator.axis === 'row') {
    const pad = Math.max(0, (PANE_SEPARATOR_HIT_PX - rect.width) / 2)
    return { left: rect.left - pad, top: rect.top, width: rect.width + 2 * pad, height: rect.height }
  }
  const pad = Math.max(0, (PANE_SEPARATOR_HIT_PX - rect.height) / 2)
  return { left: rect.left, top: rect.top - pad, width: rect.width, height: rect.height + 2 * pad }
}

/** The first flank's share of the pair, as a whole percentage. */
export function separatorValue(separator: PaneSeparatorGeometry): number {
  const sum = separator.first.length + separator.second.length
  return sum > 0 ? Math.round((100 * separator.first.length) / sum) : 50
}

/** The px an arrow key moves a handle of this orientation, or null for any other key. */
function stepFor(event: KeyboardEvent<HTMLDivElement>, vertical: boolean): number | null {
  const dec = vertical ? 'ArrowLeft' : 'ArrowUp'
  const inc = vertical ? 'ArrowRight' : 'ArrowDown'
  if (event.key !== dec && event.key !== inc) return null
  const step = event.shiftKey ? 2 * PANE_RESIZE_STEP_PX : PANE_RESIZE_STEP_PX
  return event.key === dec ? -step : step
}

export function PaneSeparator(props: PaneSeparatorProps): ReactElement {
  const t = useT()
  const { separator, onResizeStart, onResize, onResizeEnd } = props
  const vertical = separator.axis === 'row'
  const cursor = vertical ? 'col-resize' : 'row-resize'
  const dragRef = useRef<{ startPos: number; delta: number } | null>(null)
  const keysRef = useRef<{ delta: number } | null>(null)
  const bodyCursorRef = useRef<string | null>(null)

  const restoreCursor = () => {
    if (typeof document !== 'undefined' && bodyCursorRef.current !== null) {
      document.body.style.cursor = bodyCursorRef.current
      bodyCursorRef.current = null
    }
  }

  const onPointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return
      event.preventDefault()
      event.currentTarget.setPointerCapture?.(event.pointerId)
      dragRef.current = { startPos: vertical ? event.clientX : event.clientY, delta: 0 }
      if (typeof document !== 'undefined') {
        bodyCursorRef.current = document.body.style.cursor
        document.body.style.cursor = cursor
      }
      onResizeStart(separator)
    },
    [vertical, cursor, onResizeStart, separator],
  )

  const onPointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current
      if (!drag) return
      drag.delta = (vertical ? event.clientX : event.clientY) - drag.startPos
      onResize(separator, drag.delta)
    },
    [vertical, onResize, separator],
  )

  const finishDrag = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current
      if (!drag) return
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
        event.currentTarget.releasePointerCapture?.(event.pointerId)
      }
      dragRef.current = null
      restoreCursor()
      onResizeEnd(separator, drag.delta)
    },
    [onResizeEnd, separator],
  )

  // Unmounted mid-run: the run still ends where it was.
  const endRef = useRef(onResizeEnd)
  endRef.current = onResizeEnd
  const separatorRef = useRef(separator)
  separatorRef.current = separator
  useEffect(
    () => () => {
      const run = dragRef.current ?? keysRef.current
      dragRef.current = null
      keysRef.current = null
      restoreCursor()
      if (run) endRef.current(separatorRef.current, run.delta)
    },
    [],
  )

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const step = stepFor(event, vertical)
      if (step === null) return
      event.preventDefault()
      if (!keysRef.current) {
        keysRef.current = { delta: 0 }
        onResizeStart(separator)
      }
      keysRef.current.delta = onResize(separator, keysRef.current.delta + step)
    },
    [vertical, onResizeStart, onResize, separator],
  )

  const endKeys = useCallback(() => {
    const run = keysRef.current
    if (!run) return
    keysRef.current = null
    onResizeEnd(separator, run.delta)
  }, [onResizeEnd, separator])

  const onKeyUp = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (stepFor(event, vertical) === null) return
      endKeys()
    },
    [vertical, endKeys],
  )

  return (
    <div
      ref={props.elementRef}
      role="separator"
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      aria-label={t('pane.resize')}
      aria-valuenow={separatorValue(separator)}
      aria-valuemin={0}
      aria-valuemax={100}
      tabIndex={0}
      data-testid="pane-separator"
      data-separator={separator.key}
      data-axis={separator.axis}
      style={separatorStyle(separator)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finishDrag}
      onPointerCancel={finishDrag}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      onBlur={endKeys}
      className={cn(
        'group absolute z-10 flex select-none touch-none items-center justify-center outline-none',
        vertical ? 'cursor-col-resize' : 'cursor-row-resize',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'pointer-events-none rounded-full bg-transparent transition-colors',
          'group-hover:bg-foreground/30 group-focus-visible:bg-ring group-active:bg-ring',
          vertical ? 'h-full w-0.5' : 'h-0.5 w-full',
        )}
      />
    </div>
  )
}
