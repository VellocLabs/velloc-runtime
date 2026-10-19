/**
 * The Files pane's strip (F-9): the tab cap evicts the oldest evictable tab,
 * never the active or a protected one; closing focuses a neighbour; the
 * mounted-body LRU keeps visible and protected bodies; the bulk closes never
 * close a protected tab.
 */
import { describe, expect, it } from 'vitest'

import {
  activateFileTab,
  closeAllTabs,
  closeFileTab,
  closeOtherTabs,
  closeTabsAfter,
  emptyFilesPane,
  FILES_PANE_MAX_MOUNTED,
  FILES_PANE_MAX_TABS,
  openFileTab,
  reconcileMountedFiles,
  sanitizeFilesPane,
} from '@/browser/webview/layout/filesPane'

const paths = (n: number) => Array.from({ length: n }, (_, i) => `/f${i}.ts`)

describe('openFileTab', () => {
  it('adds a new tab in front, refocuses an existing one, and is a no-op when already in front', () => {
    let state = openFileTab(emptyFilesPane(), '/a.ts')
    state = openFileTab(state, '/b.ts')
    expect(state).toEqual({ tabs: ['/a.ts', '/b.ts'], active: '/b.ts' })
    const again = openFileTab(state, '/a.ts')
    expect(again).toEqual({ tabs: ['/a.ts', '/b.ts'], active: '/a.ts' })
    expect(openFileTab(again, '/a.ts')).toBe(again)
  })

  it('past the cap the oldest tab goes, never the active or a protected one', () => {
    let state = emptyFilesPane()
    for (const path of paths(FILES_PANE_MAX_TABS)) state = openFileTab(state, path)
    const over = openFileTab(state, '/new.ts', { protectedPaths: new Set(['/f0.ts']) })
    expect(over.tabs).toHaveLength(FILES_PANE_MAX_TABS)
    expect(over.tabs).toContain('/f0.ts')
    expect(over.tabs).not.toContain('/f1.ts')
    expect(over.active).toBe('/new.ts')
  })
})

describe('closeFileTab / activateFileTab', () => {
  it('closing the active tab focuses the one before it, else the one after', () => {
    const state = { tabs: ['/a.ts', '/b.ts', '/c.ts'], active: '/b.ts' }
    expect(closeFileTab(state, '/b.ts')).toEqual({ tabs: ['/a.ts', '/c.ts'], active: '/a.ts' })
    expect(closeFileTab({ ...state, active: '/a.ts' }, '/a.ts')).toEqual({ tabs: ['/b.ts', '/c.ts'], active: '/b.ts' })
    expect(closeFileTab(state, '/c.ts').active).toBe('/b.ts')
    expect(closeFileTab(state, '/zz.ts')).toBe(state)
  })

  it('activate needs an open tab and is a no-op on the active one', () => {
    const state = { tabs: ['/a.ts', '/b.ts'], active: '/a.ts' }
    expect(activateFileTab(state, '/b.ts').active).toBe('/b.ts')
    expect(activateFileTab(state, '/a.ts')).toBe(state)
    expect(activateFileTab(state, '/zz.ts')).toBe(state)
  })
})

describe('bulk closes', () => {
  const strip = { tabs: ['/a', '/b', '/c', '/d'], active: '/b' }
  const dirty = new Set(['/d'])

  it('close others keeps the target in front and every protected tab', () => {
    expect(closeOtherTabs(strip, '/c')).toEqual({ tabs: ['/c'], active: '/c' })
    expect(closeOtherTabs(strip, '/c', dirty)).toEqual({ tabs: ['/c', '/d'], active: '/c' })
    expect(closeOtherTabs(strip, '/zz')).toBe(strip)
  })

  it('close to the right keeps the active tab when it survives, else the target', () => {
    expect(closeTabsAfter(strip, '/b')).toEqual({ tabs: ['/a', '/b'], active: '/b' })
    expect(closeTabsAfter(strip, '/a', dirty)).toEqual({ tabs: ['/a', '/d'], active: '/a' })
    expect(closeTabsAfter(strip, '/d')).toBe(strip)
  })

  it('close all leaves only protected tabs, the first survivor in front', () => {
    expect(closeAllTabs(strip)).toEqual({ tabs: [], active: null })
    expect(closeAllTabs(strip, new Set(['/c', '/a']))).toEqual({ tabs: ['/a', '/c'], active: '/a' })
    expect(closeAllTabs({ tabs: ['/a', '/b'], active: '/b' }, new Set(['/b']))).toEqual({
      tabs: ['/b'],
      active: '/b',
    })
  })
})

describe('reconcileMountedFiles', () => {
  it('keeps the visible and protected bodies and releases past the cap', () => {
    const open = paths(8)
    const previous = open.slice(0, 6)
    const kept = reconcileMountedFiles({
      previous,
      visible: ['/f7.ts'],
      openTabs: open,
      protectedPaths: new Set(['/f5.ts']),
    })
    expect(kept[0]).toBe('/f7.ts')
    expect(kept).toContain('/f5.ts')
    expect(kept).toHaveLength(FILES_PANE_MAX_MOUNTED + 1)
  })

  it('a closed tab leaves the mounted set', () => {
    expect(reconcileMountedFiles({ previous: ['/a.ts', '/b.ts'], visible: [], openTabs: ['/a.ts'] })).toEqual(['/a.ts'])
  })
})

describe('sanitizeFilesPane', () => {
  it('keeps only non-empty, unrepeated paths and an active path among them', () => {
    expect(sanitizeFilesPane({ tabs: ['/a.ts', '', 7, '/a.ts', '/b.ts'], active: '/b.ts' })).toEqual({
      tabs: ['/a.ts', '/b.ts'],
      active: '/b.ts',
    })
    expect(sanitizeFilesPane({ tabs: ['/a.ts'], active: '/zz.ts' })?.active).toBeNull()
    expect(sanitizeFilesPane({ tabs: [] })).toBeUndefined()
    expect(sanitizeFilesPane('nope')).toBeUndefined()
    expect(sanitizeFilesPane({ tabs: paths(40) })?.tabs).toHaveLength(FILES_PANE_MAX_TABS)
  })
})
