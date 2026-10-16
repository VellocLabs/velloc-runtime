import { describe, expect, it } from 'vitest'

import {
  defaultSessionCardPrefs,
  moveShownSessionCard,
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
    expect(defaultSessionCardPrefs()).toEqual({ order: ['outputs', 'changes', 'tasks'], hidden: [], shown: true })
  })

  it('drops unknown ids and repeats, and puts a missing card back at its default place', () => {
    expect(
      sanitizeSessionCardPrefs({ order: ['tasks', 'bogus', 'tasks', 'outputs'], hidden: ['changes', 7, 'changes'] }),
    ).toEqual({ order: ['tasks', 'changes', 'outputs'], hidden: ['changes'], shown: true })
    expect(sanitizeSessionCardPrefs({ order: ['changes'] }).order).toEqual(['outputs', 'changes', 'tasks'])
  })

  it('rides in the layout blob, which an older blob without it still reads', () => {
    expect(defaultLayoutStorage().sessionCards).toEqual(defaultSessionCardPrefs())
    const old = { ...defaultLayoutStorage(), sessionCards: undefined }
    expect(sanitizeLayoutStorage(old).sessionCards).toEqual(defaultSessionCardPrefs())
    const stored = sanitizeLayoutStorage({ ...defaultLayoutStorage(), sessionCards: { order: ['tasks'], hidden: ['outputs'] } })
    expect(stored.sessionCards).toEqual({ order: ['outputs', 'changes', 'tasks'], hidden: ['outputs'], shown: true })
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
    expect(moved.order).toEqual(['tasks', 'changes', 'outputs'])
    expect(moveShownSessionCard(prefs, ['outputs', 'changes', 'tasks'], 0, 2).order).toEqual(['changes', 'tasks', 'outputs'])
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

  it('sums every turn and lists each created file once, oldest first', () => {
    const history = [
      turn(2, [['/w/b.ts', true, 3, 0], ['/w/a.ts', false, 1, 1]]),
      turn(1, [['/w/a.ts', true, 10, 0]]),
    ]
    expect(sessionChangeFigures(history)).toEqual({ plusLines: 14, minusLines: 1, createdFiles: ['/w/a.ts', '/w/b.ts'] })
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
})
