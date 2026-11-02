// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Sidebar, type SessionListItem } from '../browser/webview/Sidebar'
import { resetSessionTreeFallbackReports } from '../browser/webview/sessionTree'
import { en } from '../browser/webview/i18n/messages/en'

// Child session rows nest under their parent's row in the sidebar: indented,
// collapsible per parent, with the parent standing in for a collapsed subtree's
// running / needs-answer state. Pinned and nesting are orthogonal; a fork says
// what it was copied from; a missing or looping parent flattens the row and is
// reported once. (F-36)

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.now()

// Map-backed page storage, as the other render tests use.
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

const under = (parentSessionId: string, lineageKind: SessionListItem['lineageKind'] = 'side_session') => ({
  parentSessionId,
  lineageKind,
})

function renderSidebar(sessions: SessionListItem[], activeSessionId = 'none', collapsed = false) {
  return render(
    createElement(Sidebar, {
      title: 'Conversation',
      sessionId: activeSessionId,
      activeSessionId,
      sessions,
      collapsed,
    }),
  )
}

/** Session rows in DOM order, with each group header as `#<group>` and each section as `#<testid>`. */
function sequence(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(
      '[data-testid="sidebar-pinned-toggle"], [data-testid="sidebar-recents-toggle"], [data-testid="sidebar-group-header"], [data-testid^="sidebar-row-"][data-session-id]',
    ),
  ).map(el => el.dataset.sessionId ?? (el.dataset.group ? `#${el.dataset.group}` : `#${el.dataset.testid}`))
}

const rowOf = (sessionId: string) => screen.getByTestId(`sidebar-row-${sessionId}`)
const toggleOf = (sessionId: string) =>
  document.querySelector<HTMLElement>(
    `[data-testid="sidebar-children-toggle"][data-session-id="${sessionId}"]`,
  )

beforeEach(() => {
  localStorage.clear()
  resetSessionTreeFallbackReports()
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('nesting', () => {
  it('draws a child under its parent, indented one level, in Recents', () => {
    renderSidebar([item('p'), item('c', under('p')), item('q', { updatedAt: NOW - 2000 })])
    expect(sequence()).toEqual(['#sidebar-recents-toggle', 'p', 'c', 'q'])
    expect(rowOf('c').dataset.depth).toBe('1')
    expect(rowOf('c').dataset.parentSessionId).toBe('p')
    expect(rowOf('p').dataset.depth).toBeUndefined()
    expect(rowOf('p').dataset.children).toBe('1')
    expect(rowOf('q').dataset.children).toBeUndefined()
  })

  it('nests several levels, each one level deeper', () => {
    renderSidebar([item('p'), item('c', under('p')), item('g', under('c', 'hand_off'))])
    expect(sequence()).toEqual(['#sidebar-recents-toggle', 'p', 'c', 'g'])
    expect(rowOf('g').dataset.depth).toBe('2')
    expect(rowOf('p').dataset.children).toBe('2')
    expect(rowOf('c').dataset.children).toBe('1')
  })

  it('keeps a team member out of the tree (the shell lists it on the tab strip, not here)', () => {
    renderSidebar([item('lead'), item('mate', { ...under('lead', 'team'), spawnerSessionId: 'lead' })])
    expect(rowOf('mate').dataset.depth).toBeUndefined()
    expect(toggleOf('lead')).toBeNull()
  })

  it('lists a detached session top-level', () => {
    renderSidebar([item('p'), item('d', { detached: true, lineageKind: undefined })])
    expect(rowOf('d').dataset.depth).toBeUndefined()
    expect(toggleOf('p')).toBeNull()
  })

  it('draws a child whose parent is not listed top-level and warns once per session', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { rerender } = renderSidebar([item('orphan', under('gone', 'fork'))])
    expect(rowOf('orphan').dataset.depth).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toContain('orphan')
    rerender(
      createElement(Sidebar, {
        title: 'Conversation',
        sessionId: 'none',
        activeSessionId: 'none',
        sessions: [item('orphan', under('gone', 'fork')), item('other')],
      }),
    )
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('breaks a cycle at one link, keeps both rows on screen and warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    renderSidebar([item('a', under('b')), item('b', under('a'))])
    expect(sequence().filter(id => !id.startsWith('#')).sort()).toEqual(['a', 'b'])
    expect(document.querySelectorAll('[data-depth="1"]')).toHaveLength(1)
    expect(warn).toHaveBeenCalledTimes(1)
  })
})

describe('snapshot order', () => {
  const full = () =>
    createElement(Sidebar, {
      title: 'Conversation',
      sessionId: 'none',
      activeSessionId: 'none',
      sessions: [item('c', under('p', 'fork')), item('p')],
    })

  it('a child that arrives before its parent is listed, then nests once the parent is in', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { rerender } = renderSidebar([item('c', under('p', 'fork'))])
    expect(rowOf('c').dataset.depth).toBeUndefined()
    rerender(full())
    expect(rowOf('c').dataset.depth).toBe('1')
    expect(sequence()).toEqual(['#sidebar-recents-toggle', 'p', 'c'])
  })

  it('a parent removed while its child remains leaves the child top-level, never hidden', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { rerender } = render(full())
    expect(rowOf('c').dataset.depth).toBe('1')
    rerender(
      createElement(Sidebar, {
        title: 'Conversation',
        sessionId: 'none',
        activeSessionId: 'none',
        sessions: [item('c', under('p', 'fork'))],
      }),
    )
    expect(rowOf('c').dataset.depth).toBeUndefined()
    expect(screen.queryByTestId('sidebar-row-p')).toBeNull()
  })
})

describe('collapse', () => {
  it('shows a descendant summary only when collapsed and expands it without switching sessions', () => {
    const onSwitch = vi.fn()
    render(createElement(Sidebar, {
      title: 'Conversation', sessionId: 'c', activeSessionId: 'c',
      sessions: [item('p'), item('c', under('p')), item('g', under('c'))],
      onSwitchThread: onSwitch,
    }))
    expect(screen.queryByTestId('sidebar-children-summary')).toBeNull()
    expect(rowOf('p').contains(toggleOf('p'))).toBe(false)
    fireEvent.click(toggleOf('p')!)
    const summary = screen.getByTestId('sidebar-children-summary')
    expect(summary.textContent).toBe(en['sidebar.nestedSessions'].replace('{count}', '2'))
    expect(screen.queryByTestId('sidebar-row-c')).toBeNull()
    fireEvent.click(summary)
    expect(screen.queryByTestId('sidebar-children-summary')).toBeNull()
    expect(rowOf('c').dataset.active).toBe('true')
    expect(onSwitch).not.toHaveBeenCalled()
  })

  it('uses the singular summary for one child', () => {
    localStorage.setItem('nexus:sidebar:childrenCollapsed', JSON.stringify(['p']))
    renderSidebar([item('p'), item('c', under('p'))])
    expect(screen.getByTestId('sidebar-children-summary').textContent)
      .toBe(en['sidebar.nestedSessionOne'].replace('{count}', '1'))
  })

  it('a parent gets a labelled toggle; collapsing hides the rows below it and is remembered', () => {
    renderSidebar([item('p'), item('c', under('p')), item('g', under('c'))])
    const toggle = toggleOf('p')!
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(toggle.getAttribute('aria-label')).toBe('Hide the sessions under p (2)')
    expect(toggleOf('c')).not.toBeNull()

    act(() => {
      fireEvent.click(toggle)
    })
    expect(toggleOf('p')!.getAttribute('aria-expanded')).toBe('false')
    expect(toggleOf('p')!.getAttribute('aria-label')).toBe('Show the sessions under p (2)')
    expect(sequence()).toEqual(['#sidebar-recents-toggle', 'p'])
    expect(rowOf('p').dataset.childrenCollapsed).toBe('true')
    expect(JSON.parse(localStorage.getItem('nexus:sidebar:childrenCollapsed')!)).toEqual(['p'])

    // A fresh window reads the remembered state; the parent alone is collapsed.
    cleanup()
    renderSidebar([item('p'), item('c', under('p')), item('g', under('c'))])
    expect(sequence()).toEqual(['#sidebar-recents-toggle', 'p'])
    act(() => {
      fireEvent.click(toggleOf('p')!)
    })
    expect(sequence()).toEqual(['#sidebar-recents-toggle', 'p', 'c', 'g'])
    expect(localStorage.getItem('nexus:sidebar:childrenCollapsed')).toBeNull()
  })

  it('collapsing changes layout only: the child stays the active, routed session', () => {
    const onSwitch = vi.fn()
    render(
      createElement(Sidebar, {
        title: 'Conversation',
        sessionId: 'c',
        activeSessionId: 'c',
        sessions: [item('p'), item('c', under('p'))],
        onSwitchThread: onSwitch,
      }),
    )
    expect(rowOf('c').dataset.active).toBe('true')
    act(() => {
      fireEvent.click(toggleOf('p')!)
    })
    // The parent's row does not become active in the child's stead.
    expect(rowOf('p').dataset.active).toBeUndefined()
    act(() => {
      fireEvent.click(rowOf('p'))
    })
    expect(onSwitch).toHaveBeenCalledWith('p')
  })

  it('the icon rail hides the same rows the list hides', () => {
    localStorage.setItem('nexus:sidebar:childrenCollapsed', JSON.stringify(['p']))
    renderSidebar([item('p'), item('c', under('p')), item('q', { updatedAt: NOW - 2000 })], 'none', true)
    // Rail icons carry the title as their label; the hidden child's is absent.
    const railLabels = Array.from(
      document.querySelectorAll<HTMLElement>('aside button[aria-label]'),
    ).map(el => el.getAttribute('aria-label'))
    expect(railLabels).toContain('p')
    expect(railLabels).toContain('q')
    expect(railLabels).not.toContain('c')
  })
})

describe('aggregated state', () => {
  it('a collapsed parent runs and needs an answer when a descendant does; expanded, each row has its own', () => {
    localStorage.setItem('nexus:sidebar:childrenCollapsed', JSON.stringify(['p']))
    renderSidebar([
      item('p'),
      item('c', under('p')),
      item('g', { ...under('c'), running: true, needsAnswer: true }),
    ])
    expect(rowOf('p').dataset.running).toBe('true')
    expect(rowOf('p').dataset.runningBelow).toBe('true')
    expect(rowOf('p').dataset.needsAnswerBelow).toBe('true')
    expect(rowOf('p').querySelector('[data-needs-answer]')).not.toBeNull()
    expect(document.querySelectorAll('[data-slot="session-attention-dot"]')).toHaveLength(1)

    act(() => {
      fireEvent.click(toggleOf('p')!)
    })
    expect(rowOf('p').dataset.running).toBeUndefined()
    expect(rowOf('p').querySelector('[data-needs-answer]')).toBeNull()
    expect(rowOf('g').dataset.running).toBe('true')
    expect(rowOf('g').querySelector('[data-needs-answer]')).not.toBeNull()
    expect(document.querySelectorAll('[data-slot="session-attention-dot"]')).toHaveLength(1)
  })
})

describe('pinned and nesting are orthogonal', () => {
  it('a pinned child stays under its unpinned parent, with its pin', () => {
    renderSidebar([item('p'), item('c', { ...under('p'), pinned: true })])
    expect(screen.queryByTestId('sidebar-pinned-toggle')).toBeNull()
    expect(sequence()).toEqual(['#sidebar-recents-toggle', 'p', 'c'])
    expect(rowOf('c').dataset.pinned).toBe('true')
  })

  it('pinning the parent moves it, with its children under it, into Pinned; the children are not pinned', () => {
    renderSidebar([item('p', { pinned: true }), item('c', under('p')), item('q', { updatedAt: NOW - 2000 })])
    expect(sequence()).toEqual(['#sidebar-pinned-toggle', 'p', 'c', '#sidebar-recents-toggle', 'q'])
    expect(rowOf('c').dataset.pinned).toBeUndefined()
    expect(rowOf('c').dataset.depth).toBe('1')
  })
})

describe('fork rows', () => {
  it('nests under the copy source and says so', () => {
    renderSidebar([item('src', { title: 'Source' }), item('f', { ...under('src', 'fork'), title: 'Source (fork)' })])
    expect(rowOf('f').dataset.lineage).toBe('fork')
    expect(rowOf('f').getAttribute('title')).toBe('Fork of Source')
    expect(rowOf('f').querySelector('[data-slot="session-row-lineage"]')?.textContent).toBe('Fork of Source')
    expect(rowOf('src').getAttribute('title')).toBeNull()
  })
})

describe('ordering', () => {
  it('a child keeps the activity order among its siblings and never moves its parent; separators stay monotonic', () => {
    renderSidebar([
      item('top', { updatedAt: NOW - 1000 }),
      item('p', { updatedAt: NOW - 3 * DAY }),
      item('old', { updatedAt: NOW - 3 * DAY - 1000 }),
      item('c-new', { ...under('p'), updatedAt: NOW - 500 }),
      item('c-old', { ...under('p'), updatedAt: NOW - 10 * DAY }),
    ])
    expect(sequence()).toEqual([
      '#sidebar-recents-toggle',
      'top',
      '#sidebar.timePrevious7Days',
      'p',
      'c-new',
      'c-old',
      'old',
    ])
  })

  it('an active child past the page cut reveals the top-level row it sits under', () => {
    const roots = Array.from({ length: 25 }, (_, i) => item(`r${i}`, { updatedAt: NOW - i * 1000 }))
    const child = item('deep', { ...under('r24'), updatedAt: NOW - 60_000 })
    renderSidebar([...roots, child], 'deep')
    expect(screen.queryByTestId('sidebar-row-r24')).not.toBeNull()
    expect(rowOf('deep').dataset.active).toBe('true')
  })
})

describe('the Workspaces node', () => {
  it('nests a child under its parent within the folder too', () => {
    render(
      createElement(Sidebar, {
        title: 'Conversation',
        sessionId: 'none',
        activeSessionId: 'none',
        sessions: [item('p', { projectRoot: 'D:\\w' }), item('c', { ...under('p'), projectRoot: 'D:\\w' })],
        addedProjectPaths: ['D:\\w'],
        addedProjectOrder: new Map([['D:\\w', 0]]),
      }),
    )
    act(() => {
      fireEvent.click(screen.getByTestId('sidebar-projects-toggle'))
    })
    act(() => {
      fireEvent.click(screen.getByTestId('sidebar-project-row'))
    })
    const node = screen.getByTestId('sidebar-project-child')
    const nodeRows = Array.from(
      node.querySelectorAll<HTMLElement>('[data-testid^="sidebar-row-"][data-session-id]'),
    ).map(
      el => `${el.dataset.sessionId}:${el.dataset.depth ?? 0}`,
    )
    expect(nodeRows).toEqual(['p:0', 'c:1'])
    // Both copies of the parent share one collapsed state.
    act(() => {
      fireEvent.click(node.querySelector<HTMLElement>('[data-testid="sidebar-children-toggle"]')!)
    })
    expect(document.querySelectorAll('[data-testid="sidebar-row-c"]')).toHaveLength(0)
  })
})
