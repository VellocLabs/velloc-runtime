/**
 * The Right Panel's width as a per-kind share of the room beside the chat
 * (F-9): reading views (diff, file) open at chat:panel 2:3, the rest at 2:1,
 * and a drag remembers the share for its kind only.
 */
import { describe, expect, it } from 'vitest'

import {
  rightPanelShare,
  rightPanelViewKind,
  rightPanelWantWidth,
  setRightPanelShare,
  shareFromWidth,
} from '@/browser/webview/layout/panelShare'

describe('panelShare', () => {
  it('names each view by its kind; no front view is Tasks', () => {
    expect(rightPanelViewKind('file:/a/b.ts')).toBe('file')
    expect(rightPanelViewKind('diff')).toBe('diff')
    expect(rightPanelViewKind('plan')).toBe('plan')
    expect(rightPanelViewKind(null)).toBe('tasks')
  })

  it('defaults to 3/5 for a diff or a file and 1/3 for the rest', () => {
    expect(rightPanelShare({}, 'diff')).toBe(3 / 5)
    expect(rightPanelShare({}, 'file')).toBe(3 / 5)
    for (const kind of ['plan', 'tasks', 'skill'] as const) expect(rightPanelShare({}, kind)).toBe(1 / 3)
  })

  it('remembers a share per kind, leaving the other kinds at theirs', () => {
    const shares = setRightPanelShare({}, 'diff', 0.45)
    expect(rightPanelShare(shares, 'diff')).toBe(0.45)
    expect(rightPanelShare(shares, 'file')).toBe(3 / 5)
    expect(setRightPanelShare(shares, 'diff', 0.45)).toBe(shares)
    expect(setRightPanelShare(shares, 'diff', Number.NaN)).toBe(shares)
    expect(setRightPanelShare({}, 'plan', 2).plan).toBe(0.9)
  })

  it('a drag stores the width it leaves as a share, and the share redraws that width', () => {
    const room = 1312
    const share = shareFromWidth(500, room)
    const shares = setRightPanelShare({}, 'file', share)
    expect(rightPanelWantWidth(rightPanelShare(shares, 'file'), room, 280, Infinity)).toBe(500)
    // The same share keeps its proportion in a wider window.
    expect(rightPanelWantWidth(rightPanelShare(shares, 'file'), 2 * room, 280, Infinity)).toBe(1000)
  })

  it('the wanted width keeps the bounds', () => {
    expect(rightPanelWantWidth(1 / 3, 600, 280, Infinity)).toBe(280)
    expect(rightPanelWantWidth(3 / 5, 1312, 240, 360)).toBe(360)
  })
})
