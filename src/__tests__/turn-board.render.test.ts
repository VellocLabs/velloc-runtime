// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { cleanup, fireEvent, render, renderHook } from '@testing-library/react'

import {
  TurnClosingBoxView,
  TurnPlanCardView,
  countRunningSince,
  runningBaseline,
  runningTasksAnchor,
  useStepRunningTaskCount,
} from '../components/assistant-ui/turn-board'
import type { NexusTaskSummaryRow } from '../browser/bridge/protocol/ui'
import type { TurnStep } from '../sessions/turnBoard'

// The step list and the closing box (F-41): which rows and marks show, where
// the running-tasks chip sits, and what a reply button sends.

afterEach(() => cleanup())

const steps: TurnStep[] = [
  { text: 'Read the parser', status: 'completed' },
  { text: 'Fix the bug', status: 'in_progress' },
  { text: 'Run the tests', status: 'pending' },
]

function card(props: Partial<Parameters<typeof TurnPlanCardView>[0]> = {}) {
  return render(createElement(TurnPlanCardView, { steps, running: true, runningTaskCount: 0, ...props }))
}

describe('TurnPlanCardView', () => {
  it('draws nothing without steps', () => {
    const { container } = card({ steps: [] })
    expect(container.firstChild).toBeNull()
  })

  it('lists every step in order with its status', () => {
    const { getByTestId } = card()
    const rows = Array.from(getByTestId('turn-plan-card').querySelectorAll('li'))
    expect(rows.map(row => row.getAttribute('data-status'))).toEqual(['completed', 'in_progress', 'pending'])
    expect(rows.map(row => row.textContent)).toEqual([
      expect.stringContaining('Read the parser'),
      expect.stringContaining('Fix the bug'),
      expect.stringContaining('Run the tests'),
    ])
  })

  it('greys the text of a done step only', () => {
    const { getAllByTestId } = card()
    expect(getAllByTestId('turn-step-text').map(text => text.classList.contains('text-muted-foreground')))
      .toEqual([true, false, false])
  })

  it('spins the step in progress', () => {
    const { getAllByTestId } = card()
    expect(getAllByTestId('turn-step-spinner')).toHaveLength(1)
  })

  it('draws nothing once the turn has ended, finished or not', () => {
    expect(card({ running: false }).container.firstChild).toBeNull()
    cleanup()
    const done = steps.map(step => ({ ...step, status: 'completed' as const }))
    expect(card({ steps: done, running: false }).container.firstChild).toBeNull()
  })

  it('shows no chip without running tasks', () => {
    const { queryByTestId } = card({ runningTaskCount: 0 })
    expect(queryByTestId('turn-plan-running-tasks')).toBeNull()
  })

  it('puts the running-tasks chip after the text of the step in progress, on its row, and opens the task list', () => {
    const onOpenTasks = vi.fn()
    const { getByTestId, getAllByTestId } = card({ runningTaskCount: 3, onOpenTasks })
    const chip = getByTestId('turn-plan-running-tasks')
    const row = chip.closest('li')!
    expect(row.getAttribute('data-status')).toBe('in_progress')
    const text = row.querySelector('[data-testid="turn-step-text"]')!
    expect(chip.parentElement).toBe(text.parentElement)
    expect(text.nextElementSibling).toBe(chip)
    // Only the row with the chip cuts its text to keep one line.
    expect(getAllByTestId('turn-step-text').map(each => each.classList.contains('truncate')))
      .toEqual([false, true, false])
    expect(chip.textContent).toContain('3')
    fireEvent.click(chip)
    expect(onOpenTasks).toHaveBeenCalledTimes(1)
  })

  it('puts the chip after the last step when none is in progress, as plain text without a task list', () => {
    const done = steps.map(step => ({ ...step, status: 'completed' as const }))
    const { getByTestId } = card({ steps: done, runningTaskCount: 1 })
    const chip = getByTestId('turn-plan-running-tasks')
    expect(chip.tagName).toBe('SPAN')
    expect(chip.previousElementSibling!.getAttribute('data-testid')).toBe('turn-step-text')
    expect(chip.closest('li')!.textContent).toContain('Run the tests')
    expect(runningTasksAnchor(done)).toBe(2)
    expect(runningTasksAnchor(steps)).toBe(1)
  })
})

describe('TurnClosingBoxView', () => {
  const closing = { summary: 'Fix written, not committed.', question: 'Commit the fix?', replies: ['Commit', 'Not yet'], waiting: true }

  it('draws nothing for a closing without a question', () => {
    const { container } = render(
      createElement(TurnClosingBoxView, { closing: { summary: 'Done.', replies: [], waiting: false }, onReply: vi.fn() }),
    )
    expect(container.firstChild).toBeNull()
  })

  it('shows the summary, the question and a button per reply; a click sends that reply', () => {
    const onReply = vi.fn()
    const { getByTestId, getAllByTestId } = render(createElement(TurnClosingBoxView, { closing, onReply }))
    const box = getByTestId('turn-closing-box')
    expect(box.textContent).toContain('Fix written, not committed.')
    expect(box.textContent).toContain('Commit the fix?')
    expect(box.getAttribute('data-waiting')).toBe('true')
    const buttons = getAllByTestId('turn-closing-reply')
    expect(buttons.map(button => button.textContent)).toEqual(['Commit', 'Not yet'])
    fireEvent.click(buttons[1]!)
    expect(onReply).toHaveBeenCalledTimes(1)
    expect(onReply).toHaveBeenCalledWith('Not yet')
  })

  it('shows the question without buttons when the thread cannot reply', () => {
    const { getByTestId, queryAllByTestId } = render(createElement(TurnClosingBoxView, { closing }))
    expect(getByTestId('turn-closing-box').textContent).toContain('Commit the fix?')
    expect(queryAllByTestId('turn-closing-reply')).toHaveLength(0)
  })
})

describe('step running-task count', () => {
  const row = (sessionId: string, status: NexusTaskSummaryRow['status'], startedAt = 1) =>
    ({ sessionId, spawnerSessionId: 'parent', description: sessionId, status, startedAt }) as NexusTaskSummaryRow
  const at = (inProgress: number): TurnStep[] =>
    steps.map((step, i) => ({ ...step, status: i < inProgress ? 'completed' : i === inProgress ? 'in_progress' : 'pending' }))

  it('counts a running task only when its run is not in the baseline', () => {
    const baseline = runningBaseline([row('old', 'running', 1), row('gone', 'success', 1)])
    expect(countRunningSince([row('old', 'running', 1), row('new', 'running', 2), row('done', 'success', 2)], baseline)).toBe(1)
    expect(countRunningSince([row('old', 'running', 5)], baseline)).toBe(1)
  })

  it('leaves out tasks already running when the step began and counts the ones started during it', () => {
    const { result, rerender } = renderHook(({ s, rows }) => useStepRunningTaskCount(s, rows), {
      initialProps: { s: at(1), rows: [row('a', 'running')] },
    })
    expect(result.current).toBe(0)
    rerender({ s: at(1), rows: [row('a', 'running'), row('b', 'running', 2)] })
    expect(result.current).toBe(1)
    rerender({ s: at(2), rows: [row('a', 'running'), row('b', 'running', 2)] })
    expect(result.current).toBe(0)
    rerender({ s: at(2), rows: [row('a', 'success'), row('b', 'running', 2), row('c', 'running', 3)] })
    expect(result.current).toBe(1)
  })

  it('counts a task resumed during the step', () => {
    const { result, rerender } = renderHook(({ rows }) => useStepRunningTaskCount(at(1), rows), {
      initialProps: { rows: [row('a', 'running', 1)] },
    })
    rerender({ rows: [row('a', 'success', 1)] })
    rerender({ rows: [row('a', 'running', 9)] })
    expect(result.current).toBe(1)
  })

  it('re-baselines when the step in progress is replaced by one with other text', () => {
    const rows = [row('a', 'running'), row('b', 'running', 2)]
    const { result, rerender } = renderHook(({ s, r }) => useStepRunningTaskCount(s, r), {
      initialProps: { s: at(1), r: rows.slice(0, 1) },
    })
    rerender({ s: at(1), r: rows })
    expect(result.current).toBe(1)
    const replaced = at(1).map((step, i) => (i === 1 ? { ...step, text: 'Fix the other bug' } : step))
    rerender({ s: replaced, r: rows })
    expect(result.current).toBe(0)
  })
})
