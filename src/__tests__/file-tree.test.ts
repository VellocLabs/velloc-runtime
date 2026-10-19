/**
 * The Files pane's tree model (F-9 browse state): rows come out depth-first in
 * listing order with a status row for each folder not yet readable; toggling
 * and revealing expand the right folders; tree keys move focus with tree
 * semantics; the filter keeps matches and the folders above them.
 */
import { describe, expect, it } from 'vitest'

import {
  applyListing,
  childPath,
  emptyFileTree,
  filterTree,
  flattenTree,
  markListing,
  moveFocus,
  pendingListings,
  retryListing,
  revealPath,
  rowKey,
  toggleDir,
  withRoots,
  type FileTreeState,
  type FolderListing,
} from '@/browser/webview/layout/fileTree'

const file = (name: string) => ({ name, isFile: true, isDirectory: false, isSymbolicLink: false })
const dir = (name: string) => ({ name, isFile: false, isDirectory: true, isSymbolicLink: false })
const link = (name: string) => ({ name, isFile: false, isDirectory: false, isSymbolicLink: true })
const listing = (...entries: FolderListing['entries']): FolderListing => ({ entries, truncated: false })

/** /repo holding src/ (listed: a.ts, lib/) and README.md, with src expanded. */
function sample(): FileTreeState {
  let state = emptyFileTree(['/repo'])
  state = applyListing(state, '/repo', listing(dir('src'), file('README.md')))
  state = toggleDir(state, '/repo/src')
  state = applyListing(state, '/repo/src', listing(dir('lib'), file('a.ts'), link('current')))
  return state
}

const keys = (state: FileTreeState) => flattenTree(state).map(rowKey)

describe('flattenTree', () => {
  it('lists each root, then expanded folders depth-first in listing order', () => {
    expect(keys(sample())).toEqual([
      '/repo',
      '/repo/src',
      '/repo/src/lib',
      '/repo/src/a.ts',
      '/repo/src/current',
      '/repo/README.md',
    ])
    const rows = flattenTree(sample())
    expect(rows.map(row => row.depth)).toEqual([0, 1, 2, 2, 2, 1])
    expect(rows[4]).toMatchObject({ kind: 'link', name: 'current' })
  })

  it('shows a listing row under a folder not yet listed, then its error, empty and capped states', () => {
    let state = emptyFileTree(['/repo'])
    expect(keys(state)).toEqual(['/repo', 'loading:/repo'])
    state = applyListing(state, '/repo', null)
    expect(keys(state)).toEqual(['/repo', 'error:/repo'])
    state = applyListing(state, '/repo', listing())
    expect(keys(state)).toEqual(['/repo', 'empty:/repo'])
    state = applyListing(state, '/repo', { entries: [file('a')], truncated: true })
    expect(keys(state)).toEqual(['/repo', '/repo/a', 'more:/repo'])
  })

  it('joins child paths in the separator the root uses', () => {
    expect(childPath('D:\\repo', 'src')).toBe('D:\\repo\\src')
    expect(childPath('D:/repo', 'src')).toBe('D:/repo/src')
    expect(childPath('C:\\', 'x')).toBe('C:\\x')
    expect(childPath('/', 'x')).toBe('/x')
  })
})

describe('toggleDir and listing', () => {
  it('collapses and re-expands a folder without forgetting its listing', () => {
    const collapsed = toggleDir(sample(), '/repo/src')
    expect(keys(collapsed)).toEqual(['/repo', '/repo/src', '/repo/README.md'])
    expect(keys(toggleDir(collapsed, '/repo/src'))).toEqual(keys(sample()))
  })

  it('reports expanded folders with no listing in flight, and none once marked', () => {
    const state = toggleDir(sample(), '/repo/src/lib')
    expect(pendingListings(state)).toEqual(['/repo/src/lib'])
    expect(pendingListings(markListing(state, '/repo/src/lib'))).toEqual([])
    // A folder hidden under a collapsed parent is not listed.
    expect(pendingListings(toggleDir(state, '/repo/src'))).toEqual([])
  })

  it('retry forgets a failure so the folder is listed again', () => {
    const failed = applyListing(emptyFileTree(['/repo']), '/repo', null)
    expect(pendingListings(failed)).toEqual([])
    expect(pendingListings(retryListing(failed, '/repo'))).toEqual(['/repo'])
  })

  it('a new root comes in expanded; known roots keep their state', () => {
    const state = toggleDir(sample(), '/repo')
    const next = withRoots(state, ['/repo', '/other'])
    expect(next.expanded.has('/repo')).toBe(false)
    expect(next.expanded.has('/other')).toBe(true)
    expect(withRoots(next, ['/repo', '/other'])).toBe(next)
  })
})

describe('revealPath', () => {
  it('expands the ancestors and reports the ones not yet listed', () => {
    const state = toggleDir(sample(), '/repo/src')
    const { state: revealed, needsLoad } = revealPath(state, '/repo/src/lib/deep/x.ts')
    expect([...revealed.expanded]).toEqual(
      expect.arrayContaining(['/repo', '/repo/src', '/repo/src/lib', '/repo/src/lib/deep']),
    )
    expect(revealed.expanded.has('/repo/src/lib/deep/x.ts')).toBe(false)
    expect(needsLoad).toEqual(['/repo/src/lib', '/repo/src/lib/deep'])
  })

  it('matches the root across slash style and drive-letter case, keeping the root spelling', () => {
    const state = emptyFileTree(['D:\\repo'])
    const { needsLoad } = revealPath(state, 'd:/repo/src/a.ts')
    expect(needsLoad).toEqual(['D:\\repo', 'D:\\repo\\src'])
  })

  it('leaves the tree alone for a path under no root', () => {
    const state = sample()
    expect(revealPath(state, '/elsewhere/a.ts')).toEqual({ state, needsLoad: [] })
    expect(revealPath(state, '/repository/a.ts').needsLoad).toEqual([])
  })
})

describe('moveFocus', () => {
  const rows = flattenTree(sample())
  const at = (path: string) => rows.findIndex(row => rowKey(row) === path)

  it('moves up and down, stopping at the ends; Home and End jump', () => {
    expect(moveFocus(rows, 0, 'ArrowDown').index).toBe(1)
    expect(moveFocus(rows, 0, 'ArrowUp').index).toBe(0)
    expect(moveFocus(rows, rows.length - 1, 'ArrowDown').index).toBe(rows.length - 1)
    expect(moveFocus(rows, 3, 'Home').index).toBe(0)
    expect(moveFocus(rows, 0, 'End').index).toBe(rows.length - 1)
  })

  it('Left on a file goes to its parent; Left on an open folder collapses it', () => {
    expect(moveFocus(rows, at('/repo/src/a.ts'), 'ArrowLeft')).toEqual({ index: at('/repo/src') })
    expect(moveFocus(rows, at('/repo/src'), 'ArrowLeft')).toEqual({
      index: at('/repo/src'),
      toggle: '/repo/src',
    })
  })

  it('Right on a closed folder expands it, on an open one enters it, on a file does nothing', () => {
    expect(moveFocus(rows, at('/repo/src/lib'), 'ArrowRight')).toEqual({
      index: at('/repo/src/lib'),
      toggle: '/repo/src/lib',
    })
    expect(moveFocus(rows, at('/repo/src'), 'ArrowRight')).toEqual({ index: at('/repo/src/lib') })
    expect(moveFocus(rows, at('/repo/README.md'), 'ArrowRight')).toEqual({ index: at('/repo/README.md') })
  })

  it('skips the listing and empty rows, lands on an error row', () => {
    let state = toggleDir(sample(), '/repo/src/lib')
    let list = flattenTree(state)
    const lib = list.findIndex(row => rowKey(row) === '/repo/src/lib')
    expect(rowKey(list[lib + 1])).toBe('loading:/repo/src/lib')
    expect(moveFocus(list, lib, 'ArrowDown').index).toBe(lib + 2)
    expect(moveFocus(list, lib, 'ArrowRight').index).toBe(lib)
    state = applyListing(state, '/repo/src/lib', null)
    list = flattenTree(state)
    expect(moveFocus(list, lib, 'ArrowDown').index).toBe(lib + 1)
    expect(moveFocus(list, lib + 1, 'ArrowLeft').index).toBe(lib)
  })
})

describe('filterTree', () => {
  it('keeps listed matches and the folders above them, expanded', () => {
    const rows = filterTree(sample(), 'A.T')
    expect(rows.map(rowKey)).toEqual(['/repo', '/repo/src', '/repo/src/a.ts'])
    expect(rows.slice(0, 2).every(row => row.expanded)).toBe(true)
  })

  it('a folder matching by name with nothing listed below it stays collapsed', () => {
    expect(filterTree(sample(), 'lib')).toEqual([
      expect.objectContaining({ path: '/repo', expanded: true }),
      expect.objectContaining({ path: '/repo/src', expanded: true }),
      expect.objectContaining({ path: '/repo/src/lib', expanded: false }),
    ])
  })

  it('matches the path below the root: a folder\'s word keeps every listed entry under it', () => {
    expect(filterTree(sample(), 'SRC').map(rowKey)).toEqual([
      '/repo',
      '/repo/src',
      '/repo/src/lib',
      '/repo/src/a.ts',
      '/repo/src/current',
    ])
    expect(filterTree(sample(), 'repo')).toEqual([])
  })

  it('needs every space-separated word somewhere in the path, in any order', () => {
    expect(filterTree(sample(), 'a src').map(rowKey)).toEqual(['/repo', '/repo/src', '/repo/src/a.ts'])
  })

  it('searches collapsed folders that were listed, and returns nothing without a match', () => {
    const collapsed = toggleDir(sample(), '/repo/src')
    expect(filterTree(collapsed, 'a.ts').map(rowKey)).toContain('/repo/src/a.ts')
    expect(filterTree(collapsed, 'zzz')).toEqual([])
    expect(filterTree(collapsed, '  ')).toEqual([])
  })
})
