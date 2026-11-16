// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SessionsPage } from '../browser/webview/SessionsPage'
import type { SessionListItem } from '../browser/webview/SessionRows'
import { sessionsPageRows } from '../browser/webview/sessionsPageRows'
import { createTranslate } from '../browser/webview/i18n/translate'
import {
  createShellHandleArchiveSessions,
  createShellHandleNewSessionFromList,
  createShellHandleOpenListedSession,
  createShellHandleRequestBulkDelete,
} from '../browser/webview/shellSessionsPage'
import {
  BULK_DELETE_NAMED_TITLES,
  bulkDeletionOrder,
  SessionsBulkDeleteConfirm,
} from '../browser/webview/SessionsBulkDelete'

// The Sessions page ("View all"): Active / Archived, a search over titles and
// project names, newest activity first, a row opens its session. (F-17)

const t = createTranslate('en')
const MIN = 60 * 1000
const NOW = Date.now()

const SESSIONS: SessionListItem[] = [
  { sessionId: 'old', title: 'Old notes', previewText: '', updatedAt: NOW - 600 * MIN },
  {
    sessionId: 'menu',
    title: 'Compose context menu',
    previewText: '',
    updatedAt: NOW - 1 * MIN,
    projectRoot: 'D:\\work\\velloc-bootstrap\\',
    running: true,
  },
  {
    sessionId: 'draft',
    title: 'Timer stops',
    previewText: '',
    updatedAt: NOW - 120 * MIN,
    // A composer edit counts as activity: this row sorts above "Old notes".
    lastComposerEditAt: NOW - 10 * MIN,
    projectRoot: '/home/me/api',
    needsAnswer: true,
  },
  { sessionId: 'gone', title: 'Crash triage', previewText: '', updatedAt: NOW - 5 * MIN, archived: true },
  { sessionId: 'fresh', title: 'New Thread', previewText: '', updatedAt: NOW - 30 * MIN, templateType: 'agent' },
]

describe('sessionsPageRows', () => {
  it('lists one tab, flat, newest activity first', () => {
    expect(sessionsPageRows(SESSIONS, 'active', '', t).map(r => r.session.sessionId)).toEqual([
      'menu',
      'draft',
      'fresh',
      'old',
    ])
    expect(sessionsPageRows(SESSIONS, 'archived', '', t).map(r => r.session.sessionId)).toEqual([
      'gone',
    ])
  })

  it('names the project by its folder and the untitled session by its type', () => {
    const rows = sessionsPageRows(SESSIONS, 'active', '', t)
    const byId = new Map(rows.map(r => [r.session.sessionId, r]))
    expect(byId.get('menu')?.project).toBe('velloc-bootstrap')
    expect(byId.get('draft')?.project).toBe('api')
    expect(byId.get('old')?.project).toBeUndefined()
    expect(byId.get('fresh')?.title).not.toBe('New Thread')
  })

  it('matches the query against title or project, case-insensitive and trimmed', () => {
    const ids = (query: string) =>
      sessionsPageRows(SESSIONS, 'active', query, t).map(r => r.session.sessionId)
    expect(ids('  CONTEXT ')).toEqual(['menu'])
    expect(ids('bootstrap')).toEqual(['menu'])
    expect(ids('api')).toEqual(['draft'])
    expect(ids('crash')).toEqual([])
    expect(ids('   ')).toHaveLength(4)
  })
})

function renderPage() {
  const handlers = {
    onOpenSession: vi.fn(),
    onNewSession: vi.fn(),
    onArchiveSessions: vi.fn(),
    onDeleteSessions: vi.fn(),
    onClose: vi.fn(),
  }
  render(createElement(SessionsPage, { sessions: SESSIONS, ...handlers }))
  return handlers
}

const rowIds = () =>
  Array.from(document.querySelectorAll('[data-testid="sessions-page-row"]')).map(el =>
    el.getAttribute('data-session-id'),
  )

const click = (testId: string) =>
  act(() => {
    fireEvent.click(screen.getByTestId(testId))
  })

describe('SessionsPage', () => {
  afterEach(() => cleanup())

  it('opens on Active and switches to Archived', () => {
    renderPage()
    expect(screen.getByTestId('sessions-page-tab-active').getAttribute('aria-selected')).toBe('true')
    expect(rowIds()).toEqual(['menu', 'draft', 'fresh', 'old'])
    click('sessions-page-tab-archived')
    expect(screen.getByTestId('sessions-page-tab-archived').getAttribute('aria-selected')).toBe('true')
    expect(rowIds()).toEqual(['gone'])
  })

  it('marks running and waiting rows', () => {
    renderPage()
    const row = (id: string) =>
      document.querySelector(`[data-testid="sessions-page-row"][data-session-id="${id}"]`)!
    expect(row('menu').hasAttribute('data-running')).toBe(true)
    expect(row('draft').hasAttribute('data-needs-answer')).toBe(true)
    expect(row('old').hasAttribute('data-running')).toBe(false)
  })

  it('a row opens its session; New session starts one', () => {
    const { onOpenSession, onNewSession } = renderPage()
    act(() => {
      fireEvent.click(
        document.querySelector('[data-testid="sessions-page-row"][data-session-id="draft"]')!,
      )
    })
    expect(onOpenSession).toHaveBeenCalledWith('draft')
    click('sessions-page-new')
    expect(onNewSession).toHaveBeenCalledTimes(1)
  })

  it('search narrows the rows, says when nothing matches, and closing it restores them', () => {
    renderPage()
    click('sessions-page-search-toggle')
    const input = screen.getByTestId('sessions-page-search') as HTMLInputElement
    act(() => {
      fireEvent.change(input, { target: { value: 'bootstrap' } })
    })
    expect(rowIds()).toEqual(['menu'])
    act(() => {
      fireEvent.change(input, { target: { value: 'zzz' } })
    })
    expect(rowIds()).toEqual([])
    expect(screen.getByTestId('sessions-page-empty').textContent).toBe(
      t('sessionsPage.noMatches', { query: 'zzz' }),
    )
    click('sessions-page-search-close')
    expect(screen.queryByTestId('sessions-page-search')).toBeNull()
    expect(rowIds()).toHaveLength(4)
  })

  it('Escape closes an open search first, then the page', () => {
    const { onClose } = renderPage()
    click('sessions-page-search-toggle')
    act(() => {
      fireEvent.keyDown(screen.getByTestId('sessions-page-search'), { key: 'Escape' })
    })
    expect(screen.queryByTestId('sessions-page-search')).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    act(() => {
      fireEvent.keyDown(screen.getByTestId('sessions-page'), { key: 'Escape' })
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('an empty tab says so', () => {
    render(
      createElement(SessionsPage, {
        sessions: SESSIONS.filter(s => !s.archived),
        onOpenSession: vi.fn(),
        onNewSession: vi.fn(),
        onArchiveSessions: vi.fn(),
        onDeleteSessions: vi.fn(),
        onClose: vi.fn(),
      }),
    )
    click('sessions-page-tab-archived')
    expect(screen.getByTestId('sessions-page-empty').textContent).toBe(
      t('sessionsPage.emptyArchived'),
    )
  })
})

describe('shell handlers', () => {
  it('a pick from the list closes the page, the active session included', () => {
    const setOpen = vi.fn()
    const focusSession = vi.fn()
    createShellHandleOpenListedSession(setOpen, focusSession)('menu')
    expect(setOpen).toHaveBeenCalledWith(false)
    expect(focusSession).toHaveBeenCalledWith('menu')
  })

  it('New session closes the page even when the start reuses the active session', () => {
    const setOpen = vi.fn()
    const openNewSession = vi.fn()
    createShellHandleNewSessionFromList(setOpen, openNewSession)()
    expect(setOpen).toHaveBeenCalledWith(false)
    expect(openNewSession).toHaveBeenCalledTimes(1)
  })
})

const pickBox = (id: string) =>
  document.querySelector(
    `[data-testid="sessions-page-row-pick"][data-session-id="${id}"]`,
  ) as HTMLInputElement

const pick = (id: string) =>
  act(() => {
    fireEvent.click(pickBox(id))
  })

const pickedCount = () =>
  Number(screen.getByTestId('sessions-page-selection-bar').getAttribute('data-picked'))

describe('SessionsPage picks', () => {
  afterEach(() => cleanup())

  it('ticking a row picks it without opening it', () => {
    const { onOpenSession } = renderPage()
    pick('draft')
    expect(pickBox('draft').checked).toBe(true)
    expect(pickedCount()).toBe(1)
    expect(onOpenSession).not.toHaveBeenCalled()
    pick('draft')
    expect(pickedCount()).toBe(0)
  })

  it('select all picks every shown row, is mixed when some are, and clears when all are', () => {
    renderPage()
    const all = () => screen.getByTestId('sessions-page-select-all') as HTMLInputElement
    pick('menu')
    expect(all().checked).toBe(false)
    expect(all().indeterminate).toBe(true)
    click('sessions-page-select-all')
    expect(pickedCount()).toBe(4)
    expect(all().checked).toBe(true)
    expect(all().indeterminate).toBe(false)
    click('sessions-page-select-all')
    expect(pickedCount()).toBe(0)
  })

  it('select all takes only the rows the search shows, and actions skip hidden picks', () => {
    const { onArchiveSessions } = renderPage()
    pick('old')
    click('sessions-page-search-toggle')
    act(() => {
      fireEvent.change(screen.getByTestId('sessions-page-search'), { target: { value: 'api' } })
    })
    // "old" stays picked but is not shown: the bar counts only shown picks.
    expect(pickedCount()).toBe(0)
    click('sessions-page-select-all')
    click('sessions-page-archive-picked')
    expect(onArchiveSessions).toHaveBeenCalledWith(['draft'], true)
  })

  it('Archive on Active archives the picks and clears them', () => {
    const { onArchiveSessions } = renderPage()
    pick('menu')
    pick('old')
    click('sessions-page-archive-picked')
    expect(onArchiveSessions).toHaveBeenCalledWith(['menu', 'old'], true)
    expect(pickedCount()).toBe(0)
  })

  it('on Archived the same button unarchives', () => {
    const { onArchiveSessions } = renderPage()
    click('sessions-page-tab-archived')
    pick('gone')
    expect(screen.getByTestId('sessions-page-archive-picked').textContent).toBe(t('sidebar.unarchive'))
    click('sessions-page-archive-picked')
    expect(onArchiveSessions).toHaveBeenCalledWith(['gone'], false)
  })

  it('Delete asks for the picks in one request and keeps them until the delete lands', () => {
    const { onDeleteSessions } = renderPage()
    pick('fresh')
    pick('menu')
    click('sessions-page-delete-picked')
    expect(onDeleteSessions).toHaveBeenCalledTimes(1)
    expect(onDeleteSessions).toHaveBeenCalledWith(['menu', 'fresh'])
    expect(pickedCount()).toBe(2)
  })

  it('switching tabs drops the picks', () => {
    renderPage()
    pick('menu')
    click('sessions-page-tab-archived')
    click('sessions-page-tab-active')
    expect(pickedCount()).toBe(0)
    expect(pickBox('menu').checked).toBe(false)
  })

  it('Escape clears the picks before it closes the page', () => {
    const { onClose } = renderPage()
    pick('menu')
    act(() => {
      fireEvent.keyDown(screen.getByTestId('sessions-page'), { key: 'Escape' })
    })
    expect(pickedCount()).toBe(0)
    expect(onClose).not.toHaveBeenCalled()
    act(() => {
      fireEvent.keyDown(screen.getByTestId('sessions-page'), { key: 'Escape' })
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('bulk delete', () => {
  afterEach(() => cleanup())

  it('orders the picks still listed, the active session last, each once', () => {
    expect(bulkDeletionOrder(SESSIONS, ['menu', 'old', 'menu', 'missing'], 'menu')).toEqual(['old', 'menu'])
    expect(bulkDeletionOrder(SESSIONS, ['old', 'draft'], 'menu')).toEqual(['old', 'draft'])
  })

  function renderConfirm(target: string[] | null, onDelete = vi.fn(async (_sessionId: string) => true)) {
    const onClose = vi.fn()
    const onShow = vi.fn()
    const view = render(
      createElement(SessionsBulkDeleteConfirm<SessionListItem>, {
        target,
        sessions: SESSIONS,
        activeSessionId: 'menu',
        onShow,
        onDelete,
        onClose,
      }),
    )
    return { onClose, onShow, onDelete, view }
  }

  it('is one dialog naming the count, the titles and the busy ones', () => {
    renderConfirm(['old', 'draft', 'menu'])
    expect(screen.getAllByTestId('sessions-bulk-delete-dialog')).toHaveLength(1)
    expect(screen.getByRole('heading').textContent).toBe(t('sessionsPage.deleteTitle', { count: 3 }))
    expect(screen.getAllByTestId('sessions-bulk-delete-name').map(el => el.textContent)).toEqual([
      'Old notes',
      'Timer stops',
      'Compose context menu',
    ])
    // "menu" runs and "draft" waits on an answer.
    expect(screen.getByTestId('sessions-bulk-delete-busy').textContent).toBe(
      t('sessionsPage.deleteBusy', { count: 2 }),
    )
  })

  it('takes focus on Cancel and names a single busy pick in the singular', () => {
    renderConfirm(['old', 'menu'])
    expect(document.activeElement).toBe(screen.getByTestId('sessions-bulk-delete-cancel'))
    expect(screen.getByTestId('sessions-bulk-delete-busy').textContent).toBe(
      t('sessionsPage.deleteBusyOne'),
    )
  })

  it('names at most a few titles, then how many more', () => {
    const many: SessionListItem[] = Array.from({ length: BULK_DELETE_NAMED_TITLES + 2 }, (_, i) => ({
      sessionId: `s${i}`,
      title: `Session ${i}`,
      previewText: '',
      updatedAt: NOW - i * MIN,
    }))
    render(
      createElement(SessionsBulkDeleteConfirm<SessionListItem>, {
        target: many.map(s => s.sessionId),
        sessions: many,
        activeSessionId: 'none',
        onShow: vi.fn(),
        onDelete: vi.fn(),
        onClose: vi.fn(),
      }),
    )
    expect(screen.getAllByTestId('sessions-bulk-delete-name')).toHaveLength(BULK_DELETE_NAMED_TITLES)
    expect(screen.getByText(t('sessionsPage.deleteMore', { count: 2 }))).toBeTruthy()
  })

  it('Cancel and Escape delete nothing', () => {
    const { onClose, onDelete } = renderConfirm(['old'])
    expect(screen.getByRole('heading').textContent).toBe(t('sessionsPage.deleteTitleOne'))
    click('sessions-bulk-delete-cancel')
    expect(onClose).toHaveBeenCalledTimes(1)
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' })
    })
    expect(onClose).toHaveBeenCalledTimes(2)
    expect(onDelete).not.toHaveBeenCalled()
  })

  it('Confirm moves off the session on screen, deletes every pick, then closes', async () => {
    const { onClose, onDelete, onShow } = renderConfirm(['menu', 'old'])
    await act(async () => {
      fireEvent.click(screen.getByTestId('sessions-bulk-delete-confirm'))
    })
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(onDelete.mock.calls.map(call => call[0])).toEqual(['old', 'menu'])
    expect(onShow).toHaveBeenCalledTimes(1)
    expect(onShow.mock.calls[0][0]).not.toBe('menu')
    expect(onShow.mock.calls[0][0]).not.toBe('old')
  })

  it('closes on its own when none of the picks is still listed', () => {
    const { onClose } = renderConfirm(['missing'])
    expect(screen.queryByTestId('sessions-bulk-delete-dialog')).toBeNull()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('the shell handlers: archive each pick; a delete request copies the picks, and an empty one asks nothing', () => {
    const archive = vi.fn()
    createShellHandleArchiveSessions(archive)(['a', 'b'], false)
    expect(archive.mock.calls).toEqual([['a', false], ['b', false]])
    const setIds = vi.fn()
    const request = createShellHandleRequestBulkDelete(setIds)
    request([])
    expect(setIds).not.toHaveBeenCalled()
    request(['a'])
    expect(setIds).toHaveBeenCalledWith(['a'])
  })
})

// The shell half: the page keeps the threads mounted, holds itself open through a
// bulk delete, and closes on a sidebar row, a session tab or a switch. (F-17)
const shellSource = readFileSync(
  join(__dirname, '..', 'browser', 'webview', 'MultiSessionShell.tsx'),
  'utf8',
)

describe('shell wiring', () => {
  it('hides the mounted threads under the page without unmounting them', () => {
    expect(shellSource).toMatch(/className=\{sessionsPageOpen \? 'hidden' : 'contents'\}/)
    expect(shellSource).toMatch(/if \(!bulkDeletePendingRef\.current\) setSessionsPageOpen\(false\)/)
  })

  it('opens a session from a sidebar row and from a session tab, the current one included', () => {
    expect(shellSource).toMatch(/activeSessionId=\{sessionsPageOpen \? '' : sidebarActiveId\}/)
    expect(shellSource).toMatch(/onSwitchThread=\{openSessionFromList\}/)
    expect(shellSource).toMatch(/onSelectSessionTab=\{openSessionFromList\}/)
  })

  it('treats the page as covering the conversation for the app pane', () => {
    expect(shellSource).toMatch(
      /covered: settingsSection !== null \|\| customizeOpen \|\| sessionsPageOpen,/,
    )
  })
})
