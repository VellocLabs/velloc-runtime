/**
 * Waiting for a session's turn to end (F-35): what `theme.useLook` waits on
 * before it switches theme plugins or runs a look's command.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SessionIdleWaiters } from '../browser/worker/sessionIdleWaiters'

afterEach(() => vi.useRealTimers())

describe('SessionIdleWaiters', () => {
  it('settles at once for a session that runs no turn', async () => {
    const waiters = new SessionIdleWaiters(() => false)
    await expect(waiters.wait('s1')).resolves.toBeUndefined()
  })

  it('settles at the first status change that finds the session idle, and not before', async () => {
    let busy = true
    const waiters = new SessionIdleWaiters(() => busy)
    let settled = false
    const waiting = waiters.wait('s1').then(() => (settled = true))
    waiters.check('s1')
    await Promise.resolve()
    expect(settled).toBe(false)
    busy = false
    waiters.check('s2')
    await Promise.resolve()
    expect(settled).toBe(false)
    waiters.check('s1')
    await waiting
    expect(settled).toBe(true)
  })

  it('rejects when the request is cancelled, and at once for one cancelled already', async () => {
    const waiters = new SessionIdleWaiters(() => true)
    const controller = new AbortController()
    const waiting = waiters.wait('s1', controller.signal)
    controller.abort(new Error('cancelled'))
    await expect(waiting).rejects.toThrow('cancelled')
    await expect(waiters.wait('s1', controller.signal)).rejects.toThrow('cancelled')
  })

  it('a session closed while it waits is found by the slow check', async () => {
    vi.useFakeTimers()
    let held = true
    const waiters = new SessionIdleWaiters(() => held, 2000)
    const waiting = waiters.wait('s1')
    held = false
    await vi.advanceTimersByTimeAsync(2000)
    await expect(waiting).resolves.toBeUndefined()
  })
})
