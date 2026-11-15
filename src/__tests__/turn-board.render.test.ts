// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { cleanup, fireEvent, render } from '@testing-library/react'

import {
  TurnClosingBoxView,
  TurnPlanCardView,
  runningTasksAnchor,
} from '../components/assistant-ui/turn-board'
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

  it('spins the step in progress only while the turn runs', () => {
    const live = card({ running: true })
    expect(live.queryAllByTestId('turn-step-spinner')).toHaveLength(1)
    cleanup()
    const idle = card({ running: false })
    expect(idle.queryAllByTestId('turn-step-spinner')).toHaveLength(0)
  })

  it('shows no chip without running tasks', () => {
    const { queryByTestId } = card({ runningTaskCount: 0 })
    expect(queryByTestId('turn-plan-running-tasks')).toBeNull()
  })

  it('puts the running-tasks chip under the step in progress and opens the task list', () => {
    const onOpenTasks = vi.fn()
    const { getByTestId } = card({ runningTaskCount: 3, onOpenTasks })
    const chip = getByTestId('turn-plan-running-tasks')
    expect(chip.closest('li')!.getAttribute('data-status')).toBe('in_progress')
    expect(chip.textContent).toContain('3')
    fireEvent.click(chip)
    expect(onOpenTasks).toHaveBeenCalledTimes(1)
  })

  it('puts the chip under the last step when none is in progress, as plain text without a task list', () => {
    const done = steps.map(step => ({ ...step, status: 'completed' as const }))
    const { getByTestId } = card({ steps: done, runningTaskCount: 1 })
    const chip = getByTestId('turn-plan-running-tasks')
    expect(chip.tagName).toBe('SPAN')
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
