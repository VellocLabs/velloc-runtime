/**
 * The pane tree (F-9): default placement beside the chat, later panes stacked
 * below the right-most root child, a closed pane's slot remembered and reused,
 * normalisation, moving a pane to each kind of target, and the per-session
 * record ops. Same reference on no-ops.
 */
import { describe, expect, it } from 'vitest'

import {
  CHAT_WEIGHT,
  browserToggleAction,
  closePane,
  defaultPaneLayout,
  defaultSessionPaneRecord,
  findSlot,
  followBrowserTabs,
  hasPane,
  isPaneGroup,
  movePane,
  normalise,
  openPane,
  panesIn,
  paneToggleAction,
  paneWeightFor,
  placePane,
  pruneUnrestorable,
  removePane,
  resetPaneLayout,
  setMaximized,
  type PaneGroup,
  type PaneLayout,
} from '@/browser/webview/layout/paneLayout'

const leaf = (pane: 'chat' | 'tasks' | 'diff' | 'plan' | 'browser', weight = 1) => ({ pane, weight })

function shape(layout: PaneLayout): unknown {
  const walk = (node: PaneGroup['children'][number]): unknown =>
    isPaneGroup(node) ? { [node.axis]: node.children.map(walk) } : node.pane
  return walk(layout.root)
}

describe('placePane', () => {
  it('the first pane sits beside the chat at its weight', () => {
    const layout = placePane(defaultPaneLayout(), 'diff', { weight: 3 })
    expect(shape(layout)).toEqual({ row: ['chat', 'diff'] })
    expect(findSlot(layout, 'diff')).toEqual({ groupId: 'root', index: 1, axis: 'row', weight: 3 })
    expect(findSlot(layout, 'chat')?.weight).toBe(CHAT_WEIGHT)
  })

  it('later panes stack below the right-most pane, in a column that keeps its width', () => {
    const one = placePane(defaultPaneLayout(), 'diff', { weight: 3 })
    const two = placePane(one, 'tasks', { weight: 1 })
    expect(shape(two)).toEqual({ row: ['chat', { column: ['diff', 'tasks'] }] })
    const column = two.root.children[1] as PaneGroup
    expect(column.weight).toBe(3)
    expect(column.children.map(c => c.weight)).toEqual([1, 1])
    const three = placePane(two, 'plan', { weight: 1 })
    expect(shape(three)).toEqual({ row: ['chat', { column: ['diff', 'tasks', 'plan'] }] })
    expect(panesIn(three)).toEqual(['diff', 'tasks', 'plan'])
  })

  it('a remembered slot wins when its group still exists, with the index clamped', () => {
    const base = placePane(placePane(defaultPaneLayout(), 'diff', { weight: 3 }), 'tasks', { weight: 1 })
    const column = base.root.children[1] as PaneGroup
    const placed = placePane(base, 'plan', {
      weight: 1,
      slot: { groupId: column.id, index: 99, axis: 'column', weight: 2 },
    })
    expect(shape(placed)).toEqual({ row: ['chat', { column: ['diff', 'tasks', 'plan'] }] })
    expect(findSlot(placed, 'plan')?.weight).toBe(2)
    const first = placePane(base, 'plan', {
      weight: 1,
      slot: { groupId: column.id, index: 0, axis: 'column', weight: 1 },
    })
    expect(shape(first)).toEqual({ row: ['chat', { column: ['plan', 'diff', 'tasks'] }] })
  })

  it('a slot whose group is gone falls back to the default place', () => {
    const layout = placePane(defaultPaneLayout(), 'diff', {
      weight: 3,
      slot: { groupId: 'g7', index: 0, axis: 'column', weight: 1 },
    })
    expect(shape(layout)).toEqual({ row: ['chat', 'diff'] })
  })

  it('a pane already in the tree leaves it unchanged (same reference)', () => {
    const layout = placePane(defaultPaneLayout(), 'diff', { weight: 3 })
    expect(placePane(layout, 'diff', { weight: 1 })).toBe(layout)
  })
})

describe('removePane', () => {
  it('returns the slot and collapses the column it leaves', () => {
    const two = placePane(placePane(defaultPaneLayout(), 'diff', { weight: 3 }), 'tasks', { weight: 1 })
    const { layout, slot } = removePane(two, 'tasks')
    expect(slot).toEqual({ groupId: 'g1', index: 1, axis: 'column', weight: 1 })
    expect(shape(layout)).toEqual({ row: ['chat', 'diff'] })
    // The survivor takes the column's width back.
    expect(findSlot(layout, 'diff')?.weight).toBe(3)
  })

  it('the last pane gone leaves the chat alone; an absent pane is a no-op', () => {
    const one = placePane(defaultPaneLayout(), 'diff', { weight: 3 })
    expect(shape(removePane(one, 'diff').layout)).toEqual({ row: ['chat'] })
    const absent = removePane(one, 'plan')
    expect(absent.layout).toBe(one)
    expect(absent.slot).toBeNull()
  })
})

describe('normalise', () => {
  it('flattens same-axis nesting, drops repeats and ensures the chat', () => {
    const messy: PaneLayout = {
      root: {
        id: 'root',
        axis: 'row',
        weight: 1,
        children: [
          { id: 'g1', axis: 'row', weight: 4, children: [leaf('diff', 1), leaf('tasks', 3)] },
          leaf('diff', 2),
        ],
      },
    }
    const clean = normalise(messy)
    expect(shape(clean)).toEqual({ row: ['chat', 'diff', 'tasks'] })
    expect(clean.root.children.map(c => c.weight)).toEqual([CHAT_WEIGHT, 1, 3])
  })

  it('collapses a single-child group onto its child and is identity on a clean tree', () => {
    const nested: PaneLayout = {
      root: {
        id: 'root',
        axis: 'row',
        weight: 1,
        children: [leaf('chat', 2), { id: 'g1', axis: 'column', weight: 3, children: [leaf('diff', 1)] }],
      },
    }
    const clean = normalise(nested)
    expect(shape(clean)).toEqual({ row: ['chat', 'diff'] })
    expect(findSlot(clean, 'diff')?.weight).toBe(3)
    expect(normalise(clean)).toBe(clean)
  })
})

describe('paneWeightFor', () => {
  it('remembered first, else wide 3 or narrow 1', () => {
    expect(paneWeightFor('diff', {})).toBe(3)
    expect(paneWeightFor('browser', {})).toBe(3)
    expect(paneWeightFor('files', {})).toBe(3)
    expect(paneWeightFor('tasks', {})).toBe(1)
    expect(paneWeightFor('diff', { diff: 1.5 })).toBe(1.5)
    expect(paneWeightFor('diff', { diff: 0 })).toBe(3)
  })
})

describe('the session record', () => {
  it('open places at the remembered slot and forgets it; close remembers it', () => {
    let record = defaultSessionPaneRecord()
    record = openPane(record, 'diff', {})
    record = openPane(record, 'tasks', {})
    expect(panesIn(record.layout)).toEqual(['diff', 'tasks'])
    record = closePane(record, 'diff')
    expect(record.closedSlots.diff).toEqual({ groupId: 'g1', index: 0, axis: 'column', weight: 1 })
    expect(shape(record.layout)).toEqual({ row: ['chat', 'tasks'] })
    // The column is gone, so Diff reopens by the default rule: below Tasks.
    record = openPane(record, 'diff', {})
    expect(shape(record.layout)).toEqual({ row: ['chat', { column: ['tasks', 'diff'] }] })
    expect(record.closedSlots.diff).toBeUndefined()
  })

  it('open and close are no-ops (same reference) when nothing changes', () => {
    const record = openPane(defaultSessionPaneRecord(), 'diff', {})
    expect(openPane(record, 'diff', {})).toBe(record)
    expect(closePane(record, 'tasks')).toBe(record)
  })

  it('expanding needs the pane present; closing the expanded pane restores', () => {
    const record = openPane(defaultSessionPaneRecord(), 'diff', {})
    expect(setMaximized(record, 'tasks').maximized).toBeNull()
    const expanded = setMaximized(record, 'diff')
    expect(expanded.maximized).toBe('diff')
    expect(setMaximized(expanded, 'diff')).toBe(expanded)
    expect(closePane(expanded, 'diff').maximized).toBeNull()
  })

  it('reset returns to the default arrangement and keeps the Files strip', () => {
    let record = openPane(defaultSessionPaneRecord(), 'files', {})
    record = { ...record, files: { tabs: ['/a.ts'], active: '/a.ts' } }
    record = setMaximized(record, 'files')
    const reset = resetPaneLayout(record)
    expect(shape(reset.layout)).toEqual({ row: ['chat'] })
    expect(reset.maximized).toBeNull()
    expect(reset.closedSlots).toEqual({})
    expect(reset.files).toEqual({ tabs: ['/a.ts'], active: '/a.ts' })
    expect(resetPaneLayout(reset)).toBe(reset)
  })

  it('prunes the browser pane while the session owns no tab, keeping its slot', () => {
    const record = setMaximized(openPane(defaultSessionPaneRecord(), 'browser', {}), 'browser')
    const pruned = pruneUnrestorable(record, { browserTabs: 0 })
    expect(hasPane(pruned.layout, 'browser')).toBe(false)
    expect(pruned.closedSlots.browser).toEqual({ groupId: 'root', index: 1, axis: 'row', weight: 3 })
    expect(pruned.maximized).toBeNull()
    expect(pruneUnrestorable(record, { browserTabs: 1 })).toBe(record)
  })
})

describe('paneToggleAction', () => {
  it('opens a closed pane, closes an open one, shows a hidden overlay, moves an expansion', () => {
    const record = openPane(openPane(defaultSessionPaneRecord(), 'diff', {}), 'tasks', {})
    expect(paneToggleAction(record, 'plan', false)).toBe('open')
    expect(paneToggleAction(record, 'diff', false)).toBe('close')
    expect(paneToggleAction(record, 'diff', true)).toBe('show-overlay')
    const expanded = setMaximized(record, 'tasks')
    expect(paneToggleAction(expanded, 'diff', false)).toBe('move-expansion')
    expect(paneToggleAction(expanded, 'tasks', false)).toBe('close')
  })

  it('decides against the drawn record: a pruned browser pane leaves no expansion behind', () => {
    const stored = setMaximized(openPane(openPane(defaultSessionPaneRecord(), 'tasks', {}), 'browser', {}), 'browser')
    expect(paneToggleAction(stored, 'tasks', false)).toBe('move-expansion')
    const drawn = pruneUnrestorable(stored, { browserTabs: 0 })
    expect(drawn.maximized).toBeNull()
    expect(paneToggleAction(drawn, 'tasks', false)).toBe('close')
  })
})

describe('browserToggleAction', () => {
  it('with no pane and no tab it creates a tab; with a tab it opens; open, it closes like any pane', () => {
    const closed = defaultSessionPaneRecord()
    expect(browserToggleAction(closed, false, { browserTabs: 0 })).toBe('new-tab')
    expect(browserToggleAction(closed, false, { browserTabs: 2 })).toBe('open')
    const open = openPane(closed, 'browser', {})
    expect(browserToggleAction(open, false, { browserTabs: 1 })).toBe('close')
    expect(browserToggleAction(open, true, { browserTabs: 1 })).toBe('show-overlay')
    const expandedOther = setMaximized(openPane(open, 'tasks', {}), 'tasks')
    expect(browserToggleAction(expandedOther, false, { browserTabs: 1 })).toBe('move-expansion')
  })
})

describe('followBrowserTabs', () => {
  const chatOnly = defaultSessionPaneRecord()

  it('the first tab places the browser pane at its default (wide) weight', () => {
    const placed = followBrowserTabs(chatOnly, { prevTabs: 0, nextTabs: 1, dismissedAt: null }, {})
    expect(shape(placed.layout)).toEqual({ row: ['chat', 'browser'] })
    expect(findSlot(placed.layout, 'browser')?.weight).toBe(3)
  })

  it('a pane closed at a count stays closed for that count and returns on another, in its slot', () => {
    const withTasks = openPane(chatOnly, 'tasks', {})
    const open = followBrowserTabs(withTasks, { prevTabs: 0, nextTabs: 1, dismissedAt: null }, {})
    expect(shape(open.layout)).toEqual({ row: ['chat', { column: ['tasks', 'browser'] }] })
    const closed = closePane(open, 'browser')
    // Another event at the dismissed count (the stale state replayed): nothing.
    expect(followBrowserTabs(closed, { prevTabs: 0, nextTabs: 1, dismissedAt: 1 }, {})).toBe(closed)
    // New tab activity: the pane returns where it sat.
    const back = followBrowserTabs(closed, { prevTabs: 1, nextTabs: 2, dismissedAt: 1 }, {})
    expect(shape(back.layout)).toEqual({ row: ['chat', { column: ['tasks', 'browser'] }] })
    expect(back.closedSlots.browser).toBeUndefined()
  })

  it('a count of zero, an unchanged count, or a pane already open change nothing (same reference)', () => {
    const open = openPane(chatOnly, 'browser', {})
    expect(followBrowserTabs(open, { prevTabs: 1, nextTabs: 2, dismissedAt: null }, {})).toBe(open)
    expect(followBrowserTabs(chatOnly, { prevTabs: 1, nextTabs: 0, dismissedAt: null }, {})).toBe(chatOnly)
    expect(followBrowserTabs(chatOnly, { prevTabs: 2, nextTabs: 2, dismissedAt: null }, {})).toBe(chatOnly)
  })

  it('round trip: 0→1 places, the prune hides at 0 keeping the slot, 0→1 places again in that slot', () => {
    const placed = followBrowserTabs(openPane(chatOnly, 'diff', {}), { prevTabs: 0, nextTabs: 1, dismissedAt: null }, {})
    const slot = findSlot(placed.layout, 'browser')
    const gone = pruneUnrestorable(placed, { browserTabs: 0 })
    expect(hasPane(gone.layout, 'browser')).toBe(false)
    expect(gone.closedSlots.browser).toEqual(slot)
    const again = followBrowserTabs(gone, { prevTabs: 0, nextTabs: 1, dismissedAt: null }, {})
    expect(findSlot(again.layout, 'browser')).toEqual(slot)
  })
})

describe('movePane', () => {
  const chatColumn = () =>
    placePane(placePane(defaultPaneLayout(), 'diff', { weight: 3 }), 'tasks', { weight: 1 })
  const threeStacked = () => placePane(chatColumn(), 'plan', { weight: 1 })
  const threeInRow = (): PaneLayout => ({
    root: { id: 'root', axis: 'row', weight: 1, children: [leaf('chat', 2), leaf('diff', 3), leaf('tasks', 1)] },
  })
  const weightsOf = (layout: PaneLayout, groupId: string) => {
    const walk = (node: PaneGroup['children'][number]): PaneGroup | null => {
      if (!isPaneGroup(node)) return null
      if (node.id === groupId) return node
      for (const child of node.children) {
        const found = walk(child)
        if (found) return found
      }
      return null
    }
    return walk(layout.root)!.children.map(child => child.weight)
  }

  it('insert reorders within a group at the mean weight; the moved pane takes the index as the group was', () => {
    const up = movePane(chatColumn(), 'tasks', { type: 'insert', groupId: 'g1', index: 0 })
    expect(shape(up)).toEqual({ row: ['chat', { column: ['tasks', 'diff'] }] })
    expect(weightsOf(up, 'g1')).toEqual([1, 1])
    const out = movePane(chatColumn(), 'tasks', { type: 'insert', groupId: 'root', index: 1 })
    // The column it leaves collapses onto Diff, which keeps the column's weight.
    expect(shape(out)).toEqual({ row: ['chat', 'tasks', 'diff'] })
    expect(weightsOf(out, 'root')).toEqual([2, 2.5, 3])
    const after = movePane(chatColumn(), 'tasks', { type: 'insert', groupId: 'root', index: 2 })
    expect(shape(after)).toEqual({ row: ['chat', 'diff', 'tasks'] })
    expect(weightsOf(after, 'root')).toEqual([2, 3, 2.5])
  })

  it('insert at either gutter beside its own slot is a no-op (same reference)', () => {
    const layout = chatColumn()
    expect(movePane(layout, 'tasks', { type: 'insert', groupId: 'g1', index: 1 })).toBe(layout)
    expect(movePane(layout, 'tasks', { type: 'insert', groupId: 'g1', index: 2 })).toBe(layout)
    expect(movePane(layout, 'diff', { type: 'insert', groupId: 'g1', index: 0 })).toBe(layout)
    const row = threeInRow()
    expect(movePane(row, 'diff', { type: 'insert', groupId: 'root', index: 2 })).toBe(row)
    expect(movePane(row, 'tasks', { type: 'insert', groupId: 'root', index: 3 })).toBe(row)
  })

  it('wrap beside a pane makes a row (left / right) or a column (top / bottom) of the two, halving its weight', () => {
    const left = movePane(threeStacked(), 'plan', { type: 'wrap', pane: 'diff', side: 'left' })
    expect(shape(left)).toEqual({ row: ['chat', { column: [{ row: ['plan', 'diff'] }, 'tasks'] }] })
    const column = left.root.children[1] as PaneGroup
    const pair = column.children[0] as PaneGroup
    expect(pair.weight).toBe(1)
    expect(pair.children.map(c => c.weight)).toEqual([1, 1])
    expect(column.children[1].weight).toBe(1)
    const right = movePane(threeStacked(), 'plan', { type: 'wrap', pane: 'tasks', side: 'right' })
    expect(shape(right)).toEqual({ row: ['chat', { column: ['diff', { row: ['tasks', 'plan'] }] }] })
    // Along the column's own axis the pair flattens into it, 1:1 of the target's weight.
    const top = movePane(threeStacked(), 'plan', { type: 'wrap', pane: 'tasks', side: 'top' })
    expect(shape(top)).toEqual({ row: ['chat', { column: ['diff', 'plan', 'tasks'] }] })
    expect(weightsOf(top, 'g1')).toEqual([1, 0.5, 0.5])
    const bottom = movePane(threeStacked(), 'plan', { type: 'wrap', pane: 'diff', side: 'bottom' })
    expect(shape(bottom)).toEqual({ row: ['chat', { column: ['diff', 'plan', 'tasks'] }] })
    expect(weightsOf(bottom, 'g1')).toEqual([0.5, 0.5, 1])
    const inRow = movePane(threeInRow(), 'tasks', { type: 'wrap', pane: 'diff', side: 'left' })
    expect(shape(inRow)).toEqual({ row: ['chat', 'tasks', 'diff'] })
    expect(weightsOf(inRow, 'root')).toEqual([2, 1.5, 1.5])
  })

  it('wrap onto the last sibling of the group it leaves keeps that group', () => {
    const moved = movePane(chatColumn(), 'tasks', { type: 'wrap', pane: 'diff', side: 'top' })
    expect(shape(moved)).toEqual({ row: ['chat', { column: ['tasks', 'diff'] }] })
    const column = moved.root.children[1] as PaneGroup
    expect(column.id).toBe('g1')
    expect(column.weight).toBe(3)
    const same = chatColumn()
    expect(movePane(same, 'tasks', { type: 'wrap', pane: 'tasks', side: 'top' })).toBe(same)
  })

  it("split puts the pane at a group's outer edge, in a group of the perpendicular axis", () => {
    const left = movePane(threeStacked(), 'plan', { type: 'split', groupId: 'g1', side: 'left' })
    expect(shape(left)).toEqual({ row: ['chat', 'plan', { column: ['diff', 'tasks'] }] })
    expect(weightsOf(left, 'root')).toEqual([2, 1.5, 1.5])
    const top = movePane(threeStacked(), 'plan', { type: 'split', groupId: 'g1', side: 'top' })
    expect(shape(top)).toEqual({ row: ['chat', { column: ['plan', 'diff', 'tasks'] }] })
    // The group that wrapped the column is the column now (the old one flattened into it).
    expect((top.root.children[1] as PaneGroup).children.map(c => c.weight)).toEqual([1, 0.5, 0.5])
    const layout = threeStacked()
    expect(movePane(layout, 'plan', { type: 'split', groupId: 'root', side: 'left' })).toBe(layout)
    expect(movePane(layout, 'plan', { type: 'split', groupId: 'g9', side: 'left' })).toBe(layout)
  })

  it("edge puts the pane first or last in the root row at the kind's weight; a pane can sit left of the chat", () => {
    const start = movePane(chatColumn(), 'tasks', { type: 'edge', side: 'start' }, { tasks: 1.5 })
    expect(shape(start)).toEqual({ row: ['tasks', 'chat', 'diff'] })
    expect(weightsOf(start, 'root')).toEqual([1.5, 2, 3])
    expect(findSlot(start, 'chat')).toEqual({ groupId: 'root', index: 1, axis: 'row', weight: 2 })
    const end = movePane(chatColumn(), 'tasks', { type: 'edge', side: 'end' })
    expect(shape(end)).toEqual({ row: ['chat', 'diff', 'tasks'] })
    expect(weightsOf(end, 'root')).toEqual([2, 3, 1])
    expect(movePane(end, 'tasks', { type: 'edge', side: 'end' })).toBe(end)
    expect(movePane(start, 'tasks', { type: 'edge', side: 'start' })).toBe(start)
    const back = movePane(start, 'tasks', { type: 'edge', side: 'end' })
    expect(shape(back)).toEqual({ row: ['chat', 'diff', 'tasks'] })
  })

  it('an absent pane or a target that is gone leaves the layout (same reference)', () => {
    const layout = chatColumn()
    expect(movePane(layout, 'plan', { type: 'edge', side: 'end' })).toBe(layout)
    expect(movePane(layout, 'tasks', { type: 'insert', groupId: 'g7', index: 0 })).toBe(layout)
    expect(movePane(layout, 'tasks', { type: 'wrap', pane: 'plan', side: 'left' })).toBe(layout)
  })

  it('the result is normalised: no single-child group, no same-axis nesting, each pane once', () => {
    const moved = movePane(threeStacked(), 'diff', { type: 'edge', side: 'end' })
    expect(shape(moved)).toEqual({ row: ['chat', { column: ['tasks', 'plan'] }, 'diff'] })
    expect(panesIn(moved)).toEqual(['tasks', 'plan', 'diff'])
    expect(normalise(moved)).toBe(moved)
    const wrapped = movePane(moved, 'diff', { type: 'wrap', pane: 'plan', side: 'bottom' })
    expect(shape(wrapped)).toEqual({ row: ['chat', { column: ['tasks', 'plan', 'diff'] }] })
    expect(normalise(wrapped)).toBe(wrapped)
  })
})
