import { useRef, type KeyboardEvent, type PointerEvent, type ReactElement } from 'react'

import { useT } from '../i18n'
import { PANE_RESIZE_STEP_PX } from '../layout/layoutConstants'
import { FILES_TREE_MIN_WIDTH } from '../layout/filesTreeDock'

/**
 * The drag handle between the open file and the docked tree (F-9). The tree
 * sits at the end edge, so moving the handle toward the start widens it.
 * Reports the width live while a drag or key run lasts and once more when it
 * ends, so the pane can follow live and remember once.
 */
export type FilesTreeHandleProps = {
  width: number
  maxWidth: number
  onResize: (width: number) => void
  onResizeEnd: (width: number) => void
}

export function FilesTreeHandle(props: FilesTreeHandleProps): ReactElement {
  const t = useT()
  const drag = useRef<{ x: number; width: number; sign: number; last: number } | null>(null)
  const clamp = (width: number) => Math.round(Math.min(Math.max(width, FILES_TREE_MIN_WIDTH), props.maxWidth))
  // +1 when a move toward the end edge widens the tree (right-to-left), else -1.
  const signOf = (el: HTMLElement) => (getComputedStyle(el).direction === 'rtl' ? 1 : -1)

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture?.(event.pointerId)
    drag.current = { x: event.clientX, width: props.width, sign: signOf(event.currentTarget), last: props.width }
  }
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const run = drag.current
    if (!run) return
    run.last = clamp(run.width + run.sign * (event.clientX - run.x))
    props.onResize(run.last)
  }
  const onPointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    const run = drag.current
    if (!run) return
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture?.(event.pointerId)
    }
    drag.current = null
    props.onResizeEnd(run.last)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const step = event.shiftKey ? 2 * PANE_RESIZE_STEP_PX : PANE_RESIZE_STEP_PX
    // ← widens a tree on the right; on the left it narrows it.
    const toward = event.key === 'ArrowLeft' ? -1 : 1
    const next = clamp(props.width + step * toward * signOf(event.currentTarget))
    props.onResizeEnd(next)
  }

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={t('filesPane.resizeTree')}
      aria-valuenow={props.width}
      aria-valuemin={FILES_TREE_MIN_WIDTH}
      aria-valuemax={props.maxWidth}
      data-testid="files-pane-tree-handle"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onKeyDown={onKeyDown}
      className="group/handle relative w-1 shrink-0 cursor-col-resize touch-none outline-none"
    >
      <span
        aria-hidden
        className="absolute inset-y-0 start-0 w-px bg-border transition-colors group-hover/handle:bg-ring group-focus-visible/handle:bg-ring"
      />
    </div>
  )
}
