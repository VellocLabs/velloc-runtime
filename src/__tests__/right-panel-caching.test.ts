// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { cleanup, render } from '@testing-library/react'

import type { PlanPanelEntry } from '@/components/assistant-ui/plan-panel-context'
import { RightPanel, type RightPanelProps } from '@/browser/webview/RightPanel'
import {
  RIGHT_PANEL_MAX_MOUNTED_BODIES,
  combineRightPanelState,
  defaultRightPanelGeometry,
  defaultRightPanelSession,
  defaultRightPanelState,
  fileViewId,
  openView,
  setActiveView,
  type RightPanelState,
  type RightPanelViewId,
} from '@/browser/webview/layout/rightPanelManager'

// Tab-body lifecycle: a body mounts LAZILY on first activation, then stays
// mounted (state cached — the diff view's selected file, a scroll position)
// across tab switches WITHIN a session; a session switch releases every body
// except the incoming session's visible views, and re-activating a released
// tab re-mounts (reloads) it fresh.

afterEach(() => cleanup())

/** A full state with the always-open per-session tabs (tasks + diff). */
function sessionState(): RightPanelState {
  return combineRightPanelState(
    defaultRightPanelSession(),
    defaultRightPanelGeometry(),
  )
}

function props(
  state: RightPanelState,
  sessionId = 's1',
  protectedViews?: ReadonlySet<string>,
  handlers?: {
    onClosePanel?: () => void
    onCloseView?: (view: RightPanelViewId) => void
  },
): RightPanelProps {
  return {
    state,
    sessionId,
    protectedViews: protectedViews as RightPanelProps['protectedViews'],
    width: state.widthPx,
    onActivateView: () => {},
    onCloseView: handlers?.onCloseView ?? (() => {}),
    onClosePanel: handlers?.onClosePanel,
    onSplitRatioChange: () => {},
    planEntry: { toolCallId: 't', request: { planText: 'P' } } as unknown as PlanPanelEntry,
    onPlanResolve: () => {},
    taskRows: [],
    onTaskStop: () => {},
    onTaskResume: () => {},
    loadTaskTranscript: async () => null,
    readFileText: async () => 'contents',
  }
}

const FILE_VIEW = fileViewId('/repo/x.ts')
const body = (container: HTMLElement, view: string) =>
  container.querySelector(`[data-right-panel-body="${view}"]`)

describe('RightPanel — tab bodies are cached across switches', () => {
  it('mounts a body on FIRST activation and keeps it mounted (same DOM node) across switches', () => {
    // Start from the session defaults: the always-open Tasks / Diff strip
    // buttons exist but NO body is mounted (lazy) until a tab is activated.
    const { container, rerender } = render(
      createElement(RightPanel, props(sessionState())),
    )
    expect(body(container, 'diff')).toBeNull()
    expect(body(container, 'tasks')).toBeNull()

    // Activate diff → its body mounts for the first time; tasks stays lazy.
    let state = setActiveView(sessionState(), 'diff')
    rerender(createElement(RightPanel, props(state)))
    const diffBefore = body(container, 'diff')
    expect(diffBefore).not.toBeNull()
    expect(body(container, 'tasks')).toBeNull()

    // Open + activate the file → it mounts; the diff body stays (cached).
    state = openView(state, FILE_VIEW)
    rerender(createElement(RightPanel, props(state)))
    const filesBefore = body(container, FILE_VIEW)
    expect(filesBefore).not.toBeNull()
    expect(body(container, 'diff')).toBe(diffBefore)

    // Switch back → the SAME element instances survive (state preserved).
    rerender(createElement(RightPanel, props(setActiveView(state, 'diff'))))
    expect(body(container, 'diff')).toBe(diffBefore)
    expect(body(container, FILE_VIEW)).toBe(filesBefore)
  })

  it('a session switch RELEASES background bodies and remounts the visible one fresh', () => {
    // Session s1: activate both views so both bodies are mounted/cached.
    let state = openView(openView(sessionState(), FILE_VIEW), 'diff')
    state = setActiveView(state, FILE_VIEW)
    const { container, rerender } = render(createElement(RightPanel, props(state, 's1')))
    rerender(createElement(RightPanel, props(setActiveView(state, 'diff'), 's1')))
    const s1Diff = body(container, 'diff')
    expect(body(container, FILE_VIEW)).not.toBeNull()
    expect(s1Diff).not.toBeNull()

    // Switch to session s2 (same tabs, diff active): the background file body
    // is RELEASED; the visible diff body remounts as a NEW node (per-session
    // keying — s1's view state must not leak into s2).
    rerender(createElement(RightPanel, props(setActiveView(state, 'diff'), 's2')))
    expect(body(container, FILE_VIEW)).toBeNull()
    const s2Diff = body(container, 'diff')
    expect(s2Diff).not.toBeNull()
    expect(s2Diff).not.toBe(s1Diff)

    // Clicking the released background tab re-mounts (reloads) its body.
    rerender(createElement(RightPanel, props(setActiveView(state, FILE_VIEW), 's2')))
    expect(body(container, FILE_VIEW)).not.toBeNull()
  })

  it('the Tasks drawer Esc closes the PANEL (hide), not the always-open tab', () => {
    // The Tasks tab can never be closed, so the drawer's Esc (its list-level
    // onClose) must hide the panel column instead — routing to the panel-wide
    // close, never to closeView('tasks').
    const closedPanel: boolean[] = []
    const closedView: RightPanelViewId[] = []
    let state = setActiveView(sessionState(), 'tasks')
    const { container, rerender } = render(
      createElement(RightPanel, props(state, 's1', undefined, {
        onClosePanel: () => { closedPanel.push(true) },
        onCloseView: view => { closedView.push(view) },
      })),
    )
    expect(body(container, 'tasks')).not.toBeNull()

    // Esc keydown inside the drawer's document — the drawer's handler calls
    // onClose at the list level.
    container.ownerDocument.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    )
    expect(closedPanel).toHaveLength(1)
    expect(closedView, 'closeView must never be called for the default tab')
        .toEqual([])

    // And the tab survives the panel close (panel hides; tabs retained).
    rerender(createElement(RightPanel, props(
        { ...state, visible: false }, 's1', undefined, {
          onClosePanel: () => { closedPanel.push(true) },
          onCloseView: view => { closedView.push(view) },
        })))
    expect(body(container, 'tasks')).not.toBeNull()
  })
})

// The cache is BOUNDED. Before the bound it only ever grew, so a session in
// which the user opened twenty files kept twenty live CodeMirror editors
// mounted (hidden), each holding the file text twice. Past the cap the
// least-recently-visible body is released — but never one the user would
// notice losing.

// Two past the cap, so a protected view can be kept ON TOP of a full cache and
// there is still something left over to release.
const VISIT_ORDER = Array.from({ length: RIGHT_PANEL_MAX_MOUNTED_BODIES + 2 },
  (_, i) => fileViewId(`/repo/f${i}.ts`))

/** Open every view, then activate them in order, leaving the last one active. */
function visitAll(
  protectedViews?: ReadonlySet<string>,
): ReturnType<typeof render> & { state: RightPanelState } {
  // Start from the session defaults: the always-open Tasks / Diff bodies are
  // mounted (activated below), so the FILE cap still has its own budget.
  let state = VISIT_ORDER.reduce(
    (acc, view) => openView(acc, view), sessionState())
  state = setActiveView(state, 'tasks')
  state = setActiveView(state, VISIT_ORDER[0])
  const result = render(
    createElement(RightPanel, props(state, 's1', protectedViews)))
  for (const view of VISIT_ORDER.slice(1)) {
    state = setActiveView(state, view)
    result.rerender(
      createElement(RightPanel, props(state, 's1', protectedViews)))
  }
  // Activate the tasks body LAST so the file visits order the LRU correctly
  // (tasks was activated before the file loop; it must not push a file out).
  state = setActiveView(state, 'tasks')
  result.rerender(createElement(RightPanel, props(state, 's1', protectedViews)))
  return Object.assign(result, { state })
}

describe('RightPanel — the body cache is bounded', () => {
  it('releases the least-recently-visible body past the cap', () => {
    const { container } = visitAll()
    const mounted = VISIT_ORDER.filter(v => body(container, v) !== null)
    expect(mounted).toHaveLength(RIGHT_PANEL_MAX_MOUNTED_BODIES)
    // Visited first, so released first.
    expect(body(container, VISIT_ORDER[0])).toBeNull()
    // The active one is obviously still there.
    expect(body(container, VISIT_ORDER.at(-1)!)).not.toBeNull()
  })

  it('never releases a view with unsaved edits', () => {
    // Same visit order, but the first file's editor is dirty — releasing it
    // would throw away the user's typing, so it must survive the cap.
    const { container } = visitAll(new Set([VISIT_ORDER[0]]))
    expect(body(container, VISIT_ORDER[0])).not.toBeNull()
    expect(body(container, VISIT_ORDER.at(-1)!)).not.toBeNull()
    // It is kept ON TOP of a full cache, so the next-oldest is released
    // instead — the cap still did its job.
    const mounted = VISIT_ORDER.filter(v => body(container, v) !== null)
    expect(mounted).toHaveLength(RIGHT_PANEL_MAX_MOUNTED_BODIES + 1)
    expect(body(container, VISIT_ORDER[1])).toBeNull()
  })
})
