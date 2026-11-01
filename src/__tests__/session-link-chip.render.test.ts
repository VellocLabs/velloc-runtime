// @vitest-environment happy-dom
/**
 * The session link chip (F-36): `[title](#session/<id>)` in a transcript
 * renders as a chip with the session's title and state dot; hovering opens a
 * popover with its state, kind, parent, folder and last activity and an Open
 * action; the popover closes when its thread is hidden.
 */
import { createElement, type ReactElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

import { sharedMarkdownComponents } from '../components/assistant-ui/markdown-components'
import { SessionLinkChip } from '../components/assistant-ui/session-link-chip'
import { ThreadForegroundContext } from '../components/assistant-ui/thread-foreground'
import {
  publishSessionStatuses,
  resetSessionStatusesForTests,
} from '../browser/webview/sessionStatusStore'
import {
  resetTeammateJumpRequestsForTests,
  subscribeTeammateJump,
  type TeammateJumpRequest,
} from '../browser/webview/teammateJumpRequests'

afterEach(() => {
  cleanup()
  resetSessionStatusesForTests()
  resetTeammateJumpRequestsForTests()
})

const wait = (ms: number) => act(() => new Promise<void>(resolve => setTimeout(resolve, ms)))

function seed() {
  publishSessionStatuses([
    { sessionId: 'parent-1', title: 'Main work' },
    {
      sessionId: 'child-1',
      title: 'Fix the login',
      parentSessionId: 'parent-1',
      lineageKind: 'side_session',
      projectRoot: 'D:\\work\\shop',
      running: true,
      activity: { kind: 'tool', tool: 'Read' },
      updatedAt: Date.now() - 120_000,
    },
  ])
}

function inThread(foreground: boolean, child: ReactElement) {
  return createElement(ThreadForegroundContext.Provider, { value: foreground }, child)
}

const chip = () => screen.getByTestId('session-link-chip')

describe('markdown links to a session', () => {
  it('a #session/<id> link renders as the chip; any other link stays a link', () => {
    const A = sharedMarkdownComponents.a
    render(createElement('div', null,
      createElement(A, { href: '#session/child-1' }, 'the login fix'),
      createElement(A, { href: '#session/../x' }, 'odd'),
      createElement(A, { href: 'https://example.com' }, 'site')))
    expect(chip().dataset.sessionId).toBe('child-1')
    expect(screen.getAllByTestId('session-link-chip')).toHaveLength(1)
    expect(screen.getByText('odd').tagName).toBe('A')
    expect(screen.getByText('site').tagName).toBe('A')
  })
})

describe('SessionLinkChip', () => {
  it('shows the published title and state; an unlisted session shows the link text and cannot be opened', () => {
    seed()
    render(createElement(SessionLinkChip, { sessionId: 'child-1' }, 'link text'))
    expect(chip().textContent).toBe('Fix the login')
    expect(chip().dataset.status).toBe('running')
    cleanup()
    const seen: TeammateJumpRequest[] = []
    subscribeTeammateJump(request => seen.push(request))
    render(createElement(SessionLinkChip, { sessionId: 'gone-1' }, 'an old session'))
    expect(chip().textContent).toBe('an old session')
    expect(chip().dataset.status).toBe('unknown')
    fireEvent.click(chip())
    expect(seen).toEqual([])
  })

  it('hovering opens the popover with state, kind, parent, folder and activity; Open jumps to the session', async () => {
    seed()
    const seen: TeammateJumpRequest[] = []
    subscribeTeammateJump(request => seen.push(request))
    render(inThread(true, createElement(SessionLinkChip, { sessionId: 'child-1' }, 'x')))
    expect(screen.queryByTestId('session-link-popover')).toBeNull()
    fireEvent.pointerEnter(chip())
    await wait(300)
    expect(screen.getByTestId('session-link-popover-title').textContent).toBe('Fix the login')
    expect(screen.getByTestId('session-link-popover-state').textContent).toBe('Running· Started by a session')
    expect(screen.getByTestId('session-link-popover-parent').textContent).toBe('Under Main work')
    expect(screen.getByTestId('session-link-popover-folder').textContent).toBe('shop')
    expect(screen.getByTestId('session-link-popover-activity').textContent).toBe('Last activity 2 minutes ago')
    fireEvent.click(screen.getByTestId('session-link-popover-open'))
    expect(seen).toEqual([{ sessionId: 'child-1' }])
    expect(screen.queryByTestId('session-link-popover')).toBeNull()
  })

  it('leaving the chip closes the popover', async () => {
    seed()
    render(inThread(true, createElement(SessionLinkChip, { sessionId: 'child-1' }, 'x')))
    fireEvent.pointerEnter(chip())
    await wait(300)
    expect(screen.getByTestId('session-link-popover')).toBeTruthy()
    fireEvent.pointerLeave(chip())
    await wait(250)
    expect(screen.queryByTestId('session-link-popover')).toBeNull()
  })

  it('an open popover closes when its thread is hidden, and stays closed when it is shown again', async () => {
    seed()
    const view = render(inThread(true, createElement(SessionLinkChip, { sessionId: 'child-1' }, 'x')))
    fireEvent.pointerEnter(chip())
    await wait(300)
    expect(screen.getByTestId('session-link-popover')).toBeTruthy()
    view.rerender(inThread(false, createElement(SessionLinkChip, { sessionId: 'child-1' }, 'x')))
    expect(screen.queryByTestId('session-link-popover')).toBeNull()
    view.rerender(inThread(true, createElement(SessionLinkChip, { sessionId: 'child-1' }, 'x')))
    await wait(300)
    expect(screen.queryByTestId('session-link-popover')).toBeNull()
  })

  it('a hover in a hidden thread never opens it', async () => {
    seed()
    render(inThread(false, createElement(SessionLinkChip, { sessionId: 'child-1' }, 'x')))
    fireEvent.pointerEnter(chip())
    await wait(300)
    expect(screen.queryByTestId('session-link-popover')).toBeNull()
  })

  it('follows the published state', () => {
    seed()
    render(createElement(SessionLinkChip, { sessionId: 'child-1' }, 'x'))
    act(() => publishSessionStatuses([{ sessionId: 'child-1', title: 'Fix the login', ending: 'finished' }]))
    expect(chip().dataset.status).toBe('finished')
  })
})
