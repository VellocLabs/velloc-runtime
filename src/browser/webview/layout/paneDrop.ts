/**
 * Where a dragged pane may be dropped (F-9): the zones of the drawn area,
 * computed once when a drag starts from the cards' px rects, and the pick
 * of one for a pointer position. Pure.
 */
import {
  PANE_DROP_EDGE_PX,
  PANE_DROP_INSERT_PX,
  PANE_DROP_WRAP_SHARE,
  PANE_SEPARATOR_HIT_PX,
} from './layoutConstants'
import type { PaneRect, PaneSeparatorGeometry } from './paneGeometry'
import {
  findSlot,
  isPaneGroup,
  ROOT_GROUP_ID,
  wrapAxis,
  type PaneDropTarget,
  type PaneLayout,
  type PaneSide,
  type PaneSlot,
  type SidePaneKind,
} from './paneLayout'

export interface PaneDropZone {
  target: PaneDropTarget
  /** Where the pointer must be, in area px. */
  hit: PaneRect
  /** The slot the drop would create, in area px: what the indicator draws. */
  indicator: PaneRect
}

export interface PaneDropInput {
  layout: PaneLayout
  /** The pane being dragged; its own slot offers no zone. */
  source: SidePaneKind
  /** The area's size. */
  width: number
  height: number
  /** The chat's rect, in area px. */
  chat: PaneRect | null
  /** Each drawn pane's rect, in area px. */
  panes: ReadonlyMap<SidePaneKind, PaneRect>
  /** The gutters between siblings. */
  separators: readonly PaneSeparatorGeometry[]
}

function contains(rect: PaneRect, x: number, y: number): boolean {
  return x >= rect.left && x < rect.left + rect.width && y >= rect.top && y < rect.top + rect.height
}

/** `rect` widened across `axis` (a row's gutter is widened sideways) to `size`, centred. */
function widened(rect: PaneRect, axis: 'row' | 'column', size: number): PaneRect {
  if (axis === 'row') {
    const pad = Math.max(0, (size - rect.width) / 2)
    return { left: rect.left - pad, top: rect.top, width: rect.width + 2 * pad, height: rect.height }
  }
  const pad = Math.max(0, (size - rect.height) / 2)
  return { left: rect.left, top: rect.top - pad, width: rect.width, height: rect.height + 2 * pad }
}

/** The outer strip of `rect` at `side`: a quarter of its width or height. */
function strip(rect: PaneRect, side: PaneSide): PaneRect {
  const w = rect.width * PANE_DROP_WRAP_SHARE
  const h = rect.height * PANE_DROP_WRAP_SHARE
  switch (side) {
    case 'left':
      return { left: rect.left, top: rect.top, width: w, height: rect.height }
    case 'right':
      return { left: rect.left + rect.width - w, top: rect.top, width: w, height: rect.height }
    case 'top':
      return { left: rect.left + w, top: rect.top, width: rect.width - 2 * w, height: h }
    case 'bottom':
      return { left: rect.left + w, top: rect.top + rect.height - h, width: rect.width - 2 * w, height: h }
  }
}

/** The half of `rect` a wrap at `side` would give the moved pane. */
function half(rect: PaneRect, side: PaneSide): PaneRect {
  const w = rect.width / 2
  const h = rect.height / 2
  switch (side) {
    case 'left':
      return { left: rect.left, top: rect.top, width: w, height: rect.height }
    case 'right':
      return { left: rect.left + w, top: rect.top, width: w, height: rect.height }
    case 'top':
      return { left: rect.left, top: rect.top, width: rect.width, height: h }
    case 'bottom':
      return { left: rect.left, top: rect.top + h, width: rect.width, height: h }
  }
}

const SIDES: readonly PaneSide[] = ['left', 'right', 'top', 'bottom']

/**
 * Whether a wrap of `target` at `side` would put the source back where it
 * is: the two are neighbours in a group of that axis with the source on
 * that side.
 */
function facesSource(target: PaneSlot, side: PaneSide, source: PaneSlot): boolean {
  if (target.groupId !== source.groupId || target.axis !== wrapAxis(side)) return false
  const before = side === 'left' || side === 'top'
  return source.index === (before ? target.index - 1 : target.index + 1)
}

/**
 * The drop zones of a drag of `source`, in pick order: the area's edge
 * strips (`edge`), the gutters between siblings (`insert`, the separator's
 * hit area), each other pane's outer strips (`wrap`, a quarter per side),
 * then the chat's left strip (`edge` start) and right strip (`insert` after
 * the chat); the chat's top and bottom are inert. The source's own slot (its
 * card, the gutters beside it, its end, a wrap facing it) offers nothing.
 */
export function paneDropTargets(input: PaneDropInput): PaneDropZone[] {
  const { layout, source, width, height } = input
  const sourceSlot = findSlot(layout, source)
  if (!sourceSlot) return []
  const root = layout.root
  const zones: PaneDropZone[] = []
  const atRoot = (index: number) => sourceSlot.groupId === ROOT_GROUP_ID && sourceSlot.index === index
  const startStrip: PaneRect = { left: 0, top: 0, width: PANE_DROP_EDGE_PX, height }
  const endStrip: PaneRect = { left: width - PANE_DROP_EDGE_PX, top: 0, width: PANE_DROP_EDGE_PX, height }
  if (!atRoot(0)) zones.push({ target: { type: 'edge', side: 'start' }, hit: startStrip, indicator: startStrip })
  if (!atRoot(root.children.length - 1)) {
    zones.push({ target: { type: 'edge', side: 'end' }, hit: endStrip, indicator: endStrip })
  }

  const insertAt = (separator: PaneSeparatorGeometry): PaneDropZone | null => {
    if (
      separator.groupId === sourceSlot.groupId &&
      (separator.index === sourceSlot.index || separator.index === sourceSlot.index - 1)
    ) {
      return null
    }
    return {
      target: { type: 'insert', groupId: separator.groupId, index: separator.index + 1 },
      hit: widened(separator.rect, separator.axis, PANE_SEPARATOR_HIT_PX),
      indicator: widened(separator.rect, separator.axis, PANE_DROP_INSERT_PX),
    }
  }
  for (const separator of input.separators) {
    const zone = insertAt(separator)
    if (zone) zones.push(zone)
  }

  for (const [kind, rect] of input.panes) {
    if (kind === source) continue
    const slot = findSlot(layout, kind)
    if (!slot) continue
    for (const side of SIDES) {
      if (facesSource(slot, side, sourceSlot)) continue
      zones.push({ target: { type: 'wrap', pane: kind, side }, hit: strip(rect, side), indicator: half(rect, side) })
    }
  }

  const chat = input.chat
  const chatIndex = root.children.findIndex(child => !isPaneGroup(child) && child.pane === 'chat')
  if (chat && chatIndex !== -1) {
    if (!atRoot(0)) {
      zones.push({ target: { type: 'edge', side: 'start' }, hit: strip(chat, 'left'), indicator: startStrip })
    }
    if (!atRoot(chatIndex + 1)) {
      const after = input.separators.find(
        separator => separator.groupId === ROOT_GROUP_ID && separator.index === chatIndex,
      )
      zones.push({
        target: { type: 'insert', groupId: ROOT_GROUP_ID, index: chatIndex + 1 },
        hit: strip(chat, 'right'),
        indicator: after ? widened(after.rect, 'row', PANE_DROP_INSERT_PX) : endStrip,
      })
    }
  }
  return zones
}

/** The first zone under the point, or null. */
export function paneDropTargetAt(zones: readonly PaneDropZone[], x: number, y: number): PaneDropZone | null {
  for (const zone of zones) {
    if (contains(zone.hit, x, y)) return zone
  }
  return null
}
