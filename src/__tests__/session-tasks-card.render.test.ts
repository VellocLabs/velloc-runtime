// @vitest-environment happy-dom
/**
 * The Background tasks card's unfolded body (F-9): running tasks with their
 * elapsed time and a stop button (at most five until Show more), then how
 * many finished; a running row opens its detail, the finished row the list.
 */
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

import { SessionTasksList } from '@/components/assistant-ui/session-tasks-card'
import {
  BackgroundTasksContext,
  type BackgroundTasksContextValue,
} from '@/components/assistant-ui/background-tasks-context'
import type { NexusTaskSummaryRow } from '@/browser/bridge/protocol/ui'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const NOW = Date.UTC(2026, 9, 16, 12, 0, 0)

function row(sessionId: string, status: NexusTaskSummaryRow['status'], extra: Partial<NexusTaskSummaryRow> = {}): NexusTaskSummaryRow {
  return { sessionId, spawnerSessionId: 'P', status, description: `task ${sessionId}`, ...extra }
}

function draw(value: BackgroundTasksContextValue) {
  return render(createElement(BackgroundTasksContext.Provider, { value }, createElement(SessionTasksList)))
}

const labels = () => screen.queryAllByTestId('session-card-task').map(el => el.textContent ?? '')

describe('SessionTasksList', () => {
  it('lists running tasks with kind, label and elapsed time, then the finished count', () => {
    vi.useFakeTimers({ now: NOW })
    draw({
      taskRows: [
        row('sh', 'running', { type: 'local_bash', command: 'npm test', startedAt: NOW - 93_000 }),
        row('ag', 'running', { startedAt: NOW - 5_000 }),
        row('done1', 'success'),
        row('done2', 'error', { type: 'local_bash' }),
        row('fork', 'success', { type: 'local_fork' }),
      ],
    })
    const rows = screen.getAllByTestId('session-card-task')
    expect(rows.map(el => el.getAttribute('data-task-kind'))).toEqual(['local_bash', 'local_agent'])
    expect(rows[0].textContent).toContain('npm test')
    expect(rows[0].textContent).toContain('1m 33s')
    expect(rows[1].textContent).toContain('task ag')
    expect(screen.getByTestId('session-card-tasks-finished').textContent).toBe('2 finished')
  })

  it('the elapsed time ticks every second', () => {
    vi.useFakeTimers({ now: NOW })
    draw({ taskRows: [row('a', 'running', { startedAt: NOW - 1_000 })] })
    expect(screen.getByTestId('session-card-task-elapsed').textContent).toBe('1s')
    act(() => {
      vi.advanceTimersByTime(3_000)
    })
    expect(screen.getByTestId('session-card-task-elapsed').textContent).toBe('4s')
  })

  it('shows five running tasks, the rest behind Show more / Show less', () => {
    const taskRows = Array.from({ length: 7 }, (_, i) => row(`r${i}`, 'running'))
    draw({ taskRows })
    expect(labels()).toHaveLength(5)
    const more = screen.getByTestId('session-card-tasks-more')
    expect(more.textContent).toBe('Show more')
    fireEvent.click(more)
    expect(labels()).toHaveLength(7)
    expect(screen.getByTestId('session-card-tasks-more').textContent).toBe('Show less')
    fireEvent.click(screen.getByTestId('session-card-tasks-more'))
    expect(labels()).toHaveLength(5)
  })

  it('five or fewer need no Show more; no finished row when nothing finished', () => {
    draw({ taskRows: Array.from({ length: 5 }, (_, i) => row(`r${i}`, 'running')) })
    expect(screen.queryByTestId('session-card-tasks-more')).toBeNull()
    expect(screen.queryByTestId('session-card-tasks-finished')).toBeNull()
  })

  it('a running row opens its detail; the finished row opens the list', () => {
    const openTasksDrawer = vi.fn()
    const openTasksList = vi.fn()
    draw({ taskRows: [row('a', 'running'), row('b', 'success')], openTasksDrawer, openTasksList })
    fireEvent.click(screen.getByTestId('session-card-task-open'))
    expect(openTasksDrawer).toHaveBeenCalledWith('a')
    fireEvent.click(screen.getByTestId('session-card-tasks-finished'))
    expect(openTasksList).toHaveBeenCalledTimes(1)
  })

  it('stop asks once and waits for the row to settle; a fast call has no stop', () => {
    const stopTask = vi.fn()
    const { rerender } = draw({
      taskRows: [row('a', 'running', { description: 'build' }), row('f', 'running', { type: 'local_fast' })],
      stopTask,
    })
    const stops = screen.getAllByTestId('session-card-task-stop')
    expect(stops).toHaveLength(1)
    expect(stops[0].getAttribute('aria-label')).toBe('Stop build')
    fireEvent.click(stops[0])
    expect(stopTask).toHaveBeenCalledWith('a')
    expect((screen.getByTestId('session-card-task-stop') as HTMLButtonElement).disabled).toBe(true)
    rerender(
      createElement(
        BackgroundTasksContext.Provider,
        { value: { taskRows: [row('a', 'stopped'), row('f', 'running', { type: 'local_fast' })], stopTask } },
        createElement(SessionTasksList),
      ),
    )
    expect(screen.queryByTestId('session-card-task-stop')).toBeNull()
    expect(screen.getByTestId('session-card-tasks-finished').textContent).toBe('1 finished')
  })
})
