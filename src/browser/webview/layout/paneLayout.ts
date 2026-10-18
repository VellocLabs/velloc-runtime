/**
 * A session's pane arrangement (F-9): a tree of groups whose leaves are the
 * chat and the side panes, plus the per-session record that carries the
 * tree, the expanded pane and where closed panes sat. Pure: every function
 * returns a new value, or the same reference when nothing changed.
 */

/** The utility views that can be panes beside the chat. */
export type SidePaneKind = 'tasks' | 'diff' | 'browser' | 'plan' | 'skill' | 'files' | 'terminal'

export const SIDE_PANE_KINDS: readonly SidePaneKind[] = [
  'tasks',
  'diff',
  'browser',
  'plan',
  'skill',
  'files',
  'terminal',
]

/** A leaf of the tree: the chat, or one side pane. */
export type PaneId = 'chat' | SidePaneKind

export type PaneAxis = 'row' | 'column'

export interface PaneLeaf {
  pane: PaneId
  /** The leaf's flex share within its group. */
  weight: number
}

export interface PaneGroup {
  id: string
  axis: PaneAxis
  /** The group's flex share within its parent. */
  weight: number
  children: PaneNode[]
}

export type PaneNode = PaneGroup | PaneLeaf

export interface PaneLayout {
  /** Always the row group `root`; its first child is the chat by default. */
  root: PaneGroup
}

/** Where a pane sat before it closed, so it can be put back. */
export interface PaneSlot {
  groupId: string
  index: number
  axis: PaneAxis
  weight: number
}

/** Remembered pane weights, relative to the chat's `CHAT_WEIGHT`. */
export type PaneWeightByKind = Partial<Record<SidePaneKind, number>>

export const ROOT_GROUP_ID = 'root'
export const CHAT_WEIGHT = 2
/** Reading panes open at chat:pane 2:3; the rest at 2:1. */
export const WIDE_PANE_WEIGHT = 3
export const NARROW_PANE_WEIGHT = 1
const WIDE_PANE_KINDS: ReadonlySet<SidePaneKind> = new Set(['diff', 'browser', 'files'])

export function isSidePaneKind(value: unknown): value is SidePaneKind {
  return typeof value === 'string' && (SIDE_PANE_KINDS as readonly string[]).includes(value)
}

export function isPaneId(value: unknown): value is PaneId {
  return value === 'chat' || isSidePaneKind(value)
}

export function isPaneGroup(node: PaneNode): node is PaneGroup {
  return 'children' in node
}

export function isWidePaneKind(kind: SidePaneKind): boolean {
  return WIDE_PANE_KINDS.has(kind)
}

/** The weight a kind opens at: the remembered one, else wide 3 or narrow 1. */
export function paneWeightFor(kind: SidePaneKind, weights: PaneWeightByKind): number {
  const remembered = weights[kind]
  if (typeof remembered === 'number' && Number.isFinite(remembered) && remembered > 0) {
    return remembered
  }
  return isWidePaneKind(kind) ? WIDE_PANE_WEIGHT : NARROW_PANE_WEIGHT
}

export function defaultPaneLayout(): PaneLayout {
  return {
    root: {
      id: ROOT_GROUP_ID,
      axis: 'row',
      weight: 1,
      children: [{ pane: 'chat', weight: CHAT_WEIGHT }],
    },
  }
}

function collectPanes(node: PaneNode, out: SidePaneKind[]): void {
  if (isPaneGroup(node)) {
    for (const child of node.children) collectPanes(child, out)
  } else if (node.pane !== 'chat') {
    out.push(node.pane)
  }
}

/** The side panes in the tree, depth-first in drawing order. */
export function panesIn(layout: PaneLayout): SidePaneKind[] {
  const out: SidePaneKind[] = []
  collectPanes(layout.root, out)
  return out
}

export function hasPane(layout: PaneLayout, kind: SidePaneKind): boolean {
  return findSlot(layout, kind) !== null
}

function findGroup(node: PaneNode, id: string): PaneGroup | null {
  if (!isPaneGroup(node)) return null
  if (node.id === id) return node
  for (const child of node.children) {
    const found = findGroup(child, id)
    if (found) return found
  }
  return null
}

export function groupById(layout: PaneLayout, id: string): PaneGroup | null {
  return findGroup(layout.root, id)
}

function findSlotIn(group: PaneGroup, pane: PaneId): PaneSlot | null {
  for (let index = 0; index < group.children.length; index++) {
    const child = group.children[index]
    if (isPaneGroup(child)) {
      const found = findSlotIn(child, pane)
      if (found) return found
    } else if (child.pane === pane) {
      return { groupId: group.id, index, axis: group.axis, weight: child.weight }
    }
  }
  return null
}

/** The slot a pane occupies now, or null when it is not in the tree. */
export function findSlot(layout: PaneLayout, pane: PaneId): PaneSlot | null {
  return findSlotIn(layout.root, pane)
}

function groupIds(node: PaneNode, out: Set<string>): void {
  if (!isPaneGroup(node)) return
  out.add(node.id)
  for (const child of node.children) groupIds(child, out)
}

/** The smallest `g<n>` id no group in the tree uses. */
export function nextGroupId(layout: PaneLayout): string {
  const used = new Set<string>()
  groupIds(layout.root, used)
  for (let n = 1; ; n++) {
    const id = `g${n}`
    if (!used.has(id)) return id
  }
}

function replaceGroup(node: PaneNode, id: string, next: PaneGroup): PaneNode {
  if (!isPaneGroup(node)) return node
  if (node.id === id) return next
  let changed = false
  const children = node.children.map(child => {
    const replaced = replaceGroup(child, id, next)
    if (replaced !== child) changed = true
    return replaced
  })
  return changed ? { ...node, children } : node
}

function withGroup(layout: PaneLayout, id: string, next: PaneGroup): PaneLayout {
  const root = replaceGroup(layout.root, id, next)
  return root === layout.root ? layout : { root: root as PaneGroup }
}

function meanWeight(children: readonly PaneNode[]): number {
  if (children.length === 0) return 1
  return children.reduce((sum, child) => sum + child.weight, 0) / children.length
}

/**
 * Put `kind` into the tree. `slot` (where it last sat) wins when its group
 * still exists, with the index clamped. Otherwise the first pane sits beside
 * the chat at `weight`; a later pane goes below the right-most root child,
 * which is wrapped into a column (or appended when it already is one). The
 * chat is never wrapped. A pane already in the tree leaves it unchanged.
 */
export function placePane(
  layout: PaneLayout,
  kind: SidePaneKind,
  options: { slot?: PaneSlot | null; weight: number },
): PaneLayout {
  if (hasPane(layout, kind)) return layout
  const slot = options.slot ?? null
  if (slot) {
    const group = groupById(layout, slot.groupId)
    if (group) {
      const index = Math.max(0, Math.min(slot.index, group.children.length))
      const children = [...group.children]
      children.splice(index, 0, { pane: kind, weight: slot.weight })
      return normalise(withGroup(layout, group.id, { ...group, children }))
    }
  }
  const root = layout.root
  const last = root.children[root.children.length - 1]
  const sidePanes = panesIn(layout)
  if (sidePanes.length === 0 || !last || (!isPaneGroup(last) && last.pane === 'chat')) {
    return normalise({
      root: { ...root, children: [...root.children, { pane: kind, weight: options.weight }] },
    })
  }
  const leaf: PaneLeaf = { pane: kind, weight: 1 }
  const children = [...root.children]
  if (isPaneGroup(last) && last.axis === 'column') {
    children[children.length - 1] = {
      ...last,
      children: [...last.children, { ...leaf, weight: meanWeight(last.children) }],
    }
  } else {
    children[children.length - 1] = {
      id: nextGroupId(layout),
      axis: 'column',
      weight: last.weight,
      children: [{ ...last, weight: 1 }, leaf],
    }
  }
  return normalise({ root: { ...root, children } })
}

function removeLeaf(node: PaneNode, pane: PaneId): PaneNode {
  if (!isPaneGroup(node)) return node
  let changed = false
  const children: PaneNode[] = []
  for (const child of node.children) {
    if (!isPaneGroup(child) && child.pane === pane) {
      changed = true
      continue
    }
    const next = removeLeaf(child, pane)
    if (next !== child) changed = true
    children.push(next)
  }
  return changed ? { ...node, children } : node
}

/** Take `kind` out of the tree; `slot` says where it was (null when absent). */
export function removePane(
  layout: PaneLayout,
  kind: SidePaneKind,
): { layout: PaneLayout; slot: PaneSlot | null } {
  const slot = findSlot(layout, kind)
  if (!slot) return { layout, slot: null }
  const root = removeLeaf(layout.root, kind) as PaneGroup
  return { layout: normalise({ root }), slot }
}

function normaliseNode(node: PaneNode, seen: Set<PaneId>): PaneNode | null {
  if (!isPaneGroup(node)) {
    if (seen.has(node.pane)) return null
    seen.add(node.pane)
    return node
  }
  let changed = false
  const children: PaneNode[] = []
  for (const child of node.children) {
    const next = normaliseNode(child, seen)
    if (next === null) {
      changed = true
      continue
    }
    if (isPaneGroup(next) && next.axis === node.axis) {
      // Same-axis nesting flattens; the group's weight is shared out in the
      // proportions its children had.
      changed = true
      const sum = next.children.reduce((total, each) => total + each.weight, 0)
      for (const grandchild of next.children) {
        children.push({
          ...grandchild,
          weight: sum > 0 ? (grandchild.weight / sum) * next.weight : next.weight,
        })
      }
      continue
    }
    if (next !== child) changed = true
    children.push(next)
  }
  if (node.id !== ROOT_GROUP_ID) {
    if (children.length === 0) return null
    if (children.length === 1) return { ...children[0], weight: node.weight }
  }
  return changed ? { ...node, children } : node
}

/**
 * Collapse single-child groups, flatten same-axis nesting, drop repeated
 * panes and ensure the chat. The root stays the row `root`.
 */
export function normalise(layout: PaneLayout): PaneLayout {
  const seen = new Set<PaneId>()
  let root = normaliseNode(layout.root, seen) as PaneGroup | null
  root = root ?? { ...layout.root, children: [] }
  if (root.id !== ROOT_GROUP_ID || root.axis !== 'row') {
    root = { ...root, id: ROOT_GROUP_ID, axis: 'row' }
  }
  if (!seen.has('chat')) {
    root = { ...root, children: [{ pane: 'chat', weight: CHAT_WEIGHT }, ...root.children] }
  }
  return root === layout.root ? layout : { root }
}

export function paneLayoutEquals(a: PaneLayout, b: PaneLayout): boolean {
  return a === b || JSON.stringify(a.root) === JSON.stringify(b.root)
}

// ---------------------------------------------------------------------------
// The per-session record
// ---------------------------------------------------------------------------

/** The Files pane's strip: open paths in tab order, and the one in front. */
export interface FilesPaneState {
  tabs: string[]
  active: string | null
}

export interface SessionPaneRecord {
  layout: PaneLayout
  /** The pane covering the chat and the other panes, if any. */
  maximized: SidePaneKind | null
  /** Where a closed pane sat, so it reopens in place. */
  closedSlots: Partial<Record<SidePaneKind, PaneSlot>>
  files?: FilesPaneState
  /** When this session was last shown; the least recent records are dropped past the cap. */
  usedAt: number
}

export function defaultSessionPaneRecord(usedAt = 0): SessionPaneRecord {
  return { layout: defaultPaneLayout(), maximized: null, closedSlots: {}, usedAt }
}

/** Open `kind` in the record: its remembered slot, else the default place. */
export function openPane(
  record: SessionPaneRecord,
  kind: SidePaneKind,
  weights: PaneWeightByKind,
): SessionPaneRecord {
  if (hasPane(record.layout, kind)) return record
  const slot = record.closedSlots[kind] ?? null
  const layout = placePane(record.layout, kind, { slot, weight: paneWeightFor(kind, weights) })
  const closedSlots = { ...record.closedSlots }
  delete closedSlots[kind]
  return { ...record, layout, closedSlots }
}

/** Close `kind`, remembering its slot; an expanded pane closing restores the rest. */
export function closePane(record: SessionPaneRecord, kind: SidePaneKind): SessionPaneRecord {
  const removed = removePane(record.layout, kind)
  if (!removed.slot) return record
  return {
    ...record,
    layout: removed.layout,
    maximized: record.maximized === kind ? null : record.maximized,
    closedSlots: { ...record.closedSlots, [kind]: removed.slot },
  }
}

/** Expand `kind` over the area (it must be in the tree), or restore with null. */
export function setMaximized(
  record: SessionPaneRecord,
  kind: SidePaneKind | null,
): SessionPaneRecord {
  const next = kind !== null && hasPane(record.layout, kind) ? kind : null
  return next === record.maximized ? record : { ...record, maximized: next }
}

/** The record back to the default arrangement; the Files strip is content, not layout, and stays. */
export function resetPaneLayout(record: SessionPaneRecord): SessionPaneRecord {
  if (
    record.maximized === null &&
    Object.keys(record.closedSlots).length === 0 &&
    paneLayoutEquals(record.layout, defaultPaneLayout())
  ) {
    return record
  }
  return { ...record, layout: defaultPaneLayout(), maximized: null, closedSlots: {} }
}

/**
 * Drop the panes a session cannot show right now: the browser pane while the
 * session owns no tab (its slot is kept, so it returns in place when a tab
 * opens). `maximized` survives only with its pane.
 */
export function pruneUnrestorable(
  record: SessionPaneRecord,
  env: { browserTabs: number },
): SessionPaneRecord {
  let next = record
  if (env.browserTabs <= 0 && hasPane(next.layout, 'browser')) next = closePane(next, 'browser')
  if (next.maximized !== null && !hasPane(next.layout, next.maximized)) {
    next = { ...next, maximized: null }
  }
  return next
}

export function sessionPaneRecordEquals(a: SessionPaneRecord, b: SessionPaneRecord): boolean {
  if (a === b) return true
  return (
    a.maximized === b.maximized &&
    a.usedAt === b.usedAt &&
    paneLayoutEquals(a.layout, b.layout) &&
    JSON.stringify(a.closedSlots) === JSON.stringify(b.closedSlots) &&
    JSON.stringify(a.files ?? null) === JSON.stringify(b.files ?? null)
  )
}

/** What a pane toggle does to the record the screen draws. */
export type PaneToggleAction = 'open' | 'show-overlay' | 'move-expansion' | 'close'

/**
 * The toggle of `kind` against the DRAWN record: a closed pane opens; an open
 * pane's toggle shows the hidden overlay when the region is overlaid, moves
 * the expansion onto the pane when another is expanded, else closes it.
 */
export function paneToggleAction(
  record: SessionPaneRecord,
  kind: SidePaneKind,
  overlayHidden: boolean,
): PaneToggleAction {
  if (!hasPane(record.layout, kind)) return 'open'
  if (overlayHidden) return 'show-overlay'
  if (record.maximized !== null && record.maximized !== kind) return 'move-expansion'
  return 'close'
}

/**
 * The browser toggle: a pane's toggle, except that with the pane closed and
 * no session tab to show there is nothing to open yet, so a session tab is
 * created inside the pane (`new-tab`); the pane follows the tab (below).
 */
export type BrowserToggleAction = PaneToggleAction | 'new-tab'

export function browserToggleAction(
  record: SessionPaneRecord,
  overlayHidden: boolean,
  env: { browserTabs: number },
): BrowserToggleAction {
  if (!hasPane(record.layout, 'browser') && env.browserTabs <= 0) return 'new-tab'
  return paneToggleAction(record, 'browser', overlayHidden)
}

/**
 * The browser pane follows the session's tabs: a change to a count above
 * zero places the pane (its remembered slot, else the default place) unless
 * the person closed it at exactly that count — `dismissedAt`, the count the
 * pane was closed at, so new tab activity brings it back and a repeat of the
 * dismissed state does not. A count of zero changes nothing here
 * (`pruneUnrestorable` hides the pane). Same reference when nothing changes.
 */
export function followBrowserTabs(
  record: SessionPaneRecord,
  env: { prevTabs: number; nextTabs: number; dismissedAt: number | null },
  weights: PaneWeightByKind,
): SessionPaneRecord {
  if (env.nextTabs <= 0 || env.nextTabs === env.prevTabs) return record
  if (env.dismissedAt === env.nextTabs) return record
  return openPane(record, 'browser', weights)
}
