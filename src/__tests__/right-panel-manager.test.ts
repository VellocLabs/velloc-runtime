import { describe, expect, it } from 'vitest'

import {
  RIGHT_PANEL_SPLIT_DEFAULT_RATIO,
  RIGHT_PANEL_SPLIT_MAX_RATIO,
  RIGHT_PANEL_SPLIT_MIN_RATIO,
} from '@/browser/webview/layout/layoutConstants'
import {
  closeView,
  combineRightPanelState,
  DEFAULT_RIGHT_PANEL_TABS,
  RIGHT_PANEL_DEFAULT_ACTIVE_VIEW,
  defaultRightPanelGeometry,
  defaultRightPanelSession,
  defaultRightPanelState,
  defaultRightPanelTabs,
  ensureRightPanelTab,
  fileViewId,
  fileViewPath,
  isDefaultRightPanelTab,
  isFileViewId,
  isRightPanelViewId,
  openView,
  pickRightPanelGeometry,
  pickRightPanelSession,
  pinView,
  reconcileRightPanelMaximized,
  restoredRightPanelView,
  rightPanelGeometryEquals,
  rightPanelSessionEquals,
  selectRightPanelDisplayMode,
  selectRightPanelSplit,
  setActiveView,
  setRightPanelSplitRatio,
  setRightPanelVisible,
  setRightPanelShares,
  showRightPanel,
  unpinView,
  type RightPanelState,
} from '@/browser/webview/layout/rightPanelManager'

// P1 (F-9): the Right Panel state machine.

/** A full state with the always-open per-session tabs (tasks + diff). */
function sessionState(): RightPanelState {
  return combineRightPanelState(
    defaultRightPanelSession(),
    defaultRightPanelGeometry(),
  )
}

describe('ensureRightPanelTab', () => {
  it('adds the tab WITHOUT showing the panel or changing the focused tab', () => {
    const s = sessionState() // hidden, tabs [tasks, diff], activeView null
    const next = ensureRightPanelTab(s, 'skill')
    expect(next.tabs).toContain('skill')
    // availability only — the panel is not forced open, focus is untouched.
    expect(next.visible).toBe(s.visible)
    expect(next.activeView).toBe(s.activeView)
    expect(next.pinnedViews).toEqual(s.pinnedViews)
  })

  it('is a no-op (same reference) when the tab already exists', () => {
    const s = openView(sessionState(), 'skill')
    expect(ensureRightPanelTab(s, 'skill')).toBe(s)
  })

  it('leaves an already-open panel on its current view', () => {
    const s = openView(sessionState(), 'tasks') // visible, active tasks
    const next = ensureRightPanelTab(s, 'skill')
    expect(next.activeView).toBe('tasks')
    expect(next.visible).toBe(true)
    expect(next.tabs).toEqual(['tasks', 'diff', 'skill'])
  })
})

describe('defaults & guards', () => {
  it('starts hidden with no tabs', () => {
    const s = defaultRightPanelState()
    expect(s).toMatchObject({
      visible: false,
      activeView: null,
      tabs: [],
      pinnedViews: [],
      shares: {},
      splitTopRatio: RIGHT_PANEL_SPLIT_DEFAULT_RATIO,
    })
    expect(selectRightPanelSplit(s)).toBeNull()
    expect(selectRightPanelDisplayMode(s)).toBe('single')
  })

  it('the per-session default carries the always-open Tasks and Diff tabs', () => {
    expect(defaultRightPanelTabs()).toEqual(['tasks', 'diff'])
    expect(DEFAULT_RIGHT_PANEL_TABS).toEqual(['tasks', 'diff'])
    const s = sessionState()
    // Visible + focused are per-session in-memory state, but the ALWAYS-open
    // tabs exist from the start (the strip shows them whenever the panel is
    // opened) — with NO body mounted until one of them is activated.
    expect(s).toMatchObject({
      visible: false,
      activeView: null,
      tabs: ['tasks', 'diff'],
      pinnedViews: [],
    })
    expect(selectRightPanelDisplayMode(s)).toBe('tabs')
  })

  it('recognizes fixed AND per-file view ids', () => {
    expect(isRightPanelViewId('plan')).toBe(true)
    expect(isRightPanelViewId('tasks')).toBe(true)
    // The Skill view (opened from a Skill card's "View skill").
    expect(isRightPanelViewId('skill')).toBe(true)
    expect(isDefaultRightPanelTab('skill')).toBe(false)
    // Files are dynamic `file:<path>` ids, validated by prefix.
    expect(isRightPanelViewId('file:D:/a/b/foo.cc')).toBe(true)
    expect(isRightPanelViewId(fileViewId('/repo/x.ts'))).toBe(true)
    expect(fileViewPath(fileViewId('/repo/x.ts'))).toBe('/repo/x.ts')
    expect(isFileViewId(fileViewId('/repo/x.ts'))).toBe(true)
    expect(isFileViewId('diff')).toBe(false)
    // 'files' is no longer a view id (files are per-file).
    expect(isRightPanelViewId('files')).toBe(false)
    expect(isRightPanelViewId('nope')).toBe(false)
    expect(isRightPanelViewId(42)).toBe(false)
  })

  it('tags the always-open views (tasks / diff) but not others', () => {
    expect(isDefaultRightPanelTab('tasks')).toBe(true)
    expect(isDefaultRightPanelTab('diff')).toBe(true)
    expect(isDefaultRightPanelTab('plan')).toBe(false)
    expect(isDefaultRightPanelTab(fileViewId('/repo/x.ts'))).toBe(false)
    // Doubles as the validator for the PERSISTED restore target, so it must
    // reject non-strings too (a corrupt / hand-edited storage blob).
    expect(isDefaultRightPanelTab(undefined)).toBe(false)
    expect(isDefaultRightPanelTab(null)).toBe(false)
    expect(isDefaultRightPanelTab(42)).toBe(false)
  })
})

describe('opening views', () => {
  it('opening a view makes it the active tab and shows the panel', () => {
    const s = openView(defaultRightPanelState(), 'plan')
    expect(s).toMatchObject({ visible: true, activeView: 'plan', tabs: ['plan'] })
    expect(selectRightPanelSplit(s)).toBeNull()
  })

  it('a default (always-open) view is already a tab — opening it focuses it', () => {
    const s = openView(sessionState(), 'diff')
    expect(s).toMatchObject({
      visible: true,
      activeView: 'diff',
      tabs: ['tasks', 'diff'],
    })
    // Focusing an always-open tab never duplicates it.
    const again = openView(s, 'diff')
    expect(again.tabs).toEqual(['tasks', 'diff'])
    expect(again).toBe(s) // no-op → same reference (no storage thrash)
  })

  it('opening a second view does NOT auto-split — it becomes the active tab', () => {
    const s = openView(openView(defaultRightPanelState(), 'plan'), 'tasks')
    expect(s.tabs).toEqual(['plan', 'tasks'])
    expect(s.activeView).toBe('tasks')
    expect(s.pinnedViews).toEqual([])
    expect(selectRightPanelSplit(s)).toBeNull()
    expect(selectRightPanelDisplayMode(s)).toBe('tabs')
  })

  it('re-opening an existing view does not duplicate the tab', () => {
    let s = openView(defaultRightPanelState(), 'plan')
    s = openView(openView(s, 'tasks'), 'plan')
    expect(s.tabs).toEqual(['plan', 'tasks'])
    expect(s.activeView).toBe('plan')
  })

  it('setActiveView switches focus only among open tabs', () => {
    const s = openView(openView(defaultRightPanelState(), 'plan'), 'tasks')
    expect(setActiveView(s, 'plan').activeView).toBe('plan')
    // not a tab → no-op
    expect(setActiveView(s, 'diff')).toBe(s)
  })
})

describe('pinning & split', () => {
  it('pinning two views creates the derived vertical split', () => {
    let s = openView(openView(defaultRightPanelState(), 'plan'), 'tasks')
    s = pinView(pinView(s, 'plan'), 'tasks')
    expect(s.pinnedViews).toEqual(['plan', 'tasks'])
    expect(selectRightPanelSplit(s)).toEqual({
      topView: 'plan',
      bottomView: 'tasks',
      topRatio: RIGHT_PANEL_SPLIT_DEFAULT_RATIO,
    })
    expect(selectRightPanelDisplayMode(s)).toBe('splitVertical')
  })

  it('pinning a view auto-opens it as a tab', () => {
    const s = pinView(defaultRightPanelState(), 'plan')
    expect(s.tabs).toContain('plan')
    expect(s.pinnedViews).toEqual(['plan'])
    expect(s.visible).toBe(true)
    // one pinned view is not a split
    expect(selectRightPanelSplit(s)).toBeNull()
  })

  it('pinning a third view drops the oldest pinned (kept as a tab)', () => {
    let s = defaultRightPanelState()
    s = pinView(s, 'plan')
    s = pinView(s, 'tasks')
    s = pinView(s, 'diff')
    expect(s.pinnedViews).toEqual(['tasks', 'diff'])
    expect(s.tabs).toEqual(['plan', 'tasks', 'diff']) // plan stays a tab
    expect(selectRightPanelSplit(s)).toMatchObject({
      topView: 'tasks',
      bottomView: 'diff',
    })
  })

  it('unpinning collapses the split but keeps the tab', () => {
    let s = pinView(pinView(defaultRightPanelState(), 'plan'), 'tasks')
    s = unpinView(s, 'plan')
    expect(s.pinnedViews).toEqual(['tasks'])
    expect(s.tabs).toEqual(['plan', 'tasks'])
    expect(selectRightPanelSplit(s)).toBeNull()
  })

  it('unpinning a non-pinned view is a no-op', () => {
    const s = openView(defaultRightPanelState(), 'plan')
    expect(unpinView(s, 'plan')).toBe(s)
  })
})

describe('closing views', () => {
  it('closing the active view reassigns active to a remaining tab', () => {
    let s = openView(openView(defaultRightPanelState(), 'plan'), 'tasks')
    s = closeView(s, 'plan')
    expect(s.tabs).toEqual(['tasks'])
    expect(s.activeView).toBe('tasks')
    expect(s.visible).toBe(true)
  })

  it('closing the last view hides the panel and clears active', () => {
    let s = openView(defaultRightPanelState(), 'plan')
    s = closeView(s, 'plan')
    expect(s.tabs).toEqual([])
    expect(s.activeView).toBeNull()
    expect(s.visible).toBe(false)
  })

  it('the always-open Tasks / Diff tabs can NEVER be closed', () => {
    const s = openView(openView(sessionState(), 'plan'), 'diff')
    expect(closeView(s, 'tasks')).toBe(s)
    expect(closeView(s, 'diff')).toBe(s)
    expect(s.tabs).toEqual(['tasks', 'diff', 'plan'])
  })

  it('closing a pinned view removes it from the split', () => {
    let s = pinView(pinView(defaultRightPanelState(), 'plan'), 'tasks')
    s = closeView(s, 'plan')
    expect(s.pinnedViews).toEqual(['tasks'])
    expect(selectRightPanelSplit(s)).toBeNull()
  })

  it('closing the ACTIVE pane of a split keeps focus on the surviving pinned pane, not the activation history', () => {
    // pin A, pin B (split, active B), focus a non-pinned tab C, focus B again —
    // so the history top is C. Closing the active pinned B must land on the
    // surviving pinned A, NOT C.
    let s = pinView(pinView(defaultRightPanelState(), 'plan'), fileViewId('b.ts'))
    s = openView(s, 'tasks') // focus C (non-pinned)
    s = setActiveView(s, fileViewId('b.ts')) // back onto the pinned pane
    s = closeView(s, fileViewId('b.ts'))
    expect(s.activeView).toBe('plan') // surviving pinned pane, not 'tasks'
    expect(s.pinnedViews).toEqual(['plan'])
  })

  it('closing the active tab returns to the PREVIOUSLY active tab, not the first (tasks)', () => {
    // Regression: opening a new tab from `diff` and closing it used to snap back
    // to `tabs[0]` (`tasks`). It should return to `diff`.
    let s = openView(openView(openView(defaultRightPanelState(), 'tasks'), 'diff'), 'plan')
    expect(s.activeView).toBe('plan') // the freshly opened tab
    s = closeView(s, 'plan')
    expect(s.activeView).toBe('diff') // back to where we opened it from
    expect(s.tabs).toEqual(['tasks', 'diff'])
  })

  it('unwinds the activation stack across nested opens/closes', () => {
    let s = openView(defaultRightPanelState(), 'tasks')
    s = openView(s, fileViewId('a.ts')) // active a, history [tasks]
    s = openView(s, fileViewId('b.ts')) // active b, history [tasks, a]
    s = closeView(s, fileViewId('b.ts'))
    expect(s.activeView).toBe(fileViewId('a.ts')) // back to a
    s = closeView(s, fileViewId('a.ts'))
    expect(s.activeView).toBe('tasks') // then to tasks
    expect(s.activationHistory).toEqual([])
  })

  it('falls back to the first remaining tab when the closed tab has no prior focus history', () => {
    // A tab added WITHOUT being focused (ensureRightPanelTab) leaves no history,
    // so closing the active view falls back to the first remaining tab.
    let s = openView(defaultRightPanelState(), 'plan') // active plan, history []
    s = ensureRightPanelTab(s, 'diff') // tabs [plan, diff], still active plan
    s = closeView(s, 'plan')
    expect(s.activeView).toBe('diff')
  })

  it('closing a NON-active tab leaves the focus (and stack) alone but prunes it', () => {
    let s = openView(openView(openView(defaultRightPanelState(), 'tasks'), fileViewId('a.ts')), 'plan')
    // active plan, history [tasks, file:a.ts]
    s = closeView(s, fileViewId('a.ts')) // not the active tab
    expect(s.activeView).toBe('plan')
    expect(s.activationHistory).toEqual(['tasks'])
  })
})

describe('width, ratio & visibility', () => {
  it('sets the remembered shares, returning the same state when they are unchanged', () => {
    const s = defaultRightPanelState()
    const shares = { diff: 0.5 }
    const next = setRightPanelShares(s, shares)
    expect(next.shares).toBe(shares)
    expect(setRightPanelShares(next, shares)).toBe(next)
  })

  it('clamps split ratio and rejects non-finite', () => {
    const s = defaultRightPanelState()
    expect(setRightPanelSplitRatio(s, 0.01).splitTopRatio).toBe(
      RIGHT_PANEL_SPLIT_MIN_RATIO,
    )
    expect(setRightPanelSplitRatio(s, 0.99).splitTopRatio).toBe(
      RIGHT_PANEL_SPLIT_MAX_RATIO,
    )
    expect(setRightPanelSplitRatio(s, Number.NaN).splitTopRatio).toBe(
      RIGHT_PANEL_SPLIT_DEFAULT_RATIO,
    )
  })

  it('cannot become visible with no tabs', () => {
    const s = setRightPanelVisible(defaultRightPanelState(), true)
    expect(s.visible).toBe(false)
  })

  it('hide (setRightPanelVisible false) keeps the always-open tabs for re-show', () => {
    const s = setRightPanelVisible(sessionState(), false)
    expect(s.visible).toBe(false)
    expect(s.tabs).toEqual(['tasks', 'diff'])
  })
})

// A panel shown without a named view must land on a REAL tab. It used to focus
// nothing, leaving the two always-open strip buttons over an empty container
// until the user clicked one.
describe('showRightPanel — restoring the active tab', () => {
  it('focuses Tasks on a cold open (nothing focused, no preference)', () => {
    expect(RIGHT_PANEL_DEFAULT_ACTIVE_VIEW).toBe('tasks')
    const s = showRightPanel(sessionState())
    expect(s).toMatchObject({ visible: true, activeView: 'tasks' })
    expect(s.tabs).toEqual(['tasks', 'diff'])
    // Already showing that tab → no-op (same reference, no storage thrash).
    expect(showRightPanel(s)).toBe(s)
  })

  it('honours the remembered tab when the session has focused nothing', () => {
    const s = showRightPanel(sessionState(), 'diff')
    expect(s).toMatchObject({ visible: true, activeView: 'diff' })
    expect(restoredRightPanelView(sessionState(), 'diff')).toBe('diff')
  })

  it("keeps THIS session's own active tab over the remembered one", () => {
    // Hiding retains `activeView`, so re-showing returns the user to whatever
    // they were last looking at in this session — the preference is only a
    // fallback for a session that has never focused a tab.
    const hidden = setRightPanelVisible(setActiveView(sessionState(), 'diff'), false)
    expect(showRightPanel(hidden, 'tasks')).toMatchObject({
      visible: true,
      activeView: 'diff',
    })
  })

  it('falls back to the first tab when neither names an open one', () => {
    // A per-file tab strip whose remembered `tasks` was somehow not open:
    // never show an empty body.
    const s: RightPanelState = { ...defaultRightPanelState(), tabs: ['plan'] }
    expect(showRightPanel(s, 'tasks')).toMatchObject({
      visible: true,
      activeView: 'plan',
    })
    expect(restoredRightPanelView(s, 'tasks')).toBe('plan')
  })

  it('still cannot show a panel that has no tabs at all', () => {
    const s = showRightPanel(defaultRightPanelState())
    expect(s).toMatchObject({ visible: false, activeView: null })
    expect(restoredRightPanelView(defaultRightPanelState())).toBeNull()
  })

  it('re-focuses when the preference names a tab the panel is already showing', () => {
    // Visible but focused on nothing (a state only reachable from an older
    // in-memory session): showing again must still land on a tab.
    const s: RightPanelState = { ...sessionState(), visible: true }
    expect(showRightPanel(s, 'diff')).toMatchObject({
      visible: true,
      activeView: 'diff',
    })
  })
})

describe('session / geometry split (P6 persistence scoping)', () => {
  it('defaults split into showing state vs geometry', () => {
    expect(defaultRightPanelSession()).toEqual({
      visible: false,
      activeView: null,
      tabs: ['tasks', 'diff'],
      pinnedViews: [],
      activationHistory: [],
    })
    expect(defaultRightPanelGeometry()).toEqual({
      shares: {},
      splitTopRatio: RIGHT_PANEL_SPLIT_DEFAULT_RATIO,
    })
  })

  it('pick extracts the two halves; combine recombines losslessly', () => {
    let s = pinView(openView(openView(defaultRightPanelState(), 'plan'), 'tasks'), 'plan')
    s = setRightPanelShares(setRightPanelSplitRatio(s, 0.4), { file: 0.55 })
    expect(pickRightPanelSession(s)).toEqual({
      visible: true,
      activeView: 'plan',
      tabs: ['plan', 'tasks'],
      pinnedViews: ['plan'],
      // opened plan (→history []), focused tasks (→[plan]), pinned plan (→[plan,
      // tasks]): the full prior-focus order, most-recent last.
      activationHistory: ['plan', 'tasks'],
    })
    expect(pickRightPanelGeometry(s)).toEqual({ shares: { file: 0.55 }, splitTopRatio: 0.4 })
    expect(
      combineRightPanelState(pickRightPanelSession(s), pickRightPanelGeometry(s)),
    ).toEqual(s)
  })

  it('equality compares each half independently', () => {
    const session = defaultRightPanelSession()
    expect(rightPanelSessionEquals(session, defaultRightPanelSession())).toBe(true)
    expect(rightPanelSessionEquals(session, { ...session, visible: true })).toBe(false)
    expect(
      rightPanelSessionEquals(session, { ...session, tabs: ['tasks'] }),
    ).toBe(false)

    const geometry = defaultRightPanelGeometry()
    expect(rightPanelGeometryEquals(geometry, defaultRightPanelGeometry())).toBe(true)
    expect(
      rightPanelGeometryEquals(geometry, { ...geometry, shares: { diff: 0.5 } }),
    ).toBe(false)
    expect(
      rightPanelGeometryEquals({ ...geometry, shares: { diff: 0.5 } }, { ...geometry, shares: { diff: 0.5 } }),
    ).toBe(true)
  })
})

// Regression: `updateRightPanel` persists whenever `next !== prev`, so a no-op
// action MUST return the SAME reference or it thrashes localStorage with a
// byte-identical blob on every redundant click. (matches unpinView/setActiveView
// non-tab, which already returned `state`.)
describe('no-op actions return the same state reference (no storage thrash)', () => {
  it('openView on the already-visible, focused tab is a no-op', () => {
    const s = openView(defaultRightPanelState(), 'tasks')
    expect(openView(s, 'tasks')).toBe(s)
  })

  it('openView still re-shows when the view is a tab but the panel is hidden', () => {
    const hidden = setRightPanelVisible(openView(defaultRightPanelState(), 'tasks'), false)
    const shown = openView(hidden, 'tasks')
    expect(shown).not.toBe(hidden)
    expect(shown.visible).toBe(true)
  })

  it('setActiveView on the already-active visible tab is a no-op', () => {
    const s = openView(openView(defaultRightPanelState(), 'plan'), 'tasks')
    expect(setActiveView(s, 'tasks')).toBe(s)
  })

  it('pinView on an already-pinned, active, visible tab is a no-op', () => {
    const s = pinView(openView(defaultRightPanelState(), 'plan'), 'plan')
    expect(pinView(s, 'plan')).toBe(s)
  })

  it('closeView on a view that is not open is a no-op', () => {
    const s = openView(defaultRightPanelState(), 'plan')
    expect(closeView(s, 'tasks')).toBe(s)
  })
})
// The maximized flag is transient view mode, not RightPanelState: it must not
// survive a session switch OR a panel close. `resetState` is what makes the
// second one stick — deriving false while leaving the shell's flag set meant a
// panel re-opened in the SAME session painted maximized again, hiding the
// conversation column the user never asked to hide.
describe('reconcileRightPanelMaximized', () => {
  it('paints maximized only while the panel is visible and the session held', () => {
    expect(
      reconcileRightPanelMaximized({
        maximizedState: true,
        panelVisible: true,
        sessionChanged: false,
      }),
    ).toEqual({ maximized: true, resetState: false })
  })

  it('a session switch clears the flag, not just the paint', () => {
    expect(
      reconcileRightPanelMaximized({
        maximizedState: true,
        panelVisible: true,
        sessionChanged: true,
      }),
    ).toEqual({ maximized: false, resetState: true })
  })

  it('closing the panel clears the flag, so re-opening it comes back normal-sized', () => {
    expect(
      reconcileRightPanelMaximized({
        maximizedState: true,
        panelVisible: false,
        sessionChanged: false,
      }),
    ).toEqual({ maximized: false, resetState: true })
    // …and the re-open itself (flag now cleared) is an ordinary normal-width render.
    expect(
      reconcileRightPanelMaximized({
        maximizedState: false,
        panelVisible: true,
        sessionChanged: false,
      }),
    ).toEqual({ maximized: false, resetState: false })
  })

  it('never asks for a reset when the flag is already false', () => {
    for (const panelVisible of [true, false]) {
      for (const sessionChanged of [true, false]) {
        expect(
          reconcileRightPanelMaximized({
            maximizedState: false,
            panelVisible,
            sessionChanged,
          }),
        ).toEqual({ maximized: false, resetState: false })
      }
    }
  })
})
