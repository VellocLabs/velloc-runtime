// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Sidebar, type SessionListItem } from '../browser/webview/Sidebar'

// "Pinned" is a section of its own, beside "Recents": a pinned session is
// listed under Pinned and not under Recents.

const NOW = Date.now()

function item(sessionId: string, updatedAt: number, pinned = false): SessionListItem {
  return { sessionId, title: sessionId, previewText: '', updatedAt, ...(pinned ? { pinned } : {}) }
}

function renderSidebar(sessions: SessionListItem[]) {
  return render(
    createElement(Sidebar, {
      title: 'Conversation',
      sessionId: 'a',
      activeSessionId: 'a',
      sessions,
    }),
  )
}

/** Row ids in DOM order, with each section header as `#<testid>`. */
function sidebarSequence(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(
      '[data-testid="sidebar-pinned-toggle"], [data-testid="sidebar-recents-toggle"], [data-testid^="sidebar-row-"][data-session-id]',
    ),
  ).map(el => el.dataset.sessionId ?? `#${el.dataset.testid}`)
}

// This vitest realm's `localStorage` is not a working Storage; the sections'
// collapsed state reads it at call time, so a Map-backed stub stands in.
const memoryStorage = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => memoryStorage.get(k) ?? null,
  setItem: (k: string, v: string) => void memoryStorage.set(k, String(v)),
  removeItem: (k: string) => void memoryStorage.delete(k),
  clear: () => memoryStorage.clear(),
})

beforeEach(() => {
  localStorage.clear()
})
afterEach(() => cleanup())

describe('Sidebar Pinned section', () => {
  it('sits at the same level as Recents and takes the pinned rows out of it', () => {
    renderSidebar([
      item('a', NOW),
      item('b', NOW - 1000, true),
      item('c', NOW - 2000),
      item('d', NOW - 3000, true),
    ])
    const pinned = screen.getByTestId('sidebar-pinned-toggle')
    const recents = screen.getByTestId('sidebar-recents-toggle')
    expect(pinned.parentElement!.parentElement).toBe(
      recents.parentElement!.parentElement,
    )
    expect(pinned.textContent).toBe('Pinned')
    expect(sidebarSequence()).toEqual([
      '#sidebar-pinned-toggle',
      'b',
      'd',
      '#sidebar-recents-toggle',
      'a',
      'c',
    ])
  })

  it('is absent while nothing is pinned', () => {
    renderSidebar([item('a', NOW), item('b', NOW - 1000)])
    expect(screen.queryByTestId('sidebar-pinned-toggle')).toBeNull()
    expect(sidebarSequence()).toEqual(['#sidebar-recents-toggle', 'a', 'b'])
  })

  it('leaves no empty Recents header when every session is pinned', () => {
    renderSidebar([item('a', NOW, true)])
    expect(screen.queryByTestId('sidebar-recents-toggle')).toBeNull()
    expect(sidebarSequence()).toEqual(['#sidebar-pinned-toggle', 'a'])
  })

  it('collapses on its own, without collapsing Recents', () => {
    renderSidebar([item('a', NOW), item('b', NOW - 1000, true)])
    fireEvent.click(screen.getByTestId('sidebar-pinned-toggle'))
    expect(
      screen.getByTestId('sidebar-pinned-toggle').getAttribute('aria-expanded'),
    ).toBe('false')
    expect(sidebarSequence()).toEqual([
      '#sidebar-pinned-toggle',
      '#sidebar-recents-toggle',
      'a',
    ])
  })

  it('moves the list-options menu to the Pinned header when every session is pinned', () => {
    renderSidebar([item('a', NOW, true), item('b', NOW - 1000, true)])
    const options = screen.getAllByTestId('sidebar-list-options')
    expect(options).toHaveLength(1)
    expect(options[0]!.parentElement).toBe(
      screen.getByTestId('sidebar-pinned-toggle').parentElement,
    )
  })

  it('the collapsed rail shows the same first rows as the expanded list', () => {
    const DAY = 24 * 60 * 60 * 1000
    const sessions = [
      ...Array.from({ length: 25 }, (_, index) => item(`s${index}`, NOW - index * 1000)),
      item('old-pinned', NOW - 40 * DAY, true),
    ]
    render(
      createElement(Sidebar, {
        title: 'Conversation',
        sessionId: 's0',
        activeSessionId: 's0',
        sessions,
        collapsed: true,
      }),
    )
    const railTitles = Array.from(
      document.querySelectorAll<HTMLButtonElement>('aside button[title]'),
    )
      .map(button => button.title)
      .filter(title => sessions.some(session => session.title === title))
    expect(railTitles[0]).toBe('old-pinned')
    expect(railTitles).toHaveLength(20)
  })

  it('re-buckets day groups when the local day changes while idle', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date(2026, 9, 15, 23, 59, 0))
      localStorage.setItem(
        'nexus:sidebar:sessionListView',
        JSON.stringify({ groupBy: 'date', field: 'updated', direction: 'desc' }),
      )
      renderSidebar([item('a', new Date(2026, 9, 15, 23, 58).getTime())])
      // Today's group draws no header.
      expect(screen.queryAllByTestId('sidebar-group-header')).toHaveLength(0)
      act(() => {
        vi.advanceTimersByTime(3 * 60 * 1000)
      })
      expect(
        screen.getByTestId('sidebar-group-header').textContent,
      ).toContain('Yesterday')
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the list-options menu on the Recents header only', () => {
    renderSidebar([item('a', NOW), item('b', NOW - 1000, true)])
    const options = screen.getAllByTestId('sidebar-list-options')
    expect(options).toHaveLength(1)
    expect(options[0]!.parentElement).toBe(
      screen.getByTestId('sidebar-recents-toggle').parentElement,
    )
  })
})
