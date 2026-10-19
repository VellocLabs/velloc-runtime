/**
 * Security (F-9): the layout blob comes from localStorage and is never
 * trusted. Each field sanitizes on its own, every tree is rebuilt node by
 * node, bad weights become 1, slots whose group is gone are dropped, and
 * records past the cap go least recently used first.
 */
import { describe, expect, it } from 'vitest'

import {
  defaultLayoutStorage,
  sanitizeLayoutStorage,
  sanitizeModPanesAsked,
  sanitizePaneLayout,
  sanitizePaneWeightByKind,
  sanitizeSessionPaneRecord,
  sanitizeSessionRecords,
  SESSION_RECORD_CAP,
} from '@/browser/webview/layout/layoutSanitize'
import { defaultPaneLayout, panesIn, placePane } from '@/browser/webview/layout/paneLayout'

describe('sanitizeLayoutStorage', () => {
  it('a non-object, or a blob of the retired shape, is the defaults', () => {
    expect(sanitizeLayoutStorage(null)).toEqual(defaultLayoutStorage())
    expect(sanitizeLayoutStorage('garbage')).toEqual(defaultLayoutStorage())
    expect(sanitizeLayoutStorage({ version: 1, rightPanel: { shares: { diff: 0.5 } } })).toEqual(defaultLayoutStorage())
  })

  it('a bad field is its default and the rest is kept', () => {
    const out = sanitizeLayoutStorage({
      paneWeightByKind: 'nope',
      sessions: { s1: { layout: placePane(defaultPaneLayout(), 'diff', { weight: 3 }), usedAt: 5 } },
      sessionCards: { hidden: ['changes'] },
    })
    expect(out.paneWeightByKind).toEqual({})
    expect(panesIn(out.sessions.s1.layout)).toEqual(['diff'])
    expect(out.sessionCards.hidden).toEqual(['changes'])
  })
})

describe('sanitizeModPanesAsked', () => {
  it('keeps well-formed pane keys once each, the newest last; anything else is dropped', () => {
    const a = 'p\u0000a'
    const b = 'p\u0000b'
    expect(sanitizeModPanesAsked([a, 'no-separator', 7, b, a])).toEqual([b, a])
    expect(sanitizeModPanesAsked('x')).toEqual([])
    expect(sanitizeLayoutStorage({ modPanesAsked: [a] }).modPanesAsked).toEqual([a])
  })
})

describe('Files pane docked tree prefs', () => {
  it('are off and 260 px by default; a stored width is clamped, a bad one is the default', () => {
    expect(defaultLayoutStorage()).toMatchObject({ filesTreeVisible: false, filesTreeWidth: 260 })
    expect(sanitizeLayoutStorage({})).toMatchObject({ filesTreeVisible: false, filesTreeWidth: 260 })
    expect(sanitizeLayoutStorage({ filesTreeVisible: true, filesTreeWidth: 300.4 })).toMatchObject({
      filesTreeVisible: true,
      filesTreeWidth: 300,
    })
    expect(sanitizeLayoutStorage({ filesTreeVisible: 'yes', filesTreeWidth: 40 })).toMatchObject({
      filesTreeVisible: false,
      filesTreeWidth: 180,
    })
    expect(sanitizeLayoutStorage({ filesTreeWidth: 1e6 }).filesTreeWidth).toBe(800)
    expect(sanitizeLayoutStorage({ filesTreeWidth: Number.NaN }).filesTreeWidth).toBe(260)
    expect(sanitizeLayoutStorage({ filesTreeWidth: '300' }).filesTreeWidth).toBe(260)
  })
})

describe('sanitizePaneWeightByKind', () => {
  it('keeps finite positive weights of known kinds, clamped', () => {
    expect(sanitizePaneWeightByKind({ diff: 2.5, tasks: -1, plan: Number.NaN, mod: 1, browser: 1e9, files: 0 })).toEqual({
      diff: 2.5,
      browser: 50,
    })
  })
})

describe('sanitizePaneLayout', () => {
  it('rebuilds node by node: unknown panes dropped, bad weights 1, repeats dropped, chat ensured', () => {
    const layout = sanitizePaneLayout({
      root: {
        id: 'root',
        axis: 'row',
        children: [
          { pane: 'diff', weight: 'wide' },
          { id: 'g1', axis: 'column', weight: 2, children: [{ pane: 'mod:x' }, { pane: 'tasks', weight: -3 }, { pane: 'diff', weight: 1 }] },
          'junk',
        ],
      },
    })
    expect(panesIn(layout)).toEqual(['diff', 'tasks'])
    expect(layout.root.children[0]).toEqual({ pane: 'chat', weight: 2 })
    expect(layout.root.children[1]).toEqual({ pane: 'diff', weight: 1 })
    // The column collapsed onto Tasks (its only survivor), carrying the column's weight.
    expect(layout.root.children[2]).toEqual({ pane: 'tasks', weight: 2 })
  })

  it('anything unusable is the default tree', () => {
    expect(sanitizePaneLayout(null)).toEqual(defaultPaneLayout())
    expect(sanitizePaneLayout({ root: { axis: 'column' } })).toEqual(defaultPaneLayout())
    expect(sanitizePaneLayout({ root: { children: [] } })).toEqual(defaultPaneLayout())
  })

  it('repeated or missing group ids are reassigned', () => {
    const layout = sanitizePaneLayout({
      root: {
        children: [
          { pane: 'chat', weight: 2 },
          { id: 'root', axis: 'column', weight: 1, children: [{ pane: 'diff', weight: 1 }, { pane: 'tasks', weight: 1 }] },
          { axis: 'column', weight: 1, children: [{ pane: 'plan', weight: 1 }, { pane: 'skill', weight: 1 }] },
        ],
      },
    })
    const ids = layout.root.children.filter(c => 'children' in c).map(c => (c as { id: string }).id)
    expect(ids).toEqual(['g1', 'g2'])
  })
})

describe('sanitizeSessionPaneRecord', () => {
  it('keeps maximized only for a present pane and slots only for existing groups', () => {
    const stored = placePane(placePane(defaultPaneLayout(), 'diff', { weight: 3 }), 'tasks', { weight: 1 })
    const record = sanitizeSessionPaneRecord({
      layout: stored,
      maximized: 'plan',
      closedSlots: {
        plan: { groupId: 'g1', index: 7, axis: 'column', weight: 2 },
        skill: { groupId: 'g9', index: 0, axis: 'row', weight: 1 },
        diff: { groupId: 'root', index: 1, axis: 'row', weight: 3 },
        bogus: { groupId: 'root', index: 0, axis: 'row', weight: 1 },
      },
      files: { tabs: ['/a.ts'], active: '/a.ts' },
      usedAt: 'yesterday',
    })
    expect(record.maximized).toBeNull()
    expect(Object.keys(record.closedSlots)).toEqual(['plan'])
    expect(record.closedSlots.plan).toEqual({ groupId: 'g1', index: 7, axis: 'column', weight: 2 })
    expect(record.files).toEqual({ tabs: ['/a.ts'], active: '/a.ts' })
    expect(record.usedAt).toBe(0)
  })

  it('an empty record is the default record', () => {
    const record = sanitizeSessionPaneRecord({})
    expect(record.layout).toEqual(defaultPaneLayout())
    expect(record).not.toHaveProperty('files')
  })
})

describe('sanitizeSessionRecords', () => {
  it('drops the least recently used past the cap', () => {
    const raw: Record<string, unknown> = {}
    for (let i = 0; i < SESSION_RECORD_CAP + 5; i++) raw[`s${i}`] = { usedAt: i }
    const out = sanitizeSessionRecords(raw)
    expect(Object.keys(out)).toHaveLength(SESSION_RECORD_CAP)
    expect(out.s0).toBeUndefined()
    expect(out.s4).toBeUndefined()
    expect(out.s5).toBeDefined()
    expect(out[`s${SESSION_RECORD_CAP + 4}`]).toBeDefined()
  })

  it('ignores non-object entries and arrays', () => {
    expect(sanitizeSessionRecords([{ usedAt: 1 }])).toEqual({})
    expect(Object.keys(sanitizeSessionRecords({ a: 'x', b: { usedAt: 1 }, '': { usedAt: 2 } }))).toEqual(['b'])
  })
})
