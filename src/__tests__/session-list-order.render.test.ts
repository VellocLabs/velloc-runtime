// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Sidebar, type SessionListItem } from '../browser/webview/Sidebar'
import {
  DEFAULT_SESSION_LIST_ORDER,
  orderSessions,
  readSessionListOrder,
  writeSessionListOrder,
} from '../browser/webview/sessionListOrder'

// The session list's "Sort by" menu: order by last update or creation, either
// direction, remembered per window. (F-17)

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

// Activity order: b, a, c, legacy. Creation order: c, a, b; `legacy` has no
// creation time (written before it was recorded).
const SESSIONS: SessionListItem[] = [
  { sessionId: 'a', title: 'Alpha', previewText: '', updatedAt: NOW - 2 * DAY, createdAt: NOW - 20 * DAY },
  { sessionId: 'b', title: 'Bravo', previewText: '', updatedAt: NOW - 1000, createdAt: NOW - 40 * DAY },
  { sessionId: 'c', title: 'Charlie', previewText: '', updatedAt: NOW - 3 * DAY, createdAt: NOW - 3 * DAY },
  { sessionId: 'legacy', title: 'Legacy', previewText: '', updatedAt: NOW - 50 * DAY },
]

const ids = (items: readonly { sessionId: string }[]) => items.map(s => s.sessionId)

describe('orderSessions', () => {
  it('last updated, newest first, by default', () => {
    expect(ids(orderSessions(SESSIONS, DEFAULT_SESSION_LIST_ORDER))).toEqual(['b', 'a', 'c', 'legacy'])
  })

  it('a composer edit counts as activity', () => {
    const drafted = SESSIONS.map(s => (s.sessionId === 'legacy' ? { ...s, lastComposerEditAt: NOW } : s))
    expect(ids(orderSessions(drafted, DEFAULT_SESSION_LIST_ORDER))[0]).toBe('legacy')
  })

  it('last updated, oldest first', () => {
    expect(ids(orderSessions(SESSIONS, { field: 'updated', direction: 'asc' }))).toEqual(['legacy', 'c', 'a', 'b'])
  })

  it('date created: an unknown creation time counts as oldest', () => {
    expect(ids(orderSessions(SESSIONS, { field: 'created', direction: 'desc' }))).toEqual(['c', 'a', 'b', 'legacy'])
    expect(ids(orderSessions(SESSIONS, { field: 'created', direction: 'asc' }))).toEqual(['legacy', 'b', 'a', 'c'])
  })

  it('unknown creation times order among themselves by activity, then id', () => {
    const unknown = [
      { sessionId: 'y', updatedAt: 5 },
      { sessionId: 'x', updatedAt: 5 },
      { sessionId: 'z', updatedAt: 9 },
    ]
    expect(ids(orderSessions(unknown, { field: 'created', direction: 'desc' }))).toEqual(['z', 'x', 'y'])
  })

  it('does not mutate its input', () => {
    const input = [...SESSIONS]
    orderSessions(input, { field: 'created', direction: 'asc' })
    expect(ids(input)).toEqual(ids(SESSIONS))
  })
})

describe('remembered order', () => {
  beforeEach(() => localStorage.clear())

  it('defaults when nothing or garbage is stored', () => {
    expect(readSessionListOrder()).toEqual(DEFAULT_SESSION_LIST_ORDER)
    localStorage.setItem('nexus:sidebar:sessionOrder', '{not json')
    expect(readSessionListOrder()).toEqual(DEFAULT_SESSION_LIST_ORDER)
    localStorage.setItem('nexus:sidebar:sessionOrder', JSON.stringify({ field: 'name', direction: 'up' }))
    expect(readSessionListOrder()).toEqual(DEFAULT_SESSION_LIST_ORDER)
  })

  it('round-trips', () => {
    writeSessionListOrder({ field: 'created', direction: 'asc' })
    expect(readSessionListOrder()).toEqual({ field: 'created', direction: 'asc' })
  })
})

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

/** Titles of the Recents rows, in display order. */
function rowTitles(): string[] {
  return Array.from(document.querySelectorAll('[data-slot="session-row-title"]')).map(
    el => el.textContent ?? '',
  )
}

function bucketLabels(): string[] {
  return Array.from(document.querySelectorAll('[data-bucket]')).map(
    el => el.getAttribute('data-bucket') ?? '',
  )
}

function openSortSubmenu() {
  const trigger = screen.getByTestId('sidebar-list-options')
  act(() => {
    fireEvent.keyDown(trigger, { key: 'Enter' })
  })
  const sortBy = screen.getByTestId('sidebar-sort-by')
  act(() => {
    fireEvent.keyDown(sortBy, { key: 'ArrowRight' })
  })
}

function pick(testId: string) {
  act(() => {
    fireEvent.click(screen.getByTestId(testId))
  })
}

describe('Sidebar sort menu', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => cleanup())

  it('lists by last update, newest first, out of the box', () => {
    renderSidebar()
    expect(rowTitles()).toEqual(['Bravo', 'Alpha', 'Charlie', 'Legacy'])
  })

  it('shows the current field beside "Sort by" and checks the current picks', () => {
    renderSidebar()
    openSortSubmenu()

    expect(screen.getByTestId('sidebar-sort-by').textContent).toContain('Last updated')
    expect(screen.getByTestId('sidebar-sort-field-updated').getAttribute('aria-checked')).toBe('true')
    expect(screen.getByTestId('sidebar-sort-field-created').getAttribute('aria-checked')).toBe('false')
    expect(screen.getByTestId('sidebar-sort-direction-desc').getAttribute('aria-checked')).toBe('true')
    expect(screen.getByTestId('sidebar-sort-direction-asc').getAttribute('aria-checked')).toBe('false')
  })

  it('date created reorders the rows, groups them by creation day, and is remembered', () => {
    renderSidebar()
    openSortSubmenu()
    pick('sidebar-sort-field-created')

    expect(rowTitles()).toEqual(['Charlie', 'Alpha', 'Bravo', 'Legacy'])
    expect(bucketLabels()).toEqual(['sidebar.timePrevious7Days', 'sidebar.timePrevious30Days', 'sidebar.timeOlder'])
    expect(readSessionListOrder()).toEqual({ field: 'created', direction: 'desc' })

    // A new window opens with the remembered order.
    cleanup()
    renderSidebar()
    expect(rowTitles()).toEqual(['Charlie', 'Alpha', 'Bravo', 'Legacy'])
  })

  it('ascending flips the order and keeps the field', () => {
    renderSidebar()
    openSortSubmenu()
    pick('sidebar-sort-direction-asc')

    expect(rowTitles()).toEqual(['Legacy', 'Charlie', 'Alpha', 'Bravo'])
    expect(readSessionListOrder()).toEqual({ field: 'updated', direction: 'asc' })
  })
})
