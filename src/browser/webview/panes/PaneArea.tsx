import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type HTMLAttributes,
  type ReactElement,
  type ReactNode,
} from 'react'

import { PANE_GUTTER_PX } from '../layout/layoutConstants'
import { resolvePaneRects, type PaneRect } from '../layout/paneGeometry'
import {
  isPaneGroup,
  panesIn,
  ROOT_GROUP_ID,
  type PaneLayout,
  type SidePaneKind,
} from '../layout/paneLayout'
import type { PanelForm } from '../layout/shellLayout'

/**
 * Draws a session's pane tree (F-9). Groups are not DOM nodes: the chat and
 * every pane sit at absolute rects inside the area, so a pane's body stays
 * mounted whatever happens to the tree around it. The side region is one box
 * beside the chat (`beside`), over everything (`maximized`), or a seat over
 * the chat's end (`overlay`, `float`), the forms the shell's cascade decides.
 */
export type PaneAreaProps = {
  layout: PaneLayout
  maximized: SidePaneKind | null
  /** The side region's drawn form; `none` while the tree holds no pane. */
  form: PanelForm
  /** The chat's drawn width while the panes are beside it. */
  chatWidth: number
  /** The seat's width while the region is overlaid or floating. */
  seatWidth: number
  /** Overlaid: whether the seat is on screen. */
  overlayShown: boolean
  /** Spread on the seat: the overlay's dismissal handlers. */
  seatProps?: HTMLAttributes<HTMLDivElement>
  /** The chat: the mounted session sections. */
  chat: ReactNode
  /** One pane's frame. */
  renderPane: (kind: SidePaneKind) => ReactNode
}

function rectStyle(rect: PaneRect): CSSProperties {
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
}

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
  const seated = form === 'overlay' || form === 'float'
  const covering = maximized !== null && form !== 'none'

  // The region's box in the area, and each pane's rect inside it. A pane with
  // no rect is hidden (kept mounted).
  let seatRect: PaneRect | null = null
  let chatStyle: CSSProperties = { left: 0, top: 0, width: '100%', height: '100%' }
  const paneRects = new Map<SidePaneKind, PaneRect>()
  if (measured && panes.length > 0) {
    if (covering) {
      seatRect = { left: 0, top: 0, width: size.width, height: size.height }
      paneRects.set(maximized, {
        left: gutter,
        top: gutter,
        width: Math.max(0, size.width - 2 * gutter),
        height: Math.max(0, size.height - 2 * gutter),
      })
    } else {
      if (form === 'beside') {
        const chatWidth = Math.max(0, Math.min(size.width, Math.round(props.chatWidth)))
        chatStyle = { left: 0, top: 0, width: chatWidth, height: size.height }
        seatRect = {
          left: chatWidth + gutter,
          top: 0,
          width: Math.max(0, size.width - chatWidth - gutter),
          height: size.height,
        }
      } else if (seated) {
        const width = Math.max(0, Math.min(size.width, Math.round(props.seatWidth)))
        seatRect = { left: size.width - width, top: 0, width, height: size.height }
      }
      if (seatRect) {
        // The side children of the root row, laid out on their own in the box.
        const side = {
          root: {
            ...layout.root,
            id: ROOT_GROUP_ID,
            children: layout.root.children.filter(child => isPaneGroup(child) || child.pane !== 'chat'),
          },
        }
        const inset = seated ? gutter : 0
        const rects = resolvePaneRects(side, {
          width: Math.max(0, seatRect.width - gutter - inset),
          height: Math.max(0, seatRect.height - 2 * gutter),
          chatWidth: 0,
          gutter,
        })
        for (const kind of panes) {
          const rect = rects.get(kind)
          if (rect) paneRects.set(kind, { ...rect, left: rect.left + inset, top: rect.top + gutter })
        }
      }
    }
  }

  const seatVisible = !seated || form === 'float' || props.overlayShown
  const seatClass =
    form === 'float'
      ? 'absolute z-30 border-border border-s bg-background shadow-xl animate-in slide-in-from-right duration-200'
      : form === 'overlay'
        ? 'absolute z-40 border-border border-s bg-background shadow-xl'
        : 'absolute'

  return (
    <div
      ref={areaRef}
      data-testid="pane-area"
      data-panes={panes.join(' ') || undefined}
      className="relative h-full min-w-0 flex-1 overflow-hidden"
    >
      <div
        data-testid="pane-chat"
        className="absolute flex"
        style={covering ? { ...chatStyle, display: 'none' } : chatStyle}
      >
        {props.chat}
      </div>
      {panes.length > 0 ? (
        <div
          data-testid="side-region"
          data-panel-form={form}
          data-overlay-open={form === 'overlay' && props.overlayShown ? 'true' : undefined}
          className={seatClass}
          style={seatRect && seatVisible ? rectStyle(seatRect) : { display: 'none' }}
          {...(seated ? props.seatProps : null)}
        >
          {panes.map(kind => {
            const rect = paneRects.get(kind)
            return (
              <div
                key={kind}
                data-pane-slot={kind}
                className="absolute flex flex-col"
                style={rect ? rectStyle(rect) : { display: 'none' }}
              >
                {props.renderPane(kind)}
              </div>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
