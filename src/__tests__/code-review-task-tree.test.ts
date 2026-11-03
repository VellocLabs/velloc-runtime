// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ReviewReportCard, ReviewTaskTree } from '../components/assistant-ui/code-review-card'
import { BackgroundTasksContext } from '../components/assistant-ui/background-tasks-context'
import { reviewRunIdOfSkillResult, type ReviewReportView } from '../codeReview/review-protocol'
import type { ReviewTaskView } from '../codeReview/contracts'
import { createTranslate } from '../browser/webview/i18n/translate'
const t = createTranslate('en')
afterEach(cleanup)

const tasks: ReviewTaskView[] = [
  { key: 'r1', taskId: 'f-1', role: 'coordinator', label: 'max · team-ten', status: 'running', startedAt: 1, lastActivityAt: 2, lastAction: 'ReviewRead diff src/a.ts' },
  { key: 'w1', role: 'finder', label: 'calls, removed', status: 'failed', startedAt: 1, lastActivityAt: 2, finishedAt: 3, end: { kind: 'step-limit' } },
]
function report(): ReviewReportView {
  return {
    run: { id: 'r1', conversationKey: 's1', scope: { kind: 'workspace', workspaceKey: 'w', repository: { projectKey: 'repo' }, revision: { base: 'a', head: 'b' }, pathFilter: [] }, policy: { level: 'max', recipe: 'team-ten', recipeRevision: 1, execution: 'isolated', presentation: 'panel', reportLimit: 8 }, progress: { status: 'partial', stage: 'report', coveredAngles: [], unavailableAngles: [], spawnedTasks: 1, verifiedCandidates: 0, omittedByLimit: 0 }, reportRevision: 1 },
    diagnostics: [], evidence: [], assessments: [], actions: [], coverage: { complete: false, angles: [], limitations: ['review-model-error'] }, permissions: {}, tasks, end: { kind: 'model-error', detail: 'HTTP 529' },
  }
}

describe('review task tree', () => {
  it('lists every task with role, status, last action and end reason', () => {
    render(createElement(ReviewTaskTree, { tasks }))
    const rows = screen.getAllByTestId('review-task')
    expect(rows).toHaveLength(2)
    expect(rows[0].textContent).toContain(t('reviewCard.task.role.coordinator'))
    expect(rows[0].textContent).toContain(t('reviewCard.task.status.running'))
    expect(rows[0].textContent).toContain(t('reviewCard.task.lastAction', { action: 'ReviewRead diff src/a.ts' }))
    expect(rows[1].textContent).toContain(t('reviewCard.task.role.finder'))
    expect(rows[1].textContent).toContain(t('reviewCard.notice.stepLimit'))
    expect(screen.queryByTestId('review-task-transcript')).toBeNull()
  })
  it('jumps to the drawer transcript only for a task the sink registered', () => {
    const openTasksDrawer = vi.fn()
    render(createElement(BackgroundTasksContext.Provider, { value: { openTasksDrawer } }, createElement(ReviewTaskTree, { tasks })))
    const buttons = screen.getAllByTestId('review-task-transcript')
    expect(buttons).toHaveLength(1)
    fireEvent.click(buttons[0])
    expect(openTasksDrawer).toHaveBeenCalledWith('f-1')
  })
  it('shows the run end reason on the report card', () => {
    render(createElement(ReviewReportCard, { report: report(), can: () => false, onAction: vi.fn(async () => {}) }))
    expect(screen.getByTestId('review-end').textContent).toBe(`${t('reviewCard.notice.modelError')} — HTTP 529`)
    expect(screen.getByTestId('review-tasks')).toBeTruthy()
  })
})

describe('skill result card anchor', () => {
  it('accepts only the review result envelope with a valid run id', () => {
    expect(reviewRunIdOfSkillResult(JSON.stringify({ reviewRunId: 'run_1', status: 'finished', report: {} }))).toBe('run_1')
    expect(reviewRunIdOfSkillResult(JSON.stringify({ reviewRunId: '../x' }))).toBeNull()
    expect(reviewRunIdOfSkillResult(JSON.stringify({ report: {}, reviewRunId: 'run_1' }))).toBeNull()
    expect(reviewRunIdOfSkillResult('{"reviewRunId":')).toBeNull()
    expect(reviewRunIdOfSkillResult({ reviewRunId: 'run_1' })).toBeNull()
  })
})
