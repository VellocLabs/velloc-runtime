import { describe, expect, it, vi } from 'vitest'
import { registerReviewSession, releaseIdleReviewSessions, type ReviewSessionFacade } from './review-channel'

function facade(releaseIdle?: () => void): ReviewSessionFacade {
  return {
    getSnapshot: () => ({ sessionId: 's', sequence: 0, reports: [] }) as never,
    subscribe: () => () => {},
    cancel: async () => undefined,
    repair: async () => undefined,
    publish: async () => undefined,
    rerun: async () => undefined,
    ...(releaseIdle ? { releaseIdle } : {}),
  }
}

describe('releaseIdleReviewSessions', () => {
  it('asks only sessions that are not running a turn', () => {
    const idle = vi.fn()
    const running = vi.fn()
    const offIdle = registerReviewSession('idle-session', facade(idle))
    const offRunning = registerReviewSession('running-session', facade(running))
    const offPlain = registerReviewSession('plain-session', facade())
    try {
      expect(releaseIdleReviewSessions(id => id === 'running-session')).toBe(1)
      expect(idle).toHaveBeenCalledTimes(1)
      expect(running).not.toHaveBeenCalled()
    } finally { offIdle(); offRunning(); offPlain() }
  })

  it('one failing session does not stop the rest', () => {
    const after = vi.fn()
    const offA = registerReviewSession('a-session', facade(() => { throw new Error('boom') }))
    const offB = registerReviewSession('b-session', facade(after))
    try {
      releaseIdleReviewSessions(() => false)
      expect(after).toHaveBeenCalledTimes(1)
    } finally { offA(); offB() }
  })
})
