import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from 'react'

import { PANE_DRAG_THRESHOLD_PX } from '../layout/layoutConstants'
import { paneDropTargetAt, paneDropTargets, type PaneDropZone } from '../layout/paneDrop'
import type { AreaGeometry, PaneRect } from '../layout/paneGeometry'
import { findSlot, groupById, type PaneDropTarget, type PaneLayout, type SidePaneKind } from '../layout/paneLayout'

/**
 * Moving a pane (F-9): a pointer drag from its handle to a drop zone of the
 * area, or an arrow key with the handle focused. The drag paints the chip
 * and the indicator through elements once per animation frame; the drop
 * reports the target and the area's owner commits the move. Escape, a
 * pointer cancel, a drop on no zone, the tree changing under the drag, or
 * the area unmounting cancel it and restore the source.
 */
export interface PaneHandleProps {
  onPointerDown: (event: PointerEvent<HTMLElement>) => void
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void
}

/** The area's handlers for a pane's handle; null outside an area (the handle is then inert). */
export const PaneHandleContext = createContext<((kind: SidePaneKind) => PaneHandleProps) | null>(null)

export function usePaneHandle(kind: SidePaneKind): PaneHandleProps | null {
  const handleFor = useContext(PaneHandleContext)
  return handleFor ? handleFor(kind) : null
}

export interface PaneDragEnv {
  areaRef: RefObject<HTMLDivElement | null>
  layoutRef: RefObject<PaneLayout>
  /** The drawn geometry: the zones are computed from it when a drag begins. */
  geometryRef: RefObject<AreaGeometry | null>
  sizeRef: RefObject<{ width: number; height: number }>
  slotRefs: RefObject<Map<SidePaneKind, HTMLDivElement>>
  chipRef: RefObject<HTMLDivElement | null>
  indicatorRef: RefObject<HTMLDivElement | null>
  /** A drag may begin: the panes sit beside the chat with none expanded. */
  canDrag: boolean
  /** The keys may move a pane within its group: none expanded. */
  canReorder: boolean
  onMove?: (kind: SidePaneKind, target: PaneDropTarget) => void
}

export interface PaneDrag {
  /** The pane being dragged past the threshold, or null. */
  dragging: SidePaneKind | null
  handleFor: (kind: SidePaneKind) => PaneHandleProps
  areaProps: {
    onPointerMove: (event: PointerEvent<HTMLDivElement>) => void
    onPointerUp: (event: PointerEvent<HTMLDivElement>) => void
    onPointerCancel: (event: PointerEvent<HTMLDivElement>) => void
    onLostPointerCapture: (event: PointerEvent<HTMLDivElement>) => void
  }
  /** End a drag in progress without a drop. */
  cancel: () => void
}

interface Run {
  kind: SidePaneKind
  pointerId: number
  startX: number
  startY: number
  /** The area's client offset, so pointer positions become area px. */
  originLeft: number
  originTop: number
  /** Past the threshold: captured, chip and indicator up. */
  active: boolean
  zones: PaneDropZone[]
  target: PaneDropZone | null
  x: number
  y: number
  /** A paint is scheduled for the next frame. */
  pending: boolean
  frame: number | null
}

/** The chip's offset from the pointer. */
const CHIP_OFFSET_PX = 12

function applyRect(el: HTMLElement, rect: PaneRect): void {
  el.style.left = `${rect.left}px`
  el.style.top = `${rect.top}px`
  el.style.width = `${rect.width}px`
  el.style.height = `${rect.height}px`
}

function targetLabel(target: PaneDropTarget): string {
  switch (target.type) {
    case 'insert':
      return `${target.groupId}:${target.index}`
    case 'wrap':
      return `${target.pane}:${target.side}`
    case 'split':
      return `${target.groupId}:${target.side}`
    case 'edge':
      return target.side
  }
}

/** The insert target a key moves `kind` to within its group, or null for any other key. */
export function keyboardMoveTarget(layout: PaneLayout, kind: SidePaneKind, key: string): PaneDropTarget | null {
  const slot = findSlot(layout, kind)
  if (!slot) return null
  const group = groupById(layout, slot.groupId)
  if (!group) return null
  const n = group.children.length
  let index: number
  switch (key) {
    case 'ArrowLeft':
    case 'ArrowUp':
      index = Math.max(0, slot.index - 1)
      break
    case 'ArrowRight':
    case 'ArrowDown':
      index = Math.min(n, slot.index + 2)
      break
    case 'Home':
      index = 0
      break
    case 'End':
      index = n
      break
    default:
      return null
  }
  return { type: 'insert', groupId: group.id, index }
}

export function usePaneDrag(env: PaneDragEnv): PaneDrag {
  const [dragging, setDragging] = useState<SidePaneKind | null>(null)
  const runRef = useRef<Run | null>(null)
  const envRef = useRef(env)
  envRef.current = env
  const bodyRef = useRef<{ cursor: string; userSelect: string } | null>(null)

  const paint = useCallback(() => {
    const run = runRef.current
    if (!run || !run.active) return
    const chip = envRef.current.chipRef.current
    if (chip) {
      chip.style.left = `${run.x + CHIP_OFFSET_PX}px`
      chip.style.top = `${run.y + CHIP_OFFSET_PX}px`
    }
    const indicator = envRef.current.indicatorRef.current
    if (indicator) {
      if (run.target) {
        indicator.style.display = ''
        applyRect(indicator, run.target.indicator)
        indicator.dataset.dropType = run.target.target.type
        indicator.dataset.dropAt = targetLabel(run.target.target)
      } else {
        indicator.style.display = 'none'
        delete indicator.dataset.dropType
        delete indicator.dataset.dropAt
      }
    }
  }, [])

  const schedule = useCallback(() => {
    const run = runRef.current
    if (!run || run.pending) return
    if (typeof requestAnimationFrame !== 'function') {
      paint()
      return
    }
    run.pending = true
    run.frame = requestAnimationFrame(() => {
      const live = runRef.current
      if (live) {
        live.pending = false
        live.frame = null
      }
      paint()
    })
  }, [paint])

  /** The run over: capture released, the source and the body restored. */
  const finish = useCallback(() => {
    const run = runRef.current
    runRef.current = null
    if (!run) return
    if (run.frame !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(run.frame)
    if (!run.active) return
    const { areaRef, slotRefs } = envRef.current
    const area = areaRef.current
    if (area) {
      delete area.dataset.paneDragging
      if (area.hasPointerCapture?.(run.pointerId)) area.releasePointerCapture?.(run.pointerId)
    }
    const slot = slotRefs.current?.get(run.kind)
    if (slot) slot.style.opacity = ''
    if (typeof document !== 'undefined' && bodyRef.current) {
      document.body.style.cursor = bodyRef.current.cursor
      document.body.style.userSelect = bodyRef.current.userSelect
      bodyRef.current = null
    }
    setDragging(null)
  }, [])

  const cancel = useCallback(() => finish(), [finish])

  /** Past the threshold: the zones are fixed, the pointer captured, the source dimmed. */
  const activate = useCallback(
    (run: Run) => {
      const { areaRef, layoutRef, geometryRef, sizeRef, slotRefs } = envRef.current
      const geometry = geometryRef.current
      const size = sizeRef.current
      const layout = layoutRef.current
      if (!geometry || !size || !layout) return
      run.zones = paneDropTargets({
        layout,
        source: run.kind,
        width: size.width,
        height: size.height,
        chat: geometry.chat,
        panes: geometry.panes,
        separators: geometry.separators,
      })
      run.active = true
      const area = areaRef.current
      if (area) {
        area.dataset.paneDragging = run.kind
        area.setPointerCapture?.(run.pointerId)
      }
      const slot = slotRefs.current?.get(run.kind)
      if (slot) slot.style.opacity = '0.4'
      if (typeof document !== 'undefined') {
        bodyRef.current = { cursor: document.body.style.cursor, userSelect: document.body.style.userSelect }
        document.body.style.cursor = 'grabbing'
        document.body.style.userSelect = 'none'
      }
      setDragging(run.kind)
    },
    [],
  )

  const onHandlePointerDown = useCallback((kind: SidePaneKind, event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || !envRef.current.canDrag) return
    const area = envRef.current.areaRef.current
    const origin = area?.getBoundingClientRect()
    runRef.current = {
      kind,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originLeft: origin?.left ?? 0,
      originTop: origin?.top ?? 0,
      active: false,
      zones: [],
      target: null,
      x: event.clientX - (origin?.left ?? 0),
      y: event.clientY - (origin?.top ?? 0),
      pending: false,
      frame: null,
    }
  }, [])

  const onPointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const run = runRef.current
      if (!run || run.pointerId !== event.pointerId) return
      if (!run.active) {
        const dx = event.clientX - run.startX
        const dy = event.clientY - run.startY
        if (Math.hypot(dx, dy) < PANE_DRAG_THRESHOLD_PX) return
        activate(run)
        if (!run.active) {
          runRef.current = null
          return
        }
      }
      run.x = event.clientX - run.originLeft
      run.y = event.clientY - run.originTop
      run.target = paneDropTargetAt(run.zones, run.x, run.y)
      schedule()
    },
    [activate, schedule],
  )

  const onPointerUp = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const run = runRef.current
      if (!run || run.pointerId !== event.pointerId) return
      if (!run.active) {
        runRef.current = null
        return
      }
      const x = event.clientX - run.originLeft
      const y = event.clientY - run.originTop
      const target = paneDropTargetAt(run.zones, x, y)
      finish()
      if (target) envRef.current.onMove?.(run.kind, target.target)
    },
    [finish],
  )

  const onPointerCancel = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const run = runRef.current
      if (run && run.pointerId === event.pointerId) finish()
    },
    [finish],
  )

  const onLostPointerCapture = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const run = runRef.current
      if (run && run.active && run.pointerId === event.pointerId) finish()
    },
    [finish],
  )

  const onHandleKeyDown = useCallback((kind: SidePaneKind, event: KeyboardEvent<HTMLElement>) => {
    if (!envRef.current.canReorder || event.ctrlKey || event.metaKey || event.altKey) return
    const layout = envRef.current.layoutRef.current
    if (!layout) return
    const target = keyboardMoveTarget(layout, kind, event.key)
    if (!target) return
    event.preventDefault()
    envRef.current.onMove?.(kind, target)
  }, [])

  const handleFor = useCallback(
    (kind: SidePaneKind): PaneHandleProps => ({
      onPointerDown: event => onHandlePointerDown(kind, event),
      onKeyDown: event => onHandleKeyDown(kind, event),
    }),
    [onHandlePointerDown, onHandleKeyDown],
  )

  // The chip and the indicator mount with the drag: paint them where the pointer already is.
  useLayoutEffect(() => {
    if (dragging) paint()
  }, [dragging, paint])

  // Escape while dragging cancels.
  useEffect(() => {
    if (!dragging || typeof document === 'undefined') return
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      finish()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [dragging, finish])

  // Unmounting mid-drag restores the body.
  useEffect(() => () => finish(), [finish])

  return {
    dragging,
    handleFor,
    areaProps: { onPointerMove, onPointerUp, onPointerCancel, onLostPointerCapture },
    cancel,
  }
}
