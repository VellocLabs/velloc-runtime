// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useSessionManager } from '../browser/webview/useSessionManager'
import { createTranslate } from '../browser/webview/i18n/translate'

// ---------------------------------------------------------------------------
// "Fork from here" names the copy after the source — "<title> (fork)" — so the
// two are telling apart in the sidebar. The hook hands the shell the source's
// DISPLAYED title (the same merge the sidebar renders from); the shell
// localizes the suffix (`session.forkTitle`) and the manager persists it as
// the fork's own `custom-title` action + `meta.json` title. Rewind, which
// REPLACES the original, never goes through this: it keeps the exact title.
// ---------------------------------------------------------------------------

const BOOT = 'boot-session'

/** Let the 16 ms `applyMergedSessions` debounce flush into `sessions`. */
function flushMerge() {
  act(() => {
    vi.advanceTimersByTime(20)
  })
}

describe('forkSession hands the shell the source title', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('passes the renamed title of the source session', () => {
    const onRequestFork = vi.fn()
    const { result } = renderHook(() =>
      useSessionManager({ openingSessionId: BOOT, onRequestFork }),
    )
    act(() => {
      result.current.retitleSession(BOOT, 'Deploy plan')
    })
    flushMerge()

    act(() => {
      result.current.forkSession(BOOT, 'uuid-3')
    })
    expect(onRequestFork).toHaveBeenCalledTimes(1)
    const [fromId, cutUuid, requestId, sourceTitle] = onRequestFork.mock.calls[0]!
    expect(fromId).toBe(BOOT)
    expect(cutUuid).toBe('uuid-3')
    expect(typeof requestId).toBe('string')
    expect(sourceTitle).toBe('Deploy plan')
  })

  it('passes the persisted (remote) title when the local cache has none', () => {
    const onRequestFork = vi.fn()
    const { result } = renderHook(() =>
      useSessionManager({ openingSessionId: BOOT, onRequestFork }),
    )
    act(() => {
      result.current.applyRemoteList([
        {
          sessionId: 'disk-only',
          title: 'From disk',
          // The summary's `customTitle` is the RESOLVED real title (user
          // rename or AI title) — that is what the fork is named after.
          customTitle: 'From disk',
          previewText: 'hello',
          updatedAt: 1_000,
          messageCount: 2,
        },
      ])
    })
    flushMerge()

    act(() => {
      result.current.forkSession('disk-only', 'uuid-1')
    })
    expect(onRequestFork.mock.calls[0]![3]).toBe('From disk')
  })

  it('passes NO title for a source that has only its derived first-prompt title', () => {
    // The fork's title becomes a persisted USER title; pinning
    // "<first prompt> (fork)" would block the fork's own auto-title forever.
    const onRequestFork = vi.fn()
    const { result } = renderHook(() =>
      useSessionManager({ openingSessionId: BOOT, onRequestFork }),
    )
    act(() => {
      result.current.applyRemoteList([
        {
          sessionId: 'derived-only',
          title: 'fix the login bug',
          previewText: 'fix the login bug',
          updatedAt: 1_000,
          messageCount: 2,
        },
      ])
    })
    flushMerge()

    act(() => {
      result.current.forkSession('derived-only', 'uuid-1')
    })
    expect(onRequestFork.mock.calls[0]![3]).toBeUndefined()
  })

  it('passes NO title for a session that still shows the placeholder', () => {
    const onRequestFork = vi.fn()
    const { result } = renderHook(() =>
      useSessionManager({ openingSessionId: BOOT, onRequestFork }),
    )
    // The boot session has never been named or messaged: its `title` is the
    // 'New Thread' sentinel that renders as the localized "New agent" — a
    // placeholder, not a name, so a fork of it must not be called
    // "New Thread (fork)".
    act(() => {
      result.current.forkSession(BOOT, 'uuid-1')
    })
    expect(onRequestFork.mock.calls[0]![3]).toBeUndefined()
  })
})

describe('forkSession for "Send in a forked session"', () => {
  it('asks for an inclusive cut and returns the request id the ack echoes', () => {
    const onRequestFork = vi.fn()
    const { result } = renderHook(() =>
      useSessionManager({ openingSessionId: BOOT, onRequestFork }),
    )
    let requestId = ''
    act(() => {
      requestId = result.current.forkSession(BOOT, 'uuid-9', {
        keepCutMessage: true,
      })
    })
    const call = onRequestFork.mock.calls[0]!
    expect(call[1]).toBe('uuid-9')
    expect(call[2]).toBe(requestId)
    expect(requestId).not.toBe('')
    expect(call[4]).toBe(true)
  })

  it('leaves "Fork from here" on the exclusive cut', () => {
    const onRequestFork = vi.fn()
    const { result } = renderHook(() =>
      useSessionManager({ openingSessionId: BOOT, onRequestFork }),
    )
    act(() => {
      result.current.forkSession(BOOT, 'uuid-1')
    })
    expect(onRequestFork.mock.calls[0]![4]).toBeUndefined()
  })
})

describe('the fork title is a catalog string', () => {
  it('formats "<title> (fork)" in English and carries the placeholder in every locale', () => {
    const t = createTranslate('en')
    expect(t('session.forkTitle', { title: 'Deploy plan' })).toBe(
      'Deploy plan (fork)',
    )
    for (const locale of ['zh', 'ja', 'ko', 'es', 'fr', 'de'] as const) {
      const localized = createTranslate(locale)('session.forkTitle', {
        title: 'Deploy plan',
      })
      expect(localized, locale).toContain('Deploy plan')
      expect(localized, locale).not.toBe('Deploy plan')
    }
  })
})
