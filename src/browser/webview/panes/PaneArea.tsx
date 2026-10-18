import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from 'react'

import { PANE_GUTTER_PX } from '../layout/layoutConstants'
import {
  PANE_AREA_LAYER,
  resolveAreaGeometry,
  type AreaGeometry,
  type AreaGeometryInput,
  type PaneRect,
  type PaneSeparatorGeometry,
} from '../layout/paneGeometry'
import { useT } from '../i18n'
import {
  isPaneGroup,
  panesIn,
  ROOT_GROUP_ID,
  type PaneDropTarget,
  type PaneLayout,
  type SidePaneKind,
} from '../layout/paneLayout'
import { clampResizeDelta, resizeLayoutAt } from '../layout/paneResize'
import type { PanelForm } from '../layout/shellLayout'
import { PANE_ICON, PANE_LABEL_KEY } from './paneKinds'
import { PaneDropIndicator } from './PaneDropIndicator'
import { PaneSeparator, separatorStyle } from './PaneSeparator'
import { PaneHandleContext, usePaneDrag } from './usePaneDrag'

/**
 * Draws a session's pane tree (F-9). Groups are not DOM nodes: the chat and
 * every pane sit at absolute rects inside the area, so a pane's body stays
 * mounted whatever happens to the tree around it. The side region sits beside
 * the chat (a narrow slot leaves the content's end under it), over everything,
 * or floats over the chat's end. Every gutter beside the chat is a separator
 * (live paint, one commit); a pane's handle drags it to a drop zone.
 */
export type PaneAreaProps = {
  layout: PaneLayout
  maximized: SidePaneKind | null
  /** The side region's drawn form; `none` while the tree holds no pane. */
  form: PanelForm
  /** The chat's slot width while the panes are beside it. */
  chatWidth: number
  /** The seat's width while the region floats. */
  seatWidth: number
  /** The chat: the mounted session sections. */
  chat: ReactNode
  /** One pane's frame. */
  renderPane: (kind: SidePaneKind) => ReactNode
  /** A separator run ended on a changed layout: persist it. */
  onResizeCommit?: (layout: PaneLayout) => void
  /** A pane was dropped on a zone or moved by a key: apply `movePane` and persist. */
  onPaneMove?: (kind: SidePaneKind, target: PaneDropTarget) => void
}

function rectStyle(rect: PaneRect): CSSProperties {
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
}

function applyRect(el: HTMLElement | null | undefined, rect: PaneRect | null): void {
  if (!el) return
  if (!rect) {
    el.style.display = 'none'
    return
  }
  el.style.display = ''
  el.style.left = `${rect.left}px`
  el.style.top = `${rect.top}px`
  el.style.width = `${rect.width}px`
  el.style.height = `${rect.height}px`
}

/** A rect inside the box `seat` it is drawn in. */
function inSeat(rect: PaneRect, seat: PaneRect): PaneRect {
  return { ...rect, left: rect.left - seat.left, top: rect.top - seat.top }
}

/** The chat content's rect inside the chat's slot. */
function contentInSlot(g: AreaGeometry): PaneRect | null {
  return g.chat && g.chatContent ? inSeat(g.chatContent, g.chat) : null
}

/** Two cover elements: the content may stick out of the slot on either side. */
const COVER_SLOTS = [0, 1] as const

const FULL: CSSProperties = { left: 0, top: 0, width: '100%', height: '100%' }

export function PaneArea(props: PaneAreaProps): ReactElement {
  const areaRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  useLayoutEffect(() => {
    const el = areaRef.current
    if (!el) return
    const measure = () => {
      const width = Math.round(el.clientWidth)
      const height = Math.round(el.clientHeight)
      setSize(prev => (prev.width === width && prev.height === height ? prev : { width, height }))
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const { layout, maximized, form } = props
  const panes = panesIn(layout)
  const gutter = PANE_GUTTER_PX
  const measured = size.width > 0 && size.height > 0
  const seated = form === 'float'
  const covering = maximized !== null && form !== 'none'

  const input = useMemo<AreaGeometryInput | null>(
    () =>
      measured
        ? {
            layout,
            maximized,
            form,
            width: size.width,
            height: size.height,
            chatWidth: props.chatWidth,
            seatWidth: props.seatWidth,
            gutter,
          }
        : null,
    [
      measured,
      layout,
      maximized,
      form,
      size.width,
      size.height,
      props.chatWidth,
      props.seatWidth,
      gutter,
    ],
  )
  const geometry = useMemo<AreaGeometry | null>(() => (input ? resolveAreaGeometry(input) : null), [input])

  // The live drag: the latest delta is painted once per frame through the
  // elements, and the layout it ends at is committed. The render that commit
  // causes draws the same rects.
  const chatRef = useRef<HTMLDivElement>(null)
  const chatContentRef = useRef<HTMLDivElement>(null)
  const coverRefs = useRef<(HTMLDivElement | null)[]>([null, null])
  const seatRef = useRef<HTMLDivElement>(null)
  const slotRefs = useRef(new Map<SidePaneKind, HTMLDivElement>())
  const separatorRefs = useRef(new Map<string, HTMLDivElement>())
  const inputRef = useRef(input)
  inputRef.current = input
  const geometryRef = useRef(geometry)
  geometryRef.current = geometry
  const dragRef = useRef<{
    separator: PaneSeparatorGeometry
    delta: number
    /** A paint is scheduled for the next frame. */
    pending: boolean
    frame: number | null
  } | null>(null)
  const commitRef = useRef(props.onResizeCommit)
  commitRef.current = props.onResizeCommit

  const t = useT()
  const sizeRef = useRef(size)
  sizeRef.current = size
  const layoutRef = useRef(layout)
  layoutRef.current = layout
  const chipRef = useRef<HTMLDivElement | null>(null)
  const indicatorRef = useRef<HTMLDivElement | null>(null)
  const paneDrag = usePaneDrag({
    areaRef,
    layoutRef,
    geometryRef,
    sizeRef,
    slotRefs,
    chipRef,
    indicatorRef,
    canDrag: form === 'beside' && maximized === null,
    canReorder: maximized === null,
    onMove: props.onPaneMove,
  })
  const cancelPaneDrag = paneDrag.cancel
  const ChipIcon = paneDrag.dragging ? PANE_ICON[paneDrag.dragging] : null

  const paint = useCallback((g: AreaGeometry) => {
    applyRect(chatRef.current, g.chat)
    applyRect(chatContentRef.current, contentInSlot(g))
    COVER_SLOTS.forEach(i => applyRect(coverRefs.current[i], g.chatCovers[i] ?? null))
    applyRect(seatRef.current, g.seat)
    for (const [kind, el] of slotRefs.current) {
      const rect = g.panes.get(kind)
      applyRect(el, rect && g.seat ? inSeat(rect, g.seat) : null)
    }
    for (const separator of g.separators) {
      const el = separatorRefs.current.get(separator.key)
      if (!el) continue
      const style = separatorStyle(separator)
      el.style.left = `${style.left}px`
      el.style.top = `${style.top}px`
      el.style.width = `${style.width}px`
      el.style.height = `${style.height}px`
    }
  }, [])

  /** The layout and rects a run of `delta` px at `separator` ends at (the current ones when it moves nothing). */
  const previewFor = useCallback(
    (separator: PaneSeparatorGeometry, delta: number): { layout: PaneLayout; geometry: AreaGeometry } | null => {
      const base = inputRef.current
      const current = geometryRef.current
      if (!base || !current) return null
      const next = resizeLayoutAt(base.layout, separator, delta, { areaWidth: base.width, gutter: base.gutter })
      if (next === base.layout) return { layout: base.layout, geometry: current }
      const moved = clampResizeDelta(separator.first, separator.second, delta)
      let chatDelta = 0
      if (separator.groupId === ROOT_GROUP_ID) {
        const first = base.layout.root.children[separator.index]
        const second = base.layout.root.children[separator.index + 1]
        if (first && !isPaneGroup(first) && first.pane === 'chat') chatDelta = moved
        else if (second && !isPaneGroup(second) && second.pane === 'chat') chatDelta = -moved
      }
      return {
        layout: next,
        geometry: resolveAreaGeometry({ ...base, layout: next, chatWidth: base.chatWidth + chatDelta }),
      }
    },
    [],
  )

  const cancelFrame = () => {
    const drag = dragRef.current
    if (drag?.frame !== null && drag?.frame !== undefined && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(drag.frame)
    }
    if (drag) {
      drag.frame = null
      drag.pending = false
    }
  }

  const onResizeStart = useCallback((separator: PaneSeparatorGeometry) => {
    cancelFrame()
    dragRef.current = { separator, delta: 0, pending: false, frame: null }
  }, [])

  const onResize = useCallback(
    (separator: PaneSeparatorGeometry, delta: number): number => {
      const drag = dragRef.current
      const moved = clampResizeDelta(separator.first, separator.second, delta)
      if (!drag || drag.separator.key !== separator.key) return moved
      drag.delta = delta
      if (!drag.pending && typeof requestAnimationFrame === 'function') {
        drag.pending = true
        drag.frame = requestAnimationFrame(() => {
          const live = dragRef.current
          if (!live || live.separator.key !== separator.key) return
          live.pending = false
          live.frame = null
          const preview = previewFor(live.separator, live.delta)
          if (preview) paint(preview.geometry)
        })
      }
      return moved
    },
    [previewFor, paint],
  )

  const onResizeEnd = useCallback(
    (separator: PaneSeparatorGeometry, delta: number) => {
      cancelFrame()
      dragRef.current = null
      const preview = previewFor(separator, delta)
      if (!preview) return
      paint(preview.geometry)
      if (preview.layout !== inputRef.current?.layout) commitRef.current?.(preview.layout)
    },
    [previewFor, paint],
  )

  // The tree changing under a run (a pane opened by the agent, a session
  // switch) ends it unsaved, and cancels a pane drag.
  useEffect(() => {
    if (dragRef.current) {
      cancelFrame()
      dragRef.current = null
    }
    cancelPaneDrag()
  }, [layout, cancelPaneDrag])

  const chatStyle: CSSProperties = geometry?.chat ? rectStyle(geometry.chat) : FULL
  const contentRect = geometry ? contentInSlot(geometry) : null
  const seatRect = geometry?.seat ?? null
  const seatClass = seated
    ? 'absolute z-30 border-border border-s bg-background shadow-xl animate-in slide-in-from-right duration-200'
    : 'absolute pointer-events-none'

  return (
    <div
      ref={areaRef}
      data-testid="pane-area"
      data-panes={panes.join(' ') || undefined}
      className="relative h-full min-w-0 flex-1 overflow-hidden"
      {...paneDrag.areaProps}
    >
      <PaneHandleContext.Provider value={paneDrag.handleFor}>
      <div
        ref={chatRef}
        data-testid="pane-chat"
        data-chat-covered={geometry?.chatCovers.length ? 'true' : undefined}
        className="absolute"
        style={{ ...(covering ? { ...chatStyle, display: 'none' } : chatStyle), zIndex: PANE_AREA_LAYER.chat }}
      >
        <div
          ref={chatContentRef}
          data-testid="pane-chat-content"
          className="absolute flex"
          style={contentRect ? rectStyle(contentRect) : FULL}
        >
          {props.chat}
        </div>
      </div>
      {COVER_SLOTS.map(i => {
        const cover = covering ? null : geometry?.chatCovers[i] ?? null
        return (
          <div
            key={i}
            ref={el => {
              coverRefs.current[i] = el
            }}
            aria-hidden
            data-testid="pane-chat-cover"
            className="absolute bg-background"
            style={cover ? { ...rectStyle(cover), zIndex: PANE_AREA_LAYER.chatCover } : { display: 'none' }}
          />
        )
      })}
      {panes.length > 0 ? (
        <div
          ref={seatRef}
          data-testid="side-region"
          data-panel-form={form}
          className={seatClass}
          style={seatRect ? { ...rectStyle(seatRect), ...(seated ? null : { zIndex: PANE_AREA_LAYER.region }) } : { display: 'none' }}
        >
          {panes.map(kind => {
            const rect = geometry?.panes.get(kind)
            return (
              <div
                key={kind}
                ref={el => {
                  if (el) slotRefs.current.set(kind, el)
                  else slotRefs.current.delete(kind)
                }}
                data-pane-slot={kind}
                className="pointer-events-auto absolute flex flex-col"
                style={rect && seatRect ? rectStyle(inSeat(rect, seatRect)) : { display: 'none' }}
              >
                {props.renderPane(kind)}
              </div>
            )
          })}
        </div>
      ) : null}
      {geometry
        ? geometry.separators.map(separator => (
            <PaneSeparator
              key={separator.key}
              separator={separator}
              elementRef={el => {
                if (el) separatorRefs.current.set(separator.key, el)
                else separatorRefs.current.delete(separator.key)
              }}
              onResizeStart={onResizeStart}
              onResize={onResize}
              onResizeEnd={onResizeEnd}
            />
          ))
        : null}
      {paneDrag.dragging && ChipIcon ? (
        <>
          <PaneDropIndicator
            elementRef={el => {
              indicatorRef.current = el
            }}
          />
          <div
            ref={chipRef}
            aria-hidden
            data-testid="pane-drag-chip"
            className="pointer-events-none absolute z-50 flex items-center gap-1.5 rounded-md border border-border bg-popover px-2 py-1 text-[13px] font-medium text-popover-foreground shadow-md"
          >
            <ChipIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            <span>{t(PANE_LABEL_KEY[paneDrag.dragging])}</span>
          </div>
        </>
      ) : null}
      </PaneHandleContext.Provider>
    </div>
  )
}
