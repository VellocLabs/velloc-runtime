// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Sidebar, type SessionListItem } from '../browser/webview/Sidebar'
import {
  clearSessionListView,
  DEFAULT_SESSION_LIST_VIEW,
  readSessionListView,
  writeSessionListView,
} from '../browser/webview/sessionListView'

// The session list's options menu drives the rendered list: "Group by" changes
// the headers, "Sort by" the order; the choice is remembered per window. The
// grouping rules themselves are pinned in session-list-view.test.ts. (F-17)

// Map-backed page storage, as the other render tests use.
const memoryStorage = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => memoryStorage.get(k) ?? null,
  setItem: (k: string, v: string) => void memoryStorage.set(k, String(v)),
  removeItem: (k: string) => void memoryStorage.delete(k),
  clear: () => memoryStorage.clear(),
})

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.now()

// Activity order: Bravo, Alpha, Charlie, Legacy. Creation order: Charlie,
// Alpha, Bravo; Legacy has none. Alpha runs, Charlie needs an answer.
const SESSIONS: SessionListItem[] = [
  { sessionId: 'a', title: 'Alpha', previewText: '', updatedAt: NOW - 2 * DAY, createdAt: NOW - 20 * DAY, running: true },
  { sessionId: 'b', title: 'Bravo', previewText: '', updatedAt: NOW - 1000, createdAt: NOW - 40 * DAY },
  { sessionId: 'c', title: 'Charlie', previewText: '', updatedAt: NOW - 3 * DAY, createdAt: NOW - 3 * DAY, needsAnswer: true },
  { sessionId: 'legacy', title: 'Legacy', previewText: '', updatedAt: NOW - 50 * DAY },
]

function renderSidebar() {
  return render(
    createElement(Sidebar, {
      title: 'Conversation',
      sessionId: 'b',
      activeSessionId: 'b',
      sessions: SESSIONS,
    }),
  )
}

/** Recents rows in display order (a running row's shimmer overlay repeats its title; skipped). */
function rowTitles(): string[] {
  return Array.from(document.querySelectorAll('[data-slot="session-row-title"]')).map(el => {
    const copy = el.cloneNode(true) as HTMLElement
    copy.querySelectorAll('.shimmer').forEach(overlay => overlay.remove())
    return copy.textContent ?? ''
  })
}

/** Group header keys, in display order. */
function headers(): string[] {
  return Array.from(document.querySelectorAll('[data-testid="sidebar-group-header"]')).map(
    el => el.getAttribute('data-group') ?? '',
  )
}

function openSubmenu(testId: 'sidebar-group-by' | 'sidebar-sort-by') {
  act(() => {
    fireEvent.keyDown(screen.getByTestId('sidebar-list-options'), { key: 'Enter' })
  })
  act(() => {
    fireEvent.keyDown(screen.getByTestId(testId), { key: 'ArrowRight' })
  })
}

function pick(testId: string) {
  act(() => {
    fireEvent.click(screen.getByTestId(testId))
  })
}

const checked = (testId: string) => screen.getByTestId(testId).getAttribute('aria-checked')

describe('stored view', () => {
  beforeEach(() => memoryStorage.clear())

  it('defaults when nothing is stored, and per part when a part is malformed', () => {
    expect(readSessionListView()).toEqual(DEFAULT_SESSION_LIST_VIEW)
    memoryStorage.set('nexus:sidebar:sessionListView', '{not json')
    expect(readSessionListView()).toEqual(DEFAULT_SESSION_LIST_VIEW)
    memoryStorage.set(
      'nexus:sidebar:sessionListView',
      JSON.stringify({ groupBy: 'status', field: 'name', direction: 'up' }),
    )
    expect(readSessionListView()).toEqual({ ...DEFAULT_SESSION_LIST_VIEW, groupBy: 'status' })
  })

  it('round-trips', () => {
    writeSessionListView({ groupBy: 'date', field: 'created', direction: 'asc' })
    expect(readSessionListView()).toEqual({ groupBy: 'date', field: 'created', direction: 'asc' })
  })

  it('clearing deletes the stored entry, so the defaults apply', () => {
    writeSessionListView({ groupBy: 'date', field: 'created', direction: 'asc' })
    clearSessionListView()
    expect(memoryStorage.has('nexus:sidebar:sessionListView')).toBe(false)
    expect(readSessionListView()).toEqual(DEFAULT_SESSION_LIST_VIEW)
  })
})

describe('Sidebar list menu', () => {
  beforeEach(() => memoryStorage.clear())
  afterEach(() => cleanup())

  it('out of the box: grouped by week, last updated, newest first', () => {
    renderSidebar()
    expect(rowTitles()).toEqual(['Bravo', 'Alpha', 'Charlie', 'Legacy'])
    // Bravo is today: the first group, so it draws no header.
    expect(headers()).toEqual(['sidebar.timePrevious7Days', 'sidebar.timeOlder'])
  })

  it('each submenu names its current value and checks the current picks', () => {
    renderSidebar()
    openSubmenu('sidebar-group-by')
    expect(screen.getByTestId('sidebar-group-by').textContent).toContain('Week')
    expect(checked('sidebar-group-by-week')).toBe('true')
    expect(checked('sidebar-group-by-none')).toBe('false')
    expect(screen.getByTestId('sidebar-sort-by').textContent).toContain('Last updated')
    act(() => {
      fireEvent.keyDown(screen.getByTestId('sidebar-sort-by'), { key: 'ArrowRight' })
    })
    expect(checked('sidebar-sort-field-updated')).toBe('true')
    expect(checked('sidebar-sort-direction-desc')).toBe('true')
    expect(checked('sidebar-sort-direction-asc')).toBe('false')
  })

  it('group by status shows status headers in their fixed order', () => {
    renderSidebar()
    openSubmenu('sidebar-group-by')
    pick('sidebar-group-by-status')

    expect(headers()).toEqual(['sidebar.needsAnswer', 'sidebar.groupRunning', 'sidebar.groupIdle'])
    expect(rowTitles()).toEqual(['Charlie', 'Alpha', 'Bravo', 'Legacy'])
    expect(readSessionListView().groupBy).toBe('status')
  })

  it('group by none drops every header but keeps the order', () => {
    renderSidebar()
    openSubmenu('sidebar-group-by')
    pick('sidebar-group-by-none')

    expect(headers()).toEqual([])
    expect(rowTitles()).toEqual(['Bravo', 'Alpha', 'Charlie', 'Legacy'])
  })

  it('date created + ascending reorders the rows and their groups, and is remembered', () => {
    renderSidebar()
    openSubmenu('sidebar-sort-by')
    pick('sidebar-sort-field-created')
    openSubmenu('sidebar-sort-by')
    pick('sidebar-sort-direction-asc')

    const expected = ['Legacy', 'Bravo', 'Alpha', 'Charlie']
    expect(rowTitles()).toEqual(expected)
    expect(headers()).toEqual([
      'sidebar.timeOlder',
      'sidebar.timePrevious30Days',
      'sidebar.timePrevious7Days',
    ])
    expect(readSessionListView()).toEqual({ groupBy: 'week', field: 'created', direction: 'asc' })

    cleanup()
    renderSidebar()
    expect(rowTitles()).toEqual(expected)
  })

  it('group by date labels days past yesterday with their date', () => {
    renderSidebar()
    openSubmenu('sidebar-group-by')
    pick('sidebar-group-by-date')

    const labels = Array.from(
      document.querySelectorAll('[data-testid="sidebar-group-header"]'),
    ).map(el => el.textContent ?? '')
    // Bravo is today (no header); the others are older days, shown as dates.
    expect(labels).toHaveLength(3)
    for (const text of labels) expect(text).toMatch(/\d/)
  })

  it('Reset to defaults deletes the stored view and restores the default list', () => {
    renderSidebar()
    openSubmenu('sidebar-group-by')
    pick('sidebar-group-by-status')
    openSubmenu('sidebar-sort-by')
    pick('sidebar-sort-direction-asc')
    expect(memoryStorage.has('nexus:sidebar:sessionListView')).toBe(true)

    act(() => {
      fireEvent.keyDown(screen.getByTestId('sidebar-list-options'), { key: 'Enter' })
    })
    pick('sidebar-list-reset')

    expect(memoryStorage.has('nexus:sidebar:sessionListView')).toBe(false)
    expect(rowTitles()).toEqual(['Bravo', 'Alpha', 'Charlie', 'Legacy'])
    expect(headers()).toEqual(['sidebar.timePrevious7Days', 'sidebar.timeOlder'])
    openSubmenu('sidebar-group-by')
    expect(checked('sidebar-group-by-week')).toBe('true')
  })
})
