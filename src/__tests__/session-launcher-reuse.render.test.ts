// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useSessionManager } from '../browser/webview/useSessionManager'

// ---------------------------------------------------------------------------
// Thread launchers ("New agent" / "New chat" / "New code") route to `openNewSession(templateType)`: never reuse
// the ACTIVE session, and float a reused session to the top of the list (`relaunchedAt`).
// ---------------------------------------------------------------------------

const BOOT = 'boot-session'

function mountManager() {
  return renderHook(() => useSessionManager({ openingSessionId: BOOT }))
}

/** Let the 16 ms `applyMergedSessions` debounce flush into `sessions`. */
function flushMerge() {
  act(() => {
    vi.advanceTimersByTime(20)
  })
}

describe('openNewSession — thread launcher reuse', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('creates a new agent session instead of re-selecting the empty boot session', () => {
    const { result } = mountManager()

    let created = ''
    act(() => {
      created = result.current.openNewSession()
    })
    flushMerge()

    expect(created, 'the agent launcher must not reuse the ACTIVE session')
      .not.toBe(BOOT)
    expect(result.current.activeSessionId).toBe(created)
    expect(result.current.sessions.map(s => s.sessionId).sort()).toEqual(
      [BOOT, created].sort(),
    )
  })

  it('reuses a non-active empty agent session and floats it to the top', () => {
    const { result } = mountManager()

    // Click 1: allocates a second agent session (boot is active).
    let second = ''
    act(() => {
      second = result.current.openNewSession()
    })
    flushMerge()

    // Click 2: `second` is active now, so the only candidate is the boot
    // session — reuse it rather than stacking a third empty thread.
    let third = ''
    act(() => {
      third = result.current.openNewSession()
    })
    flushMerge()

    expect(third, 'a non-active empty agent session must be reused').toBe(BOOT)
    expect(result.current.sessions).toHaveLength(2)
    expect(
      result.current.sessions[0]?.sessionId,
      'the reused session must float to the top of the list',
    ).toBe(BOOT)
  })

  it('keeps the type-aware rule: a chat launch never reuses an empty agent', () => {
    const { result } = mountManager()

    let chat = ''
    act(() => {
      chat = result.current.openNewSession('chat')
    })
    flushMerge()

    expect(chat).not.toBe(BOOT)
    expect(result.current.sessions).toHaveLength(2)
    expect(
      result.current.sessions.find(s => s.sessionId === chat)?.templateType,
    ).toBe('chat')

    // A second chat click has no non-active chat to reuse either — same fix,
    // same outcome as agent.
    let chatAgain = ''
    act(() => {
      chatAgain = result.current.openNewSession('chat')
    })
    flushMerge()

    expect(chatAgain).not.toBe(chat)
    expect(result.current.sessions).toHaveLength(3)
  })

  it('does not reuse a manually renamed empty session', () => {
    const { result } = mountManager()

    let second = ''
    act(() => {
      second = result.current.openNewSession()
    })
    flushMerge()
    act(() => {
      result.current.retitleSession(BOOT, 'My Kept Session')
    })
    flushMerge()

    // `second` is active and BOOT is renamed → neither is a candidate.
    let third = ''
    act(() => {
      third = result.current.openNewSession()
    })
    flushMerge()

    expect(third).not.toBe(BOOT)
    expect(third).not.toBe(second)
    expect(result.current.sessions).toHaveLength(3)
  })

  // `deleteSession` promotes another session to active. If that write skipped
  // the active-id ref, the ref would still name the DELETED session — which is
  // no longer in the list, so the exclusion would match nothing and the
  // newly-active empty row becomes a reuse candidate again. The launcher then
  // goes dead exactly as it did before the fix, on a path the fix did not
  // originally cover.
  it('still allocates after the active session is deleted (remaining branch)', () => {
    const { result } = mountManager()

    let second = ''
    act(() => {
      second = result.current.openNewSession()
    })
    flushMerge()

    // `second` is active; deleting it promotes the empty BOOT session.
    act(() => {
      result.current.deleteSession(second)
    })
    flushMerge()

    expect(result.current.activeSessionId).toBe(BOOT)

    let third = ''
    act(() => {
      third = result.current.openNewSession()
    })
    flushMerge()

    expect(third, 'the promoted session is active — it must not be reused')
      .not.toBe(BOOT)
    expect(result.current.sessions).toHaveLength(2)
  })

  it('still allocates after the LAST session is deleted (fallback branch)', () => {
    const { result } = mountManager()

    // Deleting the only session mints an empty untyped fallback and makes it
    // active — the boot-session shape, so the very next click is the one that
    // used to be a no-op.
    act(() => {
      result.current.deleteSession(BOOT)
    })
    flushMerge()

    const fallback = result.current.activeSessionId
    expect(fallback).not.toBe(BOOT)

    let next = ''
    act(() => {
      next = result.current.openNewSession()
    })
    flushMerge()

    expect(next, 'the fallback session is active — it must not be reused')
      .not.toBe(fallback)
    expect(next, 'the deleted boot session must not be handed back').not.toBe(
      BOOT,
    )
    expect(result.current.sessions.map(s => s.sessionId).sort()).toEqual(
      [fallback, next].sort(),
    )
  })
})

// ---------------------------------------------------------------------------
// A deleted boot session stays deleted: no render puts it back, and no launcher click reuses its id.
// ---------------------------------------------------------------------------

describe('deleting the boot session', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('an inactive boot session the user deleted never comes back', () => {
    const { result, rerender } = mountManager()

    let second = ''
    act(() => {
      second = result.current.openNewSession()
    })
    flushMerge()

    // `second` is active; the boot session is an inactive empty row — the
    // one the sidebar's Delete removes.
    act(() => {
      result.current.deleteSession(BOOT)
    })
    flushMerge()
    // Renders that follow the delete for any other reason.
    rerender()
    act(() => {
      result.current.updateSessionMeta(second, { composerDraft: 'draft' })
    })
    flushMerge()

    expect(
      result.current.sessions.map(s => s.sessionId),
      'the deleted boot session must not return to the list',
    ).toEqual([second])

    let third = ''
    act(() => {
      third = result.current.openNewSession()
    })
    flushMerge()

    expect(third, 'a launcher click must never reuse a deleted id').not.toBe(
      BOOT,
    )
    expect(third).not.toBe(second)
    expect(result.current.sessions.map(s => s.sessionId).sort()).toEqual(
      [second, third].sort(),
    )
  })

  it('a boot session the worker removed never comes back', () => {
    const { result, rerender } = mountManager()

    let second = ''
    act(() => {
      second = result.current.openNewSession()
    })
    flushMerge()

    // `session.removed` — e.g. deleted from another window.
    act(() => {
      result.current.applyRemoteRemoval(BOOT)
    })
    flushMerge()
    rerender()
    act(() => {
      result.current.applyRemoteUpdate({ sessionId: second, messageCount: 0 })
    })
    flushMerge()

    expect(result.current.sessions.map(s => s.sessionId)).toEqual([second])
  })
})
