import { describe, expect, it } from 'vitest'

import {
  ASKED_MEMORY_CAP,
  REMEMBERED_FLOOR_CELLS,
  UNASKED_FLOOR_CELLS,
  forgetAskedPane,
  modPaneKey,
  modPaneOfKey,
  modsPanePlaces,
  modsPaneWeight,
  newModPaneOpens,
  opensBringModsPane,
  rememberAskedPanes,
} from '@/browser/webview/layout/modsPane'

// F-25: the Plugins side pane holds every mod pane of a session as tabs.

const report = { plugin: 'test-report', id: 'r-1', openSeq: 1 }
const clock = { plugin: 'clock', id: 'clock', openSeq: 2 }

describe('newModPaneOpens', () => {
  it("counts every pane as opened at a session's first fold", () => {
    const { opens, seen } = newModPaneOpens([report, clock], undefined)
    expect(opens).toEqual([report, clock])
    expect([...seen]).toEqual([
      [modPaneKey(report), 1],
      [modPaneKey(clock), 2],
    ])
  })

  it('then counts only new panes and re-opens (a later openSeq)', () => {
    const first = newModPaneOpens([report], undefined)
    expect(newModPaneOpens([report], first.seen).opens).toEqual([])
    const reopened = { ...report, openSeq: 3 }
    expect(newModPaneOpens([reopened, clock], first.seen).opens).toEqual([reopened, clock])
  })
})

describe('modsPanePlaces', () => {
  it('places every mod open from the unasked floor, remembered ones from the lower floor, none below', () => {
    expect(modsPanePlaces({ columns: UNASKED_FLOOR_CELLS, dismissed: false })).toBe('all')
    expect(modsPanePlaces({ columns: UNASKED_FLOOR_CELLS - 1, dismissed: false })).toBe('remembered')
    expect(modsPanePlaces({ columns: REMEMBERED_FLOOR_CELLS, dismissed: false })).toBe('remembered')
    expect(modsPanePlaces({ columns: REMEMBERED_FLOOR_CELLS - 1, dismissed: false })).toBe('none')
  })

  it('places none once the person closed the pane', () => {
    expect(modsPanePlaces({ columns: 500, dismissed: true })).toBe('none')
  })
})

describe('opensBringModsPane', () => {
  const remembered = new Set([modPaneKey(report)])
  it('an asked or focus open always brings the pane', () => {
    expect(opensBringModsPane([{ ...clock, asked: true }], 'none', new Set())).toBe(true)
    expect(opensBringModsPane([{ ...clock, focus: true }], 'none', new Set())).toBe(true)
  })

  it("a mod's own open brings it where the places admit it", () => {
    expect(opensBringModsPane([clock], 'all', new Set())).toBe(true)
    expect(opensBringModsPane([clock], 'remembered', remembered)).toBe(false)
    expect(opensBringModsPane([report], 'remembered', remembered)).toBe(true)
    expect(opensBringModsPane([report], 'none', remembered)).toBe(false)
  })
})

describe('the asked memory', () => {
  it('remembers asked opens, most recent last, and forgets a pane closed by hand', () => {
    const memory = rememberAskedPanes([], [{ ...report, asked: true }, clock])
    expect(memory).toEqual([modPaneKey(report)])
    const again = rememberAskedPanes([modPaneKey(report), modPaneKey(clock)], [{ ...report, asked: true }])
    expect(again).toEqual([modPaneKey(clock), modPaneKey(report)])
    expect(rememberAskedPanes(memory, [clock])).toBe(memory)
    expect(forgetAskedPane(again, report)).toEqual([modPaneKey(clock)])
    expect(forgetAskedPane(memory, clock)).toBe(memory)
  })

  it('keeps the newest past the cap', () => {
    const full = Array.from({ length: ASKED_MEMORY_CAP }, (_, n) => modPaneKey({ plugin: 'p', id: `i${n}` }))
    const next = rememberAskedPanes(full, [{ plugin: 'p', id: 'new', asked: true }])
    expect(next).toHaveLength(ASKED_MEMORY_CAP)
    expect(next[0]).toBe(modPaneKey({ plugin: 'p', id: 'i1' }))
    expect(next[next.length - 1]).toBe(modPaneKey({ plugin: 'p', id: 'new' }))
  })

  it('round-trips a key; a malformed key is none', () => {
    expect(modPaneOfKey(modPaneKey(report))).toEqual({ plugin: 'test-report', id: 'r-1' })
    expect(modPaneOfKey('no-separator')).toBeNull()
    expect(modPaneOfKey('\u0000id')).toBeNull()
  })
})

describe('modsPaneWeight', () => {
  it('is the weight at which the pane is `columns` cells wide beside the chat', () => {
    // 100 cells of 7px + 40px chrome = 740px; the chat gets 1000 - 740 = 260px.
    const weight = modsPaneWeight({ columns: 100, cellWidth: 7, chromeWidth: 40, rowWidth: 1000, chatWeight: 2 })
    expect(weight).toBeCloseTo((2 * 740) / 260)
  })

  it('is none without a width asked, or when the chat would get no room', () => {
    expect(modsPaneWeight({ columns: undefined, cellWidth: 7, chromeWidth: 40, rowWidth: 1000, chatWeight: 2 })).toBeNull()
    expect(modsPaneWeight({ columns: 200, cellWidth: 7, chromeWidth: 40, rowWidth: 1000, chatWeight: 2 })).toBeNull()
  })
})
