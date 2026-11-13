// @vitest-environment happy-dom
/** A side pane body's view state belongs to the session it was opened in (F-9). */
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import type { NexusTaskDetail, NexusTaskSummaryRow } from '../browser/bridge/protocol/ui'
import { SidePaneBody, type SidePaneContentProps } from '../browser/webview/panes/sidePanes'
import { createShellDismissDiffTarget, EMPTY_PANE_UI, type PaneSessionUi } from '../browser/webview/shellPaneActions'
import type { PlanPanelEntry } from '../components/assistant-ui/plan-panel-context'
import type { RightPanelDiffTarget } from '../components/assistant-ui/right-panel-content-context'
import type { TurnDiffMeta, TurnFileChange } from '../utils/turnDiffs'

afterEach(() => cleanup())

type BodyProps = Parameters<typeof SidePaneBody>[0]

function bodyProps(kind: BodyProps['kind'], overrides: Partial<SidePaneContentProps>): BodyProps {
  return {
    kind,
    planEntry: null,
    onPlanResolve: () => {},
    onClosePlan: () => {},
    taskRows: [],
    onCloseTasks: () => {},
    onTaskStop: () => {},
    onTaskResume: () => {},
    loadTaskTranscript: async () => null,
    ...overrides,
  }
}

function turn(filePath: string): TurnDiffMeta {
  return {
    turnIndex: 1,
    promptPreview: 'edit',
    timestamp: '2026-09-02T10:00:00.000Z',
    stats: { touchedFiles: 1, plusLines: 1, minusLines: 0 },
    files: [{ filePath, fileWasCreated: false, plusLines: 1, minusLines: 0 }],
  }
}

function change(filePath: string, line: string): TurnFileChange {
  return {
    filePath,
    fileWasCreated: false,
    plusLines: 1,
    minusLines: 0,
    hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [' a', `+${line}`] }],
  }
}

function taskRow(sessionId: string, description: string): NexusTaskSummaryRow {
  const now = Date.now()
  return {
    sessionId,
    spawnerSessionId: 'P',
    status: 'running',
    type: 'local_bash',
    description,
    command: description,
    startedAt: now - 5_000,
    lastActivityAt: now - 1_000,
  }
}

function plan(planText: string): PlanPanelEntry {
  return { toolCallId: `call-${planText}`, request: { toolName: 'ExitPlanMode', planText } } as PlanPanelEntry
}

const historyView = () => screen.getByTestId('turn-diff-history').getAttribute('data-view')

describe('SidePaneBody across a session switch', () => {
  it('drops the file diff another session opened from its history', async () => {
    const loadTurnDiffDetail = vi.fn(async () => [change('/a/one.ts', 'line-of-a')])
    const forA = bodyProps('diff', {
      activeSessionId: 'A',
      turnDiffHistory: [turn('/a/one.ts')],
      loadTurnDiffDetail,
    })
    const { rerender } = render(createElement(SidePaneBody, forA))
    fireEvent.click(screen.getByTestId('turn-diff-file'))
    await waitFor(() => expect(screen.getByText('line-of-a')).toBeTruthy())
    expect(historyView()).toBe('detail')

    // The same turn index exists in B; its Diff pane starts on B's own list.
    rerender(
      createElement(
        SidePaneBody,
        bodyProps('diff', {
          activeSessionId: 'B',
          turnDiffHistory: [turn('/b/two.ts')],
          loadTurnDiffDetail,
        }),
      ),
    )
    expect(historyView()).toBe('list')
    expect(screen.queryByTestId('turn-diff-detail')).toBeNull()
    expect(screen.queryByText('line-of-a')).toBeNull()
    expect(screen.getByTestId('turn-diff-file').textContent).toContain('two.ts')
    expect(loadTurnDiffDetail).toHaveBeenCalledTimes(1)
  })

  it('ignores a diff reply that lands after the switch', async () => {
    let reply: (files: TurnFileChange[]) => void = () => {}
    const loadTurnDiffDetail = vi.fn(
      () => new Promise<TurnFileChange[]>(resolve => { reply = resolve }),
    )
    const { rerender } = render(
      createElement(
        SidePaneBody,
        bodyProps('diff', { activeSessionId: 'A', turnDiffHistory: [turn('/a/one.ts')], loadTurnDiffDetail }),
      ),
    )
    fireEvent.click(screen.getByTestId('turn-diff-file'))
    rerender(
      createElement(
        SidePaneBody,
        bodyProps('diff', { activeSessionId: 'B', turnDiffHistory: [turn('/b/two.ts')], loadTurnDiffDetail }),
      ),
    )
    reply([change('/a/one.ts', 'line-of-a')])
    await Promise.resolve()
    expect(historyView()).toBe('list')
    expect(screen.queryByText('line-of-a')).toBeNull()
  })

  it('keeps the open file diff while the same session re-renders', async () => {
    const loadTurnDiffDetail = vi.fn(async () => [change('/a/one.ts', 'line-of-a')])
    const props = () =>
      bodyProps('diff', { activeSessionId: 'A', turnDiffHistory: [turn('/a/one.ts')], loadTurnDiffDetail })
    const { rerender } = render(createElement(SidePaneBody, props()))
    fireEvent.click(screen.getByTestId('turn-diff-file'))
    await waitFor(() => expect(screen.getByText('line-of-a')).toBeTruthy())
    rerender(createElement(SidePaneBody, props()))
    expect(historyView()).toBe('detail')
    expect(screen.getByText('line-of-a')).toBeTruthy()
  })

  it('drops the task detail another session opened', async () => {
    const detail: NexusTaskDetail = { entries: [], info: null } as unknown as NexusTaskDetail
    const loadTaskTranscript = vi.fn(async () => detail)
    const { rerender } = render(
      createElement(
        SidePaneBody,
        bodyProps('tasks', { activeSessionId: 'A', taskRows: [taskRow('task-a', 'build of a')], loadTaskTranscript }),
      ),
    )
    fireEvent.click(screen.getByTestId('subagent-row-open'))
    await waitFor(() => expect(screen.getByTestId('background-tasks-detail')).toBeTruthy())
    const loadsInA = loadTaskTranscript.mock.calls.length

    rerender(
      createElement(
        SidePaneBody,
        bodyProps('tasks', { activeSessionId: 'B', taskRows: [taskRow('task-b', 'build of b')], loadTaskTranscript }),
      ),
    )
    expect(screen.queryByTestId('background-tasks-detail')).toBeNull()
    expect(screen.getByTestId('subagent-row-open').textContent).toContain('build of b')
    // B never asks for A's task.
    expect(loadTaskTranscript.mock.calls.slice(loadsInA)).toEqual([])
  })

  const feedbackBox = () => document.querySelector<HTMLTextAreaElement>('[data-slot="plan-panel-feedback"]')!

  it('keeps a plan feedback draft with its plan across a switch away and back', () => {
    const inA = bodyProps('plan', { activeSessionId: 'A', planEntry: plan('round trip of a') })
    const { rerender } = render(createElement(SidePaneBody, inA))
    fireEvent.change(feedbackBox(), { target: { value: 'feedback for a' } })
    rerender(
      createElement(SidePaneBody, bodyProps('plan', { activeSessionId: 'B', planEntry: plan('round trip of b') })),
    )
    expect(feedbackBox().value).toBe('')
    rerender(createElement(SidePaneBody, inA))
    expect(feedbackBox().value).toBe('feedback for a')
  })

  it('never shows a plan feedback draft under a different plan', () => {
    const { rerender } = render(
      createElement(SidePaneBody, bodyProps('plan', { activeSessionId: 'A', planEntry: plan('first plan of a') })),
    )
    fireEvent.change(feedbackBox(), { target: { value: 'about the first plan' } })
    rerender(
      createElement(SidePaneBody, bodyProps('plan', { activeSessionId: 'A', planEntry: plan('second plan of a') })),
    )
    expect(feedbackBox().value).toBe('')
  })

  it('drops the plan feedback draft once the plan resolves', async () => {
    const onPlanResolve = vi.fn()
    const inA = bodyProps('plan', { activeSessionId: 'A', planEntry: plan('resolved plan of a'), onPlanResolve })
    const { rerender } = render(createElement(SidePaneBody, inA))
    fireEvent.change(feedbackBox(), { target: { value: 'keep planning, please' } })
    fireEvent.click(document.querySelector('[data-slot="plan-panel-keep-planning"]')!)
    await waitFor(() => expect(onPlanResolve).toHaveBeenCalledWith('reject', 'keep planning, please'))
    rerender(
      createElement(SidePaneBody, bodyProps('plan', { activeSessionId: 'B', planEntry: plan('round trip of b') })),
    )
    rerender(createElement(SidePaneBody, inA))
    await waitFor(() => expect(feedbackBox().value).toBe(''))
  })

  it('keeps the A2UI mount element across the switch', () => {
    const { rerender } = render(createElement(SidePaneBody, bodyProps('a2ui', { activeSessionId: 'A' })))
    const pane = screen.getByTestId('a2ui-pane')
    rerender(createElement(SidePaneBody, bodyProps('a2ui', { activeSessionId: 'B' })))
    expect(screen.getByTestId('a2ui-pane')).toBe(pane)
  })
})

describe('going back from a file diff', () => {
  const FILE: RightPanelDiffTarget = { kind: 'file', filePath: '/a/one.ts', hunks: [], plusLines: 0, minusLines: 0 }

  it('reports the dismissal, so the target does not return with the session', () => {
    const onDismissDiffTarget = vi.fn()
    render(
      createElement(
        SidePaneBody,
        bodyProps('diff', { activeSessionId: 'A', diffTarget: FILE, onDismissDiffTarget }),
      ),
    )
    fireEvent.click(screen.getByTestId('turn-diff-detail-back'))
    expect(onDismissDiffTarget).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('diff-panel').getAttribute('data-diff-kind')).toBe('turn-history')
  })

  it('clears the file target of the shown session only', () => {
    const ui = new Map<string, PaneSessionUi>([
      ['A', { ...EMPTY_PANE_UI, diffTarget: FILE }],
      ['B', { ...EMPTY_PANE_UI, diffTarget: FILE }],
    ])
    const updatePaneUi = (sessionId: string, fn: (prev: PaneSessionUi) => PaneSessionUi) => {
      ui.set(sessionId, fn(ui.get(sessionId) ?? EMPTY_PANE_UI))
    }
    createShellDismissDiffTarget({ current: 'A' }, updatePaneUi)()
    expect(ui.get('A')?.diffTarget).toBeNull()
    expect(ui.get('B')?.diffTarget).toBe(FILE)
  })

  it('leaves a session showing its history untouched', () => {
    const before: PaneSessionUi = { ...EMPTY_PANE_UI, diffTarget: { kind: 'turnHistory' } }
    let after = before
    createShellDismissDiffTarget({ current: 'A' }, (_id, fn) => { after = fn(before) })()
    expect(after).toBe(before)
  })
})
