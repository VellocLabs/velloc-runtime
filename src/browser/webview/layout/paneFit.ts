/**
 * The root row's weights after a pane opens (F-9): rebalanced once so that,
 * at the width the row has now, every side child keeps its minimum and the
 * chat's slot keeps `CHAT_CONTENT_MIN_WIDTH_PX` when that fits, else at least
 * `CHAT_SLOT_MIN_WIDTH_PX`. Only what must give way does: the opened pane's
 * root child first, the others only once it is at its minimum. Pure.
 */
import { CHAT_CONTENT_MIN_WIDTH_PX, CHAT_SLOT_MIN_WIDTH_PX, PANE_GUTTER_PX } from './layoutConstants'
import { nodeMinLength } from './paneGeometry'
import { isPaneGroup, type PaneLayout, type PaneNode, type SidePaneKind } from './paneLayout'

export interface RowFitEnv {
  /** The px the chat's slot and the side region split (the shell's room less the gap between them). */
  rowWidth: number
  gutter?: number
}

function holds(node: PaneNode, kind: SidePaneKind): boolean {
  return isPaneGroup(node) ? node.children.some(child => holds(child, kind)) : node.pane === kind
}

/**
 * `layout` with its root row rebalanced for `kind`, just opened; the same
 * reference when the row already fits, `kind` is not in the tree, or even
 * the slot's minimum beside every side child's does not fit (the shell then
 * shrinks everything in proportion). The chat's weight is kept.
 */
export function fitRootRowAfterOpen(layout: PaneLayout, kind: SidePaneKind, env: RowFitEnv): PaneLayout {
  const gutter = env.gutter ?? PANE_GUTTER_PX
  const children = layout.root.children
  const chatIndex = children.findIndex(child => !isPaneGroup(child) && child.pane === 'chat')
  const opened = children.findIndex(child => holds(child, kind))
  if (chatIndex === -1 || opened === -1) return layout
  const side = children.map((child, index) => ({ child, index })).filter(({ index }) => index !== chatIndex)
  const chatWeight = children[chatIndex].weight
  const sideWeight = side.reduce((sum, { child }) => sum + Math.max(0, child.weight), 0)
  const total = chatWeight + sideWeight
  if (!(env.rowWidth > 0) || !(chatWeight > 0) || !(sideWeight > 0)) return layout

  // Px as the shell and the geometry draw them before any minimum applies:
  // the region takes its share of the row, its side children share what is
  // left of it after the gutters (one at the area's edge, one between each).
  const gutters = gutter * side.length
  const content = env.rowWidth - gutters
  const mins = side.map(({ child }) => nodeMinLength(child, 'row', gutter))
  const minSum = mins.reduce((sum, min) => sum + min, 0)
  if (content - minSum < CHAT_SLOT_MIN_WIDTH_PX) return layout
  const chatFloor = content - minSum >= CHAT_CONTENT_MIN_WIDTH_PX ? CHAT_CONTENT_MIN_WIDTH_PX : CHAT_SLOT_MIN_WIDTH_PX
  const sidePx = content - (env.rowWidth * chatWeight) / total
  const px = side.map(({ child }) => (Math.max(0, child.weight) / sideWeight) * sidePx)

  let changed = false
  px.forEach((each, i) => {
    if (each < mins[i]) {
      px[i] = mins[i]
      changed = true
    }
  })
  let need = chatFloor - (content - px.reduce((sum, each) => sum + each, 0))
  if (need > 0) {
    changed = true
    const own = side.findIndex(({ index }) => index === opened)
    const fromOwn = Math.min(need, px[own] - mins[own])
    px[own] -= fromOwn
    need -= fromOwn
    if (need > 0) {
      const excess = px.map((each, i) => (i === own ? 0 : each - mins[i]))
      const excessSum = excess.reduce((sum, each) => sum + each, 0)
      const take = Math.min(need, excessSum)
      if (excessSum > 0) px.forEach((_, i) => (px[i] -= (excess[i] * take) / excessSum))
    }
  }
  if (!changed) return layout

  // Back to weights with the chat's kept: the region's share of the row
  // gives the side weights' sum, shared by the px each child is to get.
  const pxSum = px.reduce((sum, each) => sum + each, 0)
  const chatPx = content - pxSum
  if (!(chatPx > 0) || !(pxSum > 0)) return layout
  const nextSideWeight = (chatWeight * (env.rowWidth - chatPx)) / chatPx
  const next = [...children]
  side.forEach(({ child, index }, i) => {
    next[index] = { ...child, weight: (px[i] / pxSum) * nextSideWeight }
  })
  return { root: { ...layout.root, children: next } }
}
