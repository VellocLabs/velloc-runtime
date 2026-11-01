// @vitest-environment happy-dom
import { createElement, type ComponentType } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { ToolFallback } from '../components/assistant-ui/tool-fallback'
import {
  SessionProposalsContext,
  type SessionProposalsValue,
} from '../components/assistant-ui/session-proposals-context'
import { findProposalForCall } from '../components/assistant-ui/session-proposal-card'
import { holdProposalsView, proposalsActions, proposalsOfPayload } from '../browser/webview/proposalsView'
import { subscribeTeammateJump, resetTeammateJumpRequestsForTests } from '../browser/webview/teammateJumpRequests'
import type { ProposalView } from '../sessions/childProposals'
import type { RuntimeConnection, TopicEvent } from '../browser/runtimeClient/RuntimeConnection'

// The transcript card for a session proposal (F-36): one card, its text per
// state from the catalog, buttons only where the state and the thread allow,
// and the page store that feeds it.

type ToolProps = { toolCallId: string; toolName: string; args?: unknown; result?: unknown; status?: { type: string } }
const Tool = ToolFallback as unknown as ComponentType<ToolProps>

const SUGGEST_ARGS = { mode: 'suggest', title: 'Split the parser', task: 'TASK_TEXT', briefing: 'BRIEF_TEXT' }
const OFFER_ARGS = { mode: 'offer', title: 'Port the importer', task: '', briefing: '' }

function view(overrides: Partial<ProposalView> = {}): ProposalView {
  return { taskId: 'task_abcd1234', mode: 'suggest', state: 'proposed', title: 'Split the parser', toolCallId: 'tc-1', ...overrides }
}

function renderCard(value: SessionProposalsValue, props: Partial<ToolProps> = {}) {
  return render(
    createElement(
      SessionProposalsContext.Provider,
      { value },
      createElement(Tool, {
        toolCallId: 'tc-1',
        toolName: 'ProposeSession',
        args: SUGGEST_ARGS,
        result: 'Proposal task_abcd1234 is on the card.',
        status: { type: 'complete' },
        ...props,
      }),
    ),
  )
}

function actions() {
  return {
    start: vi.fn(async (_taskId: string) => {}),
    dismiss: vi.fn(async (_taskId: string) => {}),
    choose: vi.fn(async (_taskId: string, _choice: 'new' | 'here') => {}),
  }
}

afterEach(() => {
  cleanup()
  resetTeammateJumpRequestsForTests()
})

describe('SessionProposalCard', () => {
  it('a proposed suggestion shows Start and Dismiss, each acting on its task id, and never the brief', async () => {
    const acts = actions()
    const { container } = renderCard({ proposals: [view()], ...acts })
    const card = screen.getByTestId('session-proposal-card')
    expect(card.dataset.state).toBe('proposed')
    expect(card.dataset.mode).toBe('suggest')
    expect(screen.getByText('Suggested session')).toBeTruthy()
    expect(screen.getByText('Start it in its own session when you are ready')).toBeTruthy()
    expect(container.innerHTML).not.toContain('BRIEF_TEXT')
    expect(container.innerHTML).not.toContain('TASK_TEXT')
    expect(container.querySelector('[data-tool-name="ProposeSession"]')).toBeNull()
    fireEvent.click(screen.getByTestId('session-proposal-start'))
    await waitFor(() => expect(acts.start).toHaveBeenCalledWith('task_abcd1234'))
    await waitFor(() => expect((screen.getByTestId('session-proposal-dismiss') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByTestId('session-proposal-dismiss'))
    await waitFor(() => expect(acts.dismiss).toHaveBeenCalledWith('task_abcd1234'))
  })

  it('a proposed offer asks New session or Do it here', async () => {
    const acts = actions()
    renderCard({ proposals: [view({ mode: 'offer', title: 'Port the importer' })], ...acts }, { args: OFFER_ARGS })
    expect(screen.getByText('Offered session')).toBeTruthy()
    expect(screen.getByText('Work on this in a new session, or keep it here?')).toBeTruthy()
    expect(screen.queryByTestId('session-proposal-start')).toBeNull()
    fireEvent.click(screen.getByTestId('session-proposal-here'))
    await waitFor(() => expect(acts.choose).toHaveBeenCalledWith('task_abcd1234', 'here'))
    await waitFor(() => expect((screen.getByTestId('session-proposal-new') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByTestId('session-proposal-new'))
    await waitFor(() => expect(acts.choose).toHaveBeenCalledWith('task_abcd1234', 'new'))
  })

  it.each([
    [{ state: 'accepted_awaiting_brief', mode: 'offer' }, 'Preparing the new session…'],
    [{ state: 'starting' }, 'Starting…'],
    [{ state: 'dismissed' }, 'Dismissed'],
    [{ state: 'dismissed', mode: 'offer', keptHere: true }, 'Kept in this conversation'],
    [{ state: 'expired' }, 'Expired'],
    [{ state: 'superseded', mode: 'offer' }, 'Closed by your next message'],
  ] as const)('a closed or moving card (%o) reads "%s" and offers no buttons', (overrides, text) => {
    renderCard({ proposals: [view(overrides as Partial<ProposalView>)], ...actions() })
    expect(screen.getByTestId('session-proposal-status').textContent).toBe(text)
    expect(screen.getByTestId('session-proposal-card').dataset.state).toBe(overrides.state)
    for (const id of ['start', 'dismiss', 'new', 'here', 'open']) {
      expect(screen.queryByTestId(`session-proposal-${id}`)).toBeNull()
    }
  })

  it('a started card opens the child through the jump bus', () => {
    const jumps: unknown[] = []
    subscribeTeammateJump(request => jumps.push(request))
    renderCard({ proposals: [view({ state: 'started', childSessionId: 'child-7', childName: 'parser' })], ...actions() })
    expect(screen.getByTestId('session-proposal-status').textContent).toBe('Running in its own session')
    const open = screen.getByTestId('session-proposal-open')
    expect(open.getAttribute('aria-label')).toBe('Open session parser')
    fireEvent.click(open)
    expect(jumps).toEqual([{ sessionId: 'child-7' }])
  })

  it("a failed start says so, with the runtime's reason as the tooltip, and keeps the buttons", () => {
    renderCard({ proposals: [view({ failure: 'the session is not running' })], ...actions() })
    const failure = screen.getByTestId('session-proposal-failure')
    expect(failure.textContent).toBe('Could not start')
    expect(failure.getAttribute('title')).toBe('the session is not running')
    expect(screen.getByTestId('session-proposal-start')).toBeTruthy()
  })

  it('a refused action says it did not go through', async () => {
    const acts = actions()
    acts.start.mockRejectedValueOnce(new Error('conflict'))
    renderCard({ proposals: [view()], ...acts })
    fireEvent.click(screen.getByTestId('session-proposal-start'))
    expect((await screen.findByRole('alert')).textContent).toBe('That did not go through. Try again.')
  })

  it('without actions (read-only thread, or no proposals grant) draws no buttons', () => {
    renderCard({ proposals: [view()] })
    expect(screen.getByTestId('session-proposal-card').dataset.state).toBe('proposed')
    expect(screen.queryByTestId('session-proposal-start')).toBeNull()
    expect(screen.queryByTestId('session-proposal-dismiss')).toBeNull()
  })

  it('before the state lands it reads Loading; with state but no record, No longer available', () => {
    renderCard({ proposals: null })
    expect(screen.getByTestId('session-proposal-status').textContent).toBe('Loading…')
    expect(screen.getByTestId('session-proposal-title').textContent).toBe('Split the parser')
    cleanup()
    renderCard({ proposals: [] }, { args: OFFER_ARGS })
    expect(screen.getByTestId('session-proposal-status').textContent).toBe('No longer available')
    expect(screen.getByTestId('session-proposal-card').dataset.mode).toBe('offer')
  })

  it('finds its record by call id, else by the task id its result names', () => {
    const rows = [view({ toolCallId: 'other', taskId: 'task_zzzz9999' }), view({ toolCallId: undefined })]
    expect(findProposalForCall(rows, 'other', undefined)?.taskId).toBe('task_zzzz9999')
    expect(findProposalForCall(rows, 'tc-missing', 'Proposal task_abcd1234 recorded')?.taskId).toBe('task_abcd1234')
    expect(findProposalForCall(rows, 'tc-missing', 'nothing here')).toBeNull()
    expect(findProposalForCall(null, 'other', undefined)).toBeNull()
  })
})

describe('proposals page store', () => {
  function fakeConnection() {
    const listeners: Array<(event: TopicEvent<unknown>) => void> = []
    const unsubscribed = vi.fn()
    const subscribe = vi.fn((_topic: string, listener: (event: TopicEvent<unknown>) => void) => {
      listeners.push(listener)
      return unsubscribed
    })
    const request = vi.fn(async (_route: string, _payload: unknown) => ({ state: 'started' }))
    const conn = { subscribe, request } as unknown as RuntimeConnection
    const deliver = (payload: unknown) => {
      for (const listener of listeners) {
        listener({ topic: 'proposals/s1', seq: 1, type: 'state', form: 'snapshot', payload } as unknown as TopicEvent<unknown>)
      }
    }
    return { conn, subscribe, request, unsubscribed, deliver }
  }

  it('readers of one session share one subscription; a late reader gets the latest state; the last release unsubscribes', () => {
    const rig = fakeConnection()
    const first: ProposalView[][] = []
    const second: ProposalView[][] = []
    const releaseFirst = holdProposalsView(rig.conn, 's1', rows => first.push([...rows]))
    rig.deliver({ sessionId: 's1', proposals: [view()] })
    const releaseSecond = holdProposalsView(rig.conn, 's1', rows => second.push([...rows]))
    expect(rig.subscribe).toHaveBeenCalledTimes(1)
    expect(rig.subscribe.mock.calls[0]![0]).toBe('proposals/s1')
    expect(first).toEqual([[view()]])
    expect(second).toEqual([[view()]])
    releaseFirst()
    expect(rig.unsubscribed).not.toHaveBeenCalled()
    releaseSecond()
    expect(rig.unsubscribed).toHaveBeenCalledTimes(1)
  })

  it('ignores a payload for another session or of another shape, and drops malformed rows', () => {
    expect(proposalsOfPayload({ sessionId: 's2', proposals: [] }, 's1')).toBeNull()
    expect(proposalsOfPayload({ sessionId: 's1' }, 's1')).toBeNull()
    expect(proposalsOfPayload({ sessionId: 's1', proposals: [view(), { taskId: 1 }, view({ state: 'gone' as never })] }, 's1')).toEqual([view()])
  })

  it('the actions name the session and the task and nothing else', async () => {
    const rig = fakeConnection()
    const bound = proposalsActions(rig.conn, 's1')
    await bound.start('task_abcd1234')
    await bound.dismiss('task_abcd1234')
    await bound.choose('task_abcd1234', 'here')
    expect(rig.request.mock.calls).toEqual([
      ['proposals.start', { sessionId: 's1', taskId: 'task_abcd1234' }],
      ['proposals.dismiss', { sessionId: 's1', taskId: 'task_abcd1234' }],
      ['proposals.choose', { sessionId: 's1', taskId: 'task_abcd1234', choice: 'here' }],
    ])
  })
})
