// @vitest-environment happy-dom
/**
 * The start card (F-36): a `SpawnSession` call renders as a card with the
 * child's title, name and kind, and a status line driven only by what the
 * runtime publishes about the child; the card opens the child through the
 * jump bus.
 */
import { createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

import { ChildSessionCard, classifyChildSpawn } from '../components/assistant-ui/child-session-card'
import {
  publishSessionStatuses,
  resetSessionStatusesForTests,
  type SessionStatusEntry,
} from '../browser/webview/sessionStatusStore'
import {
  resetTeammateJumpRequestsForTests,
  subscribeTeammateJump,
  type TeammateJumpRequest,
} from '../browser/webview/teammateJumpRequests'
import {
  SPAWN_SESSION_TOOL_NAME,
  childSessionNotStartedAckText,
  childSessionRegisteredText,
} from '../sessions/childSessionSpec'
import { shouldInlineToolPayloads } from '../utils/toolCallDetails'

afterEach(() => {
  cleanup()
  resetSessionStatusesForTests()
  resetTeammateJumpRequestsForTests()
})

const ARGS = { title: 'Fix the login', name: 'login-fix', from: 'fresh', isolation: '' }
const ACK = childSessionRegisteredText({ sessionId: 'child-1', name: 'login-fix', title: 'Fix the login', from: 'fresh', sharedCheckout: true, cwd: 'D:/repo' })

function mount(args: unknown, result: unknown) {
  const spawn = classifyChildSpawn('SpawnSession', args, result)
  if (!spawn) throw new Error('not a start card')
  return render(createElement(ChildSessionCard, { spawn }))
}

const card = () => screen.getByTestId('child-session-card')
const statusText = () => screen.getByTestId('child-session-status').textContent

function publish(fields: Partial<SessionStatusEntry>) {
  act(() => publishSessionStatuses([{ sessionId: 'child-1', title: 'Fix the login', ...fields }]))
}

describe('classifyChildSpawn', () => {
  it('a pending call is a card from its arguments; an acknowledgement names the session; a refusal is a tool row', () => {
    expect(classifyChildSpawn('SpawnSession', ARGS, undefined)).toEqual({
      title: 'Fix the login', name: 'login-fix', from: 'fresh', sharedCheckout: null, sessionId: null,
    })
    expect(classifyChildSpawn('SpawnSession', ARGS, ACK)).toEqual({
      title: 'Fix the login', name: 'login-fix', from: 'fresh', sharedCheckout: true, sessionId: 'child-1',
    })
    expect(classifyChildSpawn('SpawnSession', ARGS, 'Refused: briefing must be at least 80 characters')).toBeNull()
    expect(classifyChildSpawn('SpawnSession', { title: '' }, undefined)).toBeNull()
    expect(classifyChildSpawn('Agent', ARGS, ACK)).toBeNull()
  })

  it('keeps the arguments and acknowledgement of the call on the transcript row, which the card is classified from', () => {
    // Lazy-loaded, a part carries `{}` args and a placeholder result, so the
    // call renders as a tool row.
    expect(shouldInlineToolPayloads(SPAWN_SESSION_TOOL_NAME)).toBe(true)
    expect(classifyChildSpawn('SpawnSession', {}, { lazyDetailFinished: true })).toBeNull()
  })
})

describe('ChildSessionCard', () => {
  it('shows title, name and kind; a pending call is starting and cannot be opened yet', () => {
    mount({ ...ARGS, from: 'fork' }, undefined)
    expect(screen.getByTestId('child-session-title').textContent).toBe('Fix the login')
    expect(screen.getByTestId('child-session-name').textContent).toBe('login-fix')
    expect(screen.getByTestId('child-session-kind').textContent).toBe('Fork of this conversation')
    expect(card().dataset.status).toBe('starting')
    expect(statusText()).toBe('Starting…')
    expect(screen.queryByTestId('child-session-open')).toBeNull()
  })

  it('names where an acknowledged child works', () => {
    mount(ARGS, ACK)
    expect(screen.getByTestId('child-session-kind').textContent).toBe('New session · Shared directory')
    cleanup()
    mount(ARGS, childSessionRegisteredText({ sessionId: 'child-1', name: 'login-fix', title: 'Fix the login', from: 'fork', sharedCheckout: false }))
    expect(screen.getByTestId('child-session-kind').textContent).toBe('Fork of this conversation · Own worktree')
  })

  it('follows the published state through every status line', () => {
    mount(ARGS, ACK)
    expect(card().dataset.status).toBe('unknown')
    expect(statusText()).toBe('Not available')

    publish({ starting: true })
    expect(card().dataset.status).toBe('starting')
    expect(statusText()).toBe('Starting…')

    publish({ running: true })
    expect(card().dataset.status).toBe('running')
    expect(statusText()).toBe('Running')

    publish({ running: true, activity: { kind: 'tool', tool: 'Read' } })
    expect(statusText()).toBe('Using Read')

    publish({ running: true, activity: { kind: 'responding' } })
    expect(statusText()).toBe('Writing a reply')

    publish({ running: true, needsAnswer: true })
    expect(card().dataset.status).toBe('waiting')
    expect(statusText()).toBe('Waiting for you')

    publish({ ending: 'finished', previewText: 'Fixed the redirect. Two files changed.' })
    expect(card().dataset.status).toBe('finished')
    expect(statusText()).toBe('FinishedFixed the redirect.')
    expect(screen.getByTestId('child-session-last-reply').textContent).toBe('Fixed the redirect.')

    publish({ ending: 'failed' })
    expect(card().dataset.status).toBe('failed')
    expect(statusText()).toBe('Failed')

    publish({ ending: 'stopped' })
    expect(card().dataset.status).toBe('stopped')
    expect(statusText()).toBe('Stopped')

    publish({})
    expect(card().dataset.status).toBe('idle')
    expect(statusText()).toBe('Idle')
  })

  it('a start that failed shows its reason', () => {
    mount(ARGS, childSessionNotStartedAckText({ sessionId: 'child-1', name: 'login-fix', reason: 'branch exists' }))
    publish({ startFailed: 'the worktree could not be created: branch exists' })
    expect(card().dataset.status).toBe('startFailed')
    expect(statusText()).toBe('Did not start: the worktree could not be created: branch exists')
    expect(screen.getByTestId('child-session-status').getAttribute('title')).toBe('the worktree could not be created: branch exists')
  })

  it('the card opens the child through the jump bus', () => {
    const seen: TeammateJumpRequest[] = []
    subscribeTeammateJump(request => seen.push(request))
    mount(ARGS, ACK)
    fireEvent.click(screen.getByTestId('child-session-open'))
    expect(seen).toEqual([{ sessionId: 'child-1' }])
    expect(screen.getByTestId('child-session-open').getAttribute('aria-label')).toBe('Open session Fix the login')
  })
})
