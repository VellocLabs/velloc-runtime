import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import type { PlanPanelEntry } from '@/components/assistant-ui/plan-panel-context'
import type { NexusTaskSummaryRow } from '@/browser/bridge/protocol/ui'
import { RightPanel, type RightPanelProps } from '@/browser/webview/RightPanel'
import {
  combineRightPanelState,
  defaultRightPanelGeometry,
  defaultRightPanelSession,
  defaultRightPanelState,
  fileViewId,
  openView,
  pinView,
  showRightPanel,
  type RightPanelState,
} from '@/browser/webview/layout/rightPanelManager'

// P1 (F-9): render the container the way
// MultiSessionShell mounts it (no extra providers) and assert the tab strip,
// the split, and the embedded-body chrome suppression — none of which `tsc`
// or `build` exercise because they never render.

const PLAN_ENTRY = {
  toolCallId: 'tool-1',
  request: { planText: 'Step 1. Do the thing.' },
} as unknown as PlanPanelEntry

function props(state: RightPanelState): RightPanelProps {
  return {
    state,
    width: state.widthPx,
    onActivateView: () => {},
    onCloseView: () => {},
    onSplitRatioChange: () => {},
    planEntry: PLAN_ENTRY,
    onPlanResolve: () => {},
    taskRows: [],
    onTaskStop: () => {},
    onTaskResume: () => {},
    loadTaskTranscript: async () => null,
  }
}

function render(state: RightPanelState): string {
  return renderToStaticMarkup(createElement(RightPanel, props(state)))
}

describe('RightPanel render', () => {
  it('mounts ONLY the visible body — a background tab shows its strip button without loading its body', () => {
    // Regression (lazy tasks): opening the panel with another view active must
    // render the Tasks TAB but not mount the tasks body until it is activated.
    const state = openView(openView(defaultRightPanelState(), 'tasks'), 'plan')
    const html = render(state)
    expect(html).toContain('data-testid="right-panel-tab-plan"')
    expect(html).toContain('data-testid="right-panel-tab-tasks"')
    // Plan is active → its body mounts; the background tasks tab does NOT.
    expect(html).toContain('data-testid="plan-details-panel"')
    expect(html).toContain('data-right-panel-body="plan"')
    expect(html).not.toContain('data-testid="background-tasks-drawer"')
    expect(html).not.toContain('data-right-panel-body="tasks"')
  })

  it('showing the panel cold renders BOTH tab buttons and mounts ONLY the restored one', () => {
    // The session defaults carry the always-open Tasks + Diff tabs; showing
    // the panel (topbar toggle) focuses one of them, so exactly one body
    // mounts — the panel never opens onto an empty container. The other stays
    // lazy until clicked.
    const state = showRightPanel(
      combineRightPanelState(
        defaultRightPanelSession(),
        defaultRightPanelGeometry(),
      ),
    )
    const html = render(state)
    expect(html).toContain('data-testid="right-panel-tab-tasks"')
    expect(html).toContain('data-testid="right-panel-tab-diff"')
    expect(html).toContain('data-testid="background-tasks-drawer"')
    expect(html).toContain('data-right-panel-body="tasks"')
    expect(html).not.toContain('data-testid="diff-panel"')
    expect(html).not.toContain('data-right-panel-body="diff"')
  })

  it('a remembered Diff preference opens the panel on Diff, leaving Tasks lazy', () => {
    const state = showRightPanel(
      combineRightPanelState(
        defaultRightPanelSession(),
        defaultRightPanelGeometry(),
      ),
      'diff',
    )
    const html = render(state)
    expect(html).toContain('data-right-panel-body="diff"')
    expect(html).not.toContain('data-testid="background-tasks-drawer"')
    expect(html).not.toContain('data-right-panel-body="tasks"')
  })

  it('the panel still renders nothing at all while hidden state has no tabs', () => {
    // Belt-and-braces on the tab-less edge: no tabs → no bodies, and the
    // restore never invents one.
    const html = render(showRightPanel(defaultRightPanelState()))
    expect(html).not.toContain('data-right-panel-body')
  })

  it('no tab shows a lock (pin) icon — pinning is gone', () => {
    const state = openView(
      openView(
        openView(
          combineRightPanelState(
            defaultRightPanelSession(),
            defaultRightPanelGeometry(),
          ),
          'plan',
        ),
        'tasks',
      ),
      'diff',
    )
    const html = render(state)
    expect(html).not.toContain('right-panel-pin-')
    expect(html).not.toContain('aria-label="Pin')
    expect(html).not.toContain('aria-label="Unpin')
    expect(html).not.toContain('lucide-pin')
  })

  it('every tab leads with its glyph: plan/tasks/diff/skills each their own, a file tab the document icon', () => {
    // Each strip button renders a lucide icon before its label so a wrapped or
    // truncated strip still identifies the view at a glance. Fixed views map
    // 1:1; every file view shares `lucide-file-text`.
    const base = combineRightPanelState(
      defaultRightPanelSession(),
      defaultRightPanelGeometry(),
    )
    const state = openView(
      openView(openView(base, 'plan'), 'skill'),
      fileViewId('D:/w/src/foo.cc'),
    )
    const html = render(state)
    const iconIn = (view: string): string | undefined =>
      html
        .split(`data-testid="right-panel-tab-${view}"`)[1]
        ?.split('</button>')[0]
        .match(/lucide-[a-z-]+/)?.[0]
    expect(iconIn('plan')).toBe('lucide-clipboard-list')
    expect(iconIn('tasks')).toBe('lucide-list-todo')
    expect(iconIn('diff')).toBe('lucide-file-diff')
    expect(iconIn('skill')).toBe('lucide-toolbox')
    expect(iconIn(fileViewId('D:/w/src/foo.cc'))).toBe('lucide-file-text')
  })

  it('wraps the tab strip onto multiple lines instead of scrolling horizontally', () => {
    const state = openView(openView(defaultRightPanelState(), 'plan'), 'tasks')
    const html = render(state)
    // The tablist wraps (flex-wrap), it does NOT get a horizontal scrollbar.
    expect(html).toMatch(/data-testid="right-panel-tabs"[^>]*class="[^"]*flex-wrap/)
    expect(html).not.toContain('overflow-x-auto')
  })

  it('renders a container-level close button at the strip end when onClosePanel is wired', () => {
    const state = openView(openView(defaultRightPanelState(), 'plan'), 'file:/repo/x.ts')
    // Wired → the panel-wide X renders (distinct from the per-tab close).
    const html = renderToStaticMarkup(
      createElement(RightPanel, { ...props(state), onClosePanel: () => {} }),
    )
    expect(html).toContain('data-testid="right-panel-close"')
    expect(html).toContain('aria-label="Close panel"')
    // A closeable tab still has its own X alongside the panel-wide one.
    expect(html).toContain('data-testid="right-panel-close-file:/repo/x.ts"')
    // Not wired → no dangling button.
    expect(render(state)).not.toContain('data-testid="right-panel-close"')
  })

  it('renders the maximize toggle next to the panel close, and swaps it for restore when maximized', () => {
    const state = openView(defaultRightPanelState(), 'plan')
    const normal = renderToStaticMarkup(
      createElement(RightPanel, {
        ...props(state),
        onClosePanel: () => {},
        onToggleMaximized: () => {},
      }),
    )
    expect(normal).toContain('data-testid="right-panel-maximize"')
    expect(normal).toContain('aria-label="Maximize panel"')
    // Not maximized → fixed width, and no maximized marker.
    expect(normal).toContain(`width:${state.widthPx}px`)
    expect(normal).not.toContain('data-maximized="true"')

    const maximized = renderToStaticMarkup(
      createElement(RightPanel, {
        ...props(state),
        onClosePanel: () => {},
        onToggleMaximized: () => {},
        maximized: true,
      }),
    )
    expect(maximized).toContain('aria-label="Restore panel size"')
    expect(maximized).toContain('data-maximized="true"')
    // Maximized → absorbs the row instead of rendering to the stored width.
    expect(maximized).not.toContain(`width:${state.widthPx}px`)
    expect(maximized).toMatch(/data-testid="right-panel"[^>]*class="[^"]*flex-1/)

    // Not wired → no dangling button.
    expect(render(state)).not.toContain('data-testid="right-panel-maximize"')
  })

  it('the always-open Tasks / Diff tabs have NO close button; others do', () => {
    const state = openView(
      openView(
        combineRightPanelState(
          defaultRightPanelSession(),
          defaultRightPanelGeometry(),
        ),
        'plan',
      ),
      fileViewId('/repo/x.ts'),
    )
    const html = render(state)
    expect(html).toContain('data-testid="right-panel-close-plan"')
    expect(html).toContain('data-testid="right-panel-close-file:/repo/x.ts"')
    expect(html).not.toContain('data-testid="right-panel-close-tasks"')
    expect(html).not.toContain('data-testid="right-panel-close-diff"')
  })

  it('the Skills tab has NO close button either — it is the one shared Skills tab, not a dismissable view', () => {
    const state = openView(
      combineRightPanelState(
        defaultRightPanelSession(),
        defaultRightPanelGeometry(),
      ),
      'skill',
    )
    const html = render(state)
    expect(html).toContain('data-testid="right-panel-tab-skill"')
    expect(html).not.toContain('data-testid="right-panel-close-skill"')
  })

  it('labels the Skills tab "Skills" (plural) — it lists the session\'s loaded skills, not one skill', () => {
    const state = openView(
      combineRightPanelState(
        defaultRightPanelSession(),
        defaultRightPanelGeometry(),
      ),
      'skill',
    )
    const html = render(state)
    expect(html).toContain('>Skills<')
  })

  it('embeds bodies WITHOUT their own panel headers', () => {
    const state = openView(defaultRightPanelState(), 'tasks')
    const html = render(state)
    expect(html).toContain('data-testid="background-tasks-drawer"')
    // the container owns the close affordance — the drawer must not render its own
    expect(html).not.toContain('data-testid="background-tasks-drawer-close"')
  })

  it('groups background tasks — running work in the always-open Running section, settled work by KIND, no status archive, no summary/session header', () => {
    const state = openView(defaultRightPanelState(), 'tasks')
    const taskRows: NexusTaskSummaryRow[] = [
      // no type ⇒ local_agent, settled → Sub-agents section
      { sessionId: 'sa-done', spawnerSessionId: 'P', status: 'success', description: 'AGENT_DESC' },
      // a RUNNING shell → the Running section (kind only files SETTLED work)
      { sessionId: 'b-1', spawnerSessionId: 'P', status: 'running', type: 'local_bash', description: 'SHELL_DESC', command: 'SHELL_DESC' },
    ]
    const html = renderToStaticMarkup(
      createElement(RightPanel, { ...props(state), taskRows }),
    )
    // A settled sub-agent files under its kind; a running task lives in Running.
    expect(html).toContain('data-testid="subagent-category-subagent"')
    expect(html).toContain('data-testid="subagent-category-running"')
    // The running shell is NOT in a Shell section — Shell holds only settled shells.
    expect(html).not.toContain('data-testid="subagent-category-shell"')
    // Only Running is expanded by default: the running shell shows, while the
    // settled sub-agent stays hidden under its collapsed Sub-agents header
    // (which still renders, with its success count).
    expect(html).toContain('SHELL_DESC')
    expect(html).not.toContain('AGENT_DESC')
    expect(html).toContain('data-testid="subagent-category-success-count"')
    // No status archive categories (running/failed/stopped/finished are gone).
    expect(html).not.toContain('data-testid="subagent-category-success"')
    // The old summary-header line ("N background sub-agents running") is gone.
    expect(html).not.toContain('background sub-agent running')
  })

  it('renders a local_bash task row with its COMMAND (mono) in place of an agent description', () => {
    const state = openView(defaultRightPanelState(), 'tasks')
    const taskRows: NexusTaskSummaryRow[] = [
      {
        sessionId: 'b1',
        spawnerSessionId: 'P',
        status: 'running',
        type: 'local_bash',
        description: 'shell',
        command: 'npm run build',
      },
    ]
    const html = renderToStaticMarkup(
      createElement(RightPanel, { ...props(state), taskRows }),
    )
    // Running section expanded (a running shell lives there) → the bash row
    // shows its command in a mono label (the kind-agnostic drawer picks each
    // row's renderer by `task.type`).
    expect(html).toContain('npm run build')
    expect(html).toContain('font-mono')
  })

  it('embeds the plan body without its own header', () => {
    const state = openView(defaultRightPanelState(), 'plan')
    const html = render(state)
    expect(html).toContain('data-testid="plan-details-panel"')
    expect(html).not.toContain('data-testid="plan-details-panel-close"')
    expect(html).toContain('Step 1. Do the thing.')
  })

  it('renders both bodies and the split divider when two views are pinned', () => {
    let state = openView(openView(defaultRightPanelState(), 'plan'), 'tasks')
    state = pinView(pinView(state, 'plan'), 'tasks')
    const html = render(state)
    expect(html).toContain('data-testid="plan-details-panel"')
    expect(html).toContain('data-testid="background-tasks-drawer"')
    expect(html).toContain('aria-label="Resize split"')
    expect(html).toContain('aria-orientation="horizontal"')
  })

  it('keeps the pinned bodies MOUNTED when an unpinned third view is active', () => {
    // Regression: with two views pinned, opening an unpinned third tab must NOT
    // unmount the pinned split bodies (else their transient state — the plan
    // textarea, the tasks detail nav — is lost). The active third view overlays
    // the split; both pinned bodies stay in the tree.
    let state = openView(openView(defaultRightPanelState(), 'plan'), 'tasks')
    state = pinView(pinView(state, 'plan'), 'tasks')
    state = openView(state, fileViewId('/repo/x.ts')) // active = unpinned third tab
    const html = renderToStaticMarkup(
      createElement(RightPanel, { ...props(state), readFileText: async () => 'x' }),
    )
    // The active (file) body shows on top…
    expect(html).toContain('data-testid="file-panel"')
    expect(html).toContain('/repo/x.ts')
    // …and the pinned bodies remain mounted underneath.
    expect(html).toContain('data-testid="plan-details-panel"')
    expect(html).toContain('data-testid="background-tasks-drawer"')
  })

  it('renders a file view as its own tab, labelled by the base name (not "Files")', () => {
    const state = openView(defaultRightPanelState(), fileViewId('/repo/src/foo.ts'))
    const html = render(state)
    // The tab id carries the path; its label is the base name.
    expect(html).toContain('data-testid="right-panel-tab-file:/repo/src/foo.ts"')
    // The label is the button's text span (a glyph precedes it).
    expect(html).toContain('>foo.ts</span></button>')
    expect(html).not.toContain('>Files</span></button>')
    expect(html).toContain('data-testid="file-panel"')
    expect(html).not.toContain('coming soon')
  })

  // Regression: Diff is an ALWAYS-OPEN tab, so clicking it in the strip (or the
  // panel restoring onto it) arrives with `diffTarget: null` — only the composer
  // diff chip and the Edit-card title ever set a target. The tab used to render
  // a "No diff open" dead end, so the same session showed its diffs through the
  // chip and nothing at all through the tab. A bare Diff tab now means the
  // session's turn history.
  it('renders the turn-diff history in the Diff view when no diff target is set', () => {
    const state = openView(defaultRightPanelState(), 'diff')
    const html = renderToStaticMarkup(
      createElement(RightPanel, {
        ...props(state),
        turnDiffHistory: [
          {
            turnIndex: 1,
            promptPreview: 'do the thing',
            stats: { touchedFiles: 1, plusLines: 3, minusLines: 1 },
            files: [
              {
                filePath: '/repo/src/foo.ts',
                fileWasCreated: false,
                plusLines: 3,
                minusLines: 1,
              },
            ],
          },
        ],
        loadTurnDiffDetail: async () => null,
      }),
    )
    expect(html).toContain('data-testid="right-panel-tab-diff"')
    expect(html).toContain('data-diff-kind="turn-history"')
    expect(html).toContain('/repo/src/foo.ts')
    expect(html).not.toContain('No diff open')
    expect(html).not.toContain('coming soon')
  })

  it('the target-less Diff view falls back to "no changes yet" when the session has no history', () => {
    const state = openView(defaultRightPanelState(), 'diff')
    const html = render(state)
    expect(html).toContain('No changes yet')
    expect(html).not.toContain('No diff open')
  })

  it('opens a SECOND file in its OWN tab (does not replace the first)', () => {
    let state = openView(defaultRightPanelState(), fileViewId('/repo/a.ts'))
    state = openView(state, fileViewId('/repo/b.ts'))
    const html = renderToStaticMarkup(
      createElement(RightPanel, { ...props(state), readFileText: async () => 'x' }),
    )
    // Two distinct file tabs coexist; only the ACTIVE one (b.ts) mounts a body
    // on this first render — a.ts was never visible here (lazy bodies).
    expect(html).toContain('data-testid="right-panel-tab-file:/repo/a.ts"')
    expect(html).toContain('data-testid="right-panel-tab-file:/repo/b.ts"')
    expect(html).not.toContain('data-right-panel-body="file:/repo/a.ts"')
    expect(html).toContain('data-right-panel-body="file:/repo/b.ts"')
  })

  it('renders a file view body for its path', () => {
    const state = openView(defaultRightPanelState(), fileViewId('/repo/src/foo.ts'))
    const html = renderToStaticMarkup(
      createElement(RightPanel, {
        ...props(state),
        readFileText: async () => 'line one\nline two\n',
      }),
    )
    // Server render shows the path header (the content arrives via effect).
    expect(html).toContain('data-testid="file-panel"')
    expect(html).toContain('/repo/src/foo.ts')
  })

  it('renders the Diff view body with the +/- counts for a file diff target', () => {
    const state = openView(defaultRightPanelState(), 'diff')
    const html = renderToStaticMarkup(
      createElement(RightPanel, {
        ...props(state),
        diffTarget: {
          kind: 'file',
          filePath: '/repo/src/foo.ts',
          plusLines: 3,
          minusLines: 1,
          hunks: [
            {
              oldStart: 1,
              oldLines: 1,
              newStart: 1,
              newLines: 3,
              lines: [' a', '+b', '+c', '-d'],
            },
          ],
        },
      }),
    )
    expect(html).toContain('data-testid="diff-panel"')
    expect(html).toContain('/repo/src/foo.ts')
    expect(html).toContain('+3')
    expect(html).toContain('-1')
  })

  it('renders the turn-diff history in the Diff view for a turnHistory target', () => {
    const state = openView(defaultRightPanelState(), 'diff')
    const html = renderToStaticMarkup(
      createElement(RightPanel, {
        ...props(state),
        diffTarget: { kind: 'turnHistory' },
        turnDiffHistory: [
          {
            turnIndex: 1,
            promptPreview: 'do the thing',
            timestamp: '2026-09-02T10:00:00.000Z',
            stats: { touchedFiles: 1, plusLines: 7, minusLines: 2 },
            files: [
              { filePath: '/repo/x.ts', fileWasCreated: false, plusLines: 7, minusLines: 2 },
            ],
          },
        ],
        loadTurnDiffDetail: async () => null,
      }),
    )
    // The Diff view now hosts the whole "Changes this turn" history (not a
    // single file), as a master/detail split: the turn + file list on top and
    // an empty detail prompt on the bottom (no file selected on first render).
    expect(html).toContain('data-testid="diff-panel"')
    expect(html).not.toMatch(/\bTurn \d+/)
    expect(html).toContain(new Date('2026-09-02T10:00:00.000Z').toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }))
    expect(html).toContain('/repo/x.ts')
    expect(html).toContain('Select a changed file')
  })
})
