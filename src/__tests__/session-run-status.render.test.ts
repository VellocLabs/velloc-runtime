// @vitest-environment happy-dom
import { createElement } from 'react'
import { BrainIcon } from 'lucide-react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, renderHook, screen } from '@testing-library/react'
import { Sidebar, type SessionListItem } from '../browser/webview/Sidebar'
import {
  publishSessionStatuses,
  resetSessionStatusesForTests,
  type SessionStatusEntry,
} from '../browser/webview/sessionStatusStore'
import {
  collapsedRowStatus,
  sessionRunStatusOf,
  useSessionRunStatus,
} from '../browser/webview/sessionRunStatus'
import { SessionStatusIcon } from '../components/assistant-ui/session-status-icon'

// One session status for the list row, the run-status row and the scroll
// button (F-17): the model request vs tool execution split, the person-halt
// precedence, paused, and done showing nothing.

const memoryStorage = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => memoryStorage.get(k) ?? null,
  setItem: (k: string, v: string) => void memoryStorage.set(k, String(v)),
  removeItem: (k: string) => void memoryStorage.delete(k),
  clear: () => memoryStorage.clear(),
})

beforeEach(() => resetSessionStatusesForTests())
afterEach(() => cleanup())

describe('sessionRunStatusOf', () => {
  it('is thinking while the model request is in flight, retries included', () => {
    expect(sessionRunStatusOf({ running: true, activity: { kind: 'responding' } })).toBe('thinking')
    expect(sessionRunStatusOf({ running: true, activity: { kind: 'retrying' } })).toBe('thinking')
  })

  it('switches to tools once the reply arrived and its tool calls execute', () => {
    expect(sessionRunStatusOf({ running: true, activity: { kind: 'tool', tool: 'Bash' } })).toBe('tools')
  })

  it('treats running work outside a model turn as tools', () => {
    // A background task or a busy CLI: running, no turn activity.
    expect(sessionRunStatusOf({ running: true })).toBe('tools')
  })

  it('puts a halt on the person above everything, even with a tool in flight', () => {
    expect(
      sessionRunStatusOf({ running: true, needsAnswer: true, activity: { kind: 'tool', tool: 'Write' } }),
    ).toBe('awaiting')
    expect(sessionRunStatusOf({ needsAnswer: true })).toBe('awaiting')
  })

  it('is paused when the turn was stopped and could be continued', () => {
    expect(sessionRunStatusOf({ ending: 'stopped' })).toBe('paused')
    expect(sessionRunStatusOf({ ending: 'failed', resumable: true })).toBe('paused')
    expect(sessionRunStatusOf({ ending: 'stopped', resumable: false })).toBeNull()
  })

  it('shows nothing for a finished or idle session', () => {
    expect(sessionRunStatusOf({ ending: 'finished' })).toBeNull()
    expect(sessionRunStatusOf({ ending: 'failed' })).toBeNull()
    expect(sessionRunStatusOf({})).toBeNull()
  })
})

describe('useSessionRunStatus', () => {
  const entry = (extra: Partial<SessionStatusEntry>): SessionStatusEntry => ({
    sessionId: 's1',
    title: 's1',
    ...extra,
  })

  it('follows the published activity from request to tools and back', () => {
    const { result } = renderHook(() => useSessionRunStatus('s1'))
    expect(result.current).toBeNull()
    act(() => publishSessionStatuses([entry({ running: true, activity: { kind: 'responding' } })]))
    expect(result.current).toBe('thinking')
    act(() => publishSessionStatuses([entry({ running: true, activity: { kind: 'tool', tool: 'Read' } })]))
    expect(result.current).toBe('tools')
    act(() => publishSessionStatuses([entry({ running: true, activity: { kind: 'responding' } })]))
    expect(result.current).toBe('thinking')
    act(() => publishSessionStatuses([entry({ ending: 'finished' })]))
    expect(result.current).toBeNull()
  })

  it('reads a run the list has not published yet as a request just sent', () => {
    const { result } = renderHook(() => useSessionRunStatus('s1', { running: true }))
    expect(result.current).toBe('thinking')
  })

  it('re-renders only when the status changes, not on every entry update', () => {
    let renders = 0
    renderHook(() => {
      renders++
      return useSessionRunStatus('s1')
    })
    act(() => publishSessionStatuses([entry({ running: true, activity: { kind: 'tool', tool: 'Read' } })]))
    const afterTools = renders
    act(() => publishSessionStatuses([entry({ running: true, activity: { kind: 'tool', tool: 'Edit' }, updatedAt: 2 })]))
    act(() => publishSessionStatuses([entry({ running: true, activity: { kind: 'tool', tool: 'Bash' }, previewText: 'x' })]))
    act(() => publishSessionStatuses([entry({ running: true, activity: { kind: 'tool', tool: 'Bash' } }), entry({ sessionId: 's2', running: true })]))
    expect(renders).toBe(afterTools)
  })
})

describe('collapsedRowStatus', () => {
  const idle = { running: false, needsAnswer: false }
  it('keeps the parent own status when it has a live one', () => {
    expect(collapsedRowStatus('thinking', { running: true, needsAnswer: false })).toBe('thinking')
    expect(collapsedRowStatus('paused', idle)).toBe('paused')
    expect(collapsedRowStatus(null, idle)).toBeNull()
  })
  it('reads running descendants as tools and a halt below as awaiting', () => {
    expect(collapsedRowStatus(null, { running: true, needsAnswer: false })).toBe('tools')
    expect(collapsedRowStatus('paused', { running: true, needsAnswer: false })).toBe('tools')
    expect(collapsedRowStatus('tools', { running: true, needsAnswer: true })).toBe('awaiting')
  })
})

describe('SessionStatusIcon', () => {
  it('draws the thinking brain from unit-length strokes', () => {
    const { container } = render(createElement(SessionStatusIcon, { status: 'thinking' }))
    const paths = [...container.querySelectorAll('[data-status="thinking"] > path')]
    expect(paths).toHaveLength(8)
    for (const path of paths) expect(path.getAttribute('pathLength')).toBe('1')
  })

  it('draws the same brain as lucide BrainIcon', () => {
    const strokes = (el: ParentNode) =>
      [...el.querySelectorAll('path')].map(p => p.getAttribute('d'))
    const drawn = render(createElement(SessionStatusIcon, { status: 'thinking' })).container
    const library = render(createElement(BrainIcon)).container
    expect(strokes(drawn)).toEqual(strokes(library))
  })

  it('names each status for assistive technology', () => {
    render(createElement(SessionStatusIcon, { status: 'awaiting' }))
    const icon = screen.getByRole('img')
    expect(icon.getAttribute('aria-label')).toBe('Waiting for your reply')
    expect(icon.getAttribute('data-status')).toBe('awaiting')
  })

  it('hides itself when decorative', () => {
    const { container } = render(createElement(SessionStatusIcon, { status: 'paused', decorative: true }))
    const icon = container.querySelector('[data-slot="session-status-icon"]')!
    expect(icon.getAttribute('aria-hidden')).toBe('true')
    expect(icon.getAttribute('aria-label')).toBeNull()
  })
})

describe('session list row', () => {
  const item = (sessionId: string, extra: Partial<SessionListItem> = {}): SessionListItem => ({
    sessionId,
    title: sessionId,
    previewText: '',
    updatedAt: Date.now() - 1000,
    ...extra,
  })
  const renderRows = (sessions: SessionListItem[]) =>
    render(
      createElement(Sidebar, {
        title: 'Conversation',
        sessionId: 'none',
        activeSessionId: 'none',
        sessions,
      }),
    )
  const leading = (sessionId: string) => {
    const row = screen.getByTestId(`sidebar-row-${sessionId}`)
    return {
      status: row.querySelector<HTMLElement>('[data-slot="session-status-icon"]')?.dataset.status ?? null,
      typeIcon: row.querySelector('[data-slot="session-row-type-icon"]') !== null,
    }
  }

  it('shows the status before the title and the type icon once done', () => {
    publishSessionStatuses([
      { sessionId: 'a', title: 'a', running: true, activity: { kind: 'responding' } },
      { sessionId: 'b', title: 'b', running: true, activity: { kind: 'tool', tool: 'Bash' } },
      { sessionId: 'c', title: 'c', needsAnswer: true },
      { sessionId: 'd', title: 'd', ending: 'stopped' },
      { sessionId: 'e', title: 'e', ending: 'finished' },
    ])
    renderRows([
      item('a', { running: true }),
      item('b', { running: true }),
      item('c', { needsAnswer: true }),
      item('d'),
      item('e'),
    ])
    expect(leading('a')).toEqual({ status: 'thinking', typeIcon: false })
    expect(leading('b')).toEqual({ status: 'tools', typeIcon: false })
    expect(leading('c')).toEqual({ status: 'awaiting', typeIcon: false })
    expect(leading('d')).toEqual({ status: 'paused', typeIcon: false })
    expect(leading('e')).toEqual({ status: null, typeIcon: true })
  })

  it('shows a collapsed parent idle while its child runs a tool as tools, not thinking', () => {
    localStorage.setItem('nexus:sidebar:childrenCollapsed', JSON.stringify(['p']))
    publishSessionStatuses([
      { sessionId: 'p', title: 'p', ending: 'finished' },
      { sessionId: 'c', title: 'c', parentSessionId: 'p', running: true, activity: { kind: 'tool', tool: 'Bash' } },
    ])
    renderRows([
      item('p'),
      item('c', { parentSessionId: 'p', lineageKind: 'side_session', running: true }),
    ])
    expect(leading('p').status).toBe('tools')
  })

  it('labels the waiting icon only where no attention dot already says it', () => {
    publishSessionStatuses([{ sessionId: 'c', title: 'c', needsAnswer: true }])
    renderRows([item('c', { needsAnswer: true })])
    const icon = screen.getByTestId('sidebar-row-c').querySelector('[data-slot="session-status-icon"]')!
    expect(icon.getAttribute('aria-hidden')).toBe('true')
  })

  it('keeps the waiting icon named on the active row, where no dot is drawn', () => {
    publishSessionStatuses([{ sessionId: 'c', title: 'c', needsAnswer: true }])
    render(
      createElement(Sidebar, {
        title: 'Conversation',
        sessionId: 'c',
        activeSessionId: 'c',
        sessions: [item('c', { needsAnswer: true })],
      }),
    )
    const icon = screen.getByTestId('sidebar-row-c').querySelector('[data-slot="session-status-icon"]')!
    expect(icon.getAttribute('aria-hidden')).toBeNull()
    expect(icon.getAttribute('aria-label')).toBe('Waiting for your reply')
  })
})
