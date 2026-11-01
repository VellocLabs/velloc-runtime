// @vitest-environment happy-dom
/**
 * A background sub-agent's work in its parent session's UI (F-2): its file
 * changes as their own sections in the Diff pane and lines in the Changes
 * card, and its background tasks labelled with the sub-agent they came from.
 */
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

import { TurnDiffHistoryView } from '../components/assistant-ui/TurnDiffSummary'
import { SessionTasksList } from '../components/assistant-ui/session-tasks-card'
import { BackgroundTasksContext } from '../components/assistant-ui/background-tasks-context'
import { agentChangeLines } from '../components/assistant-ui/session-card-stack'
import type { NexusAgentChangeSection, NexusTaskSummaryRow } from '../browser/bridge/protocol/ui'
import type { TurnDiffMeta, TurnFileChange } from '../utils/turnDiffs'

afterEach(() => cleanup())

const OWN: TurnDiffMeta[] = [
  {
    turnIndex: 1,
    promptPreview: 'own work',
    stats: { touchedFiles: 1, plusLines: 2, minusLines: 0 },
    files: [{ filePath: '/repo/README.md', fileWasCreated: false, plusLines: 2, minusLines: 0 }],
  },
]

const section = (taskId: string, status: NexusAgentChangeSection['status'], workDir?: string): NexusAgentChangeSection => ({
  taskId,
  description: `Refactor ${taskId}`,
  agentType: 'general-purpose',
  status,
  ...(workDir ? { workDir } : {}),
  turns: [
    {
      turnIndex: 1,
      promptPreview: 'go',
      stats: { touchedFiles: 1, plusLines: 3, minusLines: 1 },
      files: [{ filePath: `${workDir ?? '/repo'}/src/${taskId}.ts`, fileWasCreated: false, plusLines: 3, minusLines: 1 }],
    },
  ],
})

const AGENT_DETAIL: TurnFileChange[] = [
  {
    filePath: '/repo/.wt/a1/src/a1.ts',
    fileWasCreated: false,
    plusLines: 3,
    minusLines: 1,
    hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old line', '+new line'] }],
  },
]

describe('the Diff pane with sub-agent changes', () => {
  it('lists the session\'s turns, then one section per sub-agent', () => {
    render(
      createElement(TurnDiffHistoryView, {
        history: OWN,
        agents: [section('a1', 'running', '/repo/.wt/a1'), section('a2', 'success')],
      }),
    )
    expect(screen.getAllByTestId('turn-diff-group-heading').map(el => el.textContent)).toEqual([
      'This session',
      'Sub-agents',
    ])
    const sections = screen.getAllByTestId('turn-diff-agent-section')
    expect(sections.map(el => el.getAttribute('data-task-id'))).toEqual(['a1', 'a2'])
    // A running agent starts open, a finished one closed.
    const [running, finished] = sections
    expect(within(running!).getByTestId('turn-diff-agent-workdir').textContent).toBe('Working dir: /repo/.wt/a1')
    expect(within(running!).getByTestId('turn-diff-file').textContent).toContain('src/a1.ts')
    expect(within(running!).getByTestId('turn-diff-file').textContent).not.toContain('/repo/.wt/a1')
    expect(within(finished!).queryByTestId('turn-diff-file')).toBeNull()
    fireEvent.click(within(finished!).getByTestId('turn-diff-agent-trigger'))
    expect(within(finished!).getByTestId('turn-diff-file')).toBeTruthy()
  })

  it('has no group headings while only the session changed files', () => {
    render(createElement(TurnDiffHistoryView, { history: OWN, agents: [] }))
    expect(screen.queryByTestId('turn-diff-group-heading')).toBeNull()
  })

  it('shows sub-agent changes when the session itself changed nothing', () => {
    render(createElement(TurnDiffHistoryView, { history: [], agents: [section('a1', 'running')] }))
    expect(screen.getByTestId('turn-diff-agent-section')).toBeTruthy()
    expect(screen.getAllByTestId('turn-diff-group-heading').map(el => el.textContent)).toEqual(['Sub-agents'])
  })

  it('fetches an agent file\'s hunks from that agent, not from the session', async () => {
    const loadDetail = vi.fn(async () => null)
    const loadAgentDetail = vi.fn(async () => AGENT_DETAIL)
    render(
      createElement(TurnDiffHistoryView, {
        history: OWN,
        loadDetail,
        agents: [section('a1', 'running', '/repo/.wt/a1')],
        loadAgentDetail,
      }),
    )
    const agent = screen.getByTestId('turn-diff-agent-section')
    fireEvent.click(within(agent).getByTestId('turn-diff-file'))
    await waitFor(() => expect(screen.getByTestId('turn-diff-detail')).toBeTruthy())
    expect(loadAgentDetail).toHaveBeenCalledWith('a1', 1)
    expect(loadDetail).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.getByTestId('turn-diff-detail').textContent).toContain('new line'))
  })
})

describe('the Background tasks card', () => {
  it('labels a task a sub-agent launched with that sub-agent', () => {
    const rows: NexusTaskSummaryRow[] = [
      { sessionId: 'b1', spawnerSessionId: 'subagent-x', ownerSessionId: 'P', viaTaskId: 'a1', viaDescription: 'Explore the repo', status: 'running', type: 'local_bash', command: 'npm test', description: 'npm test' },
      { sessionId: 'b2', spawnerSessionId: 'P', status: 'running', type: 'local_bash', command: 'git status', description: 'git status' },
    ]
    render(createElement(BackgroundTasksContext.Provider, { value: { taskRows: rows } }, createElement(SessionTasksList)))
    const origins = screen.getAllByTestId('session-card-task-origin')
    expect(origins.map(el => el.textContent)).toEqual(['via Explore the repo'])
    expect(screen.getAllByTestId('session-card-task-open')[0]!.getAttribute('title')).toBe('npm test · via Explore the repo')
  })
})

describe('the Changes card', () => {
  it('has one line per sub-agent that changed lines, with its counts', () => {
    const quiet: NexusAgentChangeSection = { ...section('a3', 'success'), turns: [] }
    expect(agentChangeLines([section('a1', 'running'), quiet])).toEqual([
      { taskId: 'a1', name: 'Refactor a1', plusLines: 3, minusLines: 1 },
    ])
  })
})
