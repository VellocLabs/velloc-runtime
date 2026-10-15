// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useSessionManager } from '../browser/webview/useSessionManager'

// ---------------------------------------------------------------------------
// `retitleSession` and `updateSessionMeta` spread a whole base `LocalSessionEntry` and override only what they
// change, so no field is dropped. Pinned with NO remote summary present, so nothing can mask a loss.
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

describe('local session entry — fields survive the optimistic writers', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('retitleSession keeps templateType and projectRoot', () => {
    const { result } = mountManager()

    let coded = ''
    act(() => {
      coded = result.current.openNewSession('code', 'D:/project/demo')
    })
    flushMerge()

    act(() => {
      result.current.retitleSession(coded, 'Renamed thread')
    })
    flushMerge()

    const entry = result.current.sessions.find(s => s.sessionId === coded)
    expect(entry?.title).toBe('Renamed thread')
    expect(
      entry?.templateType,
      'a rename must not un-type the session',
    ).toBe('code')
    expect(
      entry?.projectRoot,
      'a rename must not unbind the project folder',
    ).toBe('D:/project/demo')

    // The worker.init readers go through these, not through the merged list:
    // dropping the fields here is what makes a renamed `code` session boot
    // untyped and re-prompt for a folder.
    expect(result.current.getSessionTemplateType(coded)).toBe('code')
    expect(result.current.getSessionProjectRoot(coded)).toBe('D:/project/demo')
  })

  it('updateSessionMeta keeps templateType and projectRoot', () => {
    const { result } = mountManager()

    let coded = ''
    act(() => {
      coded = result.current.openNewSession('code', 'D:/project/demo')
    })
    flushMerge()

    act(() => {
      result.current.updateSessionMeta(coded, {
        previewText: 'first reply',
        messageCount: 2,
      })
    })
    flushMerge()

    const entry = result.current.sessions.find(s => s.sessionId === coded)
    expect(entry?.previewText).toBe('first reply')
    expect(entry?.templateType).toBe('code')
    expect(entry?.projectRoot).toBe('D:/project/demo')
    expect(result.current.getSessionTemplateType(coded)).toBe('code')
    expect(result.current.getSessionProjectRoot(coded)).toBe('D:/project/demo')
  })

  it('retitleSession keeps the launcher float floor (relaunchedAt)', () => {
    const { result } = mountManager()

    // Click 1 allocates a second session (BOOT is active, so it can't be
    // reused); click 2 then REUSES BOOT and stamps `relaunchedAt` on it.
    act(() => {
      result.current.openNewSession()
    })
    flushMerge()

    let reused = ''
    act(() => {
      reused = result.current.openNewSession()
    })
    flushMerge()
    expect(reused, 'setup: the second click must reuse the boot session').toBe(
      BOOT,
    )
    const floor = result.current.sessions.find(s => s.sessionId === BOOT)
      ?.relaunchedAt
    expect(floor, 'setup: reuse must stamp relaunchedAt').toBeTypeOf('number')

    act(() => {
      result.current.retitleSession(BOOT, 'Kept thread')
    })
    flushMerge()

    const entry = result.current.sessions.find(s => s.sessionId === BOOT)
    expect(entry?.title).toBe('Kept thread')
    expect(
      entry?.relaunchedAt,
      'renaming a re-launched session must not drop its sort floor',
    ).toBe(floor)
  })

  it('renames a session that exists only as a remote summary', () => {
    const { result } = mountManager()

    act(() => {
      result.current.applyRemoteList([
        {
          sessionId: 'from-disk',
          title: 'Persisted title',
          previewText: 'last reply',
          templateType: 'code',
          projectRoot: 'D:/project/persisted',
          messageCount: 4,
          updatedAt: 1_000,
        },
      ])
    })
    flushMerge()

    // No local entry exists for this session, so the rename has to synthesize
    // a whole one from the summary rather than mutating what isn't there.
    act(() => {
      result.current.retitleSession('from-disk', 'Renamed from disk')
    })
    flushMerge()

    const entry = result.current.sessions.find(s => s.sessionId === 'from-disk')
    expect(entry?.title).toBe('Renamed from disk')
    expect(entry?.customTitle).toBe('Renamed from disk')
    expect(
      entry?.previewText,
      'the summary\u2019s preview must survive the synthesized entry',
    ).toBe('last reply')
    expect(entry?.messageCount).toBe(4)
    expect(entry?.templateType).toBe('code')
    expect(entry?.projectRoot).toBe('D:/project/persisted')
  })
})
