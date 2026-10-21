// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import {
  useSessionManager,
  type RemoteSessionSummary,
} from '../browser/webview/useSessionManager'
import { pinnedFirst, sidebarRowOrder } from '../browser/webview/sessionPinning'
import { pickNeighborSession } from '../browser/webview/sessionVisibility'

// Pinned state comes from the runtime's summary; deleting the session on
// screen lands on its neighbor in the sidebar's order; the sidebar's Fork asks
// the runtime for a copy of the whole conversation.

const BOOT = 'boot-session'

/** Let the 16 ms `applyMergedSessions` debounce flush into `sessions`. */
function flushMerge() {
  act(() => {
    vi.advanceTimersByTime(20)
  })
}

function summary(
  sessionId: string,
  updatedAt: number,
  extra: Partial<RemoteSessionSummary> = {},
): RemoteSessionSummary {
  return {
    sessionId,
    title: sessionId,
    previewText: sessionId,
    updatedAt,
    messageCount: 2,
    ...extra,
  }
}

describe('pinnedFirst', () => {
  it('moves pinned sessions up and keeps each half in order', () => {
    const rows = [
      { id: 'a' },
      { id: 'b', pinned: true },
      { id: 'c' },
      { id: 'd', pinned: true },
    ]
    expect(pinnedFirst(rows).map(row => row.id)).toEqual(['b', 'd', 'a', 'c'])
  })
})

describe('pickNeighborSession', () => {
  const rows = [
    { sessionId: 'a' },
    { sessionId: 'b' },
    { sessionId: 'teammate', spawnerSessionId: 'b' },
    { sessionId: 'c' },
  ]

  it('takes the next row', () => {
    expect(pickNeighborSession(rows, 'b', new Set())?.sessionId).toBe('c')
  })

  it('takes the previous row when the deleted one is last', () => {
    expect(pickNeighborSession(rows, 'c', new Set())?.sessionId).toBe('b')
  })

  it('follows the pinned-first order and skips hidden rows', () => {
    const withPin = [...rows, { sessionId: 'p', pinned: true }]
    // Sidebar order: p, a, b, c — `a` follows `p`.
    expect(pickNeighborSession(withPin, 'p', new Set())?.sessionId).toBe('a')
    expect(pickNeighborSession(withPin, 'p', new Set(['a']))?.sessionId).toBe('b')
  })

  it('finds nothing when the deleted row is the only one', () => {
    expect(pickNeighborSession([{ sessionId: 'a' }], 'a', new Set())).toBeUndefined()
  })

  it('follows the order the sidebar shows, not activity order', () => {
    // Created a, b, c in that order; activity order is c, a, b.
    const sessions = [
      { sessionId: 'c', updatedAt: 3_000, createdAt: 30 },
      { sessionId: 'a', updatedAt: 2_000, createdAt: 10 },
      { sessionId: 'b', updatedAt: 1_000, createdAt: 20 },
    ]
    const view = { groupBy: 'none', field: 'created', direction: 'asc' } as const
    const order = sidebarRowOrder(sessions, view, 5_000).map(s => s.sessionId)
    expect(order).toEqual(['a', 'b', 'c'])
    expect(pickNeighborSession(sessions, 'b', new Set(), [order])?.sessionId).toBe('c')
  })

  it('skips the rows of a collapsed section', () => {
    const sessions = [
      { sessionId: 'p', updatedAt: 3_000, pinned: true },
      { sessionId: 'a', updatedAt: 2_000 },
      { sessionId: 'b', updatedAt: 1_000 },
    ]
    const view = { groupBy: 'none', field: 'updated', direction: 'desc' } as const
    const order = sidebarRowOrder(sessions, view, 5_000, { pinned: true }).map(
      s => s.sessionId,
    )
    expect(order).toEqual(['a', 'b'])
    expect(pickNeighborSession(sessions, 'b', new Set(), [order])?.sessionId).toBe('a')
  })

  it('takes the full order when every section is collapsed', () => {
    const sessions = [
      { sessionId: 'p', updatedAt: 3_000, pinned: true },
      { sessionId: 'a', updatedAt: 2_000 },
      { sessionId: 'b', updatedAt: 1_000 },
    ]
    const view = { groupBy: 'none', field: 'updated', direction: 'desc' } as const
    const shown = sidebarRowOrder(sessions, view, 5_000, { pinned: true, recents: true })
      .map(s => s.sessionId)
    const full = sidebarRowOrder(sessions, view, 5_000).map(s => s.sessionId)
    expect(shown).toEqual([])
    expect(pickNeighborSession(sessions, 'a', new Set(), [shown, full])?.sessionId).toBe('b')
  })

  it('takes the full order for a row a collapsed section hides', () => {
    const sessions = [
      { sessionId: 'p', updatedAt: 4_000, pinned: true },
      { sessionId: 'q', updatedAt: 3_000, pinned: true },
      { sessionId: 'a', updatedAt: 2_000 },
      { sessionId: 'b', updatedAt: 1_000 },
    ]
    const view = { groupBy: 'none', field: 'updated', direction: 'desc' } as const
    const shown = sidebarRowOrder(sessions, view, 5_000, { pinned: true }).map(s => s.sessionId)
    const full = sidebarRowOrder(sessions, view, 5_000).map(s => s.sessionId)
    // `q` is not in the shown rows: its neighbor in the full order is `a`, not
    // the shown list's first row.
    expect(pickNeighborSession(sessions, 'p', new Set(), [shown, full])?.sessionId).toBe('q')
    expect(pickNeighborSession(sessions, 'q', new Set(), [shown, full])?.sessionId).toBe('a')
  })

  it('takes the full order when the shown rows hold only the deleted one', () => {
    const sessions = [
      { sessionId: 'p', updatedAt: 3_000, pinned: true },
      { sessionId: 'a', updatedAt: 2_000 },
    ]
    expect(pickNeighborSession(sessions, 'a', new Set(), [['a'], ['p', 'a']])?.sessionId).toBe('p')
  })
})

describe('useSessionManager pin, fork and delete', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function mount(onRequestFork = vi.fn(), onRequestDelete = vi.fn()) {
    const hook = renderHook(() =>
      useSessionManager({
        openingSessionId: BOOT,
        onRequestFork,
        onRequestDelete,
      }),
    )
    return { ...hook, onRequestFork, onRequestDelete }
  }

  it('carries the runtime’s pinned flag and drops it when the runtime does', () => {
    const { result } = mount()
    act(() => {
      result.current.applyRemoteList([
        summary('a', 3_000),
        summary('b', 2_000, { pinned: true }),
      ])
    })
    flushMerge()
    const pinnedOf = (id: string) =>
      result.current.sessions.find(s => s.sessionId === id)?.pinned
    expect(pinnedOf('b')).toBe(true)
    expect(pinnedOf('a')).toBeUndefined()

    act(() => {
      result.current.applyRemoteUpdate(summary('b', 2_000))
    })
    flushMerge()
    expect(pinnedOf('b')).toBeUndefined()
  })

  it('switches to the next session in the list when the active one is deleted', () => {
    const { result, onRequestDelete } = mount()
    act(() => {
      result.current.applyRemoteList([
        summary('a', 3_000),
        summary('b', 2_000),
        summary('c', 1_000),
      ])
    })
    flushMerge()
    act(() => {
      result.current.focusSession('b')
    })
    act(() => {
      result.current.deleteSession('b')
    })
    flushMerge()
    expect(result.current.activeSessionId).toBe('c')
    expect(result.current.sessions.some(s => s.sessionId === 'b')).toBe(false)
    expect(onRequestDelete).toHaveBeenCalledWith('b', expect.any(String))
  })

  it('switches to the previous session when the deleted one is last', () => {
    const { result } = mount()
    act(() => {
      result.current.applyRemoteList([summary('a', 3_000), summary('b', 2_000)])
    })
    flushMerge()
    act(() => {
      result.current.focusSession('b')
    })
    act(() => {
      result.current.deleteSession('b')
    })
    // The boot placeholder was minted at mount, so the order is boot, a, b.
    expect(result.current.activeSessionId).toBe('a')
  })

  it('moves off a teammate on screen when its lead is deleted', () => {
    const { result } = mount()
    act(() => {
      result.current.applyRemoteList([
        summary('a', 3_000),
        summary('lead', 2_000),
        summary('mate', 2_500, { spawnerSessionId: 'lead', teammateName: 'm' }),
        summary('c', 1_000),
      ])
    })
    flushMerge()
    act(() => {
      result.current.focusSession('mate')
    })
    act(() => {
      result.current.deleteSession('lead')
    })
    expect(result.current.activeSessionId).toBe('c')
  })

  it('opens a fresh session when the deleted one was the only one', () => {
    const { result } = mount()
    act(() => {
      result.current.deleteSession(BOOT)
    })
    flushMerge()
    const active = result.current.activeSessionId
    expect(active).not.toBe(BOOT)
    expect(result.current.sessions.map(s => s.sessionId)).toEqual([active])
  })

  it('forks the whole conversation when no cut is named', () => {
    const { result, onRequestFork } = mount()
    act(() => {
      result.current.applyRemoteList([
        summary('a', 3_000, { customTitle: 'Plan' }),
      ])
    })
    flushMerge()
    act(() => {
      result.current.forkSession('a', undefined, { keepCutMessage: true })
    })
    expect(onRequestFork).toHaveBeenCalledWith(
      'a',
      undefined,
      expect.any(String),
      'Plan',
      true,
      undefined,
    )
  })

  it('a retargeted fork carries the retarget and leaves the copy untitled', () => {
    const { result, onRequestFork } = mount()
    act(() => {
      result.current.forkSession('a', 'cut-1', { retarget: { templateType: 'code', projectRoot: '/work/app' } })
    })
    expect(onRequestFork).toHaveBeenCalledWith(
      'a',
      'cut-1',
      expect.any(String),
      undefined,
      undefined,
      { templateType: 'code', projectRoot: '/work/app' },
    )
  })

  it('lands on the neighbor in the row order the caller passes', () => {
    const { result } = mount()
    act(() => {
      result.current.applyRemoteList([
        summary('a', 3_000),
        summary('b', 2_000),
        summary('c', 1_000),
      ])
    })
    flushMerge()
    act(() => {
      result.current.focusSession('b')
    })
    act(() => {
      result.current.deleteSession('b', [['c', 'b', 'a']])
    })
    expect(result.current.activeSessionId).toBe('a')
  })

  it('lands on an existing session, not a new one, when every section is collapsed', () => {
    const { result } = mount()
    act(() => {
      result.current.applyRemoteList([summary('a', 3_000), summary('b', 2_000)])
    })
    flushMerge()
    act(() => {
      result.current.focusSession('b')
    })
    const before = result.current.sessions.map(s => s.sessionId)
    act(() => {
      result.current.deleteSession('b', [[], ['a', 'b']])
    })
    expect(result.current.activeSessionId).toBe('a')
    flushMerge()
    expect(
      result.current.sessions.filter(s => !before.includes(s.sessionId)),
    ).toEqual([])
  })

  it('a late write to a deleted session does not bring its row back', () => {
    const { result } = mount()
    act(() => {
      result.current.applyRemoteList([summary('a', 3_000), summary('b', 2_000)])
    })
    flushMerge()
    act(() => {
      result.current.focusSession('b')
    })
    act(() => {
      result.current.deleteSession('b')
    })
    act(() => {
      result.current.updateSessionMeta('b', {
        composerDraft: 'half typed',
        lastComposerEditAt: 9_000,
      })
    })
    flushMerge()
    expect(result.current.sessions.some(s => s.sessionId === 'b')).toBe(false)
  })
})
