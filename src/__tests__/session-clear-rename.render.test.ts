// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useSessionManager } from '../browser/webview/useSessionManager'

// An empty title clears a rename (F-34 "Use automatic title"): the request goes
// to the runtime as an empty title, and once its summary drops the rename the
// row shows the automatic title rather than the old name.

const BOOT = 'boot-session'

function flushMerge() {
  act(() => {
    vi.advanceTimersByTime(20)
  })
}

describe('clearing a rename', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('asks the runtime to clear it, then shows the automatic title the runtime reports', () => {
    const onRequestRename = vi.fn()
    const { result } = renderHook(() => useSessionManager({ openingSessionId: BOOT, onRequestRename }))
    act(() => {
      result.current.applyRemoteList([
        { sessionId: 'cli', title: 'Fix login', templateType: 'cli-codex', messageCount: 0, updatedAt: 1_000 },
      ])
    })
    flushMerge()
    act(() => result.current.retitleSession('cli', 'My name'))
    flushMerge()
    expect(result.current.sessions.find(s => s.sessionId === 'cli')?.title).toBe('My name')

    act(() => result.current.retitleSession('cli', ''))
    flushMerge()
    expect(onRequestRename).toHaveBeenLastCalledWith('cli', '', expect.any(String))

    act(() => {
      result.current.applyRemoteList([
        { sessionId: 'cli', title: 'Fix login', templateType: 'cli-codex', messageCount: 0, updatedAt: 1_000 },
      ])
    })
    flushMerge()
    const entry = result.current.sessions.find(s => s.sessionId === 'cli')
    expect(entry?.title).toBe('Fix login')
    expect(entry?.customTitle).toBeUndefined()
  })

  it('an empty title on a session that was never renamed asks nothing', () => {
    const onRequestRename = vi.fn()
    const { result } = renderHook(() => useSessionManager({ openingSessionId: BOOT, onRequestRename }))
    act(() => {
      result.current.applyRemoteList([{ sessionId: 'plain', title: 'Auto', messageCount: 0, updatedAt: 1_000 }])
    })
    flushMerge()
    act(() => result.current.retitleSession('plain', '  '))
    expect(onRequestRename).not.toHaveBeenCalled()
  })
})
