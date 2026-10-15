import { describe, expect, it, vi } from 'vitest'

import { createSessionMessageCallbackFactory } from '../browser/webview/sessionMessageCallbacks'

/**
 * The factory caches one bound callback pair per sessionId: the SAME sessionId yields the SAME references, which
 * `MultiSessionShell`'s React.memo'd threads rely on.
 */
describe('createSessionMessageCallbackFactory', () => {
  it('returns referentially-stable callbacks for the same sessionId', () => {
    const get = createSessionMessageCallbackFactory(
      () => {},
      () => {},
    )

    const first = get('session-a')
    const second = get('session-a')

    // The whole object and both callbacks must be identical references — this
    // is exactly what React.memo's shallow prop compare checks.
    expect(second).toBe(first)
    expect(second.onFork).toBe(first.onFork)
    expect(second.onRewind).toBe(first.onRewind)
  })

  it('returns distinct callbacks for different sessionIds', () => {
    const get = createSessionMessageCallbackFactory(
      () => {},
      () => {},
    )

    expect(get('session-a')).not.toBe(get('session-b'))
    expect(get('session-a').onFork).not.toBe(get('session-b').onFork)
  })

  it('binds the sessionId and forwards the cutUuid to the underlying mutators', () => {
    const forkSession = vi.fn()
    const rewindSession = vi.fn()
    const get = createSessionMessageCallbackFactory(forkSession, rewindSession)

    get('session-a').onFork('uuid-1')
    get('session-b').onRewind('uuid-2')

    expect(forkSession).toHaveBeenCalledWith('session-a', 'uuid-1')
    expect(rewindSession).toHaveBeenCalledWith('session-b', 'uuid-2')
  })

  it('binds the sessionId for a fork-send and keeps it referentially stable', async () => {
    const sendInForkedSession = vi.fn(async () => true)
    const get = createSessionMessageCallbackFactory(
      () => {},
      () => {},
      sendInForkedSession,
    )
    const message = { role: 'user' } as never

    expect(get('session-a').onSendInFork).toBe(get('session-a').onSendInFork)
    await expect(get('session-a').onSendInFork!('uuid-3', message)).resolves.toBe(true)
    expect(sendInForkedSession).toHaveBeenCalledWith('session-a', 'uuid-3', message)
  })

  it('offers no fork-send when the shell wires none', () => {
    const get = createSessionMessageCallbackFactory(
      () => {},
      () => {},
    )
    expect(get('session-a').onSendInFork).toBeUndefined()
  })
})
