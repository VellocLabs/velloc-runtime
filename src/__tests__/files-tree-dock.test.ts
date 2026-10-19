/** The Files pane's docked tree (F-9): when it fits, how wide it may be, and the tree's spelling of a path. */
import { describe, expect, it } from 'vitest'

import {
  clampFilesTreeWidth,
  dockFits,
  maxDockWidth,
  treeSpelling,
} from '@/browser/webview/layout/filesTreeDock'

describe('dockFits', () => {
  it('needs the tree width plus 360 px for the file; an unmeasured body fits', () => {
    expect(dockFits(620, 260)).toBe(true)
    expect(dockFits(619, 260)).toBe(false)
    expect(dockFits(0, 260)).toBe(true)
  })
})

describe('maxDockWidth', () => {
  it('leaves the file 360 px, within the tree bounds', () => {
    expect(maxDockWidth(1000)).toBe(640)
    expect(maxDockWidth(400)).toBe(180)
    expect(maxDockWidth(5000)).toBe(800)
    expect(maxDockWidth(0)).toBe(800)
  })
})

describe('clampFilesTreeWidth', () => {
  it('rounds into 180..800; a non-number is 260', () => {
    expect(clampFilesTreeWidth(200.6)).toBe(201)
    expect(clampFilesTreeWidth(10)).toBe(180)
    expect(clampFilesTreeWidth(Infinity)).toBe(260)
    expect(clampFilesTreeWidth(undefined)).toBe(260)
  })
})

describe('treeSpelling', () => {
  it('spells a path under a root the way the tree joins its rows', () => {
    expect(treeSpelling(['/repo'], '/repo/src/main.ts')).toBe('/repo/src/main.ts')
    expect(treeSpelling(['D:\\proj'], 'd:/proj/src/main.ts')).toBe('D:\\proj\\src\\main.ts')
    expect(treeSpelling(['D:/proj/'], 'D:\\proj\\a.ts')).toBe('D:/proj/a.ts')
    expect(treeSpelling(['/repo'], '/repo')).toBe('/repo')
  })

  it('leaves a path under no root as given', () => {
    expect(treeSpelling(['/repo'], '/elsewhere/a.ts')).toBe('/elsewhere/a.ts')
    expect(treeSpelling(['/repo'], '/repository/a.ts')).toBe('/repository/a.ts')
  })
})
