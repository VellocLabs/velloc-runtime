import { describe, expect, it } from 'vitest'

import {
  defaultSessionCardPrefs,
  moveShownSessionCard,
  outputFileKind,
  sanitizeSessionCardPrefs,
  sessionChangeFigures,
  setSessionCardHidden,
  setSessionCardsShown,
} from '@/browser/webview/layout/sessionCards'
import { defaultLayoutStorage, sanitizeLayoutStorage } from '@/browser/webview/layout/layoutSanitize'
import type { TurnDiffMeta } from '@/utils/turnDiffs'

// F-9: the session card stack's model.

function turn(turnIndex: number, files: Array<[string, boolean, number, number]>): TurnDiffMeta {
  return {
    turnIndex,
    promptPreview: '',
    stats: {
      touchedFiles: files.length,
      plusLines: files.reduce((sum, [, , plus]) => sum + plus, 0),
      minusLines: files.reduce((sum, [, , , minus]) => sum + minus, 0),
    },
    files: files.map(([filePath, fileWasCreated, plusLines, minusLines]) => ({
      filePath,
      fileWasCreated,
      plusLines,
      minusLines,
    })),
  }
}

describe('sanitizeSessionCardPrefs', () => {
  it('defaults when nothing usable is stored', () => {
    expect(sanitizeSessionCardPrefs(undefined)).toEqual(defaultSessionCardPrefs())
    expect(sanitizeSessionCardPrefs('x')).toEqual(defaultSessionCardPrefs())
    expect(defaultSessionCardPrefs()).toEqual({ order: ['outputs', 'changes', 'connectors', 'tasks'], hidden: [], shown: true })
  })

  it('drops unknown ids and repeats, and puts a missing card back at its default place', () => {
    expect(
      sanitizeSessionCardPrefs({ order: ['tasks', 'bogus', 'tasks', 'outputs'], hidden: ['changes', 7, 'changes'] }),
    ).toEqual({ order: ['tasks', 'changes', 'connectors', 'outputs'], hidden: ['changes'], shown: true })
    expect(sanitizeSessionCardPrefs({ order: ['changes'] }).order).toEqual(['outputs', 'changes', 'connectors', 'tasks'])
  })

  it('an order stored before the Connectors card gains it at its default place', () => {
    expect(sanitizeSessionCardPrefs({ order: ['outputs', 'changes', 'tasks'] }).order)
      .toEqual(['outputs', 'changes', 'connectors', 'tasks'])
    expect(sanitizeSessionCardPrefs({ order: ['tasks', 'outputs', 'changes'] }).order)
      .toEqual(['tasks', 'outputs', 'connectors', 'changes'])
  })

  it('rides in the layout blob, which an older blob without it still reads', () => {
    expect(defaultLayoutStorage().sessionCards).toEqual(defaultSessionCardPrefs())
    const old = { ...defaultLayoutStorage(), sessionCards: undefined }
    expect(sanitizeLayoutStorage(old).sessionCards).toEqual(defaultSessionCardPrefs())
    const stored = sanitizeLayoutStorage({ ...defaultLayoutStorage(), sessionCards: { order: ['tasks'], hidden: ['outputs'] } })
    expect(stored.sessionCards).toEqual({ order: ['outputs', 'changes', 'connectors', 'tasks'], hidden: ['outputs'], shown: true })
  })

  it('keeps the topbar toggle: only an explicit false hides the stack', () => {
    expect(sanitizeSessionCardPrefs({ shown: false }).shown).toBe(false)
    expect(sanitizeSessionCardPrefs({ shown: 'no' }).shown).toBe(true)
    const off = setSessionCardsShown(defaultSessionCardPrefs(), false)
    expect(off.shown).toBe(false)
    expect(setSessionCardsShown(off, false)).toBe(off)
    expect(setSessionCardHidden(off, 'tasks', true).shown).toBe(false)
  })
})

describe('setSessionCardHidden', () => {
  it('hides and shows a card, the same prefs back when nothing changes', () => {
    const prefs = defaultSessionCardPrefs()
    const hidden = setSessionCardHidden(prefs, 'changes', true)
    expect(hidden.hidden).toEqual(['changes'])
    expect(setSessionCardHidden(hidden, 'changes', true)).toBe(hidden)
    expect(setSessionCardHidden(hidden, 'changes', false).hidden).toEqual([])
  })
})

describe('moveShownSessionCard', () => {
  it('moves among the shown cards; a card not shown keeps its slot', () => {
    const prefs = defaultSessionCardPrefs()
    // `changes` is empty now: only outputs and tasks are drawn.
    const moved = moveShownSessionCard(prefs, ['outputs', 'tasks'], 1, 0)
    expect(moved.order).toEqual(['tasks', 'changes', 'connectors', 'outputs'])
    expect(moveShownSessionCard(prefs, ['outputs', 'changes', 'tasks'], 0, 2).order).toEqual(['changes', 'tasks', 'connectors', 'outputs'])
  })

  it('ignores a move out of range or onto itself', () => {
    const prefs = defaultSessionCardPrefs()
    expect(moveShownSessionCard(prefs, ['outputs'], 0, 0)).toBe(prefs)
    expect(moveShownSessionCard(prefs, ['outputs'], 0, 3)).toBe(prefs)
  })
})

describe('sessionChangeFigures', () => {
  it('nothing for no history', () => {
    expect(sessionChangeFigures(null)).toEqual({ plusLines: 0, minusLines: 0, createdFiles: [] })
  })

  it('sums every turn and lists each created file once, newest first', () => {
    const history = [
      turn(1, [['/w/a.ts', true, 10, 0]]),
      turn(2, [['/w/b.ts', true, 3, 0], ['/w/c.ts', true, 1, 0], ['/w/a.ts', false, 1, 1]]),
    ]
    // Turn 2 before turn 1; within a turn the last written first.
    expect(sessionChangeFigures(history)).toEqual({
      plusLines: 15,
      minusLines: 1,
      createdFiles: ['/w/c.ts', '/w/b.ts', '/w/a.ts'],
    })
  })

  it('a file created again in a later turn takes that turn\'s place', () => {
    const history = [
      turn(1, [['/w/a.ts', true, 1, 0], ['/w/b.ts', true, 1, 0]]),
      turn(3, [['/w/a.ts', true, 1, 0]]),
    ]
    expect(sessionChangeFigures(history).createdFiles).toEqual(['/w/a.ts', '/w/b.ts'])
  })

  it('skips the whole-session row for lines, and takes created files from it when present', () => {
    const history = [
      turn(0, [['/w/b.ts', true, 3, 0]]),
      turn(2, [['/w/b.ts', true, 3, 0]]),
      turn(1, [['/w/a.ts', true, 5, 0]]),
    ]
    // `/w/a.ts` was created and then removed: the net row no longer names it.
    expect(sessionChangeFigures(history)).toEqual({ plusLines: 8, minusLines: 0, createdFiles: ['/w/b.ts'] })
  })

  it('keeps the net row\'s newest-first order, a file only it names last', () => {
    const history = [
      turn(0, [['/w/a.ts', true, 1, 0], ['/w/b.ts', true, 1, 0], ['/w/z.ts', true, 1, 0]]),
      turn(1, [['/w/a.ts', true, 1, 0]]),
      turn(2, [['/w/b.ts', true, 1, 0]]),
    ]
    expect(sessionChangeFigures(history).createdFiles).toEqual(['/w/b.ts', '/w/a.ts', '/w/z.ts'])
  })
})

describe('outputFileKind', () => {
  it('names code, images and notes by suffix; anything else is a plain file', () => {
    expect(outputFileKind('/w/src/report.ts')).toBe('code')
    expect(outputFileKind('C:\\w\\patch_render_test.py')).toBe('code')
    expect(outputFileKind('/w/shot.PNG')).toBe('image')
    expect(outputFileKind('/w/handoff.md')).toBe('note')
    expect(outputFileKind('/w/msg.txt')).toBe('file')
    expect(outputFileKind('/w/Makefile')).toBe('file')
    expect(outputFileKind('/w/.env')).toBe('file')
    expect(outputFileKind('/w.d/notes')).toBe('file')
  })
})
