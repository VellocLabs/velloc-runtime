/**
 * Pixel rects for a pane tree (F-9). Groups are not DOM nodes: every leaf is
 * drawn at an absolute rect inside the area, so a pane keeps its mounted body
 * (an editor with unsaved edits) when the tree around it changes. A group
 * shares its length among its children by weight, each held at its minimum
 * and separated by a gutter. Pure.
 */
import {
  CHAT_CONTENT_MIN_WIDTH_PX,
  PANE_GUTTER_PX,
  PANE_MIN_HEIGHT_PX,
  RIGHT_PANEL_MIN_WIDTH_PX,
  WEBVIEW_AREA_MIN_WIDTH_PX,
} from './layoutConstants'
import {
  isPaneGroup,
  panesIn,
  ROOT_GROUP_ID,
  type PaneAxis,
  type PaneGroup,
  type PaneId,
  type PaneLayout,
  type PaneNode,
  type SidePaneKind,
} from './paneLayout'
import type { PanelForm } from './shellLayout'

export interface PaneRect {
  left: number
  top: number
  width: number
  height: number
}

export interface PaneGeometryInput {
  /** The area the tree fills, in CSS px. */
  width: number
  height: number
  /** The chat's drawn width (the shell's cascade decides it); the side panes share the rest. */
  chatWidth: number
  gutter?: number
}

/** A pane's narrowest drawn width. */
export function paneMinWidth(pane: PaneId): number {
  if (pane === 'chat') return CHAT_CONTENT_MIN_WIDTH_PX
  if (pane === 'browser') return WEBVIEW_AREA_MIN_WIDTH_PX
  return RIGHT_PANEL_MIN_WIDTH_PX
}

export function paneMinHeight(pane: PaneId): number {
  return pane === 'chat' ? 0 : PANE_MIN_HEIGHT_PX
}

/** A node's minimum along `axis`: a leaf's own, a group's sum or widest child plus gutters. */
export function nodeMinLength(node: PaneNode, axis: 'row' | 'column', gutter = PANE_GUTTER_PX): number {
  const own = (pane: PaneId) => (axis === 'row' ? paneMinWidth(pane) : paneMinHeight(pane))
  if (!isPaneGroup(node)) return own(node.pane)
  const parts = node.children.map(child => nodeMinLength(child, axis, gutter))
  if (parts.length === 0) return 0
  if (node.axis === axis) {
    return parts.reduce((sum, part) => sum + part, 0) + gutter * (parts.length - 1)
  }
  return Math.max(...parts)
}

/**
 * Share `length` among `children` by weight: each child at least its minimum,
 * the rest in proportion, gutters between. Rounded to whole px; the last
 * child absorbs the rounding.
 */
export function shareLength(
  children: readonly { weight: number; min: number }[],
  length: number,
  gutter: number,
): number[] {
  const n = children.length
  if (n === 0) return []
  const free = Math.max(0, length - gutter * (n - 1))
  const out = new Array<number>(n).fill(0)
  const fixed = new Set<number>()
  // Children under their minimum are pinned there; the others share what is left.
  for (;;) {
    let weightSum = 0
    let fixedSum = 0
    for (let i = 0; i < n; i++) {
      if (fixed.has(i)) fixedSum += out[i]
      else weightSum += Math.max(0, children[i].weight)
    }
    const room = Math.max(0, free - fixedSum)
    let pinned = false
    for (let i = 0; i < n; i++) {
      if (fixed.has(i)) continue
      const want = weightSum > 0 ? (Math.max(0, children[i].weight) / weightSum) * room : room / (n - fixed.size)
      if (want < children[i].min) {
        out[i] = children[i].min
        fixed.add(i)
        pinned = true
      } else {
        out[i] = want
      }
    }
    if (!pinned || fixed.size === n) break
  }
  let used = 0
  for (let i = 0; i < n; i++) {
    out[i] = i === n - 1 ? Math.max(children[i].min, Math.round(free - used)) : Math.round(out[i])
    used += out[i]
  }
  return out
}

function layoutGroup(
  group: PaneGroup,
  rect: PaneRect,
  gutter: number,
  out: Map<PaneId, PaneRect>,
  lengths?: number[],
): void {
  const row = group.axis === 'row'
  const sizes =
    lengths ??
    shareLength(
      group.children.map(child => ({ weight: child.weight, min: nodeMinLength(child, group.axis, gutter) })),
      row ? rect.width : rect.height,
      gutter,
    )
  let offset = 0
  group.children.forEach((child, index) => {
    const size = sizes[index] ?? 0
    const childRect: PaneRect = row
      ? { left: rect.left + offset, top: rect.top, width: size, height: rect.height }
      : { left: rect.left, top: rect.top + offset, width: rect.width, height: size }
    if (isPaneGroup(child)) layoutGroup(child, childRect, gutter, out)
    else out.set(child.pane, childRect)
    offset += size + gutter
  })
}

/**
 * Every leaf's rect. The root row gives the chat `chatWidth` and shares the
 * remaining width among the side children by weight; nested groups share by
 * weight alone.
 */
export function resolvePaneRects(layout: PaneLayout, input: PaneGeometryInput): Map<PaneId, PaneRect> {
  const gutter = input.gutter ?? PANE_GUTTER_PX
  const out = new Map<PaneId, PaneRect>()
  const root = layout.root
  const chatIndex = root.children.findIndex(child => !isPaneGroup(child) && child.pane === 'chat')
  const sideChildren = root.children.filter((_, index) => index !== chatIndex)
  if (chatIndex === -1 || sideChildren.length === 0) {
    layoutGroup(root, { left: 0, top: 0, width: input.width, height: input.height }, gutter, out)
    return out
  }
  const chatWidth = Math.max(0, Math.min(input.width, Math.round(input.chatWidth)))
  const sideWidth = Math.max(0, input.width - chatWidth - gutter)
  const sideSizes = shareLength(
    sideChildren.map(child => ({ weight: child.weight, min: nodeMinLength(child, 'row', gutter) })),
    sideWidth,
    gutter,
  )
  const lengths: number[] = []
  let next = 0
  root.children.forEach((_, index) => {
    lengths.push(index === chatIndex ? chatWidth : sideSizes[next++])
  })
  layoutGroup(root, { left: 0, top: 0, width: input.width, height: input.height }, gutter, out, lengths)
  return out
}

/** The side region beside the chat, as the shell's cascade sees it. */
export interface SideRegionMetrics {
  /** The narrowest the region draws: its root-row children's minimums plus gutters. */
  minWidth: number
  /** The region's share of the root row: side weights over all weights. */
  share: number
  /** Side panes present in the root row (0 means chat alone). */
  count: number
}

export function sideRegionMetrics(layout: PaneLayout, gutter = PANE_GUTTER_PX): SideRegionMetrics {
  const root = layout.root
  const side = root.children.filter(child => isPaneGroup(child) || child.pane !== 'chat')
  if (side.length === 0) return { minWidth: 0, share: 0, count: 0 }
  const minWidth =
    side.reduce((sum, child) => sum + nodeMinLength(child, 'row', gutter), 0) + gutter * (side.length - 1)
  const total = root.children.reduce((sum, child) => sum + Math.max(0, child.weight), 0)
  const sideWeight = side.reduce((sum, child) => sum + Math.max(0, child.weight), 0)
  return { minWidth, share: total > 0 ? sideWeight / total : 0, count: side.length }
}

// ---------------------------------------------------------------------------
// Separators and the drawn area
// ---------------------------------------------------------------------------

/** One flank of a separator: its drawn length along the axis and its minimum there. */
export interface SeparatorFlank {
  length: number
  min: number
}

/**
 * The gutter between two adjacent children of a group, as a resize handle: a
 * row's separator is a vertical bar, a column's a horizontal one.
 */
export interface PaneSeparatorGeometry {
  /** `<groupId>:<index>`; the same while the pair exists. */
  key: string
  groupId: string
  /** The first flank's index among the group's children; the second is `index + 1`. */
  index: number
  axis: PaneAxis
  /** The gutter between the flanks, in area px. */
  rect: PaneRect
  first: SeparatorFlank
  second: SeparatorFlank
}

/** The box a node's drawn leaves cover, or null when none is drawn. */
export function nodeExtent(node: PaneNode, rects: ReadonlyMap<PaneId, PaneRect>): PaneRect | null {
  if (!isPaneGroup(node)) return rects.get(node.pane) ?? null
  let out: PaneRect | null = null
  for (const child of node.children) {
    const extent = nodeExtent(child, rects)
    if (!extent) continue
    if (!out) {
      out = { ...extent }
      continue
    }
    const left = Math.min(out.left, extent.left)
    const top = Math.min(out.top, extent.top)
    const right = Math.max(out.left + out.width, extent.left + extent.width)
    const bottom = Math.max(out.top + out.height, extent.top + extent.height)
    out = { left, top, width: right - left, height: bottom - top }
  }
  return out
}

function collectSeparators(
  group: PaneGroup,
  rects: ReadonlyMap<PaneId, PaneRect>,
  gutter: number,
  out: PaneSeparatorGeometry[],
): void {
  const row = group.axis === 'row'
  for (let index = 0; index + 1 < group.children.length; index++) {
    const first = group.children[index]
    const second = group.children[index + 1]
    const a = nodeExtent(first, rects)
    const b = nodeExtent(second, rects)
    if (!a || !b) continue
    const rect: PaneRect = row
      ? {
          left: a.left + a.width,
          top: Math.min(a.top, b.top),
          width: Math.max(0, b.left - a.left - a.width),
          height: Math.max(a.top + a.height, b.top + b.height) - Math.min(a.top, b.top),
        }
      : {
          left: Math.min(a.left, b.left),
          top: a.top + a.height,
          width: Math.max(a.left + a.width, b.left + b.width) - Math.min(a.left, b.left),
          height: Math.max(0, b.top - a.top - a.height),
        }
    out.push({
      key: `${group.id}:${index}`,
      groupId: group.id,
      index,
      axis: group.axis,
      rect,
      first: { length: row ? a.width : a.height, min: nodeMinLength(first, group.axis, gutter) },
      second: { length: row ? b.width : b.height, min: nodeMinLength(second, group.axis, gutter) },
    })
  }
  for (const child of group.children) {
    if (isPaneGroup(child)) collectSeparators(child, rects, gutter, out)
  }
}

/** A separator for every adjacent pair whose flanks are both drawn; groups walked depth-first. */
export function resolvePaneSeparators(
  layout: PaneLayout,
  rects: ReadonlyMap<PaneId, PaneRect>,
  gutter = PANE_GUTTER_PX,
): PaneSeparatorGeometry[] {
  const out: PaneSeparatorGeometry[] = []
  collectSeparators(layout.root, rects, gutter, out)
  return out
}

export interface AreaGeometryInput {
  layout: PaneLayout
  maximized: SidePaneKind | null
  /** The side region's drawn form; `none` while the tree holds no pane. */
  form: PanelForm
  /** The area's size. */
  width: number
  height: number
  /** The chat's drawn width while the panes are beside it. */
  chatWidth: number
  /** The seat's width while the region is overlaid or floating. */
  seatWidth: number
  gutter?: number
}

export interface AreaGeometry {
  /** The chat's box; null while a pane covers it. */
  chat: PaneRect | null
  /** The side region's box; null while the tree holds no pane. */
  seat: PaneRect | null
  /** Each drawn pane's box in area px; a pane missing here is hidden. */
  panes: Map<SidePaneKind, PaneRect>
  /** The resize handles: only while the panes sit beside the chat with none expanded. */
  separators: PaneSeparatorGeometry[]
}

/**
 * Where everything in the area is drawn: the chat, the side region's box
 * beside the chat (`beside`), over everything (`maximized`), or a seat at the
 * area's end (`overlay`, `float`), each pane inside it, and the separators.
 */
export function resolveAreaGeometry(input: AreaGeometryInput): AreaGeometry {
  const gutter = input.gutter ?? PANE_GUTTER_PX
  const { layout, maximized, form, width, height } = input
  const panes = new Map<SidePaneKind, PaneRect>()
  const full: PaneRect = { left: 0, top: 0, width, height }
  if (panesIn(layout).length === 0 || form === 'none') return { chat: full, seat: null, panes, separators: [] }
  if (maximized !== null) {
    panes.set(maximized, {
      left: gutter,
      top: gutter,
      width: Math.max(0, width - 2 * gutter),
      height: Math.max(0, height - 2 * gutter),
    })
    return { chat: null, seat: full, panes, separators: [] }
  }
  const seated = form === 'overlay' || form === 'float'
  let chat: PaneRect = full
  let seat: PaneRect
  if (seated) {
    const seatWidth = Math.max(0, Math.min(width, Math.round(input.seatWidth)))
    seat = { left: width - seatWidth, top: 0, width: seatWidth, height }
  } else {
    const chatWidth = Math.max(0, Math.min(width, Math.round(input.chatWidth)))
    chat = { left: 0, top: 0, width: chatWidth, height }
    seat = { left: chatWidth + gutter, top: 0, width: Math.max(0, width - chatWidth - gutter), height }
  }
  // The side children of the root row, laid out on their own in the seat,
  // inset by a gutter at the top, the bottom and the area's edge (both edges
  // when the seat floats over the chat).
  const side: PaneLayout = {
    root: {
      ...layout.root,
      id: ROOT_GROUP_ID,
      children: layout.root.children.filter(child => isPaneGroup(child) || child.pane !== 'chat'),
    },
  }
  const inset = seated ? gutter : 0
  const rects = resolvePaneRects(side, {
    width: Math.max(0, seat.width - gutter - inset),
    height: Math.max(0, seat.height - 2 * gutter),
    chatWidth: 0,
    gutter,
  })
  for (const [pane, rect] of rects) {
    if (pane === 'chat') continue
    panes.set(pane, { ...rect, left: seat.left + inset + rect.left, top: gutter + rect.top })
  }
  if (seated) return { chat, seat, panes, separators: [] }
  const all = new Map<PaneId, PaneRect>(panes)
  all.set('chat', chat)
  return { chat, seat, panes, separators: resolvePaneSeparators(layout, all, gutter) }
}
