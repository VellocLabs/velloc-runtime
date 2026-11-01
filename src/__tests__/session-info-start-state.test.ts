import { describe, expect, it } from 'vitest'
import { projectSessionInfo } from '../browser/worker/sessionInfoProjection'
import { buildSessionSummaryFromMetadata } from '../sessions/sessionStore'

// The list entry of a session another session is starting (F-36): `starting`
// while the runtime holds the start state, `startFailed` with the reason from
// the live state or, across a reload, from the persisted record; the relation
// fields the summary computed ride along.

const SNAPSHOT = { initialized: false, messageCount: 0 } as never

describe('projectSessionInfo — start state', () => {
  it('shows a held start as starting, with its relation', () => {
    const fs = buildSessionSummaryFromMetadata('c', 1, {
      spawnedFrom: { sessionId: 'p', taskId: 't', kind: 'side_session', initiator: 'model', name: 'login-fix', sharedCheckout: true },
      customTitle: 'Fix the login redirect',
    })!
    const card = projectSessionInfo({ sessionId: 'c', entry: undefined, live: undefined, fs, start: { state: 'starting', since: 5 } })
    expect(card).toMatchObject({
      sessionId: 'c',
      starting: true,
      parentSessionId: 'p',
      lineageKind: 'side_session',
      familyName: 'login-fix',
      title: 'Fix the login redirect',
    })
    expect(card?.startFailed).toBeUndefined()
  })

  it('shows a failed start with the live reason, and drops starting', () => {
    const fs = buildSessionSummaryFromMetadata('c', 1, {})!
    const card = projectSessionInfo({
      sessionId: 'c',
      entry: undefined,
      live: undefined,
      fs,
      start: { state: 'failed', reason: 'the worktree could not be created: branch exists', at: 9 },
    })
    expect(card?.starting).toBeUndefined()
    expect(card?.startFailed).toBe('the worktree could not be created: branch exists')
  })

  it('carries a persisted failure across a reload, when no live state is held', () => {
    const fs = buildSessionSummaryFromMetadata('c', 1, { startFailed: { reason: 'no provider', at: 3 } })!
    expect(fs.startFailed).toEqual({ reason: 'no provider', at: 3 })
    const card = projectSessionInfo({ sessionId: 'c', entry: undefined, live: undefined, fs })
    expect(card?.startFailed).toBe('no provider')
    expect(card?.starting).toBeUndefined()
  })

  it('a started session shows neither', () => {
    const fs = buildSessionSummaryFromMetadata('c', 1, { firstPrompt: 'hi' })!
    const card = projectSessionInfo({ sessionId: 'c', entry: undefined, live: undefined, fs, start: undefined })
    expect(card?.starting).toBeUndefined()
    expect(card?.startFailed).toBeUndefined()
    const live = projectSessionInfo({
      sessionId: 'c',
      entry: { snapshot: SNAPSHOT },
      live: undefined,
      fs: undefined,
    })
    expect(live?.starting).toBeUndefined()
  })

  it('ignores a malformed persisted failure', () => {
    const fs = buildSessionSummaryFromMetadata('c', 1, { startFailed: { reason: 7 } } as never)!
    expect(fs.startFailed).toBeUndefined()
  })

  it('a detached child projects as detached', () => {
    const fs = buildSessionSummaryFromMetadata('d', 1, {
      spawnedFrom: { sessionId: 'p', taskId: 't', kind: 'side_session', initiator: 'model' },
      lineageDetached: true,
    })!
    const card = projectSessionInfo({ sessionId: 'd', entry: undefined, live: undefined, fs })
    expect(card?.detached).toBe(true)
    expect(card?.parentSessionId).toBeUndefined()
  })
})
