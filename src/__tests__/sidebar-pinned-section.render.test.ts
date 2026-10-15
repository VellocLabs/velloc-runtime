// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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

  it('keeps the list-options menu on the Recents header only', () => {
    renderSidebar([item('a', NOW), item('b', NOW - 1000, true)])
    const options = screen.getAllByTestId('sidebar-list-options')
    expect(options).toHaveLength(1)
    expect(options[0]!.parentElement).toBe(
      screen.getByTestId('sidebar-recents-toggle').parentElement,
    )
  })
})
