import { describe, expect, it } from 'vitest'

import { foldModDock, modDockKey, sameModDockFront } from '@/browser/webview/layout/modDock'

// F-25: a mod's pane docked in the session card stack (a `Pane` with
// `placement: 'dock'`); at most one pane card is open in front.

const report = { plugin: 'test-report', id: 'r-1', asked: true, openSeq: 1 }
const clock = { plugin: 'clock', id: 'clock', asked: true, openSeq: 2 }
const REPORT = { plugin: report.plugin, id: report.id }
const CLOCK = { plugin: clock.plugin, id: clock.id }

describe('foldModDock', () => {
  it('a session folded for the first time opens no card, whatever was asked before', () => {
    const { front, seen } = foldModDock({ front: null, panes: [report], seen: undefined })
    expect(front).toBeNull()
    expect([...seen]).toEqual([[modDockKey(report), 1]])
  })

  it('a session folded for the first time opens a focus pane no window has shown yet', () => {
    const waited = { plugin: 'p', id: 'hold', focus: true, openSeq: 2 }
    const first = foldModDock({ front: null, panes: [report, waited], seen: undefined })
    expect(first.front).toEqual({ plugin: 'p', id: 'hold' })
    expect(foldModDock({ front: REPORT, panes: [report, waited], seen: first.seen }).front).toEqual(REPORT)
  })

  it('a pane the person opened while the session is watched comes to the front', () => {
    const first = foldModDock({ front: null, panes: [], seen: undefined })
    expect(foldModDock({ front: first.front, panes: [report], seen: first.seen }).front).toEqual(REPORT)
  })

  it('a second asked pane takes the front; of two new ones the later open wins', () => {
    const first = foldModDock({ front: null, panes: [report], seen: new Map() })
    expect(first.front).toEqual(REPORT)
    expect(foldModDock({ front: first.front, panes: [report, clock], seen: first.seen }).front).toEqual(CLOCK)
    expect(foldModDock({ front: null, panes: [clock, report], seen: new Map() }).front).toEqual(CLOCK)
  })

  it("a mod's own open adds its card without taking the front", () => {
    const unasked = { plugin: 'p', id: 'quiet', openSeq: 3 }
    const first = foldModDock({ front: REPORT, panes: [report], seen: new Map([[modDockKey(report), 1]]) })
    expect(foldModDock({ front: first.front, panes: [report, unasked], seen: first.seen }).front).toEqual(REPORT)
  })

  it("a mod's focus open takes the front once per openSeq", () => {
    const focused = { plugin: 'p', id: 'f', focus: true, openSeq: 4 }
    const seen = new Map([[modDockKey(report), 1]])
    const first = foldModDock({ front: REPORT, panes: [report, focused], seen })
    expect(first.front).toEqual({ plugin: 'p', id: 'f' })
    // The person closes its card; the same openSeq does not reopen it.
    expect(foldModDock({ front: null, panes: [report, focused], seen: first.seen }).front).toBeNull()
    // A new focus open does.
    const again = { ...focused, openSeq: 5 }
    expect(foldModDock({ front: null, panes: [report, again], seen: first.seen }).front).toEqual({ plugin: 'p', id: 'f' })
  })

  it('a pane the runtime closed leaves the front empty', () => {
    const first = foldModDock({ front: REPORT, panes: [report], seen: new Map([[modDockKey(report), 1]]) })
    const closed = foldModDock({ front: first.front, panes: [], seen: first.seen })
    expect(closed.front).toBeNull()
    expect(closed.seen.size).toBe(0)
  })

  it('a pane closed and opened again under the same id comes back to the front', () => {
    const closed = foldModDock({ front: null, panes: [], seen: new Map() })
    expect(foldModDock({ front: null, panes: [report], seen: closed.seen }).front).toEqual(REPORT)
  })
})

describe('sameModDockFront', () => {
  it('compares plugin and id; null only equals null', () => {
    expect(sameModDockFront(REPORT, { ...REPORT })).toBe(true)
    expect(sameModDockFront(REPORT, CLOCK)).toBe(false)
    expect(sameModDockFront(null, null)).toBe(true)
    expect(sameModDockFront(REPORT, null)).toBe(false)
  })
})
