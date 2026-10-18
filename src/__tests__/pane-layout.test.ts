/**
 * The pane tree (F-9): default placement beside the chat, later panes stacked
 * below the right-most root child, a closed pane's slot remembered and reused,
 * normalisation, and the per-session record ops. Same reference on no-ops.
 */
import { describe, expect, it } from 'vitest'

import {
  CHAT_WEIGHT,
  closePane,
  defaultPaneLayout,
  defaultSessionPaneRecord,
  findSlot,
  hasPane,
  isPaneGroup,
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
