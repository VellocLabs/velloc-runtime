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
import { isPaneGroup, type PaneGroup, type PaneId, type PaneLayout, type PaneNode } from './paneLayout'

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
