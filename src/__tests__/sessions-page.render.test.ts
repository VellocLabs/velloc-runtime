// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SessionsPage } from '../browser/webview/SessionsPage'
import type { SessionListItem } from '../browser/webview/SessionRows'
import { sessionsPageRows } from '../browser/webview/sessionsPageRows'
import { createTranslate } from '../browser/webview/i18n/translate'
import {
  createShellHandleNewSessionFromList,
  createShellHandleOpenListedSession,
} from '../browser/webview/shellSessionsPage'

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
  const handlers = { onOpenSession: vi.fn(), onNewSession: vi.fn(), onClose: vi.fn() }
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
