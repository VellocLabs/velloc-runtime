// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  SessionRowList,
  type SessionListItem,
  type SessionRowListProps,
} from '../browser/webview/SessionRows'
import { DEFAULT_SESSION_LIST_VIEW } from '../browser/webview/sessionListView'
import { buildPinnedFirstView } from '../browser/webview/sessionPinning'

// The per-row ⋯ menu: Pin/Unpin, Rename, Fork, a separator, then Delete —
// on every row, the active one included. Within one list (a workspace group,
// the narrow popover) pinned rows list first and carry an indicator.

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.now()

const SESSIONS: SessionListItem[] = [
  { sessionId: 'newest', title: 'Newest', previewText: '', updatedAt: NOW },
  { sessionId: 'middle', title: 'Middle', previewText: '', updatedAt: NOW - 1000 },
  { sessionId: 'old-pinned', title: 'Old pinned', previewText: '', updatedAt: NOW - 40 * DAY, pinned: true },
]

function renderList(overrides: Partial<SessionRowListProps> = {}) {
  const handlers = {
    onSwitchThread: vi.fn(),
    onDeleteThread: vi.fn(),
    onRenameThread: vi.fn(),
    onPinThread: vi.fn(),
    onForkThread: vi.fn(),
  }
  render(
    createElement(SessionRowList, {
      groups: buildPinnedFirstView(SESSIONS, DEFAULT_SESSION_LIST_VIEW, NOW),
      activeSessionId: 'newest',
      scope: 'recents',
      ...handlers,
      ...overrides,
    }),
  )
  return handlers
}

function rowOrder(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>('[data-testid^="sidebar-row-"][data-session-id]'),
  ).map(row => row.dataset.sessionId!)
}

/** Open the ⋯ menu of `sessionId`'s row and return the menu element. */
async function openMenu(sessionId: string): Promise<HTMLElement> {
  const row = screen.getByTestId(`sidebar-row-${sessionId}`)
  const trigger = row.parentElement!.querySelector<HTMLElement>(
    '[data-testid="sidebar-row-actions"]',
  )!
  fireEvent.pointerDown(trigger)
  fireEvent.click(trigger)
  return (await screen.findByRole('menu')) as HTMLElement
}

/** The menu's entries in DOM order: each item's test id, `separator` for the rule. */
function menuEntries(menu: HTMLElement): string[] {
  return Array.from(
    menu.querySelectorAll<HTMLElement>('[data-testid]'),
  ).map(el =>
    el.getAttribute('role') === 'separator' ? 'separator' : el.dataset.testid!,
  )
}

afterEach(() => cleanup())

describe('session row menu', () => {
  it('lists Pin, Rename, Fork, a separator, then Delete', async () => {
    renderList()
    const menu = await openMenu('middle')
    expect(menuEntries(menu)).toEqual([
      'sidebar-pin-thread',
      'sidebar-rename-thread',
      'sidebar-fork-thread',
      'separator',
      'sidebar-delete-thread',
    ])
    expect(menu.textContent).toBe('PinRenameForkDelete')
    expect(
      screen.getByTestId('sidebar-delete-thread').className,
    ).toContain('text-destructive')
  })

  it('offers Delete on the active row and deletes it', async () => {
    const handlers = renderList()
    await openMenu('newest')
    fireEvent.click(screen.getByTestId('sidebar-delete-thread'))
    expect(handlers.onDeleteThread).toHaveBeenCalledWith('newest')
  })

  it('pins an unpinned row', async () => {
    const handlers = renderList()
    await openMenu('middle')
    const pin = screen.getByTestId('sidebar-pin-thread')
    expect(pin.getAttribute('aria-label')).toBe('Pin thread: Middle')
    fireEvent.click(pin)
    expect(handlers.onPinThread).toHaveBeenCalledWith('middle', true)
  })

  it('offers Unpin on a pinned row', async () => {
    const handlers = renderList()
    const menu = await openMenu('old-pinned')
    expect(menu.textContent).toContain('Unpin')
    fireEvent.click(screen.getByTestId('sidebar-pin-thread'))
    expect(handlers.onPinThread).toHaveBeenCalledWith('old-pinned', false)
  })

  it('forks the row’s session', async () => {
    const handlers = renderList()
    await openMenu('middle')
    fireEvent.click(screen.getByTestId('sidebar-fork-thread'))
    expect(handlers.onForkThread).toHaveBeenCalledWith('middle')
  })

  it('omits the separator when Delete is the only action', async () => {
    renderList({
      onRenameThread: undefined,
      onPinThread: undefined,
      onForkThread: undefined,
    })
    const menu = await openMenu('middle')
    expect(menuEntries(menu)).toEqual(['sidebar-delete-thread'])
  })
})

describe('pinned rows', () => {
  it('list first, with a pin indicator only on the pinned row', () => {
    renderList()
    expect(rowOrder()).toEqual(['old-pinned', 'newest', 'middle'])
    const indicators = document.querySelectorAll('[data-slot="session-row-pin"]')
    expect(indicators).toHaveLength(1)
    expect(indicators[0]!.getAttribute('aria-label')).toBe('Pinned')
    expect(
      screen.getByTestId('sidebar-row-old-pinned').getAttribute('data-pinned'),
    ).toBe('true')
  })

  it('sit outside the time groups: the first unpinned row labels its day', () => {
    renderList()
    const headers = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="sidebar-group-header"]'),
    ).map(el => el.dataset.group)
    // No "Older" header for the 40-day-old pinned row; "Today" labels the
    // first unpinned row because it follows the pinned one.
    expect(headers).toEqual(['sidebar.timeToday'])
  })

  it('leave "Today" unlabeled when nothing is pinned', () => {
    const unpinned = SESSIONS.filter(session => !session.pinned)
    renderList({
      groups: buildPinnedFirstView(unpinned, DEFAULT_SESSION_LIST_VIEW, NOW),
    })
    expect(
      document.querySelectorAll('[data-testid="sidebar-group-header"]'),
    ).toHaveLength(0)
  })

  it('stay first under a non-time grouping, ordered by the view', () => {
    const groups = buildPinnedFirstView(
      [
        ...SESSIONS,
        { sessionId: 'new-pinned', title: 'New pinned', previewText: '', updatedAt: NOW - 10, pinned: true },
      ],
      { ...DEFAULT_SESSION_LIST_VIEW, groupBy: 'status' },
      NOW,
    )
    expect(groups.map(group => group.key)).toEqual(['pinned', 'sidebar.groupIdle'])
    expect(groups[0]!.label).toBeUndefined()
    expect(groups[0]!.sessions.map(s => s.sessionId)).toEqual(['new-pinned', 'old-pinned'])
  })
})
