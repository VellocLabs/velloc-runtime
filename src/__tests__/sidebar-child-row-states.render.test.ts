// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Sidebar, type SessionListItem } from '../browser/webview/Sidebar'
import { resetSessionTreeFallbackReports } from '../browser/webview/sessionTree'
import { sidebarRowOrder } from '../browser/webview/sessionPinning'
import { DEFAULT_SESSION_LIST_VIEW } from '../browser/webview/sessionListView'

// A child session's row while it starts, after it failed to start, and once
// archived: progress, the failure with its dismiss, and Archived naming the
// parent. (F-36)

const NOW = Date.now()

const memoryStorage = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => memoryStorage.get(k) ?? null,
  setItem: (k: string, v: string) => void memoryStorage.set(k, String(v)),
  removeItem: (k: string) => void memoryStorage.delete(k),
  clear: () => memoryStorage.clear(),
})

function item(sessionId: string, extra: Partial<SessionListItem> = {}): SessionListItem {
  return { sessionId, title: sessionId, previewText: '', updatedAt: NOW - 1000, ...extra }
}

const under = (parentSessionId: string) => ({ parentSessionId, lineageKind: 'side_session' as const })

type Handlers = {
  onArchiveThread?: (id: string, archived: boolean) => void
  onSwitchThread?: (id: string) => void
  onDeleteThread?: (id: string) => void
}

function sidebar(sessions: SessionListItem[], handlers: Handlers = {}) {
  return createElement(Sidebar, {
    title: 'Conversation',
    sessionId: 'none',
    activeSessionId: 'none',
    sessions,
    ...handlers,
  })
}

const renderSidebar = (sessions: SessionListItem[], handlers: Handlers = {}) =>
  render(sidebar(sessions, handlers))

const rowOf = (sessionId: string) => screen.getByTestId(`sidebar-row-${sessionId}`)
const slot = (sessionId: string, name: string) =>
  rowOf(sessionId).querySelector<HTMLElement>(`[data-slot="${name}"]`)

/** Session rows in DOM order, with each section toggle as `#<testid>`. */
function sequence(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(
      '[data-testid="sidebar-recents-toggle"], [data-testid="sidebar-archived-toggle"], [data-testid^="sidebar-row-"][data-session-id]',
    ),
  ).map(el => el.dataset.sessionId ?? `#${el.dataset.testid}`)
}

beforeEach(() => {
  localStorage.clear()
  resetSessionTreeFallbackReports()
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('a starting child row', () => {
  it('shows progress in the leading slot and the starting word, nested under its parent', () => {
    renderSidebar([item('p'), item('c', { ...under('p'), starting: true })], { onArchiveThread: vi.fn() })
    expect(rowOf('c').dataset.depth).toBe('1')
    expect(slot('c', 'session-row-starting-icon')).not.toBeNull()
    expect(slot('c', 'session-row-type-icon')).toBeNull()
    expect(slot('c', 'session-row-start-state')?.dataset.startState).toBe('starting')
    expect(slot('c', 'session-row-start-state')?.textContent).toBe('Starting…')
  })

  it('offers no way to archive it: no dismiss, no Unarchive, nothing in its menu', async () => {
    renderSidebar([item('p'), item('c', { ...under('p'), starting: true })], { onArchiveThread: vi.fn(), onDeleteThread: vi.fn() })
    expect(screen.queryByTestId('sidebar-dismiss-start')).toBeNull()
    const trigger = rowOf('c').parentElement!.querySelector<HTMLElement>('[data-testid="sidebar-row-actions"]')!
    fireEvent.pointerDown(trigger)
    fireEvent.click(trigger)
    await screen.findByRole('menu')
    expect(screen.queryByTestId('sidebar-unarchive-thread')).toBeNull()
  })

  it('shows its type icon again once it started, and the running mark while it runs', () => {
    const { rerender } = renderSidebar([item('p'), item('c', { ...under('p'), starting: true })])
    rerender(sidebar([item('p'), item('c', under('p'))]))
    expect(slot('c', 'session-row-starting-icon')).toBeNull()
    expect(slot('c', 'session-row-type-icon')).not.toBeNull()
    expect(slot('c', 'session-row-start-state')).toBeNull()
    rerender(sidebar([item('p'), item('c', { ...under('p'), running: true })]))
    expect(slot('c', 'session-row-running-icon')).not.toBeNull()
  })
})

describe('a child that did not start', () => {
  const failed = () => item('c', { ...under('p'), startFailed: 'the worktree could not be created' })

  it('shows the failure, with its reason for the tooltip and for assistive tech, and no progress', () => {
    renderSidebar([item('p'), failed()], { onArchiveThread: vi.fn() })
    const state = slot('c', 'session-row-start-state')!
    expect(state.dataset.startState).toBe('failed')
    expect(state.textContent).toBe('Did not start')
    expect(state.title).toBe('Did not start: the worktree could not be created')
    expect(rowOf('c').textContent).toContain('Did not start: the worktree could not be created')
    expect(slot('c', 'session-row-starting-icon')).toBeNull()
    fireEvent.pointerOver(rowOf('c'))
    expect(rowOf('c').getAttribute('title')).toContain('Did not start: the worktree could not be created')
  })

  it('is dismissed by archiving it, without opening it', () => {
    const onArchiveThread = vi.fn()
    const onSwitchThread = vi.fn()
    renderSidebar([item('p'), failed()], { onArchiveThread, onSwitchThread })
    const dismiss = screen.getByTestId('sidebar-dismiss-start')
    expect(dismiss.dataset.sessionId).toBe('c')
    expect(dismiss.getAttribute('aria-label')).toBe('Dismiss c (moves it to Archived)')
    fireEvent.click(dismiss)
    expect(onArchiveThread).toHaveBeenCalledWith('c', true)
    expect(onSwitchThread).not.toHaveBeenCalled()
  })

  it('offers no dismiss without an archive handler, nor on a row that started', () => {
    renderSidebar([item('p'), item('ok', under('p')), failed()])
    expect(screen.queryByTestId('sidebar-dismiss-start')).toBeNull()
    cleanup()
    renderSidebar([item('p'), item('ok', under('p'))], { onArchiveThread: vi.fn() })
    expect(screen.queryByTestId('sidebar-dismiss-start')).toBeNull()
  })
})

describe('an archived child', () => {
  const sessions = () => [
    item('p', { title: 'Main work' }),
    item('c', { ...under('p'), title: 'Old probe', archived: true }),
    item('live', { ...under('p'), title: 'Still going' }),
  ]

  it('leaves the nested list: its parent counts only the live child', () => {
    renderSidebar(sessions(), { onArchiveThread: vi.fn() })
    expect(rowOf('p').dataset.children).toBe('1')
    expect(document.querySelector('[data-parent-session-id="p"] [data-session-id="c"]')).toBeNull()
  })

  it('is listed under Archived, collapsed until opened, naming its parent', () => {
    renderSidebar(sessions(), { onArchiveThread: vi.fn() })
    expect(sequence()).toEqual(['#sidebar-recents-toggle', 'p', 'live', '#sidebar-archived-toggle'])
    fireEvent.click(screen.getByTestId('sidebar-archived-toggle'))
    expect(sequence()).toEqual(['#sidebar-recents-toggle', 'p', 'live', '#sidebar-archived-toggle', 'c'])
    expect(rowOf('c').dataset.archived).toBe('true')
    expect(rowOf('c').dataset.depth).toBeUndefined()
    expect(slot('c', 'session-row-archived-parent')?.textContent).toBe('from Main work')
    // Opened stays opened in this window.
    cleanup()
    renderSidebar(sessions(), { onArchiveThread: vi.fn() })
    expect(sequence()).toContain('c')
  })

  it('names a parent that is itself archived; a top-level archived row names none', () => {
    renderSidebar(
      [
        item('p', { title: 'Main work', archived: true }),
        item('c', { ...under('p'), title: 'Old probe', archived: true }),
        item('solo', { title: 'Solo', archived: true }),
      ],
      { onArchiveThread: vi.fn() },
    )
    fireEvent.click(screen.getByTestId('sidebar-archived-toggle'))
    expect(slot('c', 'session-row-archived-parent')?.textContent).toBe('from Main work')
    expect(slot('solo', 'session-row-archived-parent')).toBeNull()
    expect(slot('p', 'session-row-archived-parent')).toBeNull()
  })

  it('is unarchived from its menu, which offers no pin, rename, fork or archive', async () => {
    const onArchiveThread = vi.fn()
    renderSidebar(sessions(), { onArchiveThread, onDeleteThread: vi.fn() })
    fireEvent.click(screen.getByTestId('sidebar-archived-toggle'))
    const trigger = rowOf('c').parentElement!.querySelector<HTMLElement>('[data-testid="sidebar-row-actions"]')!
    fireEvent.pointerDown(trigger)
    fireEvent.click(trigger)
    await screen.findByRole('menu')
    expect(screen.queryByTestId('sidebar-pin-thread')).toBeNull()
    expect(screen.queryByTestId('sidebar-rename-thread')).toBeNull()
    expect(screen.queryByTestId('sidebar-fork-thread')).toBeNull()
    expect(screen.queryByTestId('sidebar-archive-thread')).toBeNull()
    expect(screen.getByTestId('sidebar-delete-thread')).toBeTruthy()
    fireEvent.click(screen.getByTestId('sidebar-unarchive-thread'))
    expect(onArchiveThread).toHaveBeenCalledWith('c', false)
  })

  it('lists the live child of an archived parent top-level, without a missing-parent report', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    renderSidebar([item('p', { archived: true }), item('c', under('p'))])
    expect(rowOf('c').dataset.depth).toBeUndefined()
    expect(warn).not.toHaveBeenCalled()
  })

  it('is not among the rows the rail and the keyboard order walk', () => {
    const rows = sidebarRowOrder(sessions(), DEFAULT_SESSION_LIST_VIEW, NOW)
    expect(rows.map(r => r.sessionId)).toEqual(['p', 'live'])
  })

  it('shows no Archived section when nothing is archived', () => {
    renderSidebar([item('p'), item('c', under('p'))])
    expect(screen.queryByTestId('sidebar-archived-toggle')).toBeNull()
  })
})
