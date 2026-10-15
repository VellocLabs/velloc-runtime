import { describe, expect, it } from 'vitest'

import {
  closeView,
  combineRightPanelState,
  defaultRightPanelGeometry,
  defaultRightPanelSession,
  isModViewId,
  isRightPanelViewId,
  modViewId,
  modViewParts,
  openView,
  reconcileMountedBodies,
  type ModViewId,
  type RightPanelState,
} from '@/browser/webview/layout/rightPanelManager'
import { syncModPaneTabs } from '@/browser/webview/layout/modPaneTabs'

// F-25: a mod's pane docked in the Right Panel (a `Pane` with `placement:
// 'dock'`).

/** A session's panel as the shell starts it: hidden, tabs [tasks, diff]. */
function sessionState(): RightPanelState {
  return combineRightPanelState(defaultRightPanelSession(), defaultRightPanelGeometry())
}

const report = { plugin: 'test-report', id: 'r-1', asked: true, openSeq: 1 }
const clock = { plugin: 'clock', id: 'clock', asked: true, openSeq: 2 }
const REPORT = modViewId(report.plugin, report.id)
const CLOCK = modViewId(clock.plugin, clock.id)

describe('mod view ids', () => {
  it('names (plugin, pane id) and splits at the last colon', () => {
    expect(REPORT).toBe('mod:test-report:r-1')
    expect(isModViewId(REPORT)).toBe(true)
    expect(isModViewId('tasks')).toBe(false)
    expect(modViewParts(REPORT)).toEqual({ plugin: report.plugin, id: report.id })
    // A plugin name may hold a colon; a pane id ("letters, digits, _ and -")
    // never does.
    expect(modViewParts(modViewId('a:b', 'x'))).toEqual({ plugin: 'a:b', id: 'x' })
  })

  it('a malformed one is not a view id', () => {
    expect(modViewParts('mod:noid' as ModViewId)).toBeNull()
    expect(modViewParts('mod::x' as ModViewId)).toBeNull()
    expect(modViewParts('mod:p:' as ModViewId)).toBeNull()
    expect(isRightPanelViewId('mod:noid')).toBe(false)
    expect(isRightPanelViewId(REPORT)).toBe(true)
  })

  it('a mod tab is closable like a file tab', () => {
    const s = openView(sessionState(), REPORT)
    expect(closeView(s, REPORT).tabs).toEqual(['tasks', 'diff'])
  })
})

describe('reconcileMountedBodies — a mod body lives only while shown', () => {
  it('keeps a visible mod body and releases it once another tab shows', () => {
    const openTabs = ['tasks', 'diff', REPORT] as const
    const shown = reconcileMountedBodies({ previous: ['tasks'], visible: [REPORT], openTabs: [...openTabs] })
    expect(shown).toEqual([REPORT, 'tasks'])
    // Tasks shows again: a singleton stays mounted, the mod body goes, so its
    // plugin is not asked to draw a pane nobody sees.
    const hidden = reconcileMountedBodies({ previous: shown, visible: ['tasks'], openTabs: [...openTabs] })
    expect(hidden).toEqual(['tasks'])
  })
})

describe('syncModPaneTabs', () => {
  it('a session seen for the first time gets tabs for its open panes, the panel left hidden', () => {
    const { state, seen } = syncModPaneTabs(sessionState(), { panes: [report], seen: undefined, docked: true })
    expect(state.tabs).toEqual(['tasks', 'diff', REPORT])
    expect(state.visible).toBe(false)
    expect(state.activeView).toBeNull()
    expect([...seen]).toEqual([[REPORT, 1]])
  })

  it('a pane the person opened while the session is watched opens its tab and shows the panel', () => {
    const first = syncModPaneTabs(sessionState(), { panes: [], seen: undefined, docked: true })
    const { state } = syncModPaneTabs(first.state, { panes: [report], seen: first.seen, docked: true })
    expect(state.visible).toBe(true)
    expect(state.activeView).toBe(REPORT)
    expect(state.tabs).toEqual(['tasks', 'diff', REPORT])
  })

  it('a second pane opened later takes the focus; the first stays a tab', () => {
    const a = syncModPaneTabs(sessionState(), { panes: [], seen: undefined, docked: true })
    const b = syncModPaneTabs(a.state, { panes: [report], seen: a.seen, docked: true })
    const c = syncModPaneTabs(b.state, { panes: [report, clock], seen: b.seen, docked: true })
    expect(c.state.activeView).toBe(CLOCK)
    expect(c.state.tabs).toEqual(['tasks', 'diff', REPORT, CLOCK])
  })

  it('a pane the runtime closed takes its tab; focus returns to the tab before it', () => {
    const a = syncModPaneTabs(openView(sessionState(), 'tasks'), { panes: [], seen: undefined, docked: true })
    const b = syncModPaneTabs(a.state, { panes: [report], seen: a.seen, docked: true })
    const c = syncModPaneTabs(b.state, { panes: [], seen: b.seen, docked: true })
    expect(c.state.tabs).toEqual(['tasks', 'diff'])
    expect(c.state.activeView).toBe('tasks')
    expect(c.state.visible).toBe(true)
    expect(c.seen.size).toBe(0)
  })

  it('a pane closed and opened again under the same id opens again', () => {
    const a = syncModPaneTabs(sessionState(), { panes: [report], seen: undefined, docked: true })
    const b = syncModPaneTabs(a.state, { panes: [], seen: a.seen, docked: true })
    const c = syncModPaneTabs(b.state, { panes: [{ ...report, openSeq: 3 }], seen: b.seen, docked: true })
    expect(c.state.activeView).toBe(REPORT)
    expect(c.state.visible).toBe(true)
  })

  it("a mod's own open adds its tab without popping the panel or taking the active tab", () => {
    const a = syncModPaneTabs(openView(sessionState(), 'tasks'), { panes: [], seen: undefined, docked: true })
    const b = syncModPaneTabs(a.state, { panes: [{ ...report, asked: false }], seen: a.seen, docked: true })
    expect(b.state.tabs).toEqual(['tasks', 'diff', REPORT])
    expect(b.state.activeView).toBe('tasks')
    const hidden = syncModPaneTabs({ ...a.state, visible: false }, { panes: [{ ...report, asked: false }], seen: a.seen, docked: true })
    expect(hidden.state.visible).toBe(false)
  })

  it("a mod's focus open activates its tab and shows the panel, once per openSeq", () => {
    const held = { ...report, asked: false, focus: true }
    const a = syncModPaneTabs({ ...openView(sessionState(), 'tasks'), visible: false }, { panes: [], seen: undefined, docked: true })
    const b = syncModPaneTabs(a.state, { panes: [held], seen: a.seen, docked: true })
    expect(b.state.tabs).toEqual(['tasks', 'diff', REPORT])
    expect(b.state.activeView).toBe(REPORT)
    expect(b.state.visible).toBe(true)
    // The person moves to another tab: the same open does not pull it back.
    const moved = openView(b.state, 'tasks')
    expect(syncModPaneTabs(moved, { panes: [held], seen: b.seen, docked: true }).state.activeView).toBe('tasks')
    // A later focus open does.
    const again = syncModPaneTabs(moved, { panes: [{ ...held, openSeq: 5 }], seen: b.seen, docked: true })
    expect(again.state.activeView).toBe(REPORT)
  })

  it("the person's open of a pane already open shows it again: its tab behind another, or its panel hidden", () => {
    const a = syncModPaneTabs(sessionState(), { panes: [], seen: undefined, docked: true })
    const b = syncModPaneTabs(a.state, { panes: [report], seen: a.seen, docked: true })
    // The person hides the panel (not the tab's close mark): the pane stays.
    const hidden = { ...b.state, visible: false }
    expect(syncModPaneTabs(hidden, { panes: [report], seen: b.seen, docked: true }).state).toBe(hidden)
    const again = syncModPaneTabs(hidden, { panes: [{ ...report, openSeq: 5 }], seen: b.seen, docked: true })
    expect(again.state.visible).toBe(true)
    expect(again.state.activeView).toBe(REPORT)
    // Another tab in front: the person's open brings the pane's back.
    const behind = openView(again.state, 'tasks')
    const front = syncModPaneTabs(behind, { panes: [{ ...report, openSeq: 6 }], seen: again.seen, docked: true })
    expect(front.state.activeView).toBe(REPORT)
    // A mod's own re-open does neither.
    const own = syncModPaneTabs(hidden, { panes: [{ ...report, openSeq: 7, asked: false }], seen: front.seen, docked: true })
    expect(own.state).toBe(hidden)
  })

  it('an unchanged list changes nothing (same state reference)', () => {
    const a = syncModPaneTabs(sessionState(), { panes: [report], seen: undefined, docked: true })
    expect(syncModPaneTabs(a.state, { panes: [report], seen: a.seen, docked: true }).state).toBe(a.state)
  })

  it('not docked (a narrow window), mod tabs leave the strip; widening restores them without popping the panel', () => {
    const a = syncModPaneTabs(sessionState(), { panes: [], seen: undefined, docked: true })
    const opened = syncModPaneTabs(a.state, { panes: [report], seen: a.seen, docked: true })
    const narrow = syncModPaneTabs(opened.state, { panes: [report], seen: opened.seen, docked: false })
    expect(narrow.state.tabs).toEqual(['tasks', 'diff'])
    // A pane opened while narrow draws inline; it is seen all the same.
    const narrowOpen = syncModPaneTabs(narrow.state, { panes: [report, clock], seen: narrow.seen, docked: false })
    expect(narrowOpen.state.tabs).toEqual(['tasks', 'diff'])
    const hiddenPanel = { ...narrowOpen.state, visible: false }
    const wide = syncModPaneTabs(hiddenPanel, { panes: [report, clock], seen: narrowOpen.seen, docked: true })
    expect(wide.state.tabs).toEqual(['tasks', 'diff', REPORT, CLOCK])
    expect(wide.state.visible).toBe(false)
  })
})
