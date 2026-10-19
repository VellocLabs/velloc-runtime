/**
 * The Files pane's path bar model (F-9): a path splits into segments relative
 * to the session root (absolute outside it) in either slash style, joined by
 * the platform separator; each folder segment browses the folder it names and
 * the file-name segment its own folder. Collapsing hides leading folders first
 * and never the file name. Type-ahead finds the next row by name prefix.
 */
import { describe, expect, it } from 'vitest'

import {
  collapseSegments,
  pathBarModel,
  platformSeparator,
  type PathSegment,
} from '@/browser/webview/panes/FilesPathBar'
import { typeAheadIndex } from '@/browser/webview/panes/FolderDropdown'
import type { TreeRow } from '@/browser/webview/layout/fileTree'

const labels = (segments: readonly PathSegment[]) => segments.map(segment => segment.label)

describe('pathBarModel', () => {
  it('is relative to a POSIX root', () => {
    const model = pathBarModel('/repo/a/b/c.txt', '/repo')
    expect(labels(model.segments)).toEqual(['a', 'b', 'c.txt'])
    expect(model.separator).toBe('/')
    expect(model.leading).toBe('')
    expect(model.segments.map(segment => segment.folder)).toEqual(['/repo/a', '/repo/a/b', '/repo/a/b'])
    expect(model.segments[2].file).toBe('/repo/a/b/c.txt')
    expect(model.segments[0].file).toBeUndefined()
  })

  it('is relative to a Windows root in either slash style, joined by a backslash', () => {
    const back = pathBarModel('D:\\proj\\src\\main.ts', 'D:\\proj')
    expect(labels(back.segments)).toEqual(['src', 'main.ts'])
    expect(back.separator).toBe('\\')
    expect(back.segments[0].folder).toBe('D:\\proj\\src')
    const forward = pathBarModel('d:/proj/src/main.ts', 'D:\\proj')
    expect(labels(forward.segments)).toEqual(['src', 'main.ts'])
    expect(forward.separator).toBe('\\')
  })

  it("browses the root for a file at the root's top level", () => {
    const model = pathBarModel('/repo/README.md', '/repo')
    expect(model.segments).toEqual([{ label: 'README.md', folder: '/repo', file: '/repo/README.md' }])
  })

  it('is absolute outside the root: a drive leads on Windows, a slash on POSIX', () => {
    const win = pathBarModel('C:\\Users\\me\\notes.txt', 'D:\\proj')
    expect(labels(win.segments)).toEqual(['C:', 'Users', 'me', 'notes.txt'])
    expect(win.segments.map(segment => segment.folder)).toEqual([
      'C:\\',
      'C:\\Users',
      'C:\\Users\\me',
      'C:\\Users\\me',
    ])
    expect(win.leading).toBe('')
    const posix = pathBarModel('/etc/hosts', '/repo')
    expect(labels(posix.segments)).toEqual(['etc', 'hosts'])
    expect(posix.leading).toBe('/')
    expect(posix.segments[0].folder).toBe('/etc')
  })

  it('does not take a sibling folder sharing the prefix as inside the root', () => {
    expect(labels(pathBarModel('/repo-two/x.ts', '/repo').segments)).toEqual(['repo-two', 'x.ts'])
  })

  it('picks the platform separator from the path', () => {
    expect(platformSeparator('D:/a')).toBe('\\')
    expect(platformSeparator('a\\b')).toBe('\\')
    expect(platformSeparator('/a/b')).toBe('/')
  })
})

describe('collapseSegments', () => {
  const segments = pathBarModel('/r/a/b/c/f.ts', '/r').segments

  it('hides leading folders first, behind one ellipsis', () => {
    expect(collapseSegments(segments, 0).map(item => item.kind)).toEqual(['segment', 'segment', 'segment', 'segment'])
    const two = collapseSegments(segments, 2)
    expect(two[0]).toEqual({ kind: 'ellipsis', hidden: segments.slice(0, 2) })
    expect(two.slice(1).map(item => (item.kind === 'segment' ? item.segment.label : '…'))).toEqual(['c', 'f.ts'])
  })

  it('never hides the file name', () => {
    const all = collapseSegments(segments, 99)
    expect(all).toHaveLength(2)
    expect(all[1]).toMatchObject({ kind: 'segment', segment: { label: 'f.ts' } })
  })
})

describe('typeAheadIndex', () => {
  const node = (name: string): TreeRow => ({ path: `/r/${name}`, name, kind: 'file', depth: 0 })
  const rows: TreeRow[] = [node('alpha'), node('beta'), { kind: 'loading', path: '/r', depth: 1 }, node('bravo'), node('apple')]

  it('jumps to the next name starting with a letter, wrapping', () => {
    expect(typeAheadIndex(rows, 0, 'b')).toBe(1)
    expect(typeAheadIndex(rows, 1, 'b')).toBe(3)
    expect(typeAheadIndex(rows, 3, 'b')).toBe(1)
    expect(typeAheadIndex(rows, 1, 'a')).toBe(4)
  })

  it('a longer prefix may stay on the current row; a repeated letter cycles', () => {
    expect(typeAheadIndex(rows, 3, 'br')).toBe(3)
    expect(typeAheadIndex(rows, 1, 'bb')).toBe(3)
    expect(typeAheadIndex(rows, 0, 'zz')).toBe(-1)
  })
})
