/**
 * Resizing the pane tree at a separator (F-9). Pure: a drag of `delta` px
 * rewrites the two weights flanking the separator and nothing else, clamped
 * so neither flank goes under its minimum (a group's minimum along the axis
 * is its children's), and returns the same layout when nothing moves.
 */
import { PANE_GUTTER_PX } from './layoutConstants'
import type { PaneSeparatorGeometry, SeparatorFlank } from './paneGeometry'
import {
  CHAT_WEIGHT,
  groupById,
  isPaneGroup,
  ROOT_GROUP_ID,
  withGroup,
  type PaneLayout,
  type PaneNode,
  type PaneWeightByKind,
} from './paneLayout'

/** The px the first flank grows by (negative: shrinks) for a wanted `delta`, within both minimums. */
export function clampResizeDelta(first: SeparatorFlank, second: SeparatorFlank, delta: number): number {
  if (!Number.isFinite(delta)) return 0
  const firstMayLose = Math.min(0, first.min - first.length)
  const secondMayLose = Math.max(0, second.length - second.min)
  return Math.round(Math.min(Math.max(delta, firstMayLose), secondMayLose))
}

/** The two weights after the first flank grows by `delta` px: the pair's weight sum, shared by the new lengths. */
export function resizeFlankWeights(
  first: SeparatorFlank & { weight: number },
  second: SeparatorFlank & { weight: number },
  delta: number,
): { first: number; second: number } {
  const same = { first: first.weight, second: second.weight }
  const moved = clampResizeDelta(first, second, delta)
  if (moved === 0) return same
  const sum = first.length + second.length
  const total = first.weight + second.weight
  if (sum <= 0 || total <= 0) return same
  const share = (first.length + moved) / sum
  return { first: total * share, second: total * (1 - share) }
}

export interface ResizeEnv {
  /** The area's width: beside the chat, the chat and the region split it less one gutter. */
  areaWidth: number
  gutter?: number
}

function isChatLeaf(node: PaneNode): boolean {
  return !isPaneGroup(node) && node.pane === 'chat'
}

/**
 * The layout after `separator` moves `delta` px toward its second flank; the
 * same reference when nothing moves. Inside a group the pair's weight sum is
 * shared by the new lengths. Beside the chat (drawn by the cascade from the
 * region's share) the neighbour's weight is set against the other side
 * children, the chat's against the region, so the commit lands where the
 * separator was released.
 */
export function resizeLayoutAt(
  layout: PaneLayout,
  separator: PaneSeparatorGeometry,
  delta: number,
  env: ResizeEnv,
): PaneLayout {
  const gutter = env.gutter ?? PANE_GUTTER_PX
  const moved = clampResizeDelta(separator.first, separator.second, delta)
  if (moved === 0) return layout
  const group = groupById(layout, separator.groupId)
  if (!group) return layout
  const first = group.children[separator.index]
  const second = group.children[separator.index + 1]
  if (!first || !second) return layout
  const a = separator.first.length + moved
  const b = separator.second.length - moved
  let weights: { first: number; second: number }
  const chatAt =
    group.id === ROOT_GROUP_ID ? (isChatLeaf(first) ? 'first' : isChatLeaf(second) ? 'second' : null) : null
  if (chatAt) {
    const panelRoom = env.areaWidth - gutter
    const chatPx = chatAt === 'first' ? a : b
    const sidePx = chatAt === 'first' ? b : a
    const regionPx = panelRoom - chatPx
    const others = group.children.filter(
      (_, index) => index !== separator.index && index !== separator.index + 1,
    )
    const othersWeight = others.reduce((sum, child) => sum + Math.max(0, child.weight), 0)
    // The other side children's px: the region less its edge gutter, its
    // inner gutters and the neighbour.
    const othersPx = regionPx - gutter - gutter * others.length - sidePx
    let chatWeight: number
    let sideWeight: number
    if (others.length > 0 && othersWeight > 0 && othersPx > 0 && regionPx > 0) {
      sideWeight = (othersWeight * sidePx) / othersPx
      chatWeight = ((sideWeight + othersWeight) * chatPx) / regionPx
    } else {
      const total = first.weight + second.weight
      chatWeight = panelRoom > 0 ? (total * chatPx) / panelRoom : first.weight
      sideWeight = total - chatWeight
    }
    weights =
      chatAt === 'first'
        ? { first: chatWeight, second: sideWeight }
        : { first: sideWeight, second: chatWeight }
  } else {
    weights = resizeFlankWeights(
      { ...separator.first, weight: first.weight },
      { ...separator.second, weight: second.weight },
      moved,
    )
  }
  if (
    !Number.isFinite(weights.first) ||
    !Number.isFinite(weights.second) ||
    weights.first <= 0 ||
    weights.second <= 0
  ) {
    return layout
  }
  if (weights.first === first.weight && weights.second === second.weight) return layout
  const children = [...group.children]
  children[separator.index] = { ...first, weight: weights.first }
  children[separator.index + 1] = { ...second, weight: weights.second }
  return withGroup(layout, group.id, { ...group, children })
}

/**
 * The weight of each pane sitting directly in the root row, relative to the
 * chat's `CHAT_WEIGHT`: what the kind opens at next. A column's panes have no
 * weight of their own (their width is the column's).
 */
export function rootPaneWeightsByKind(layout: PaneLayout): PaneWeightByKind {
  const chat = layout.root.children.find(isChatLeaf)
  const chatWeight = chat?.weight ?? CHAT_WEIGHT
  const out: PaneWeightByKind = {}
  if (!(chatWeight > 0)) return out
  for (const child of layout.root.children) {
    if (isPaneGroup(child) || child.pane === 'chat') continue
    out[child.pane] = (child.weight * CHAT_WEIGHT) / chatWeight
  }
  return out
}
